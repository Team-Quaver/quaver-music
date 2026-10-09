// Quaver — 界面高亮色（tint）功能的护栏。跑：  node scripts/verify-tint.ts
//
// 两头抓：
//   • 纯逻辑：颜色字面量与三个模式之间的换算（lib/color.ts）——HEX 解析/规范化、
//     HSL 与 CMYK 的往返（8bit 量化容差内）、边界（纯黑、越界夹紧、半截输入不合法）。
//   • 源码级接线：三档档位卡与选择器的 DOM 结构、四个编辑通道（HSL/CMYK/RGB + HEX）、
//     浮窗能藏住、染色归 lib/tint.ts（shell 不再自己写 --cvg-accent）、schema/FALLBACK 同步。
//
// 反向断言（把「回归写法」当输入，确认断言会红）是防「断言自己写错、永远为真」——
// 本仓库踩过一次 verify 脚本自毁（正则被批量替换打坏后静默变绿）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cmyk2rgb, hsl2rgb, isHexColor, parseHex, rgb2cmyk, rgb2hsl, toHex } from "../src/lib/color.ts";
import { defaults, schemaIndex } from "../electron/config.ts";
import { pickPreset, resolvePresetColor, sparkTintChoice, tintPolicyOf, validPresets } from "../src/sparkle/theme-tint.ts";

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
/** 仓库根下的文件（vendor/Sparkle 的 SDK、文档、市场示例插件） */
const srcVendor = (rel: string) => readFileSync(join(UI, "..", rel), "utf8");
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ================= 颜色字面量 =================
section("颜色字面量（HEX ⇄ RGB）");
eq("#ffffff → 白", parseHex("#ffffff"), { r: 255, g: 255, b: 255 });
eq("#fff 短写展开（每位翻倍）", parseHex("#fff"), { r: 255, g: 255, b: 255 });
eq("省略 # 也认（输入框里正在敲）", parseHex("19c2d8"), { r: 25, g: 194, b: 216 });
eq("大写认", parseHex("#19C2D8"), { r: 25, g: 194, b: 216 });
eq("前后空白认", parseHex("  #19c2d8  "), { r: 25, g: 194, b: 216 });
eq("五位不合法", parseHex("#12345"), null);
eq("空串不合法（半截输入一律拒绝，不猜）", parseHex(""), null);
eq("非十六进制字符不合法", parseHex("#gggggg"), null);
eq("裸色名不合法", parseHex("cyan"), null);
eq("rgb() 函数式不合法", parseHex("rgb(25,194,216)"), null);
eq("toHex 逐通道补零", toHex({ r: 1, g: 2, b: 3 }), "#010203");
eq("toHex 夹紧越界并取整", toHex({ r: 300, g: -5, b: 25.6 }), "#ff001a");
eq("真相规范化：parseHex → toHex 收敛成小写 6 位", toHex(parseHex("#0FF")!), "#00ffff");
check("isHexColor 与 parseHex 同判据", isHexColor("#19c2d8") && !isHexColor("cyan") && !isHexColor(""));

// ================= HSL =================
section("HSL（h 0..360，s/l 0..1）");
for (const [h, s, l] of [[0, 1, 0.5], [120, 1, 0.5], [240, 1, 0.5], [188, 0.79, 0.47], [60, 0.5, 0.8], [300, 0.3, 0.2]]) {
  const back = rgb2hsl(hsl2rgb(h, s, l));
  check(`hsl(${h}, ${s}, ${l}) 往返`, near(back.h, h, 1.5) && near(back.s, s, 0.02) && near(back.l, l, 0.02),
    `→ h${back.h.toFixed(1)} s${back.s.toFixed(3)} l${back.l.toFixed(3)}`);
}
eq("纯灰（无彩度）色相归 0", rgb2hsl({ r: 128, g: 128, b: 128 }).s, 0);
eq("默认青的背景色 r=25 g=194 b=216 的色相在青区", Math.round(rgb2hsl({ r: 25, g: 194, b: 216 }).h), 187);

