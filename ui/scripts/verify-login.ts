// 登录页「本机 QQ 快速登录 + 二维码兜底」的静态与运行时断言
//
// 需求：默认尝试本机 QQ 快速登录，不打开 ssl.ptlogin2 登录页；
// 检测到后头像淡入左移、昵称/QQ 号一上一下非线性入场；
// 未检测到或用户点「使用二维码登录」时进入原扫码流程。
//
// 用法：node scripts/verify-login.ts
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { viewSource, viewsSource } from "./views-source.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const views = viewsSource();
const css = read("src/style.css");
const contrast = read("scripts/verify-highlight-contrast.ts");
const appGo = readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "app.go"), "utf8");

let fails = 0;
let checks = 0;

const ok = (name, cond, note = "") => {
  checks++;

  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

const has = (h, n) => h.includes(n);
const re = (h, rx) => rx.test(h);
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const source = viewSource("login");
const view = noComments(source);

ok("views: 抠到 loginView 源码", view.length > 800, `${view.length} 字符`);

// ============ 快速登录 ============
ok("快速登录: 视图打开即探测本机 QQ（GET /login/qq-quick）",
  re(view, /api(?:<[^>(]*>)?<QQQuickResp>\("\/login\/qq-quick"\)/) && re(view, /void detect\(\);/));

ok("布局: 视图挂 login-host，卡片在 Content View 内垂直居中",
  re(view, /root\.classList\.add\("login-host"\)/)
  && /\.route > \.entering\.login-host \{[^}]*place-items:\s*center/.test(css));

ok("快速登录: 不打开 ssl 登录页（没有 window.open / location 跳 ptlogin2）",
  !has(view, "window.open") && !/ptlogin2\.qq\.com/.test(view));

ok("快速登录: 初始态是「正在加载」且不渲染账号卡", has(view, "正在加载…") && has(view, "quick-loading"));

ok("快速登录: 头像+昵称整组即登录按钮（无单独「点击登录」）",
  /<button id="quick-login" class="quick-card ready" type="button">/.test(view)
  && has(view, "quick-avatar") && has(view, "quick-name") && has(view, "quick-uin")
  && !has(view, "点击登录"));

ok("快速登录: 点击登录提交 uin 到 POST /login/qq-quick",
  re(view, /postJson\("\/login\/qq-quick", \{ uin: d\.uin \}\)/));

ok("快速登录: 成功后仍跳回首页", has(view, 'location.href = "/index.html"'));

ok("兜底: 快捷登录下方的「使用二维码登录」是按钮", has(view, '使用二维码登录') && re(view, /#quick-fallback/));

ok("兜底: 二维码区下方可切回「使用 QQ 快捷登录」", has(view, '使用 QQ 快捷登录') && re(view, /#qr-fallback/));

ok("动画: 头像淡入并左移到位（quick-avatar-in）",
  /@keyframes quick-avatar-in[\s\S]*?opacity:\s*0;[\s\S]*?translateX\(26px\)[\s\S]*?opacity:\s*1[\s\S]*?transform:\s*none/.test(css));

ok("动画: 昵称自下而上、QQ 号自上而下，且都是非线性缓动",
  /@keyframes quick-name-in[\s\S]*?translateY\(12px\)[\s\S]*?transform:\s*none/.test(css)
  && /@keyframes quick-uin-in[\s\S]*?translateY\(-10px\)[\s\S]*?transform:\s*none/.test(css)
  && /\.quick-name \{[^}]*cubic-bezier\(\.34,1\.3,\.4,1\)/.test(css));

ok("切换: 自带 display 的面板不会被 [hidden] 的 UA 样式顶掉",
  /\.quick-login\[hidden\], \.qr-panel\[hidden\] \{ display: none; \}/.test(css));

// ============ 二维码兜底 ============
ok("登录方式不再用 <select>（view 内无 select / option）", !has(view, "<select") && !has(view, "<option"));

ok("也去掉了 select 的 onchange 接线", !has(view, "onchange"));

ok("css: .row-btn 里那个 select 的样式已清掉（那一行只剩「重新生成」按钮）",
  !has(css, ".row-btn select") && has(css, ".row-btn button"));

ok("DOM: 标签行 = .tag-tabs#channel + role=tablist",
  /<div class="tag-tabs" id="channel" role="tablist" aria-label="登录方式">/.test(view));

ok("DOM: 三个标签都是 button.tag + role=tab + aria-selected + data-ch",
  (view.match(/<button class="tag[^"]*" type="button" role="tab" aria-selected="(?:true|false)" data-ch="[a-z]+">/g) ?? []).length === 3);

ok("DOM: 默认选中第一个标签（.sel + aria-selected=true 都落在同一颗上）",
  /<button class="tag sel" type="button" role="tab" aria-selected="true" data-ch="(\w+)">/.test(view)
  && re(view, /let channel = \(?tabs\[0\]\?\.dataset\.ch \?\? "mobile"\)?/));

// Go sidecar 的登录类型表 = app.go 的 qrTypeNames（写错是 422，不是静默失败）
const backend = new Set([...appGo.matchAll(/^\t"([a-z]+)":\s+modules\.QRType/gm)].map((m) => m[1]));
const frontend = [...view.matchAll(/data-ch="([a-z]+)"/g)].map((m) => m[1]);

ok("通道: 前端三个 data-ch 都落在 sidecar QR_TYPES 里",
  frontend.length === 3 && frontend.every((c) => backend.has(c)),
  `前端 ${frontend.join("/")}　后端 ${[...backend].join("/")}`);

ok("换标签: 点击即重开二维码（void start()）", re(view, /void start\(\);/));

ok("换标签: 重复点当前档不重开（避免白烧一次上游请求 + 触发限流）",
  /if \(ch === channel\) return; \/\/ 重复点当前档不重开/.test(views));

ok("换标签: 选中态与 aria-selected 同步切换",
  re(view, /x\.classList\.toggle\("sel", on\);\s*x\.setAttribute\("aria-selected", String\(on\)\);/));

ok("换标签: 重开前先清掉旧轮询（两个通道的轮询不许串台）",
  re(view, /async function start\(\) \{\s*window\.clearInterval\(timer\);/));

ok("请求路径用当前通道（不是元素 value）",
  re(view, /api(?:<[^>(]*>)?\(`\/login\/qrcode\/\$\{loginChannel\}`\)/)
  && re(view, /api(?:<[^>(]*>)?\(`\/login\/qrcode\/\$\{loginChannel\}\/status\?identifier=/));

ok("「重新生成」按钮仍在", re(view, /#refresh"\)!\.onclick = \(\) => void start\(\)/));

ok("回归: 视图返回的 cleanup 仍然停轮询（离页不留定时器）",
  re(view, /return \(\) => \{ stopped = true; window\.clearInterval\(timer\); \};/));

ok("回归: 二维码登录成功仍跳回首页", (view.match(/location\.href = "\/index\.html"/g) ?? []).length === 2);

// ============ 版式与高亮态 ============
ok("css: 标签行在登录区居中", /\.login-wrap \.tag-tabs \{[^}]*justify-content:\s*center/.test(css));

const sel = css.match(/\.login-wrap \.tag\.sel \{([^}]*)\}/)?.[1] ?? "";

ok("css: 选中态走「软洗底 + accent 系前景 + accent 描边」（不用白字压裸 accent）",
  /background:[^;]*color-mix\([^;]*transparent/.test(sel)
  && /border-color:[^;]*var\(--cvg-accent/.test(sel)
  && /(?<![-\w])color:[^;]*var\(--ink\)/.test(sel));

ok("contrast: .login-wrap .tag.sel 已登记进 verify-highlight-contrast", has(contrast, '".login-wrap .tag.sel"'));

// ============ 运行时 ============
// 运行时桩提供 api/postJson/errText，源码里的 import 要剥掉才能进 new Function。
const loginSource = source
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
  .replace("export default async function", "async function");

const makeLogin = new Function("api", "postJson", "window", "location", "setTimeout", "errText",
  stripTypeScriptTypes(loginSource) + "; return loginView;");

const pending = [];
const intervals = new Map();
const delayed = [];
let timerId = 0;
const state = { textContent: "" }, qr = { innerHTML: "" }, refresh = { onclick: null };

const quickEl = {
  innerHTML: "", hidden: false, classList: { add() {} },
  querySelector(s) { return { "#quick-login": quickLogin, "#quick-error": quickError }[s]; },
};
const quickLogin = { disabled: false, onclick: null };
const quickError = { textContent: "" };
const fallback = { hidden: true, onclick: null };
const qrPanel = {
  hidden: true, querySelector: (s) => ({ "#qr": qr, "#lstate": state, "#refresh": refresh, "#qr-fallback": qrFallback }[s]),
  querySelectorAll: () => tabs,
};
const qrFallback = { hidden: true, onclick: null };
const fakeRoot = {
  innerHTML: "",
  classList: { add() {} },
  querySelector(s) { return { "#quick": quickEl, "#quick-fallback": fallback, "#qr-panel": qrPanel }[s]; },
};

const tabs = ["mobile", "qq", "wx"].map((ch) => ({
  dataset: { ch }, click: null, classList: { toggle() {} }, setAttribute() {},
  addEventListener(_, cb) { this.click = cb; },
}));

const fakeWindow = {
  setInterval(cb) { const id = ++timerId; intervals.set(id, cb); return id; },
  clearInterval(id) { intervals.delete(id); },
};

const fakeLocation = { href: "" };
const api = (path) => new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
const postJson = (path, body) => new Promise((resolve, reject) => pending.push({ path, body, resolve, reject }));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const cleanup = await makeLogin(api, postJson, fakeWindow, fakeLocation, (cb) => delayed.push(cb), (e) => e.message)(fakeRoot);

ok("运行时：初始探测挂起时不露出二维码兜底入口", fallback.hidden && pending.length === 1);

pending[0].resolve({ available: true, uin: 123456, nickname: "Neo", avatar: "avatar.jpg" });

await flush();

ok("运行时：检测到本机 QQ 后渲染头像/昵称/QQ 号",
  quickEl.innerHTML.includes("avatar.jpg") && quickEl.innerHTML.includes("Neo") && quickEl.innerHTML.includes("QQ 号 123456"));

ok("运行时：探测完成后才露出二维码兜底入口", fallback.hidden === false);

fallback.onclick();

ok("运行时：切到二维码时隐藏快捷登录并露出返回入口",
  quickEl.hidden && qrPanel.hidden === false && qrFallback.hidden === false);

qrFallback.onclick();

ok("运行时：从二维码切回快捷登录并收起返回入口",
  quickEl.hidden === false && qrPanel.hidden && intervals.size === 0);

pending.splice(1); // start() 的二维码请求不在本轮断言里

quickLogin.onclick();

ok("运行时：点击登录提交的是探测到的 uin", pending[1].path === "/login/qq-quick" && pending[1].body.uin === 123456);

pending[1].resolve({ logged_in: true });

await flush();

delayed.shift()!();

ok("运行时：快速登录成功跳回首页", fakeLocation.href === "/index.html");

cleanup();

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);

process.exit(fails ? 1 : 0);
