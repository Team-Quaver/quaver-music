// 侧栏（主菜单栏）缩回/展开 + 设置齿轮图标的静态断言
//
// 这个改动有四处必须同时成立，错一处从界面上很难一眼看出来：
//   ① 状态真相只有一份 —— quaver.conf 的 Window.SidebarCollapsed，外观挂在 body.side-collapsed
//      （与 applyDecor 的 body.ssd 同一套路）。侧栏是 bootShell 才注入的，CSS 只按 body 状态描述，
//      模块之间不必互相找节点；换页面/换主题都不会把状态丢在某个被重建的节点上。
//   ② 收字必须是「可过渡的隐藏」—— 用 max-width→0 + 淡出，不能用 display:none
//      （用了文字会瞬间消失，宽度还在动 → 看着像闪了一下）。
//   ③ transition 是整体覆盖属性：.nav a / .pl 自己已有声明（背景/按压缩放），
//      gap/padding 必须并进那一条，单独写一条会被顶掉（宽度收窄了却卡着不动）。
//   ④ 缩态只剩图标 → 每个导航项/歌单项都得有 title，否则鼠标悬停是唯一认字途径这件事就没了。
//
// 用法：node scripts/verify-sidebar.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const shell = read("src/shell.ts");
const prefs = read("src/lib/prefs.ts");
const main = read("src/main.ts");
const conf = read("electron/config.mjs");
const confTs = read("src/lib/config.ts");
const css = read("src/style.css");

let fails = 0, checks = 0;
const ok = (name, cond, note = "") => {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};
// 抓某条规则的大括号内容（压成单行，方便 includes 断言）
const ruleBody = (rx) => (css.match(rx)?.[1] ?? "").replace(/\s+/g, " ").trim();

// ============ ① 图标：设置 = 齿轮；缩回/展开 = 双 chevron ============
const settingsIco = shell.match(/^\s*settings:\s*\n?\s*'([^']+)'/m)?.[1] ?? "";
ok("设置图标是齿轮（中心孔 + 齿形外圈 path）",
  settingsIco.includes('circle cx="12" cy="12" r="3.1"') && /a1\.65 1\.65 0 0 0 \.33 1\.82/.test(settingsIco));
ok("设置图标不再是旧的亮度/太阳图形（八条辐射线）",
  !/M12 2\.8v3/.test(settingsIco) && !/M2\.8 12h3/.test(settingsIco));
ok("齿轮沿用同一套线性图标口径（24 网格 / currentColor / fill:none）",
  settingsIco.includes('viewBox="0 0 24 24"') && settingsIco.includes("currentColor") && settingsIco.includes("fill=\"none\""));
const collapseIco = shell.match(/^\s*collapse:\s*\n?\s*'([^']+)'/m)?.[1] ?? "";
ok("缩回/展开图标存在（双 chevron，方向由 CSS 翻转）",
  collapseIco.includes("viewBox=\"0 0 24 24\"") && collapseIco.split("M").length - 1 === 2);

// ============ ② 侧栏结构：底部按钮排 + 缩回按钮 ============
ok("设置按钮移进底部按钮排 .side-foot，并保留语义类 settings",
  /<div class="side-foot">[\s\S]{0,400}class="side-btn settings"[\s\S]{0,200}href="#\/settings"/.test(shell));
ok("缩回/展开按钮是 <button> 且带 id=side-collapse（不是 <a>，它不导航）",
  /<button class="side-btn" id="side-collapse" type="button"/.test(shell));
ok("按钮初始 title/aria 是「缩回侧栏」（默认展开态）",
  /id="side-collapse"[^>]*title="缩回侧栏"[^>]*aria-label="缩回侧栏"/.test(shell));
ok("导航项带 title（缩态只剩图标时靠它认字）",
  /data-route="\$\{n\.path\.slice\(1\) \|\| "\/"\}" title="\$\{n\.label\}"/.test(shell));
ok("歌单项带 title（同上；收藏的歌单把创建者也缀上）",
  /const title = String\(x\.title \?\? "歌单"\);[\s\S]{0,120}a\.title = sub \? `\$\{title\} · \$\{sub\}` : title;/.test(shell));

// ============ ③ 状态源：配置 + body class 一份真相 ============
ok("prefs 暴露 get/apply/set 三个入口",
  /export function getSidebarCollapsed\(\): boolean/.test(prefs)
  && /export function applySidebar\(\)/.test(prefs)
  && /export function setSidebarCollapsed\(v: boolean\)/.test(prefs));
