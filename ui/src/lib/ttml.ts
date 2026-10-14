// Quaver — TTML 逐字歌词门面：数据库地址模板展开 + 在线库查询 + 会话级未命中缓存。
//
// 数据是 AMLL TTML（<tt …> XML，逐词时间轴 + 可选翻译/注音）；解析永远交给在位的逐字提供器
// （默认 = 宿主内置 AMLL，见 src/lyrics），本模块只管「拿到文本」这一段。
//
// 地址模板的两个占位符（口径来自 AMLL TTML 数据库 amll-dev/amll-ttml-db 的仓库布局，
// 镜像站按目录原样转发，默认地址 = bikonoo 实时镜像）：
//   %p = 平台目录名（下表）；%s = 该平台歌曲 id（QQ 为 songmid，网易云为 track id…）。
// 夸克当前只认得 QQ 歌曲身份，但模板与展开表是全平台的：换库/自建镜像只改 [Lyrics] TtmlDatabase。
//
// isTtmlDatabaseUrl 与 electron/config.ts 的 isTtmlDatabaseUrlTemplate **同规**（写盘拦截 vs
// 输入框即时反馈两个消费点，改一处要改两处，同 isHexColor/parseHex 的先例）。
// 在线查询走渲染层直连 fetch：公共静态库、无凭证、镜像回显 Origin 的 CORS；CSP connect-src 放行 https。

/** 默认数据库地址模板（与 schema 默认值同源；「恢复默认」按钮的唯一真相）。 */
export const TTML_DB_DEFAULT_URL = "https://amlldb.bikonoo.com/%p/%s.ttml";

/** 平台 → AMLL TTML 数据库仓库的平台目录名。表里没有的平台 = 无身份可用，展开返回 null。 */
export const TTML_PLATFORM_DIRS: Record<string, string> = {
  qq: "qq-lyrics",
  ncm: "ncm-lyrics",
  netease: "ncm-lyrics",
  music163: "ncm-lyrics",
  am: "am-lyrics",
  apple: "am-lyrics",
  itunes: "am-lyrics",
  spotify: "spotify-lyrics",
};

/** 地址模板判据：http(s) 绝对地址、必须含 %s（%p 可选）、无空白/引号/尖括号/反斜杠/井号/竖线、≤512。 */
export function isTtmlDatabaseUrl(v: string): boolean {
  const s = String(v ?? "").trim();
  return s.length > 0 && s.length <= 512 && s.includes("%s") && /^https?:\/\/[^\s"'<>\\#|]+$/.test(s);
}

/** 模板展开：任何不满足前提的情况（模板非法/id 空/需要 %p 但平台不认识）返回 null = 不发请求。 */
export function expandTtmlUrl(tpl: string, platform: string, id: string): string | null {
  const t = String(tpl ?? "").trim();
  const sid = String(id ?? "").trim();
  if (!isTtmlDatabaseUrl(t) || !sid) return null;
  const dir = TTML_PLATFORM_DIRS[String(platform ?? "").toLowerCase()] ?? "";
  if (t.includes("%p") && !dir) return null; // 模板要求平台目录但没有这个平台：别拿空目录打请求
  return t.replaceAll("%p", dir).replaceAll("%s", encodeURIComponent(sid));
}

/** 内容嗅探：与 electron/local/library.ts 的 sniffLyricFormat 同一判据的 TTML 半边。 */
export function looksLikeTtml(text: string): boolean {
  return /<tt[\s>]|<ttml|xmlns="[^"]*ttml/i.test(String(text ?? "").slice(0, 4096));
}

/** 单份 TTML 的体积上限（与本地库读盘同一档：512KB 装不满就不是歌词）。 */
export const TTML_TEXT_CAP = 512 * 1024;

const miss = new Map<string, number>(); // 未命中缓存：url → 记入时刻（会话级）
const MISS_TTL_MS = 10 * 60 * 1000;

/** 这个地址刚查过且没有（404/非 TTML）——TTL 内不再打第二遍。 */
export function ttmlMissCached(url: string): boolean {
  const at = miss.get(url);
  if (at === undefined) return false;
  if (Date.now() - at > MISS_TTL_MS) { miss.delete(url); return false; }
  return true;
}
export function ttmlMissRemember(url: string): void {
  // 粗防呆：表胖了就整表倒一遍 TTL（会话内换不了几个库地址，不值得做 LRU）
  if (miss.size > 2048) {
    const cut = Date.now() - MISS_TTL_MS;
    for (const [k, v] of miss) if (v < cut) miss.delete(k);
  }
  miss.set(url, Date.now());
}

/** 在线库查询：拿不到（网络失败/非 200/嗅探不是 TTML/超时）一律 null，调用方无脑回落。 */
export async function fetchTtml(url: string, timeoutMs = 6000): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text || text.length > TTML_TEXT_CAP) return null;
    return looksLikeTtml(text) ? text : null;
  } catch {
    return null;
  }
}