// ================= CMYK =================
section("CMYK（四通道 0..1）");
for (const c of [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, { r: 25, g: 194, b: 216 }, { r: 200, g: 30, b: 90 }, { r: 128, g: 128, b: 128 }]) {
  const back = cmyk2rgb(rgb2cmyk(c));
  check(`rgb(${c.r},${c.g},${c.b}) 往返`, near(back.r, c.r, 1) && near(back.g, c.g, 1) && near(back.b, c.b, 1), JSON.stringify(back));
}
eq("纯黑不走 0/0 除法（按约定全 0 + K=1）", rgb2cmyk({ r: 0, g: 0, b: 0 }), { c: 0, m: 0, y: 0, k: 1 });
eq("纯白 K=0 且其余全 0", rgb2cmyk({ r: 255, g: 255, b: 255 }), { c: 0, m: 0, y: 0, k: 0 });
eq("越界通道被夹紧（手改 / 输入框越界）", cmyk2rgb({ c: 2, m: -1, y: 0.5, k: 0 }), { r: 0, g: 255, b: 128 });
check("NaN 通道当 0（不把 NaN 流进 CSS）", JSON.stringify(cmyk2rgb({ c: NaN, m: 0, y: 0, k: 0 })) === JSON.stringify({ r: 255, g: 255, b: 255 }));

// ================= schema / 默认值 =================
section("schema 与默认值");
const idx = schemaIndex();
eq("三档默认青色（不跟封面跑）", defaults()["Style.Tint"], "default");
eq("自定义色默认 = 主题青色", defaults()["Style.TintColor"], "#19c2d8");
check("Style.Tint / Style.TintColor 都在 schema 里", "Style.Tint" in idx && "Style.TintColor" in idx);
const tintValid = idx["Style.Tint"].valid;
const hexValid = idx["Style.TintColor"].valid;
check("档位值域四档放行（default/cover/system/custom）", ["default", "cover", "system", "custom"].every((v) => tintValid(v)));
check("档位值域收得住（大小写 / 空 / 未知值）", !tintValid("Default") && !tintValid("") && !tintValid("random"));
check("颜色值域收得住：裸色名 / rgb() / 空串一律不合法（这个值会进 CSS 变量）",
  !hexValid("cyan") && !hexValid("rgb(0,0,0)") && !hexValid("") && !hexValid("var(--x)"));
check("颜色值域放行 #rrggbb 与 #rgb（大小写皆可）", hexValid("#19c2d8") && hexValid("#19C2D8") && hexValid("#0ff"));
// 两侧判据交叉：渲染层写盘用的 toHex 结果，必须一定过 schema 校验（否则手改的值会被静默丢弃）
check("渲染层 toHex 的产出一定过 schema 校验",
  [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, { r: 25, g: 194, b: 216 }, { r: 1, g: 2, b: 3 }]
    .every((c) => hexValid(toHex(c))));
check("渲染层 FALLBACK 与 schema 同步（改一处要改两处）",
  ['"Style.Tint": "default"', '"Style.TintColor": "#19c2d8"'].every((line) => src("src/lib/config.ts").includes(line)));

// ================= 源码接线 · 渲染层 =================
section("源码接线 · 渲染层");
const views = src("src/views.ts");
const prefs = src("src/lib/prefs.ts");
const tint = src("src/lib/tint.ts");
const shell = src("src/shell.ts");
const css = src("src/style.css");

// 高亮颜色分组：从 id="tint-cards" 到下一个注释块（Sparkle 主题）之间就是这一组
const tintBlock = /id="tint-cards"([\s\S]*?)<!-- Sparkle 主题/.exec(views)?.[1] ?? "";
check("高亮颜色分组能取到（防正则失配让下面全绿）", tintBlock.length > 400, String(tintBlock.length));
check("四档卡片齐全（含「系统强调色」）", ["default", "cover", "system", "custom"].every((m) => tintBlock.includes(`data-opt="${m}"`)), tintBlock.replace(/\s+/g, " ").slice(0, 200));
check("色块按钮就在「自定义颜色」卡旁边（同一个定位锚里）",
  tintBlock.includes('id="tint-chip"') && tintBlock.indexOf('data-opt="custom"') < tintBlock.indexOf('id="tint-chip"'));
check("选择器浮窗在同一锚点内（absolute 定位挂它）",
  tintBlock.includes('id="tint-slot"') && tintBlock.indexOf('id="tint-slot"') < tintBlock.indexOf('id="tint-pop"'));
