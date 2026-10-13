// Quaver — NAS 通路之一：WebDAV 客户端（只依赖全局 fetch，零 npm 包）。
//
// 为什么是 WebDAV 而不是 SMB：SMB 没有纯 Node 实现（要么引第三方大依赖，要么依赖系统挂载），
// 而 NAS 恰恰普遍自带 WebDAV。挂载盘（SMB/NFS 映射成本机路径）走 folder 源同样覆盖 NAS，
// 这里补的是「不挂载、直接吃网络共享」那条路。凭证只进不出：username/password 存在
// local-library.json（0600），任何响应与日志都不回显。
//
// 能力面（刻意收窄，够扫描与流播即可）：
//   - PROPFIND Depth:1 → 目录列表（name/isCollection/size/mtime）；
//   - GET + Range → 头部窗口读取（扫描时解析标签）与音频流代理（透传 Range/206）。
// 服务器要求：Basic 认证、Range 支持（不给 Range 的服务器仍可整段播，只是 seek 依赖对方）。

export interface DavAuth { username?: string; password?: string }

export interface DavEntry {
  /** 服务器绝对路径（已百分号解码，用于拼 relPath 与再入队目录） */
  path: string;
  name: string;
  isCollection: boolean;
  size: number;
  /** Unix ms；读不到给 0 */
  mtime: number;
}

export class DavError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** base URL（目录）与相对路径拼成请求 URL；段各自百分号编码，保住已编码字符不被二次处理。 */
export function davJoin(base: string, rel: string): string {
  const b = base.replace(/\/+$/, "") + "/";
  const r = rel.replace(/^\/+/, "").split("/").map((s) => encodeURIComponent(s)).join("/");
  return b + r;
}

/** href 可能是「绝对路径」或完整 URL；统一成百分号解码后的服务器路径。 */
function hrefToPath(base: string, href: string): string {
  let p = href;
  try {
    const u = new URL(href, base);
    p = u.pathname;
  } catch { /* 原样 */ }
  return decodeURIComponent(p.replace(/^https?:\/\/[^/]+/i, ""));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** 取块里第一个 <name>…</name>（含命名空间前缀，自闭合算空）。 */
function firstTag(block: string, name: string): string | null {
  const m = new RegExp(`<([\\w.-]*:)?${name}\\b([^>]*)>([\\s\\S]*?)(?:<\\/\\1?${name}>|$)`, "i").exec(block);
  if (!m) return null;
  if (m[2] && m[2].trimEnd().endsWith("/")) return "";
  return m[3];
}

export function parsePropfind(xml: string, baseUrl: string): DavEntry[] {
  const out: DavEntry[] = [];
  const re = /<([\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/\1response>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const href = firstTag(body, "href");
    if (href == null) continue;
    const path = hrefToPath(baseUrl, decodeEntities(href).trim());
    const rt = /<([\w.-]*:)?collection\b/i.test(body);
    const size = Number(firstTag(body, "getcontentlength") ?? "0") || 0;
    const lm = firstTag(body, "getlastmodified");
    const mtime = lm ? (Date.parse(decodeEntities(lm).trim()) || 0) : 0;
    const name = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? path);
    out.push({ path, name, isCollection: rt, size, mtime });
  }
  return out;
}

function authHeaders(auth?: DavAuth): Record<string, string> {
  if (!auth?.username) return {};
  // Node 侧没有 btoa 的全局可用性问题（Node 18+ 有）；Buffer 更稳。
  const b = Buffer.from(`${auth.username}:${auth.password ?? ""}`, "utf8").toString("base64");
  return { authorization: `Basic ${b}` };
}

/** PROPFIND Depth:1；207/200 都算成功。 */
export async function propfind(url: string, auth?: DavAuth, signal?: AbortSignal): Promise<DavEntry[]> {
  let r: Response;
  try {
    r = await fetch(davJoinRoot(url), {
      method: "PROPFIND",
      headers: {
        ...authHeaders(auth),
        depth: "1",
        "content-type": "application/xml",
        accept: "application/xml, text/xml",
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
      signal,
      redirect: "follow",
    });
  } catch (e) {
    throw new DavError(`WebDAV 连接失败：${(e as Error).message}`);
  }
  if (r.status !== 207 && r.status !== 200) {
    throw new DavError(`WebDAV PROPFIND ${r.status} ${r.statusText}`, r.status);
  }
  return parsePropfind(await r.text(), url);
}

/** 给 PROPFIND 用的 URL：目录必须有尾斜杠（Depth:1 列子项）。 */
function davJoinRoot(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/** 读一个字节窗口 [from, to)；服务器无视 Range（回 200 全量）时截头部并保长度语义。 */
export async function davReadRange(url: string, from: number, to: number, auth?: DavAuth, signal?: AbortSignal): Promise<Buffer> {
  const r = await fetch(url, {
    method: "GET",
    headers: { ...authHeaders(auth), range: `bytes=${from}-${to - 1}` },
    signal,
    redirect: "follow",
  });
  if (r.status === 404 || r.status === 403 || r.status === 401) {
    throw new DavError(`WebDAV GET ${r.status}`, r.status);
  }
  if (!r.ok && r.status !== 206) throw new DavError(`WebDAV GET ${r.status}`, r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status === 206) return buf;
  return buf.subarray(from, Math.min(buf.length, to));
}

export function davAuthHeaders(auth?: DavAuth): Record<string, string> {
  return authHeaders(auth);
}