ok("读的是配置键 Window.SidebarCollapsed（不是 localStorage 私货）",
  /cfg\("Window\.SidebarCollapsed", "False"\)/.test(prefs));
ok("外观只由 body.side-collapsed 驱动（与 applyDecor 的 body.ssd 同一套路）",
  /document\.body\.classList\.toggle\("side-collapsed", getSidebarCollapsed\(\)\)/.test(prefs));
ok("set 先落盘再应用（顺序反了会写出一个界面与配置不符的状态）",
  /cfgSet\(\{ "Window\.SidebarCollapsed": v \? "True" : "False" \}\);\s*applySidebar\(\);/.test(prefs));
ok("main.ts 在 bootShell 之前 applySidebar（壳层一注入就是终态，不会先展开再收）",
  main.indexOf("applySidebar();") > 0 && main.indexOf("applySidebar();") < main.indexOf("bootShell();"));
ok("壳层点击只做「读当前值取反」并同步按钮文案，不自己维护第二份状态",
  /setSidebarCollapsed\(!getSidebarCollapsed\(\)\);\s*syncCollapseBtn\(\);/.test(shell));
ok("按钮文案/aria 随状态走（缩态下提示不能还是「缩回侧栏」）",
  /const label = off \? "展开侧栏" : "缩回侧栏";/.test(shell)
  && /collapseBtn\.setAttribute\("aria-expanded", String\(!off\)\)/.test(shell));
ok("切换不动 DOM 结构（侧栏是常驻节点，只切 class）",
  !/collapseBtn\.addEventListener[\s\S]{0,300}innerHTML/.test(shell));

// ============ ④ 配置三处对齐 ============
ok("electron/config.mjs：SCHEMA 有 Window.SidebarCollapsed，默认 False",
  /key: "SidebarCollapsed",\s*def: "False"/.test(conf));
ok("config.mjs 收布尔值域（手改配置写脏值会被拒并回落默认）",
  /key: "SidebarCollapsed",[\s\S]{0,400}valid: \(v\) => \["True", "False", "true", "false", "1", "0", "yes", "no"\]\.includes\(v\)/.test(conf));
ok("config.ts：FALLBACK 补齐同一键（浏览器 dev 不与桌面端分叉）",
  /"Window\.SidebarCollapsed": "False"/.test(confTs));

// ============ ⑤ CSS：宽度、收字、过渡 ============
const colSide = ruleBody(/body\.side-collapsed \.sidebar \{([^}]*)\}/);
const colAvatar = ruleBody(/body\.side-collapsed \.avatar \{([^}]*)\}/);
const colNav = ruleBody(/body\.side-collapsed \.nav a \{([^}]*)\}/);
const colPl = ruleBody(/body\.side-collapsed \.pl \{([^}]*)\}/);
const colGroup = ruleBody(/body\.side-collapsed \.pl-group \{([^}]*)\}/);
const colEmpty = ruleBody(/body\.side-collapsed \.pl-empty \{([^}]*)\}/);
const colFoot = ruleBody(/body\.side-collapsed \.side-foot \{([^}]*)\}/);
const colIcon = ruleBody(/body\.side-collapsed \.side-btn svg \{([^}]*)\}/);

ok("缩态宽度 64px 且收窄水平内距", /flex-basis: 64px/.test(colSide) && /padding: 14px 8px/.test(colSide));
const basis = Number(colSide.match(/flex-basis:\s*(\d+)px/)?.[1]);
const padX = Number(colSide.match(/padding:\s*\d+px\s+(\d+)px/)?.[1]) * 2;
ok(`缩态可用宽 ${basis - padX}px 容得下头像 38px / 歌单封面 32px`,
  basis - padX >= 38 && /width: 38px/.test(colAvatar));

ok("缩态保留导航图标：条目改居中排布，不隐藏",
  /justify-content: center/.test(colNav) && /gap: 0/.test(colNav) && !/display: none/.test(colNav));
ok("缩态保留歌单封面：条目改居中排布，不隐藏",
  /justify-content: center/.test(colPl) && !/display: none/.test(colPl));
