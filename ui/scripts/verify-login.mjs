// 登录页「登录方式用标签（Tag）而不是下拉菜单」的静态断言
//
// 需求：把 <select> 下拉换成标签行。顺带守住几件容易在重写里丢掉的事：
//   1. data-ch 的取值必须落在 sidecar 的 QR_TYPES（qq/wx/mobile）里 —— 写错是 422，不是静默失败；
//   2. 换标签要重开二维码，并把旧轮询清掉（否则两个通道的轮询串台，状态互相覆盖）；
//   3. 视图返回的 cleanup 仍然停掉轮询（离开页面别留定时器）。
//
// 用法：node scripts/verify-login.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const views = read("src/views.ts");
const css = read("src/style.css");
const contrast = read("scripts/verify-highlight-contrast.mjs");
const appPy = readFileSync(join(root, "..", "vendor", "Typhoeus", "quaver_server", "app.py"), "utf8");

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

const view = noComments(views.match(/async function loginView[\s\S]*?\n\}/)?.[0] ?? "");
ok("views: 抠到 loginView 源码", view.length > 800, `${view.length} 字符`);

// ============ 没有下拉了 ============
ok("登录方式不再用 <select>（view 内无 select / option）", !has(view, "<select") && !has(view, "<option"));
ok("也去掉了 select 的 onchange 接线", !has(view, "onchange"));
ok("css: .row-btn 里那个 select 的样式已清掉（那一行只剩「重新生成」按钮）",
  !has(css, ".row-btn select") && has(css, ".row-btn button"));

// ============ 标签行本体 ============
ok("DOM: 标签行 = .tag-tabs#channel + role=tablist",
  /<div class="tag-tabs" id="channel" role="tablist" aria-label="登录方式">/.test(view));
ok("DOM: 三个标签都是 button.tag + role=tab + aria-selected + data-ch",
  (view.match(/<button class="tag[^"]*" type="button" role="tab" aria-selected="(?:true|false)" data-ch="[a-z]+">/g) ?? []).length === 3);
ok("DOM: 默认选中第一个标签（.sel + aria-selected=true 都落在同一颗上）",
  /<button class="tag sel" type="button" role="tab" aria-selected="true" data-ch="(\w+)">/.test(view)
  && has(view, "let channel = tabs[0]?.dataset.ch ?? \"mobile\";"));

// ============ 三个通道必须与 sidecar 对齐 ============
const backend = new Set((appPy.match(/QR_TYPES = \{([^}]*)\}/)?.[1] ?? "")
  .split(",").map((s) => s.split(":")[0].trim().replace(/["']/g, "")).filter(Boolean));
const frontend = [...view.matchAll(/data-ch="([a-z]+)"/g)].map((m) => m[1]);
ok("通道: 前端三个 data-ch 都落在 sidecar QR_TYPES 里",
  frontend.length === 3 && frontend.every((c) => backend.has(c)),
  `前端 ${frontend.join("/")}　后端 ${[...backend].join("/")}`);

// ============ 交互与生命周期 ============
ok("换标签: 点击即重开二维码（void start()）", re(view, /void start\(\);/));
ok("换标签: 重复点当前档不重开（避免白烧一次上游请求 + 触发限流）",
  /if \(ch === channel\) return; \/\/ 重复点当前档不重开/.test(views));
ok("换标签: 选中态与 aria-selected 同步切换",
  re(view, /x\.classList\.toggle\("sel", on\);\s*x\.setAttribute\("aria-selected", String\(on\)\);/));
ok("换标签: 重开前先清掉旧轮询（两个通道的轮询不许串台）",
  re(view, /async function start\(\) \{\s*window\.clearInterval\(timer\);/));
ok("请求路径用当前通道（不是元素 value）",
  re(view, /api<any>\(`\/login\/qrcode\/\$\{channel\}`\)/)
  && re(view, /api\(`\/login\/qrcode\/\$\{channel\}\/status\?identifier=/));
ok("「重新生成」按钮仍在", re(view, /#refresh"\)!\.onclick = \(\) => void start\(\)/));
ok("回归: 视图返回的 cleanup 仍然停轮询（离页不留定时器）",
  re(view, /return \(\) => \{ stopped = true; window\.clearInterval\(timer\); \};/));
ok("回归: 登录成功仍跳回首页", has(view, 'location.href = "/index.html"'));

// ============ 版式与高亮态 ============
ok("css: 标签行在登录区居中", /\.login-wrap \.tag-tabs \{[^}]*justify-content:\s*center/.test(css));
const sel = css.match(/\.login-wrap \.tag\.sel \{([^}]*)\}/)?.[1] ?? "";
ok("css: 选中态走「软洗底 + accent 系前景 + accent 描边」（不用白字压裸 accent）",
  /background:[^;]*color-mix\([^;]*transparent/.test(sel)
  && /border-color:[^;]*var\(--cvg-accent/.test(sel)
  && /(?<![-\w])color:[^;]*var\(--ink\)/.test(sel));
ok("contrast: .login-wrap .tag.sel 已登记进 verify-highlight-contrast", has(contrast, '".login-wrap .tag.sel"'));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
