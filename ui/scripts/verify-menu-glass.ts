// Quaver — 浮层菜单的玻璃（[Style] MenuBlur，设置→外观→菜单毛玻璃）的护栏。
// 跑：  node scripts/verify-menu-glass.ts
//
// 背景（为什么要这个脚本）：七个浮层菜单原本各写一份 `background + border + box-shadow +
// backdrop-filter`，底片不透明度从 0.78 到 0.85 各不相同，还都挂在自己就带 backdrop-filter 的
// 祖先里（.player / 已模糊的 .np-bg）—— 结果就是「菜单看着根本没有模糊」。
// 改造 = 一组 --menu-* 令牌 + 一条共享规则 + 一棵真开关，并让 Sparkle 主题能接管/美化。
//
// 两头抓：
//   • 纯逻辑单测：sparkle/theme-menus.ts 的归属策略（缺省 = 主题接管；不成形声明按让位处理）。
//   • 源码级接线断言 + **反向自证**：令牌是唯一来源、七个菜单不再各写一份、开关三态接线、
//     关闭档不得退回 blur(0px)（那等于没关）、设置页与主题切换/插件启停都要重刷、
//     SDK 契约与两份文档同步。
// 反向断言（把「回归写法」当输入，确认筛选函数会返回 false）是防「断言自己写错、永远为真」
// —— 本仓库踩过一次 verify 脚本自毁（断言读源码文本做正则，被批量替换打坏后静默变绿）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { menuGlassPolicyOf } from "../src/sparkle/theme-menus.ts";
import { defaults } from "../electron/config.ts";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(join(UI, rel), "utf8");
/** 仓库根下的文件（vendor/Sparkle 的 SDK / 文档 / 市场示例插件） */
const srcVendor = (rel: string) => readFileSync(join(UI, "../vendor/Sparkle", rel), "utf8");
/** 取 [from, to) 之间的一段源码；找不到任一端就返回空串（下面每段都先自证非空）。 */
const between = (s: string, from: string, to: string, n = 6000) => {
  const i = s.indexOf(from);
  if (i < 0) return "";
  const j = s.indexOf(to, i);
  return j < 0 ? s.slice(i, i + n) : s.slice(i, j);
};

const css = src("src/style.css");
const menuGlass = src("src/lib/menu-glass.ts");
const themeMenus = src("src/sparkle/theme-menus.ts");
const views = src("src/views.ts");
const shell = src("src/shell.ts");
const prefs = src("src/lib/prefs.ts");
const config = src("src/lib/config.ts");
const registry = src("src/sparkle/registry.ts");
const host = src("src/sparkle/host.ts");
const playlistMenu = src("src/components/PlaylistMenu.ts");
const nowPlaying = src("src/components/NowPlaying.ts");
const sdkTypes = srcVendor("sdk/types.ts");
const guide = srcVendor("docs/plugin-author-guide.md");
const aurora = srcVendor("marketplace/aurora/index.ts");

/** 七个消费这套玻璃的菜单 */
const MENU_SELECTORS = [".ctx-menu", ".pb-qpop", ".pb-lpop", ".pb-volpop", ".tint-pop", ".np-menu", ".np-qinfo"];
const NO_COMMENT = /\/\*[\s\S]*?\*\//g;
const noComments = (s: string) => s.replace(NO_COMMENT, "");
/** 取某个选择器**自己那条**规则的规则体（`\n.sel {` 到下一个 `\n}`） */
const ruleOf = (s: string, sel: string) => {
  const i = s.indexOf(`\n${sel} {`);
  if (i < 0) return "";
  const j = s.indexOf("\n}", i);
  return j < 0 ? "" : s.slice(i, j);
};

// ——— 纯逻辑：主题 ⇄ 菜单外观的归属策略 ———
section("归属策略（纯逻辑）");
/** 造一个「只有 menus 不同」的主题；字段是第三方给的任意值，所以断言成 never 再传进去 */
const mkTheme = (menus?: unknown) =>
  ({ id: "t", name: "T", css: "", ...(menus === undefined ? {} : { menus }) }) as never;

