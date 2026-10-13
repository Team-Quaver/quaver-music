// Quaver — 应用页面 CSP（electron/csp.ts）的单测与源码护栏。
// 跑：  node scripts/verify-csp.ts
//
// 起因：`pnpm run app` 的终端与正在播放页里刷过一条
//   [renderer:warning] Electron Security Warning (Insecure Content-Security-Policy)
// Electron 在非打包态只认两件事：**页面没有 CSP**，或 **CSP 里有 unsafe-eval** —— 任一即警告。
// 所以修法必须是「真给一条不含 unsafe-eval 的 CSP」，而不是拿 ELECTRON_DISABLE_SECURITY_WARNINGS
// 把警告静音（那是把烟雾报警器的线拔了）。
//
// 两层：
//   ① 功能：策略文本本身（收紧的到底是什么）+ 只给本机 origin 贴头 + 覆盖既有 CSP + 挂钩子；
//   ② 源码护栏：主进程确实在 loadURL 之前挂了钩子；页面里不许再有内联 <script>
//      （script-src 不开 unsafe-inline，内联跳转会直接失效 = 用户停在空白页）；新 verify 进总闸。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_CSP, APP_CSP_DIRECTIVES, cspHeadersFor, installAppCsp } from "../electron/csp.ts";

const UI = join(import.meta.dirname, "..");
const read = (p: string) => {
  try { return readFileSync(join(UI, p), "utf8"); } catch { return ""; }
};

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** 把 CSP 头值折成「指令名 -> 来源列表」 */
function parse(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const cells = part.trim().split(/\s+/).filter(Boolean);
    if (cells.length) out[cells[0].toLowerCase()] = cells.slice(1);
  }
  return out;
}

/** Electron 的判据（我们照它自检；策略里任何一条含 unsafe-eval 或缺 CSP 都会重新刷警告） */
const electronWouldWarn = (csp: string) => !csp.trim() || /unsafe-eval/i.test(csp);

const directives = parse(APP_CSP);

// ——— ① 策略文本 ———
section("策略文本：网络放开、脚本收紧");
eq("APP_CSP 就是逐条指令拼出来的", APP_CSP, APP_CSP_DIRECTIVES.join("; "));
eq("default-src 只认同源", directives["default-src"], ["'self'"]);
eq("script-src 只有同源与 blob:（第三方插件走同源 URL import；blob 只给本地插件预读元数据）",
  directives["script-src"], ["'self'", "blob:"]);
check("script-src 不含 unsafe-inline（内联脚本报废 = innerHTML 混进来的代码升不成脚本）",
  !directives["script-src"].includes("'unsafe-inline'"));
check("整条策略不含 unsafe-eval（Electron 正是看这个报警）", !/unsafe-eval/i.test(APP_CSP));
eq("style-src 允许内联（主题/插件运行期注入 <style> 与 style 属性，样式不是代码）",
  directives["style-src"], ["'self'", "'unsafe-inline'"]);
check("img/media 放开远端（封面外链与插件音源直链都在这张页面上取）",
  directives["img-src"].includes("https:") && directives["media-src"].includes("https:")
  && directives["media-src"].includes("data:") && directives["media-src"].includes("blob:"));
check("connect 覆盖同源 /api 中继与远端 https（更新检查、插件源探测）",
  directives["connect-src"].includes("'self'") && directives["connect-src"].includes("https:"));
eq("object-src 关死", directives["object-src"], ["'none'"]);
eq("frame-ancestors 关死（本窗不许被别人嵌走当钓鱼画布）", directives["frame-ancestors"], ["'none'"]);
eq("base-uri 只认同源", directives["base-uri"], ["'self'"]);
eq("form-action 只认同源", directives["form-action"], ["'self'"]);

// ——— ② 贴头逻辑 ———
section("cspHeadersFor：只给应用 origin 贴，且不留第二份 CSP");
const ORIGIN = "http://127.0.0.1:4174";
const headers = cspHeadersFor(`${ORIGIN}/index.html`, ORIGIN, { "Content-Type": ["text/html"] });
eq("同源响应带上 CSP", headers?.["Content-Security-Policy"], [APP_CSP]);
eq("原有头保留", headers?.["Content-Type"], ["text/html"]);
const clobbered = cspHeadersFor(`${ORIGIN}/index.html`, ORIGIN, { "content-security-policy": ["default-src *"] });
eq("既有 CSP（小写同名）被替换成这一份", Object.keys(clobbered ?? {}), ["Content-Security-Policy"]);
const other = cspHeadersFor("https://example.com/index.html", ORIGIN, { "X-Powered-By": ["vite"] });
eq("别的 origin 一律不动", other, { "X-Powered-By": ["vite"] });
check("别的 origin 也不会被顺手加上头", !Object.keys(other ?? {}).some((k) => k.toLowerCase() === "content-security-policy"));
eq("URL 读不成（畸形）时不动", cspHeadersFor("not-a-url", ORIGIN, { A: ["1"] }), { A: ["1"] });
eq("没有既有头也能建出来", cspHeadersFor(`${ORIGIN}/assets/x.js`, ORIGIN, undefined), { "Content-Security-Policy": [APP_CSP] });

