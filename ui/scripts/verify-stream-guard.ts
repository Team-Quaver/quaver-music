// Quaver — 播放流闸门（electron/stream-guard.ts + sidecar stream_guard.go）的单测与源码护栏。
// 跑：  node scripts/verify-stream-guard.ts
//
// 背景：DevTools「开发者模式」保留，但网络面板曾能把 /api/stream/<token> 复制出去拖走
// 整曲。两层防线各管一段：主进程按 resourceType 收口浏览器内的顺手路径；sidecar 按
// Sec-Fetch 分类 + mid 粒度限速兜底本机脚本。断言分两层：
//   ① 判定表：放行/拦截矩阵逐条点名（媒体元素、小探测、整段 fetch、地址栏、legacy 裸链）；
//   ② 源码护栏：主进程真的在 loadURL 前挂了钩子；两套中继转发了 Sec-Fetch 头；Go 侧
//     闸门文件与限速接线还在；PROBE_MAX_SPAN 与 Go 的 probeMaxSpan 同值。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROBE_MAX_SPAN, classifyGuardedPath, closedRangeSpan, installStreamGuard, streamGuardPreflightVerdict,
  streamGuardVerdict,
  type GuardRequestLike,
} from "../electron/stream-guard.ts";

const UI = join(import.meta.dirname, "..");
const GO_GUARD = join(UI, "..", "vendor", "Typhoeus-go", "server", "stream_guard.go");
const GO_STREAM = join(UI, "..", "vendor", "Typhoeus-go", "server", "handlers_stream.go");

const read = (p: string) => {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
};

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ORIGIN = "http://127.0.0.1:34111";

// ——— ① 判定表 ———
section("路径归类");

check("播放流 token 路径 = stream", classifyGuardedPath("/api/stream/AbC-123_x") === "stream");

check("本地缓存播放流 = stream", classifyGuardedPath("/api/cache/music/stream/AbC-123_x") === "stream");

check("微云播放流 = stream", classifyGuardedPath("/api/weiyun/music/10001-abc") === "stream");

check("resolve 不归 token 闸门管", classifyGuardedPath("/api/stream/resolve") === null);

check("tiers 不归 token 闸门管", classifyGuardedPath("/api/stream/tiers") === null);

check("裸链批量端点 = legacy", classifyGuardedPath("/api/song/urls") === "legacy");

check("裸链单曲端点 = legacy", classifyGuardedPath("/api/song/002J4UUk29y8BY/url") === "legacy");

check("歌词/搜索等其它路径直通", classifyGuardedPath("/api/song/002J4UUk29y8BY/detail") === null);

section("Range 语义（与 Go closedRangeSpan 对齐）");

check("bytes=0-4095 → 4096", closedRangeSpan("bytes=0-4095") === 4096);

check("开区间 bytes=0- 拒", closedRangeSpan("bytes=0-") === null);

check("后缀式 bytes=-512 拒", closedRangeSpan("bytes=-512") === null);

check("多段拒", closedRangeSpan("bytes=0-9,20-29") === null);

check("无 Range 拒（整段 GET）", closedRangeSpan(undefined) === null);

check("倒挂区间拒", closedRangeSpan("bytes=10-5") === null);

const req = (over: Partial<GuardRequestLike>): GuardRequestLike =>
  ({ url: `${ORIGIN}/api/stream/tok123`, method: "GET", resourceType: "media", ...over });

section("放行/拦截矩阵");

check("<audio> 元素（media）放行", streamGuardVerdict(req({}), ORIGIN).allow === true);

check("媒体元素带小 Range 也放行",
  streamGuardVerdict(req({ requestHeaders: [{ name: "Range", value: "bytes=1024-2047" }] }), ORIGIN).allow === true);

const xhr = (range?: string) => req({
  resourceType: "xhr",
  requestHeaders: range ? [{ name: "range", value: range }] : [],
});

check("Electron xhr 小探测（≤64KiB）放行（音质浮窗）", streamGuardVerdict(xhr("bytes=0-4095"), ORIGIN).allow === true);

check("CDP 兼容：xmlhttprequest 小探测同样放行",
  streamGuardVerdict({ ...xhr("bytes=0-4095"), resourceType: "xmlhttprequest" }, ORIGIN).allow === true);

check("fetch 无 Range 整段 → 拦截", streamGuardVerdict(xhr(), ORIGIN).allow === false);

check("fetch 开区间 → 拦截", streamGuardVerdict(xhr("bytes=0-"), ORIGIN).allow === false);

check("fetch 超 64KiB 闭合段 → 拦截",
  streamGuardVerdict(xhr(`bytes=0-${PROBE_MAX_SPAN}`), ORIGIN).allow === false);

check("地址栏/新标签页（main_frame）拦截",
  streamGuardVerdict(req({ resourceType: "main_frame" }), ORIGIN).allow === false);

check("右键另存（other）拦截", streamGuardVerdict(req({ resourceType: "other" }), ORIGIN).allow === false);

check("token 路径上的 POST 拦截", streamGuardVerdict(req({ method: "POST" }), ORIGIN).allow === false);

check("legacy 裸链：fetch 拦截",
  streamGuardVerdict(req({ url: `${ORIGIN}/api/song/urls`, method: "POST", resourceType: "xmlhttprequest" }), ORIGIN).allow === false);

