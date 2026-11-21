// Sparkle — 主题「透明模式」的宿主实现
//
// 契约在 sdk/types.ts 的 SparkleThemeTransparent：主题声明 `transparent: { mode: "on" }`
// 后，宿主做三件事：
//   ① <html data-sparkle-transparent="on">（主题据此写条件选择器）；
//   ② 摘掉宿主自己的实底（html / body / .frame），让主题画的半透明表面能透到下面那层；
//   ③ 环境背景层（lib/ambient.ts，铺在 body 最底下）因此成为可见的「下层」——
//      专辑封面 / 自定义壁纸从主题的玻璃表面下透出来，不用主题自己伪造背景。
//
// 为什么基础规则是**运行时注入**而不是写进 style.css：透明模式是低频能力（只有声明它的
// 主题才用），主窗首屏 CSS 有 84KB 的硬预算（verify-bundle），没必要为偶尔才用的一套基
// 规则让所有人付字节。样式只注入一次，切到不透明主题时把 data 属性摘掉即可 —— 规则留着
// 不生效，等于零成本。
//
// 边界（诚实写清楚）：这里让的是**页面的画布**，不是 Electron 窗口的底色。窗口在创建时
// 就是不透明的（main.ts 的 backgroundColor），所以「透出桌面」需要改窗口创建参数，不在
// 本扩展点范围内；主题能做的是「透出宿主环境背景」，这也是绝大多数玻璃主题真正想要的。
import { sparkleActiveTheme } from "./registry";

const STYLE_ID = "sparkle-transparent-base";

/** 透明模式的基础规则：只摘宿主实底，不规定主题各层用多少不透明度。 */
const BASE_CSS = `
html[data-sparkle-transparent="on"],
html[data-sparkle-transparent="on"] body { background: transparent; }
html[data-sparkle-transparent="on"] .frame { background: transparent; }
/* 内容区与路由容器默认是透明，但主题/宿主可能给过实底；这里只兜住 .frame 以下的直系层，
   面板（.sidebar / .player / .set-group …）交给主题自己写 —— 宿主猜不准它的玻璃语言。 */
html[data-sparkle-transparent="on"] .content,
html[data-sparkle-transparent="on"] .content-body,
html[data-sparkle-transparent="on"] .route { background: transparent; }
`;

function ensureBaseStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BASE_CSS;
  document.head.append(style);
}

/** 重算透明模式归属（bootShell 与每次主题切换/插件启停时调用；幂等）。 */
export function applyThemeTransparent(): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const on = sparkleActiveTheme()?.transparent?.mode === "on";

  if (on) {
    ensureBaseStyle();
    root.dataset.sparkleTransparent = "on";
  } else {
    delete root.dataset.sparkleTransparent;
  }
}

/** 当前是否处于主题透明模式（设置页/主题作者排查用） */
export const sparkleTransparentActive = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset.sparkleTransparent === "on";