ok("缩态保留底部两颗按钮：竖排居中，不隐藏",
  /flex-direction: column/.test(colFoot) && !/display: none/.test(css.match(/body\.side-collapsed \.side-foot \{[^}]*\}/)?.[0] ?? ""));
ok("缩回图标翻转 180°（同一个图标表达两种意图）", /rotate\(180deg\)/.test(colIcon));

const hideSel = css.match(/(body\.side-collapsed \.user-meta,[\s\S]*?)\{/)?.[1] ?? "";
const hideBody = ruleBody(/body\.side-collapsed \.user-meta,[\s\S]*?\{([^}]*)\}/);
ok("收字选择器覆盖昵称/徽章、导航文字、歌单名三处",
  ["body.side-collapsed .user-meta", "body.side-collapsed .nav a span", "body.side-collapsed .pname"]
    .every((s) => hideSel.includes(s)));
ok("收字用 max-width→0 + 淡出（可过渡）", /max-width: 0/.test(hideBody) && /opacity: 0/.test(hideBody));
ok("收字不用 display:none（用了文字会瞬间消失、宽度还在动 = 闪一下）",
  !/display:\s*none/.test(hideBody) && !/body\.side-collapsed \.pname[^{]*\{[^}]*display:\s*none/.test(css));
ok("分组标题退化成一条虚线分隔（两团歌单在缩态仍分得开）",
  /height: 0/.test(colGroup) && /border-top: 1px dashed/.test(colGroup));
const colGroupFirst = ruleBody(/body\.side-collapsed \.pl-group:first-child \{([^}]*)\}/);
ok("缩态第一团分组不画线（上方 .sep 已是导航/歌单的分界，两条虚线会贴在一起）",
  /border-top: 0/.test(colGroupFirst) && /margin-top: 0/.test(colGroupFirst));
ok("缩态保留 .sep（导航与歌单区的分界不能跟着一起丢）",
  /body\.side-collapsed \.sep \{([^}]*)\}/.test(css) && /margin: 4px 12px/.test(ruleBody(/body\.side-collapsed \.sep \{([^}]*)\}/)));
ok("空态文案整体隐去（「登录后可见歌单」在 48px 里排不下，不给半截字）",
  /font-size: 0/.test(colEmpty) && /overflow: hidden/.test(colEmpty));

// 过渡：宽度类走同一条曲线；.nav a / .pl 的 gap/padding 必须并进它们自己的声明
const mergeBlock = css.match(/\.sidebar, \.user, \.user-meta[\s\S]*?\{([^}]*)\}/)?.[1].replace(/\s+/g, " ") ?? "";
ok("侧栏本体的过渡包含 flex-basis / padding（且与全站同一条曲线）",
  /flex-basis \.24s cubic-bezier\(\.22,\.61,\.36,1\)/.test(mergeBlock) && /padding \.24s/.test(mergeBlock));
ok("合并块含 max-width 与更短的 opacity（先淡出、后收窄）",
  /max-width \.24s/.test(mergeBlock) && /opacity \.12s/.test(mergeBlock));
const navDecl = ruleBody(/\.nav a \{([^}]*)\}/);
const plDecl = ruleBody(/\.pl \{([^}]*)\}/);
ok(".nav a 自己的 transition 里带上了 gap/padding（单独写一条会被整体覆盖顶掉）",
  /transition: background \.14s, transform \.1s ease,[\s\S]*gap \.24s/.test(navDecl) && /padding \.24s/.test(navDecl));
ok(".pl 同上", /gap \.24s/.test(plDecl) && /padding \.24s/.test(plDecl));
ok("缩态不用 display:none 收整栏（用了就没有展开动画）",
  !/body\.side-collapsed \.sidebar \{[^}]*display:\s*none/.test(css));
ok("max-width 抓手有初值（none→0 不参与插值，必须在展开态给死值）",
  /\.user-meta \{[^}]*max-width: 160px/.test(css.replace(/\s+/g, " "))
  && /\.pname \{[^}]*max-width: 200px/.test(css.replace(/\s+/g, " "))
  && /\.nav a span \{[^}]*max-width: 140px/.test(css.replace(/\s+/g, " ")));

// 减弱动效：直接跳终态
const prm = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
ok("减弱动效下侧栏成员禁用过渡（直接跳终态）",
  /transition: none/.test(prm) && /\.side-btn svg/.test(prm) && /\.user-meta/.test(prm));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
