// Quaver — 环境色层（默认主题的背景）。呈现风格两套（用户偏好 / Sparkle 主题都可指定）：
//   mesh   AMLL BackgroundRender 把封面 / 自定义图展开成 Apple Music 式流动渐变（默认）；
//   quaver Quaver Design 的封面模糊铺底（原图 + CSS blur，只取色彩倾向）。
//
// 三种图源模式（quaver.conf 的 [Style] Background，设置→外观→背景）：
//   off    关闭背景 —— 整层不画，只剩主题底色；
//   cover  当前曲封面（环境色）；
//   custom 用户自己选的图片。
// 外加第四个**非用户档位**的 data-mode="theme"：启用的 Sparkle 主题接管背景时这一层不画
// （契约见 sparkle/theme-background.ts），CSS 里与 off 一样整层藏掉。
// 流动速度（BackgroundFlow，AMLL setFlowSpeed 系数 0..2）只改动画快慢，不改画面内容。
//
// 分工：本模块只管这一层。封面主色 → --cvg-accent/--cvg-glow 的**界面染色**在 shell.ts，
// 两者同源（同一张封面）但互不依赖：一个管背景，一个管高亮色，关掉背景不该影响高亮。
//
// 还有一层归属：**启用的 Sparkle 主题可能接管背景**（契约见 sparkle/theme-background.ts）——
// 主题不声明 background 就由它管，本模块让位（整层不画），设置页那一组同时禁用。判定与
// tint 的让位是同一套口径，别只改一边。
import { coverUrl } from "./api";
import { getBackgroundBlur, getBackgroundFlow, getBackgroundImage, getBackgroundMode, getBackgroundRenderer, type BackgroundRenderer } from "./prefs";
import { player } from "../player";
import { onSparkleChange, sparkleActiveTheme } from "../sparkle/registry";
import { backgroundPolicyOf, backgroundRendererOf } from "../sparkle/theme-background";

/** 同源背景图端点（dev/preview = src/relay.ts，打包态 = electron/native-server.ts） */
const BG_ROUTE = "/api/bg";

/** QQ CDN 封面没有 CORS 头，而 AMLL 要 fetch + canvas 取色 —— 与 lib/color.ts 同一套中继。 */
const proxied = (url: string) => "/api/img?u=" + encodeURIComponent(url);

/** 封面模式的取图尺寸：AMLL 只取主色，300px 足够（与 shell 的染色取图同口径） */
const COVER_SIZE = 300;

/** AMLL 背景实例：懒加载（主窗首屏不背 AMLL 的 ~400KB，verify-bundle 钉着这条）。 */
type AmlBackground = import("@applemusic-like-lyrics/core").BackgroundRender<import("@applemusic-like-lyrics/core").MeshGradientRenderer>;

let bgInit: Promise<AmlBackground | null> | null = null;
let bg: AmlBackground | null = null;

let layer: HTMLElement | null = null;
let canvasHost: HTMLElement | null = null;
let quaverArt: HTMLElement | null = null;
let playing = false;

/** 当前图源指纹（模式 + 具体来源）：只有它变了才重新取图 —— 拖速度滑块不该重拉一张图 */
let artKey = "";

/** 自定义图的取图序号：同一个路径换了文件（用户替换了原图）也要能击穿缓存 */
let bgRev = 0;

/** 建层并接管播放事件。由 shell.ts 在 bootShell 时调用一次（必须早于第一次路由渲染）。 */
export function bootBackground() {
  if (layer) return;

  layer = document.createElement("div");
  layer.className = "ambient";
  canvasHost = document.createElement("div");
  canvasHost.className = "ambient-host";
  quaverArt = document.createElement("div");
  quaverArt.className = "ambient-art";
  layer.append(canvasHost, quaverArt);
  document.body.prepend(layer);
  player.on(() => {
    // player.on 同时是 4Hz 位置广播：播放态先比对再动手，图源指纹在 applyBackground 里挡
    const now = player.playing;

    if (now !== playing) { playing = now; syncPlaying(); }

    applyBackground();
  });

  // 插件启停 / 主题注册变化都会改归属（主题接管与否决定本模块让不让位），跟着重算一次
  onSparkleChange(applyBackground);

  applyBackground();
}

/** 播放状态同步给 AMLL：暂停即停动画循环，空转也是在烧 GPU。 */
function syncPlaying() {
  if (playing) bg?.resume();
  else bg?.pause();
}

/** WebGL 不可用 / 图加载失败时退回中性底（不闪半成品）。指纹保留，不必每次播放事件重试。 */
function hideCanvas() {
  canvasHost?.classList.remove("ready");
}

