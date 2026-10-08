// Quaver — 界面高亮色（tint）：:root 上那几个染色变量的来源与写值。
//
// 三档（quaver.conf 的 [Style] Tint，设置→外观→高亮颜色）：
//   default 固定青色（TINT_DEFAULT_COLOR）—— 默认档。不跟封面跑，色相稳定；
//   cover   当前曲封面主色（extractCoverColor → toUiColors），换曲平滑跟随（:root 上有 transition）；
//   custom  用户自选色（TintColor，HEX），设置页的颜色选择器按 HSL / CMYK / RGB 编辑。
//
// 但**主题优先于档位**：启用 Sparkle 主题后由它决定（契约见 sparkle/theme-tint.ts）——
//   主题没声明 tint   → 主题自带强调色：本模块**让位**（清掉内联变量，回落 :root 的 --acc/--cyan）
//   主题 tint=host    → 上面那三档照常
//   主题 tint=presets → 用主题给的方案（用户在设置页挑，选择存在 localStorage）
// 让位是必须的：这几个变量是行内样式，会压过主题的 html[data-sparkle-theme=…] 规则。
//
// 本模块是**全应用唯一的染色来源**，一次写两套变量（都由同一个源色派生）：
//   --cvg-accent / --cvg-glow  UI 高亮（选中态、激活描边、歌曲行/胶囊洗底…，亮度用途见 toUiColors）
//   --cvg-bar-fill / --cvg-bar-line  播放条（已播区填充 / 拖拽 seek 的边线；toBarColors 另调过亮度）
//   --np-hl                   播放页歌词当前句（与进度条同源；目前是预留钩子，CSS 侧未启用）
// 曾几何时进度条自己从封面取色（PlayerBar 里的 --tint/--tint-line）：那等于绕过本设置 ——
// 选「固定青色」时界面高亮变了、进度条还在跟封面跑。现在它同源，只是色对另算。
//
// 分工：本模块只管写变量。取值 ⇄ 配置的映射在 lib/prefs.ts，颜色数学（HEX/HSL/CMYK/RGB
// 互转）在 lib/color.ts，主题交接策略在 sparkle/theme-tint.ts。ambient.ts 管背景那张图 ——
// 两者同源（都可能取同一张封面）但彼此独立：关掉背景不该把高亮色一起关掉。
// shell.ts 只调 bootTint()。
import { coverUrl } from "./api";
import { extractCoverColor, parseHex, toBarColors, toUiColors, type RGB } from "./color";
import { getTintColor, getTintMode, TINT_DEFAULT_COLOR } from "./prefs";
import { player } from "../player";
import { onSparkleChange, sparkleActiveTheme } from "../sparkle/registry";
import { pickPreset, sparkTintChoice, tintPolicyOf } from "../sparkle/theme-tint";

/** 封面取图尺寸：染色只取色彩倾向，300px 足够（与背景层、播放条同口径，CDN 缓存也共用）。 */
const COVER_SIZE = 300;

/** 封面档当前生效的图源：同曲重复触发不重取（extractCoverColor 有缓存，这是省一层 promise）。 */
let coverPic = "";

/** 当前生效的 Sparkle 主题。解析在 sparkle/registry.ts:sparkleActiveTheme（那边不 import host，
 *  读的是 host 维护在 <html data-sparkle-theme> 上的公开真相）—— 设置页与背景层共用同一份。 */
const activeSparkTheme = sparkleActiveTheme;

/** 本模块产出的全部变量（移除时一起清，别漏一个导致「半套颜色」残留）。 */
const TINT_VARS = ["--cvg-accent", "--cvg-glow", "--cvg-bar-fill", "--cvg-bar-line", "--np-hl"];

/** 写变量。无颜色（未播放 / 中继不可用 / 让位给主题）时全部移除，CSS 回落到主题默认色。 */
function paint(rgb: RGB | null) {
  const root = document.documentElement;
  const ui = toUiColors(rgb);
  if (!ui) {
    for (const v of TINT_VARS) root.style.removeProperty(v);
    return;
  }
  // 进度条的色对与 UI 高亮不同源（亮度各调各的）：从同一个 rgb 派生出两套，色相一致
  const bar = toBarColors(rgb);
  root.style.setProperty("--cvg-accent", ui.accent);
  root.style.setProperty("--cvg-glow", ui.glow);
  root.style.setProperty("--cvg-bar-fill", bar.soft);
  root.style.setProperty("--cvg-bar-line", bar.line);
  root.style.setProperty("--np-hl", bar.line);
}

/** 应用当前偏好。设置页改完立刻调一次即生效；换曲与插件启停由 bootTint 注册的监听驱动。 */
export function applyTint() {
  const policy = tintPolicyOf(activeSparkTheme());

  // 主题接管高亮色：让位。清掉内联变量后 --cvg-accent 回落 :root 的 var(--acc)，
  // 而主题一般已经覆盖了 --acc/--cyan —— 高亮色于是自然跟着主题走。
  if (policy.mode === "off") {
    coverPic = "";
    paint(null);
    return;
  }
  // 主题自带方案：用用户挑好的那套（没挑过 = 第一个），走自定义色那条通路应用
  if (policy.mode === "presets") {
    coverPic = "";
    const chosen = pickPreset(policy.presets, sparkTintChoice(policy.themeId));
    paint(chosen ? parseHex(chosen.color) : null);
    return;
  }

  // 以下 = 主题把高亮色交给宿主（或压根没启用主题）：用户的三档
  const mode = getTintMode();

  if (mode !== "cover") {
    coverPic = ""; // 离开封面档：作废在途取色（下面的回调还会复检一次档位）
    paint(parseHex(mode === "custom" ? getTintColor() : TINT_DEFAULT_COLOR));
    return;
  }

  const pic = player.current ? coverUrl(player.current, COVER_SIZE) : "";
  if (!pic) {
    // 封面档但没有曲目：不是「保持不变」，而是明确回到无色（否则会停在上一档写下的颜色上）
    coverPic = "";
    paint(null);
    return;
  }
  if (pic === coverPic) return; // 同一张封面：已应用过，空转
  coverPic = pic;
  // extractCoverColor 有 url 缓存，与背景层各取一份不重复请求网络
  void extractCoverColor(pic).then((rgb) => {
    if (coverPic === pic && getTintMode() === "cover" && tintPolicyOf(activeSparkTheme()).mode === "host") paint(rgb);
  });
}

/** 建订阅。由 shell.ts 在 bootShell 时调用一次（必须早于第一次路由渲染）。 */
export function bootTint() {
  player.on(applyTint);
  // 插件启停 / 主题注册变化都会改策略（主题接管与否决定本模块让不让位），跟着重算一次
  onSparkleChange(applyTint);
  applyTint();
}