check("选择器浮窗默认收起（hidden 起步）", /id="tint-pop"[^>]*hidden/.test(tintBlock));
check("可缩回：浮窗自带「收起」按钮", tintBlock.includes('id="tint-fold"') && /收起/.test(tintBlock));
check("三个颜色模式 tab 齐全", ["hsl", "cmyk", "rgb"].every((m) => tintBlock.includes(`data-mode="${m}"`)));
check("HEX 输入框常驻（跨模式都能直接填）", tintBlock.includes('id="tint-hex"') && /HEX/.test(tintBlock));
check("有实时预览（色块 + HEX 码）", tintBlock.includes('id="tint-swatch"') && tintBlock.includes('id="tint-code"'));
check("有色相条（不看数字也能调）", tintBlock.includes('id="tint-hue"'));

check("点「自定义颜色」就地弹出选择器", views.includes('if (next === "custom") popOpen = true'));
check("色块按钮切换展开/收起", /tintChip\.onclick = \(\) => \{ setPopOpen\(!popOpen\); \}/.test(views));
check("收起按钮收起浮窗", /tintFold\.onclick = \(\) => \{ setPopOpen\(false\); \}/.test(views));
// 这两条故意用「宽松尾部」：主题接管（tintPolicy().mode）也是不给开 / 不显色块的条件之一，
// 断言写死整行会在加条件时误红；但少掉档位判定又必须能红 —— 所以两段关键字都卡住。
check("非自定义档不给开（面板编的就是自定义色）", /popOpen = open && [^\n]*getTintMode\(\) === "custom"/.test(views));
check("色块只在自定义档出现", /tintChip\.hidden = [^\n]*mode !== "custom"/.test(views));
check("浮窗显隐跟着 popOpen", views.includes("tintPop.hidden = !popOpen"));
check("切档位立刻重写 CSS 变量（封面档还会去取当前曲封面）", /setTintMode\(next\);\s*\n\s*applyTint\(\);/.test(views));

check("四个编辑通道都接上了纯函数", ["hsl2rgb(", "rgb2hsl(", "cmyk2rgb(", "rgb2cmyk("].every((f) => views.includes(f)));
check("HEX 通道只在解析得动时才改色（半截输入不落盘）", /const c = parseHex\(tintHex\.value\);\s*\n\s*if \(c\) commitColor\(c\);/.test(views));
check("写色一次做齐：落盘 + 即时生效 + 刷新显示",
  /setTintColor\(toHex\(tintRgb\)\);\s*\n\s*applyTint\(\);/.test(views));
check("通道输入是逐字符的（input 事件，不是 change）", views.includes('tintFields.addEventListener("input"'));
check("正在编辑的框不被回填打断", views.includes("if (el && document.activeElement !== el) el.value"));
check("色相条拖动时用拖动值回填滑块（免得往返抖动）", views.includes("paintColor(hue)"));
check("模式切换只重建通道行（不重渲染整页）", /colorMode = b\.dataset\.mode as ColorMode; renderFields\(\);/.test(views));

check("prefs 里默认色与 schema 默认同值", prefs.includes('export const TINT_DEFAULT_COLOR = "#19c2d8";'));
check("prefs 的档位白名单是四档（含 system）",
  /const TINT_MODES: readonly string\[\] = \["default", "cover", "system", "custom"\]/.test(prefs));