function hideQuaverArt() {
  quaverArt?.classList.remove("ready");

  if (quaverArt) quaverArt.style.backgroundImage = "";
}

/**
 * 应用当前偏好（模式 / 图源 / 流动速度）。设置页改完立刻调一次即生效；
 * 幂等：图源没变时不重取图，速度由 ensureBackground / 事件里即时下发。
 */
export async function applyBackground() {
  if (!layer || !canvasHost) return;

  // 主题接管背景：让位 —— 整层不画（否则用户的自定义壁纸会从主题的底色底下透出来），
  // 也顺手作废图源指纹：切回默认主题时要重新取图，不能停在「已加载」的假象上。
  if (backgroundPolicyOf(sparkleActiveTheme()).mode === "off") {
    layer.dataset.mode = "theme";
    artKey = "";
    bg?.pause();
    hideCanvas();
    hideQuaverArt();

    return;
  }

  const mode = getBackgroundMode();
  layer.dataset.mode = mode;
  const song = player.current;
  const path = getBackgroundImage();

  const key = mode === "custom" ? (path ? `custom:${path}` : "")
    : mode === "cover" ? (song ? `cover:${coverUrl(song, COVER_SIZE)}` : "")
    : "";

  if (!key) {
    bg?.pause();
    hideCanvas();
    hideQuaverArt();

    return;
  }

  const renderer: BackgroundRenderer = backgroundRendererOf(sparkleActiveTheme()) ?? getBackgroundRenderer();
  layer.dataset.renderer = renderer;
  layer.style.setProperty("--bg-blur", `${getBackgroundBlur()}px`);
  bg?.setFlowSpeed(getBackgroundFlow()); // 速度只改动画快慢：实例已建时即时下发，不重取图

  if (key === artKey && layer.dataset.renderer === renderer) return;
  artKey = key;

  if (renderer === "quaver") {
    bg?.pause();
    hideCanvas();
    applyQuaverArt(key);

    return;
  }

  hideQuaverArt();

  // 自定义图走后端端点（路径只认 quaver.conf，query 只用来击穿缓存）；
  // 远端封面经 /api/img 中继成同源（AMLL 要 fetch + canvas 取色，直连 CDN 会被 CORS 拦下）
  const src = key.startsWith("custom:") ? `${BG_ROUTE}?v=${++bgRev}`
    : proxied(key.slice("cover:".length));

  const inst = await ensureBackground();

  if (artKey !== key) return; // 期间已换模式/换曲

  if (!inst) return; // WebGL 不可用等：中性底兜底，不闪半成品

  canvasHost.classList.add("ready");

  try {
    await inst.setAlbum(src);

    if (artKey !== key) return;

    syncPlaying();
  } catch {
    if (artKey === key) hideCanvas(); // 封面 404 或自定义图读不出来
  }
}

/** 懒建 AMLL 背景。失败（无 WebGL / import 失败）只记一次结果，之后空转不再反复 import。 */
async function ensureBackground(): Promise<AmlBackground | null> {
  if (bg) return bg;

  if (!bgInit) {
    bgInit = (async () => {
      const { BackgroundRender, MeshGradientRenderer } = await import("@applemusic-like-lyrics/core");

      // SAFETY: 构造前先探测，WebGL 缺失时直接走中性底
      if (!MeshGradientRenderer.isSupported()) return null;

      const inst = BackgroundRender.new(MeshGradientRenderer);

      inst.setRenderScale(1);
      inst.setFlowSpeed(getBackgroundFlow());
      inst.setStaticMode(false);
      canvasHost?.append(inst.getElement());

      return inst;
    })().catch(() => null);
  }

  const inst = await bgInit;

  if (inst) { bg = inst; bg.setFlowSpeed(getBackgroundFlow()); }

  return inst;
}

/** Quaver Design：原图 + CSS blur 铺底（强模糊只取色彩倾向，加载完成后淡入）。 */
function applyQuaverArt(key: string) {
  if (!quaverArt) return;

  if (!key) { hideQuaverArt(); return; }

  const src = key.startsWith("custom:") ? `${BG_ROUTE}?v=${++bgRev}` : proxied(key.slice("cover:".length));
  const img = new Image();

  img.onload = () => {
    if (artKey !== key || !quaverArt) return;
    quaverArt.style.backgroundImage = `url("${src}")`;
    quaverArt.classList.add("ready");
  };

  img.onerror = () => { if (artKey === key) hideQuaverArt(); };

  img.src = src;
}
