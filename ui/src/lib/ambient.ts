// Quaver — 环境色层（默认主题的背景）：整窗铺底的一张图，侧栏/播放条/悬浮菜单这些玻璃面板
// 的 backdrop-filter 透出它的色彩。
//
// 三种模式（quaver.conf 的 [Style] Background，设置→外观→背景）：
//   off    关闭背景 —— 整层不画，只剩主题底色；
//   cover  当前曲封面（默认，也就是本功能之前一直的行为）—— 强模糊 + 提饱和/提亮，只取色彩
//          倾向，所以压到 55% 不透明度；
//   custom 用户自己选的图片 —— 是他挑的图，就该看得清：满不透明，且不额外调色。
// 模糊强度（BackgroundBlur，px）对两种出图模式都生效；扩边系数随模糊一起收放 —— 扩边只为
// 盖住 blur() 边缘的发白，不模糊时不该平白裁掉一圈图。
//
// 分工：本模块只管这一层。封面主色 → --cvg-accent/--cvg-glow 的**界面染色**在 shell.ts，
// 两者同源（同一张封面）但互不依赖：一个管背景，一个管高亮色，关掉背景不该影响高亮。
import { coverUrl } from "./api";
import { getBackgroundBlur, getBackgroundImage, getBackgroundMode } from "./prefs";
import { player } from "../player";

/** 同源背景图端点（dev/preview = src/relay.ts，打包态 = electron/native-server.ts） */
const BG_ROUTE = "/api/bg";
/** 封面模式的取图尺寸：环境层是模糊铺底，300px 足够（与 shell 的染色取图同口径） */
const COVER_SIZE = 300;
/** 扩边系数：blur 0 → 1（不裁图）｜70（默认）→ 1.15（与改造前的硬编码值一致）｜120 → 1.26 */
const SCALE_AT_70 = 0.15;
const scaleFor = (blur: number) => 1 + (blur / 70) * SCALE_AT_70;

let layer: HTMLElement | null = null;
let art: HTMLElement | null = null;
/** 当前图源指纹（模式 + 具体来源）：只有它变了才重新取图 —— 拖模糊滑块不该重拉一张 4K 壁纸 */
let artKey = "";
/** 自定义图的取图序号：同一个路径换了文件（用户替换了原图）也要能击穿缓存 */
let bgRev = 0;

/** 建层并接管播放事件。由 shell.ts 在 bootShell 时调用一次（必须早于第一次路由渲染）。 */
export function bootBackground() {
  if (layer) return;
  layer = document.createElement("div");
  layer.className = "ambient";
  layer.innerHTML = `<div class="ambient-art"></div>`;
  art = layer.querySelector<HTMLElement>(".ambient-art")!;
  document.body.prepend(layer);
  player.on(applyBackground); // 换曲：封面模式跟着换图（off/custom 下指纹不变，空转）
  applyBackground();
}

/** 撤下图。指纹保留：一张取不回来的图（文件被挪走/404）不必每次播放事件都重试。 */
function hideArt() {
  if (!art) return;
  art.classList.remove("ready");
  art.style.backgroundImage = "";
}

/**
 * 应用当前偏好（模式 / 图源 / 模糊强度）。设置页改完立刻调一次即生效；
 * 幂等：图源没变时只更新模糊与模式，不重新取图。
 */
export function applyBackground() {
  if (!layer || !art) return;
  const mode = getBackgroundMode();
  layer.dataset.mode = mode;
  const blur = getBackgroundBlur();
  layer.style.setProperty("--ambient-blur", `${blur}px`);
  layer.style.setProperty("--ambient-scale", String(scaleFor(blur)));

  const song = player.current;
  const path = getBackgroundImage();
  const key = mode === "custom" ? (path ? `custom:${path}` : "")
    : mode === "cover" ? (song ? `cover:${coverUrl(song, COVER_SIZE)}` : "")
    : "";
  if (key === artKey) return;
  artKey = key;
  if (!key) {
    hideArt();
    return;
  }
  // 自定义图走后端端点（路径只认 quaver.conf，query 只用来击穿缓存）；
  // 封面直接吃远端 URL（与其它地方的封面图同一个 CDN 缓存条目，不额外拉一次）
  const src = key.startsWith("custom:") ? `${BG_ROUTE}?v=${++bgRev}` : key.slice("cover:".length);
  const img = new Image();
  img.onload = () => {
    if (artKey !== key || !art) return; // 期间已换模式/换曲
    art.style.backgroundImage = `url("${src}")`;
    art.classList.add("ready");
  };
  img.onerror = () => {
    // 封面 404 或自定义图读不出来：保持中性底，不闪一下半成品
    if (artKey === key) hideArt();
  };
  img.src = src;
}