eq("没启用主题 → 宿主的正常开关", menuGlassPolicyOf(null).mode, "host");
eq("不启用主题时 themeId 为 null", menuGlassPolicyOf(null).themeId, null);
eq("主题不声明 menus → 让位（主题自带菜单外观）", menuGlassPolicyOf(mkTheme()).mode, "off");
eq("声明 host → 宿主接管（用户那棵开关照常）", menuGlassPolicyOf(mkTheme({ mode: "host" })).mode, "host");
eq("mode 不认识 → 按让位处理（安全侧：宁可让主题自己画）", menuGlassPolicyOf(mkTheme({ mode: "wat" })).mode, "off");
eq("声明成空对象 → 同样让位（只有显式 host 才算交出去）", menuGlassPolicyOf(mkTheme({})).mode, "off");
eq("字段写成 true / 字符串这类不成形的值 → 让位，且不抛",
  [menuGlassPolicyOf(mkTheme(true)).mode, menuGlassPolicyOf(mkTheme("host")).mode, menuGlassPolicyOf(mkTheme(1)).mode],
  ["off", "off", "off"]);
eq("策略带回主题 id", menuGlassPolicyOf(mkTheme({ mode: "host" })).themeId, "t");
eq("策略模块零 ui 依赖（可在 node 里直接 import 做单测）",
  themeMenus.includes('from "@quaver/sparkle"') && !/from "\.\.?\//.test(noComments(themeMenus)), true);

// ——— CSS：令牌一处定义、七处消费 ———
section("CSS 令牌与共享规则");
const glass = between(css, "浮层菜单的玻璃（唯一来源", "* { box-sizing");
check("玻璃令牌段取得到（防失配让下面全绿）", glass.length > 400, String(glass.length));
check("模糊半径是令牌（不许退回写死值）", /--menu-filter: blur\(\d+px\) saturate\([\d.]+\);/.test(glass));
const surfaceAlpha = Number(/--menu-surface: rgba\(246, 246, 248, \.(\d+)\);/.exec(glass)?.[1] ?? NaN);
check("底片不透明度落在 0.6~0.7（≥0.7 时模糊被实色底片吃掉，是这次的病根之一）",
  surfaceAlpha >= 60 && surfaceAlpha <= 70, String(surfaceAlpha));
check("暗色主题另给一份表面/阴影/内高光", /html\[data-theme="dark"\] \{[^}]*--menu-surface:/.test(glass));
check("正在播放页另给一份深色表面（那一页恒为深色玻璃）",
  /\.np \{[^}]*--menu-surface:/.test(glass));
check("关闭档：模糊换 none（不是 blur(0px)）", /html\[data-menu-glass="off"\] \{[\s\S]*?--menu-filter: none;/.test(glass));
check("关闭档：底片换实色（不然关掉模糊后文字压不住背景）",
  /html\[data-menu-glass="off"\] \{[\s\S]*?--menu-surface: var\(--card\);/.test(glass));
check("关闭档：正在播放页那份深色表面也要顶掉（.np 自己声明过同一个变量）",
  /html\[data-menu-glass="off"\] \.np \{/.test(glass));
check("theme 档不写任何令牌（宿主让位，交给主题覆盖）", !/data-menu-glass="theme"/.test(css));

const sharedIdx = css.indexOf("浮层菜单的玻璃（共享规则）");
const shared = sharedIdx < 0 ? "" : css.slice(sharedIdx, sharedIdx + 900);
check("共享规则段取得到", shared.length > 200, String(shared.length));
check("七个菜单全在那条共享规则的选择器表里",
  MENU_SELECTORS.every((s) => shared.includes(s)), MENU_SELECTORS.filter((s) => !shared.includes(s)).join(","));
check("共享规则吃令牌：模糊", /backdrop-filter: var\(--menu-filter\);/.test(shared));
check("共享规则吃令牌：底片 / 描边 / 阴影 + 内高光",
  /background: var\(--menu-surface\);/.test(shared)
  && /border: 1px solid var\(--menu-line\);/.test(shared)
  && /box-shadow: var\(--menu-shadow\), inset 0 1px 0 var\(--menu-edge\);/.test(shared));

// —— 这一条是本次「菜单完全没有模糊」的真凶，必须钉死 ——
// lightningcss（Vite 8 的 CSS 压缩器）把同一逻辑属性的重复声明按后者优先折叠，它不认前缀；
// 于是 `backdrop-filter: X; -webkit-backdrop-filter: X;` 在产物里只剩后一条，而 Chromium
// **没有** -webkit-backdrop-filter 这个别名（Electron 44 二进制里连这个字符串都搜不到）——
// 整个应用的毛玻璃就这么静默失效了，而且只在构建产物里失效（dev 不压缩 → 两份都在 → 看着是对的）。
check("**源码里不许出现 -webkit-backdrop-filter**（前缀成对写法 = 产物里无前缀那份被折叠掉）",
  !noComments(css).includes("webkit-backdrop-filter"));
const prefixedPair = (s: string) => /backdrop-filter:[^;]+;\s*-webkit-backdrop-filter:/.test(s);
check("…反向：成对前缀写法会被逮住", prefixedPair("backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);"));
check("…当前源码确实没有成对写法（比对的是去注释后的源码 —— 顶部那段说明本身就写着这个反例）",
  !prefixedPair(noComments(css)));

// .player 曾自己带 backdrop-filter → 成了它上方三颗浮窗（音质/播放模式/音量）的 backdrop root，
// 而浮窗的盒子整个在条外 → 采样到空白 → 浮窗等于没有毛玻璃。玻璃挪到 ::before 才修得掉。
const playerRule = ruleOf(noComments(css), ".player");
check(".player 自己的规则不带 backdrop-filter（带了就是那三颗浮窗的 backdrop root）",
  playerRule.length > 0 && !playerRule.includes("backdrop-filter"), playerRule.replace(/\s+/g, " ").slice(0, 120));
const playerBefore = ruleOf(noComments(css), ".player::before");
check(".player 的玻璃挪到 ::before：铺满 + 圆角继承 + z-index:-1（压在内容之下、自身背景之上）",
  playerBefore.includes("inset: 0") && playerBefore.includes("border-radius: inherit")
  && playerBefore.includes("z-index: -1") && /backdrop-filter: blur\(26px\)/.test(playerBefore),
  playerBefore.replace(/\s+/g, " ").slice(0, 150));
check("…且 ::before 不吃指针（它铺满整条）", /\.player::before \{[\s\S]*?pointer-events: none/.test(css));

for (const sel of MENU_SELECTORS) {
  const body = ruleOf(css, sel);
  check(`${sel} 自己的规则不再各写一份玻璃（只留定位/尺寸/动画）`,
    body.length > 0 && !body.includes("backdrop-filter") && !body.includes("background:"), body.slice(0, 120));
}
check("旧的 --volpop 令牌已清干净（七处都转到了 --menu-surface）", !noComments(css).includes("--volpop"));

// 反向自证：某处菜单又自己写一份 backdrop-filter 必须被逮住
const dupGlass = (s: string) => MENU_SELECTORS.some((sel) => ruleOf(s, sel).includes("backdrop-filter"));
check("…反向：菜单又自己写一份 backdrop-filter 会被逮住", dupGlass("\n.pb-qpop {\n  backdrop-filter: blur(24px);\n}"));
check("…当前源码确实没有", !dupGlass(css));
const zeroBlur = (s: string) => /data-menu-glass="off"\][\s\S]{0,120}--menu-filter: blur\(0px\)/.test(s);
check("…反向：关闭档退回 blur(0px)（照样占一层 GPU 合成）会被逮住",
  zeroBlur('html[data-menu-glass="off"] {\n  --menu-filter: blur(0px);\n}'));
check("…当前关闭档用的是 none", !zeroBlur(css));

// ——— 渲染层：三态属性 + 设置页 ———
section("源码接线 · 渲染层");
check("菜单玻璃段取得到", /export function applyMenuGlass\(\)/.test(menuGlass));
check("写的是 <html data-menu-glass>（CSS 侧据此取值）", /dataset\.menuGlass/.test(menuGlass));
check("主题接管时让位：不写 on/off，改写 theme",
  /menuGlassPolicyOf\(sparkleActiveTheme\(\)\)\.mode === "off"[\s\S]{0,160}?dataset\.menuGlass = "theme"/.test(menuGlass));
check("开启档写 on", /dataset\.menuGlass = getMenuBlur\(\) \? "on" : "off"/.test(menuGlass));
check("boot 时订阅插件启停（注册表变化要重算归属）", /onSparkleChange\(applyMenuGlass\)/.test(menuGlass));
check("shell 启动时拉起这棵开关", /^\s*bootMenuGlass\(\);$/m.test(shell) && shell.includes('from "./lib/menu-glass"'));

const mgBlock = between(views, 'id="menu-glass-cards"', "</div>");
check("设置页分组取得到", mgBlock.length > 60, String(mgBlock.length));
check("开关两档齐全", mgBlock.includes('data-opt="on"') && mgBlock.includes('data-opt="off"'));
check("点档位写配置 + 立刻重算属性",
  /setMenuBlur\(b\.dataset\.opt === "on"\)/.test(views) && /setMenuBlur\([\s\S]{0,80}applyMenuGlass\(\)/.test(views));
check("主题接管时整组留在原位但禁用 + 写明由谁接管",
  /menuGlassCards\.querySelectorAll<HTMLButtonElement>\("\[data-opt\]"\)\.forEach\(\(b\) => \{ b\.disabled = locked; \}\)/.test(views)
  && views.includes("自带菜单外观，已接管"));
check("切主题后重算这一组", /paintBgPolicy\(\);[\s\S]{0,120}paintMenuGlassPolicy\(\)/.test(views));
check("插件启停（主题列表变化）也重算这一组",
  (views.match(/paintMenuGlassPolicy\(\)/g) ?? []).length >= 3, String((views.match(/paintMenuGlassPolicy\(\)/g) ?? []).length));
check("host 换/停主题后重算（否则停在上一套策略上）", /applyBackground\(\);\n\s*applyMenuGlass\(\)/.test(host));
check("提示里点明「看不到模糊先开背景」（默认配置下背景是关的，那才是看不出玻璃的主因）",
  views.includes("看不出模糊时，先把上面的「背景」打开"));

// ——— 配置三处 + Sparkle 契约 ———
section("源码接线 · 配置 / SDK / 宿主接入点");
eq("schema 有 Style.MenuBlur 且默认开", defaults()["Style.MenuBlur"], "True");
check("渲染层 FALLBACK 与 schema 同步（改一处要改两处）", config.includes('"Style.MenuBlur": "True",'));
check("prefs 的读法把 False/0/no 当关（手改 conf 写 no 也认）",
  /getMenuBlur\(\): boolean \{\s*return !\/\^\(false\|0\|no\)\$\/i\.test\(cfg\("Style\.MenuBlur", "True"\)\)/.test(prefs));
check("prefs 的写法落 True/False（与其余布尔项同一套）", /setMenuBlur\(v: boolean\)[\s\S]{0,120}"Style\.MenuBlur": v \? "True" : "False"/.test(prefs));

check("SDK 定义了 SparkleThemeMenus", sdkTypes.includes("export interface SparkleThemeMenus"));
check("SDK 的 SparkleTheme 带上了 menus 字段", /interface SparkleTheme \{[\s\S]*?menus\?: SparkleThemeMenus;/.test(sdkTypes));
check("SDK 写明了缺省语义（不声明 = 主题接管）", /缺省[^\n]*主题自带菜单外观/.test(sdkTypes));
check("SDK 定义了另外两处菜单的 ctx 类型",
  sdkTypes.includes("export interface SparklePlaylistMenuCtx") && sdkTypes.includes("export interface SparkleNpMenuCtx"));
check("SDK 的 ctx 暴露了这两个注册入口",
  sdkTypes.includes("registerPlaylistMenuItem(") && sdkTypes.includes("registerNowPlayingMenuItem("));

check("registry 登记/读取成套", ["sparkRegisterPlaylistMenuItem", "sparkRegisterNpMenuItem",
  "sparklePlaylistMenuItems", "sparkleNpMenuItems"].every((s) => registry.includes(s)));
check("registry 三处菜单项共用同一个求值器（不许各写一份 try/catch）",
  /function collectMenuItems</.test(registry) && (noComments(registry).match(/collectMenuItems\(/g) ?? []).length >= 3);
check("host 把两个入口接到 ctx 上",
  /registerPlaylistMenuItem: \(item\) => sparkRegisterPlaylistMenuItem\(pluginId, item\)/.test(host)
  && /registerNowPlayingMenuItem: \(item\) => sparkRegisterNpMenuItem\(pluginId, item\)/.test(host));
check("侧栏歌单菜单（自建/收藏）追加插件项", /items\.push\(\.\.\.sparklePlaylistMenuItems\(\{[\s\S]{0,160}kind: opts\.kind/.test(playlistMenu));
check("侧栏虚拟歌单（每日 30 首 / 我喜欢）也追加，且带上稳定 id",
  /items\.push\(\.\.\.sparklePlaylistMenuItems\(\{ id, title, kind: "virtual"/.test(playlistMenu)
  && /openVirtualPlaylistMenu\(e\.clientX, e\.clientY, v\.title, v\.fetch, a, v\.id\)/.test(shell));
check("正在播放页 ⋮ 菜单追加插件项（含 danger 语义）",
  /sparkleNpMenuItems\(\{ song: s \?\? null \}\)/.test(nowPlaying) && /classList\.add\("danger"\)/.test(nowPlaying));
check("⋮ 菜单的危险项有样式（否则插件标了 danger 也看不出来）", /\.np-menu-item\.danger \{/.test(css));

check("插件开发文档写了 menus 契约", guide.includes("浮层菜单的外观归谁管") && guide.includes('menus: { mode: "host" }'));
check("文档说明了三件事各自独立声明", guide.includes("各自独立声明"));
check("文档列了这套玻璃的两个新注册入口",
  guide.includes("registerPlaylistMenuItem") && guide.includes("registerNowPlayingMenuItem"));
check("市场示例里三种写法都在", /menus: \{ mode: "host" \}/.test(aurora) && /浮层菜单的外观归谁管/.test(aurora));

// 反向自证：让位这件事一旦被写没，必须能被逮住
const yieldsMenu = (s: string) => /dataset\.menuGlass = "theme"/.test(s);
check("…反向：主题接管时不写 theme 会被逮住", !yieldsMenu('root.dataset.menuGlass = getMenuBlur() ? "on" : "off";'));
check("…当前实现确实让位了", yieldsMenu(menuGlass));
const locksGroup = (s: string) => /menuGlassCards\.querySelectorAll<HTMLButtonElement>/.test(s);
check("…反向：主题接管却不锁设置项会被逮住", !locksGroup("menuGlassCards.querySelectorAll('[data-opt]');"));
check("…当前实现确实锁了", locksGroup(views));

// ——— 产物级：用户跑的就是这份 ————
// 上面全是源码断言，但这次的病恰恰只出现在**构建产物**里（压缩器折叠前缀）。所以只要 dist
// 在，就直接验产物 —— 这是唯一能挡住「源码看着对、构建完没有模糊」的一层。
section("产物级（dist 存在时）");
{
  let built = "";
  try {
    const dir = join(UI, "dist/assets");
    for (const f of readdirSync(dir)) if (f.endsWith(".css")) built += readFileSync(join(dir, f), "utf8");
  } catch { /* 没跑过 build */ }
  if (!built) {
    console.log("  ⏭️ dist/assets 下没有 CSS（本机没跑过 build）—— 跳过产物级断言");
  } else {
    // 压缩器会自己补 -webkit- 前缀（且补在**前**面，无前缀那份在后 = 后者生效），这没问题；
    // 出问题的是反过来「只剩带前缀那份」——所以要卡的是「无前缀那份必须在」+「顺序对」。
    check("产物里有**无前缀**的 backdrop-filter（没有 = 全部毛玻璃失效）",
      /(?<!-)backdrop-filter:/.test(built));
    check("带前缀那份若在，必须排在同值的无前缀之前（顺序反了 = 生效的是 Chromium 不认的那条）",
      !built.includes("-webkit-backdrop-filter") || /-webkit-backdrop-filter:([^;}]+);\s*backdrop-filter:\1/.test(built));
    check("产物里的菜单玻璃走令牌 var(--menu-filter)",
      /(?<!-)backdrop-filter:var\(--menu-filter\)/.test(built));
    check("产物里的 .player 玻璃在 :before 上，.player 自身不带 backdrop-filter",
      /\.player:before\{[^}]*(?<!-)\bbackdrop-filter:blur\(26px\)/.test(built)
      && !/\.player\{[^}]*backdrop-filter/.test(built));
    check("产物里的关闭档是 none（不是 blur(0px)）", /--menu-filter:none/.test(built));
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-menu-glass: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