// ——— ③ 挂钩子 ———
section("installAppCsp：会话级 webRequest 钩子");
type Captured = { filters: { urls: string[] } | null; handler: ((d: any, cb: (r: any) => void) => void) | null };
const fakeSession = (cap: Captured) => ({
  webRequest: {
    onHeadersReceived(filters: { urls: string[] }, listener: (d: any, cb: (r: any) => void) => void) {
      cap.filters = filters;
      cap.handler = listener;
    },
  },
});
const cap: Captured = { filters: null, handler: null };
const logs: string[] = [];
eq("本机 http origin 挂得上", installAppCsp(fakeSession(cap) as any, ORIGIN, (m: string) => logs.push(m)), true);
eq("过滤器只指向应用 origin", cap.filters?.urls, [`${ORIGIN}/*`]);
check("挂上后有日志（启动可查，不是静默改行为）", logs.some((l) => l.includes("CSP")));
let cbResult: any = null;
cap.handler?.({ url: `${ORIGIN}/index.html`, responseHeaders: { "Content-Type": ["text/html"] } }, (r: any) => { cbResult = r; });
eq("回调交出的响应头里有 CSP", cbResult?.responseHeaders?.["Content-Security-Policy"], [APP_CSP]);
const capSkip: Captured = { filters: null, handler: null };
eq("file:// 没有 HTTP 头可贴 → 返回 false 且不挂钩子",
  installAppCsp(fakeSession(capSkip) as any, "file://", () => {}) === false && capSkip.handler === null, true);
eq("origin 带路径也不挂（过滤器会拼出无效 pattern）",
  installAppCsp(fakeSession(capSkip) as any, "http://127.0.0.1:4174/index.html", () => {}), false);

// ——— ④ 反向自证：什么情况下 Electron 会重新报警 ———
section("反向自证：Electron 的报警条件");
check("本策略不会触发警告", !electronWouldWarn(APP_CSP));
check("没有 CSP 会触发（所以这条策略不能只是「看起来设了」）", electronWouldWarn(""));
check("放开 unsafe-eval 会触发（谁往 script-src 塞 eval 谁就把警告请回来）",
  electronWouldWarn("script-src 'self' 'unsafe-eval'"));
check("换个写法照样会触发（不是只挡一种拼法）", electronWouldWarn("default-src 'self'; script-src 'unsafe-eval' blob:"));

// ——— ⑤ 源码护栏 ———
section("接线：主进程挂钩子 + 页面没有内联脚本");
const mainSrc = read("electron/main.ts");
check("主进程 import 了 installAppCsp", /import \{ installAppCsp \} from "\.\/csp\.ts";/.test(mainSrc));
check("主进程 import 了 session（app.session 在 Electron 44 是 undefined，实测会把钩子静默吞掉）",
  /import \{[^}]*\bsession[,}]/.test(mainSrc));
check("在 loadURL 之前挂钩子（晚挂 = 首帧没头）",
  mainSrc.indexOf("installAppCsp(session.defaultSession") < mainSrc.indexOf("win.loadURL(url)"));
check("默认会话 + 唯一 origin（session.defaultSession：Electron 44 已无 app.session，别改回去）",
  /installAppCsp\(session\.defaultSession, appOrigin/.test(mainSrc));
check("没有拿 ELECTRON_DISABLE_SECURITY_WARNINGS 静音",
  !read("electron/main.ts").includes("ELECTRON_DISABLE_SECURITY_WARNINGS")
  && !read("package.json").includes("ELECTRON_DISABLE_SECURITY_WARNINGS"));

const PAGES = ((): string[] => {
  const m = /const PAGES = \[([^\]]*)\]/.exec(read("vite.config.ts"));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
})();
check(`从 vite.config.ts 读到页面表（${PAGES.join(", ")}）`, PAGES.length > 0);
for (const page of PAGES) {
  const html = read(`${page}.html`);
  const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
  check(`${page}.html：没有内联 <script>（script-src 不开 unsafe-inline，内联会被拦）`, html !== "" && inline.length === 0,
    inline.length ? `发现 ${inline.length} 处内联` : "文件读不到");
  const external = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  for (const m of external) {
    const target = m[1].replace(/^\//, "");
    const okFile = target.startsWith("src/") ? existsSync(join(UI, target)) : existsSync(join(UI, "public", target));
    check(`${page}.html 的外链脚本 ${m[1]} 在源码里存在`, okFile);
  }
}
const redirect = read("public/redirect.js");
check("跳转层读得到且靠 data-route 定位", redirect.includes("data-route") || redirect.includes('getAttribute("data-route")'));
check("旧 playlist 深链的 tid/dir 映射还在", redirect.includes('q.get("tid")') && redirect.includes('q.get("dir")'));
check("跳转用 location.replace（不留历史记录）", redirect.includes("location.replace("));

// ——— ⑥ 总闸接线 ———
section("package.json：verify 脚本与总闸");
const pkg = JSON.parse(read("package.json") || "{}");
eq("verify:csp 脚本存在", pkg.scripts?.["verify:csp"], "node scripts/verify-csp.ts");
check("verify:static 收录了 verify-csp（新脚本必须进总闸，否则等于没测）",
  String(pkg.scripts?.["verify:static"] ?? "").includes("verify-csp"));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-csp: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