check("prefs 的 setTintColor 解析不动就不写盘", /if \(!c\) return;/.test(prefs));
check("prefs 的高频写走合并落盘（拖色相条/连打数字）", /cfgSetSoon\(\{ "Style\.TintColor": toHex\(c\) \}/.test(prefs));

// ——— 染色归 tint 模块 ———
section("源码接线 · 高亮色模块");
check("tint.ts 提供 bootTint", /export function bootTint\(\)/.test(tint));
check("启动时先应用一次（不等播放事件）", /player\.on\(applyTint\);[\s\S]{0,300}\n\s*applyTint\(\);/.test(tint));
check("写的就是那两个变量", tint.includes('setProperty("--cvg-accent"') && tint.includes('setProperty("--cvg-glow"'));
check("无色时移除变量（CSS 回落主题色）而非写死灰",
  /TINT_VARS = \[[^\]]*"--cvg-accent", "--cvg-glow"/.test(tint)
  && /for \(const v of TINT_VARS\) root\.style\.removeProperty\(v\)/.test(tint));
check("默认档 = 固定青色常量", /mode === "custom" \? getTintColor\(\) : TINT_DEFAULT_COLOR/.test(tint));
check("封面档走封面提色", /extractCoverColor\(pic\)/.test(tint));
check("离开封面档作废在途取色（否则回调会把颜色写回来）", /coverPic = ""; \/\/ 离开封面档/.test(tint));
check("封面档的空曲目明确回无色（不留在上一档的颜色上）", /if \(!pic\) \{\s*\n\s*\/\/[^\n]*\n\s*coverPic = "";\s*\n\s*paint\(null\);/.test(tint));
check("同曲重复触发不重取（指纹短路）", tint.includes("if (pic === coverPic) return;"));

check("shell 拉起 tint 模块", /^\s*bootTint\(\);$/m.test(shell));
check("shell 不再自己写 --cvg-accent（染色归 tint.ts）", !shell.includes('setProperty("--cvg-accent"'));
check("shell 不再自己取封面提色", !shell.includes("extractCoverColor") && !shell.includes("applyCoverTint"));

// ——— CSS ———
section("源码接线 · 样式");
const blockOf = (sel) => {
  const m = css.match(new RegExp(sel.replace(/[.#[\]="]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : null;
};
const popBlock = blockOf(".tint-pop");
check("浮窗样式取得到（取不到就是下面的断言在骗人）", typeof popBlock === "string" && popBlock.includes("position"), String(popBlock).slice(0, 80));
check("浮窗是绝对定位的浮层（不占版面、往卡片旁边弹）", /position:\s*absolute/.test(popBlock ?? ""));
check("浮窗藏得住：显式 [hidden] override（作者样式压过 UA 的 [hidden]）",
  css.includes(".tint-pop[hidden] { display: none; }"));
check("锚点 relative（浮窗以它为基准）", /\.tint-slot \{[^}]*position:\s*relative/.test(css));
check("色块与色相条的样式在位", css.includes(".tint-chip__sw") && css.includes(".tint-hue::-webkit-slider-thumb"));
check("模式 tab 的选中态用高亮色（跟随 tint 自己）", /\.tint-mode\.sel \{[^}]*var\(--cvg-accent/.test(css));
// 数字框的通用规则别把浮窗里的输入打成方块（.set-row__ctrl input 只在那一行内生效，这里另给一套）
check("浮窗内的输入有自己的一套（不靠 .set-row__ctrl）", /\.tint-fields \.tint-field input, \.tint-hex-row input \{/.test(css));

// —— 系统强调色（第四档 + presets 的 "system" 哨兵）———
section("源码接线 · 系统强调色");
const accentLib = src("src/lib/accent.ts");
check("tint.ts 从 lib/accent 取系统强调色（探测在主进程 electron/accent.ts，经 /api/accent）",
  tint.includes('from "./accent"') && tint.includes("currentAccent()"));
check("系统档开着强调色轮询（换桌面配色自动跟随），离开该档停表",
  /mode === "system"[\s\S]{0,200}syncAccentWatch\(true\)/.test(tint)
  && /syncAccentWatch\(false\);\s*\n\s*const pic = player\.current/.test(tint));
check("系统档读不到时回落默认青色（不停在上一档的颜色上）",
  /parseHex\(currentAccent\(\)\?\.color \?\? ""\) \?\? parseHex\(TINT_DEFAULT_COLOR\)/.test(tint));
check("哨兵方案读不到系统色时回落第一套非哨兵方案",
  /policy\.presets\.find\(\(p\) => p\.color !== "system"\)/.test(tint));
check("tint.ts 引用 theme-tint 的 resolvePresetColor（哨兵值的解析只有一份）",
  tint.includes("resolvePresetColor("));
check("accent 轮询只在用得上时开（不养常驻定时器）",
  /function syncAccentWatch\(wanted: boolean\)/.test(tint)
  && /if \(!listeners\.size && timer\)/.test(accentLib));
check("views 的第四档卡就在封面档后面（顺序 = 用户读到文案的顺序）",
  tintBlock.indexOf('data-opt="cover"') > -1
  && tintBlock.indexOf('data-opt="system"') > tintBlock.indexOf('data-opt="cover"')
  && tintBlock.indexOf('data-opt="system"') < tintBlock.indexOf('data-opt="custom"'));
check("views 的系统档提示把读到的来源/色值说给用户听",
  views.includes("已读到") && views.includes("暂时没读到"));
check("views 的哨兵方案卡：读到系统色上真色，没读到用占位色块",
  views.includes("TINT_PRESET_SYSTEM") && views.includes('class="sw sw-accent"'));
check("views 补拉一次有防自旋（拉不到不重画循环）",
  /let accentProbed = false/.test(views) && /if \(accentProbed \|\| currentAccent\(\)\?\.color\) return;/.test(views));
check("css 有系统强调色的占位色块", css.includes(".sw-accent"));

section("方案 color 的哨兵值（纯逻辑）");
eq("哨兵方案通过校验（color:\"system\"）",
  validPresets([{ id: "sys", label: "S", color: "system" }]), [{ id: "sys", label: "S", color: "system" }]);
eq("resolvePresetColor：普通字面量规范化成 6 位", resolvePresetColor("#0FF", null), "#00ffff");
eq("resolvePresetColor：哨兵 + 有系统色 → 系统色", resolvePresetColor("system", "#3584e4"), "#3584e4");
eq("resolvePresetColor：哨兵 + 没系统色 → null（调用方回落）", resolvePresetColor("system", null), null);
eq("resolvePresetColor：非法色 → null（双保险）", resolvePresetColor("red", "#ffffff"), null);

// ================= 反向自证 =================
section("反向自证（回归写法必须能被逮住）");
const shellOwnsTint = (s) => /applyCoverTint|setProperty\("--cvg-accent"/.test(s);
check("…反向：shell 又自己写 --cvg-accent 会被逮住", shellOwnsTint('root.style.setProperty("--cvg-accent", c.accent);'));
check("…当前 shell 确实没有", !shellOwnsTint(shell));

const popHides = (s) => s.includes(".tint-pop[hidden] { display: none; }");
check("…反向：少写 [hidden] override 会被逮住", !popHides(".tint-pop[hidden] { opacity: 0; }"));
check("…当前 CSS 里确实有", popHides(css));

const hexGuard = (s) => /if \(c\) commitColor\(c\);/.test(s);
check("…反向：HEX 通道不做合法性判断会被逮住", !hexGuard("commitColor(parseHex(tintHex.value));"));
check("…当前源码里确实有", hexGuard(views));

const popAlwaysOpen = (s) => /popOpen = open;/.test(s);
check("…反向：非自定义档也允许展开（面板编的是自定义色）会被逮住", popAlwaysOpen("const setPopOpen = (open) => { popOpen = open; };"));
check("…当前实现带档位判定", !popAlwaysOpen(views));

// 值域是字符串白名单实现的：把「什么都收」这种回归写法当输入，确认上面的断言确实会红
const looseValid = (_v: string) => true;
check("…反向：值域松成「什么都收」会被逮住", !(looseValid("nope") === false));
check("…当前值域收得住未知档位", tintValid("nope") === false);

// ——— 进度条（曾经自己跟封面跑，绕过了本设置）———
section("源码接线 · 进度条与歌词高亮");
const bar = src("src/components/PlayerBar.ts");
check("tint.ts 用 toBarColors 派生进度条色对（同源色、另一套亮度）", /const bar = toBarColors\(rgb\)/.test(tint));
check("tint.ts 写进度条的两个变量",
  /setProperty\("--cvg-bar-fill", bar\.soft\)/.test(tint) && /setProperty\("--cvg-bar-line", bar\.line\)/.test(tint));
check("tint.ts 一并供歌词当前句", /setProperty\("--np-hl"/.test(tint));
check("清理时五个变量一起清（别留半套颜色）",
  /const TINT_VARS = \[/.test(tint) && /for \(const v of TINT_VARS\) root\.style\.removeProperty\(v\)/.test(tint));
check("PlayerBar 不再自己从封面取色（那条通路等于绕过本设置）",
  !bar.includes("extractCoverColor") && !bar.includes("toBarColors") && !bar.includes('setProperty("--tint"'));
check("PlayerBar 也不再写 --np-hl（染色统一由 tint.ts 产出）", !bar.includes("--np-hl"));
check("PlayerBar 不再订阅封面换色（少一条重复的取色链）", !bar.includes("paintTint"));
check("进度条已播区读 tint 的变量", /\.pb-fill \{[^}]*background: var\(--cvg-bar-fill/.test(css));
check("拖拽 seek 的边线也读 tint 的变量", /\.player\.scrubbing \.pb-fill \{[^}]*var\(--cvg-bar-line/.test(css));

// 旧通路必须真的消失，且别误伤同前缀的另一个 token（--tint-row 是主题的条目底色）
const legacyTintVars = (s) => /var\(--tint[,\s)]|var\(--tint-line/.test(s);
check("…旧通路已无消费点（--tint / --tint-line）", !legacyTintVars(css));
check("…反向：进度条又回去读 --tint 会被逮住", legacyTintVars(".pb-fill { background: var(--tint, rgba(25,194,216,.75)); }"));
check("…反向：--tint-row（另一个 token）不该被误伤", !legacyTintVars(".row.playing { background: var(--cvg-glow, var(--tint-row)); }"));

// ================= Sparkle 主题与 tint 的交接 =================
section("主题交接策略（纯逻辑）");
/** 造一个「只有 tint 不同」的主题；tint 是第三方给的任意值，所以断言成 never 再传进去 */
const mkTheme = (tint?: unknown) => ({ id: "t", name: "T", css: "", ...(tint === undefined ? {} : { tint }) }) as never;

eq("没启用主题 → 宿主的正常三档", tintPolicyOf(null).mode, "host");
eq("主题不声明 tint → 让位（主题自带强调色）", tintPolicyOf(mkTheme()).mode, "off");
eq("声明 host → 宿主接管", tintPolicyOf(mkTheme({ mode: "host" })).mode, "host");
eq("mode 不认识 → 按让位处理（安全侧：宁可少写变量）", tintPolicyOf(mkTheme({ mode: "wat" })).mode, "off");
eq("声明 presets 且有一套合法 → presets",
  tintPolicyOf(mkTheme({ mode: "presets", presets: [{ id: "a", label: "A", color: "#19c2d8" }] })).mode, "presets");
eq("声明 presets 但一套都没给 → 降级 host（别让整组不可用）", tintPolicyOf(mkTheme({ mode: "presets" })).mode, "host");
eq("声明 presets 但全是非法色 → 同样降级 host",
  tintPolicyOf(mkTheme({ mode: "presets", presets: [{ id: "a", label: "A", color: "red" }] })).mode, "host");
eq("策略带回主题 id（方案选择要按它存）", tintPolicyOf(mkTheme({ mode: "host" })).themeId, "t");

section("方案列表校验（主题是第三方代码，先校验再信）");
eq("裸色名被滤掉", validPresets([{ id: "a", label: "A", color: "red" }]), []);
eq("缺 label 被滤掉", validPresets([{ id: "a", color: "#fff" }]), []);
eq("缺 id 被滤掉", validPresets([{ label: "A", color: "#fff" }]), []);
eq("id 重复只留第一个", validPresets([{ id: "a", label: "A", color: "#fff" }, { id: "a", label: "B", color: "#000" }]).length, 1);
eq("非数组 → 空", validPresets("nope"), []);
eq("合法项原样保留（含 3 位简写）", validPresets([{ id: "a", label: "A", color: "#0ff" }]), [{ id: "a", label: "A", color: "#0ff" }]);

section("方案选择");
const PS = [{ id: "a", label: "A", color: "#111111" }, { id: "b", label: "B", color: "#222222" }];
eq("没选过 → 第一个（与主题包 variants 同口径）", pickPreset(PS, null)?.id, "a");
eq("选过 → 那一个", pickPreset(PS, "b")?.id, "b");
eq("选过的方案已消失 → 回落第一个", pickPreset(PS, "gone")?.id, "a");
eq("空列表 → null（调用方据此不写变量）", pickPreset([], "a"), null);
eq("themeId 为 null 时不碰存储", sparkTintChoice(null), null);

section("源码接线 · 主题交接");
const themeTint = src("src/sparkle/theme-tint.ts");
const hostSrc = src("src/sparkle/host.ts");
const sdkTypes = srcVendor("vendor/Sparkle/sdk/types.ts");
const guide = srcVendor("vendor/Sparkle/docs/plugin-author-guide.md");
const aurora = srcVendor("vendor/Sparkle/marketplace/aurora/index.ts");

check("SDK 定义了 SparkleTintPreset / SparkleThemeTint",
  sdkTypes.includes("export interface SparkleTintPreset") && sdkTypes.includes("export interface SparkleThemeTint"));
check("SDK 的 SparkleTheme 带上了 tint 字段", /interface SparkleTheme \{[\s\S]*?tint\?: SparkleThemeTint;/.test(sdkTypes));
check("SDK 写明了缺省语义（不声明 = 主题接管 + 宿主让位）", sdkTypes.includes("缺省 = 主题接管"));

check("交接策略模块零 ui 依赖（只 import SDK 类型与颜色纯函数）",
  themeTint.includes('from "@quaver/sparkle"') && themeTint.includes('from "../lib/color.ts"') && !themeTint.includes('from "../shell"'));
check("…且值导入带 .ts（护栏要在 node 里直接 import 它做单测，剥离不补扩展名）",
  /from "\.\.\/lib\/color\.ts"/.test(themeTint));
check("激活主题的解析走 registry（读 host 维护在 <html> 的 data-sparkle-theme）",
  src("src/sparkle/registry.ts").includes("document.documentElement.dataset.sparkleTheme")
  && /const activeSparkTheme = sparkleActiveTheme;/.test(tint));
check("…且两处都不 import sparkle/host（那个模块反向依赖 shell，会成环）",
  !tint.includes('from "../sparkle/host"') && !src("src/sparkle/registry.ts").includes('from "./host"'));
check("主题接管时让位：清掉变量而不是照写", /policy\.mode === "off"[\s\S]{0,160}?paint\(null\)/.test(tint));
check("presets 模式用主题方案色（用户选过的优先，否则第一个）",
  /pickPreset\(policy\.presets, sparkTintChoice\(policy\.themeId\)\)/.test(tint));
check("bootTint 订阅插件启停（注册表变化要重算策略）", /onSparkleChange\(applyTint\)/.test(tint));
check("封面取色的回调里复检策略（主题中途接管就不能再把颜色写回来）",
  /tintPolicyOf\(activeSparkTheme\(\)\)\.mode === "host"/.test(tint));

const applyFn = /function applySparkleTheme\(\) \{([\s\S]*?)\n\}/.exec(hostSrc)?.[1] ?? "";
check("applySparkleTheme 体取得到（防失配让下面全绿）", applyFn.length > 50, String(applyFn.length));
check("host 换/停主题后重算 tint（否则会停在上一套策略上）", applyFn.includes("applyTint()"));

check("设置页按策略收口：三档与主题方案卡互斥",
  /tintCards\.hidden = presets/.test(views) && /tintSparkCards\.hidden = !presets/.test(views));
check("主题接管时三档禁用（可见但不可点，比整组消失好懂）", /b\.disabled = locked/.test(views));
check("方案卡带色块 + data-preset", /b\.dataset\.preset = p\.id/.test(views) && /\$\{p\.color\}/.test(views));
check("方案名字走 escHtml（主题是第三方代码）", /escHtml\(p\.label\)/.test(views));
check("接管时选择器不给开", /popOpen = open && tintPolicy\(\)\.mode === "host"/.test(views));
check("切主题 / 插件启停都重刷这一组",
  /syncSparkleThemeSel\(\);\s*\n\s*paintTintPolicy\(\)/.test(views) && /paintTintPolicy\(\); \/\/ 主题列表变了/.test(views));
check("方案卡组有 [hidden] 兜底（.opt-cards 是 flex，光加属性藏不住）",
  /\.opt-card\[hidden\][^}]*\.opt-cards\[hidden\][^}]*\{\s*display:\s*none;\s*\}/.test(css));

check("插件开发文档写了 tint 契约", guide.includes("高亮色（tint）归谁管") && guide.includes('tint: { mode: "host" }'));
check("市场示例说明了三种写法", /mode: "host"/.test(aurora) && /mode: "presets"/.test(aurora));

// 反向：不为主题让位（照写变量压主题）是这次要防的回归
const noYield = (s) => !/policy\.mode === "off"/.test(s);
check("…反向：applyTint 不为主题让位会被逮住",
  noYield("export function applyTint() { paint(parseHex(getTintColor())); }"));
check("…当前实现确实让位", !noYield(tint));

check("…反向：validPresets 拒收哨兵值会被逮住",
  validPresets([{ id: "x", label: "X", color: "system" }]).length === 1);
check("…反向：resolvePresetColor 把哨兵当非法色（恒 null）会被逮住", resolvePresetColor("system", "#123456") !== null);
check("…反向：tint.ts 的系统档忘了开轮询（永远停在默认青）会被逮住",
  !/mode === "system"[\s\S]{0,200}syncAccentWatch\(true\)/.test(tint.replace(/mode === "system"/, 'mode === "off"')));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-tint: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