check("legacy 裸链：媒体类型也拦（该端点只回 JSON）",
  streamGuardVerdict(req({ url: `${ORIGIN}/api/song/002J4UUk29y8BY/url` }), ORIGIN).allow === false);

check("resolve POST 不在此闸门内（正常取链不受影响）",
  streamGuardVerdict(req({ url: `${ORIGIN}/api/stream/resolve`, method: "POST", resourceType: "xmlhttprequest" }), ORIGIN).allow === true);

check("其它 origin 直通（插件外部源不归管）",
  streamGuardVerdict(req({ url: "https://example.com/api/stream/tok" }), ORIGIN).allow === true);

check("onBeforeRequest 预检：xhr 延后到请求头阶段判定",
  streamGuardPreflightVerdict(xhr(), ORIGIN).allow === true);

check("onBeforeRequest 预检：媒体放行、地址栏拦截",
  streamGuardPreflightVerdict(req({}), ORIGIN).allow === true
    && streamGuardPreflightVerdict(req({ resourceType: "main_frame" }), ORIGIN).allow === false);

// ——— ② 源码护栏 ———
section("接线：主进程 / 中继 / 后端");

const mainSrc = read(join(UI, "electron/main.ts"));

check("main.ts import 了 installStreamGuard", /import \{ installStreamGuard \} from "\.\/stream-guard\.ts"/.test(mainSrc));

const guardInstall = mainSrc.indexOf("installStreamGuard(session.defaultSession");

check("主进程挂了钩子", guardInstall > 0);

check("钩子先于 loadURL（webRequest 会话级，晚挂首帧漏网）",
  guardInstall > 0 && guardInstall < mainSrc.indexOf("win.loadURL(url)"));

const native = read(join(UI, "electron/native-server.ts"));
const relay = read(join(UI, "src/relay.ts"));

check("打包态中继转发 sec-fetch-dest", /headers\.set\("sec-fetch-dest"/.test(native));

check("开发态中继转发 sec-fetch-dest（dev 与 prod 同权）", /headers\.set\("sec-fetch-dest"/.test(relay));

const goGuard = read(GO_GUARD);
const goStream = read(GO_STREAM);

check("Go 侧闸门文件存在（分类 + 令牌桶）", goGuard.length > 0 && /func classifyStreamClient/.test(goGuard));

check("Go 侧限速：写出经 pacedWriter", /pacedWriter\{/.test(goStream) && /func \(p \*pacedWriter\) Write/.test(goGuard));

check("Go 侧探测闸门接在 handleStreamProxy", /classifyStreamClient\(r\)/.test(goStream));

check("裸链端点对页面关门", /denyBrowserClients\(w, r\)/.test(read(join(UI, "..", "vendor/Typhoeus-go/server/handlers_content.go"))));

check("探测上限两处同值（64KiB）",
  PROBE_MAX_SPAN === 64 * 1024 && /probeMaxSpan\s*=\s*64 << 10/.test(goGuard));

check("TTL 已从 2h 收紧（滑动 30min + 绝对 3h）",
  !/streamTTL/.test(goStream) && /streamIdleTTL = 30 \* time\.Minute/.test(goStream) && /streamMaxAge  = 3 \* time\.Hour/.test(goStream));

const apiSrc = read(join(UI, "src/lib/api.ts"));

check("resolve 带 duration_ms 限速提示", /duration_ms: durationHintMs\(song\)/.test(apiSrc));

let requestHookOk = false;
let headerHookOk = false;

installStreamGuard({
  webRequest: {
    onBeforeRequest: (_f, listener) => {
      const box = { cancel: false };

      listener(req({ resourceType: "main_frame" }), (r) => { box.cancel = r.cancel === true; });
      requestHookOk = box.cancel;
    },
    onBeforeSendHeaders: (_f, listener) => {
      const full = { cancel: false };
      const probe = { cancel: false };

      listener(xhr(), (r) => { full.cancel = r.cancel === true; });
      listener(xhr("bytes=0-4095"), (r) => { probe.cancel = r.cancel === true; });
      headerHookOk = full.cancel && !probe.cancel;
    },
  },
}, ORIGIN, () => {});

check("onBeforeRequest 真的把 cancel 传回 webRequest", requestHookOk);

check("onBeforeSendHeaders 拦截整段 xhr、放行闭合小 Range", headerHookOk);

check("坏 origin（file: 等）返回 false 而不是抛",
  installStreamGuard({ webRequest: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {} } }, "file:///", () => {}) === false);

const pkg = JSON.parse(read(join(UI, "package.json")));

check("verify:static 收录了 verify-stream-guard（新脚本必须进总闸，否则等于没测）",
  String(pkg.scripts?.["verify:static"] ?? "").includes("node scripts/verify-stream-guard.ts"));

check("package.json 有独立入口 verify:stream-guard",
  String(pkg.scripts?.["verify:stream-guard"] ?? "") === "node scripts/verify-stream-guard.ts");

console.log(`\n${fail === 0 ? "✅" : "❌"} stream-guard: ${pass} pass, ${fail} fail`);

process.exit(fail === 0 ? 0 : 1);
