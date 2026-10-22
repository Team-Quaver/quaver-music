// Quaver — 播放流闸门（主进程 webRequest 层；第二层在 vendor/Typhoeus-go/server/stream_guard.go）。
//
// 起因：设置 → 通用 → 调试 → 「开发者模式」开 DevTools 后，网络面板里能看到
// /api/stream/<token>，右键复制（新标签页打开 / 另存为 / Copy as cURL）或控制台
// fetch 一下，整首歌就被人拖走了 —— 加密档在后端也是解密后出流的，这条口子
// 等于直接违背应用「仅提供流媒体、不提供任何下载」的立场（README 协议节）。
//
// 主进程有一样渲染层伪造不了的事实：**请求是从什么资源类型发出来的**。
// resourceType：media = <audio>/<video> 元素；xmlhttprequest = fetch/XHR；
// main_frame = 地址栏/新标签页；other = 右键另存… 于是按白名单收口：
//   • /api/stream/<token>：只放行 media 的 GET；fetch/XHR 只放行「小的闭合 Range
//     探测」（正在播放页音质浮窗取容器头，语义与后端一致：单段闭合 ≤64KiB）
//   • /api/song/urls、/api/song/<id>/url：返回裸链（带 vkey/ekey）的旧端点，渲染层
//     没有任何合法用途 —— 对页面整段拉黑
//   • 其余资源类型（文档、frame、other…）：403 语义 = cancel
//
// 边界要说实话：DevTools 保留可用是用户诉求，而「控制台里能敲代码的进程」与
// 「应用自己」在同一台机器上共享一切本地资源 —— curl 伪造头、翻本机端口都挡不住
// webRequest 这一层。真正兜底的是后端第二层：Sec-Fetch 分类 + **mid 粒度令牌桶**
// 把取流速度压到 ≈3× 实时 —— 「一键下整曲」变成「下一首 ≈ 听一首」，批量拖库
// 失去意义，而正常播放（1× 消费 + 突发额度）无感。两层各挡各的形态：
//   webRequest 挡浏览器内顺手路径（面板复制 / 地址栏 / 控制台 fetch）—— 用户报告的那条；
//   后端限速挡本机脚本（重放、分块、反复 resolve 换 token 都绕不开同一个桶）。
// 验证：node scripts/verify-stream-guard.ts（判定表 + 主进程确实挂了钩子）。

/** 探测窗口上限（与后端 stream_guard.go 的 probeMaxSpan 对齐；改一处要同步另一处） */
export const PROBE_MAX_SPAN = 64 * 1024;

/** /api 路径的守卫归类：stream = 播放流 token 路径；legacy = 裸链端点；null = 不归本闸门管 */
export function classifyGuardedPath(pathname: string): "stream" | "legacy" | null {
  if (pathname === "/api/song/urls" || /^\/api\/song\/[^/]+\/url$/.test(pathname)) return "legacy";

  const m = /^\/api\/stream\/([^/?#]+)$/.exec(pathname);

  if (m && m[1] !== "resolve" && m[1] !== "tiers") return "stream";

  return null;
}

/** 「单段、闭合区间」的 Range（bytes=start-end）字节数；多段/开区间/后缀式/缺失 → null。
 *  与 closedRangeSpan（Go）同语义：整段取流形态一律按 null 拒。 */
export function closedRangeSpan(value: string | undefined): number | null {
  const spec = String(value ?? "").trim();

  if (!spec.startsWith("bytes=") || spec.includes(",")) return null;
  const body = spec.slice(6);
  const at = body.indexOf("-");

  if (at <= 0 || at === body.length - 1) return null; // 空 start（bytes=-N）/ 空 end（bytes=0-）

  if (!/^\d+$/.test(body.slice(0, at)) || !/^\d+$/.test(body.slice(at + 1))) return null;

  const start = Number(body.slice(0, at));
  const end = Number(body.slice(at + 1));

  if (end < start) return null;

  return end - start + 1;
}

/** onBeforeRequest 的 details 里本闸门用到的字段（结构声明；不 import electron，裸 node 可载） */
export interface GuardRequestLike {
  url: string;
  method: string;
  resourceType: string;
  requestHeaders?: { name: string; value?: string }[];
}

export type GuardVerdict = { allow: true } | { allow: false; reason: string };

/** 纯判定：这条应用同源请求能不能放行。 */
export function streamGuardVerdict(details: GuardRequestLike, appOrigin: string): GuardVerdict {
  let u: URL;

  try { u = new URL(details.url); } catch { return { allow: true }; }

  if (u.origin !== appOrigin) return { allow: true };

  const kind = classifyGuardedPath(u.pathname);

  if (!kind) return { allow: true };

  if (kind === "legacy") {
    return { allow: false, reason: "渲染层不开放裸链取用，播放一律走 /api/stream" };
  }

  if (details.method !== "GET") return { allow: false, reason: "播放流仅接受 GET" };

  // <audio>/<video> 元素：正常播放通路（mpv 是独立进程，不走 Chromium 栈，天然不见于此层）
  if (details.resourceType === "media") return { allow: true };

  // 页面脚本（fetch/XHR）：只允许小的闭合 Range 探测（音质浮窗取容器头）
  if (details.resourceType === "xmlhttprequest") {
    const header = (details.requestHeaders ?? []).find((h) => String(h.name).toLowerCase() === "range");
    const span = closedRangeSpan(header?.value);

    if (span !== null && span <= PROBE_MAX_SPAN) return { allow: true };

    return { allow: false, reason: "页面 fetch 仅允许小范围探测，不支持整段取流" };
  }

  // 地址栏粘贴 / 新标签页 / 右键另存 / 其它资源形态
  return { allow: false, reason: "播放流仅允许应用内播放器取用" };
}

/** 只用到的那一个方法按结构声明（对齐 csp.ts 的 SessionLike 写法） */
export interface GuardSessionLike {
  webRequest: {
    onBeforeRequest(
      filters: { urls: string[] },
      listener: (
        details: GuardRequestLike,
        callback: (result: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
}

/**
 * 挂钩子。返回 false = 没挂上（与 CSP 同款降级姿态：闸门缺失记日志，不该把应用锁死）。
 * urls 过滤已收窄到本 origin 的 /api/*，listener 里再按路径判定 —— 其它 /api 请求零开销直通。
 */
export function installStreamGuard(
  session: GuardSessionLike,
  appOrigin: string,
  log: (msg: string, ...rest: unknown[]) => void = () => {},
): boolean {
  if (!session) { log("[quaver] 播放流闸门未挂：拿不到 session"); return false; }

  if (!session.webRequest) { log("[quaver] 播放流闸门未挂：session.webRequest 不可用"); return false; }

  if (!/^https?:\/\/[^/]+$/.test(appOrigin)) { log("[quaver] 播放流闸门未挂：origin 不是纯 http(s) 源 =", appOrigin); return false; }

  session.webRequest.onBeforeRequest({ urls: [`${appOrigin}/api/*`] }, (details, callback) => {
    const verdict = streamGuardVerdict(details, appOrigin);

    if (verdict.allow) { callback({}); return; }

    log(`[quaver] 已拦截播放流请求（${details.resourceType}）: ${details.url} —— ${verdict.reason}`);
    callback({ cancel: true });
  });
  log("[quaver] 播放流闸门已挂到", appOrigin);

  return true;
}
