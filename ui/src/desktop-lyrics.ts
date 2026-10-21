// Quaver — 桌面歌词覆盖层页面（desktop-lyrics.html 的入口）
//
// **不是** SPA 页面：不 mountLayout、没有路由、不 import player —— 这是主进程托管的
// 透明置顶窗里的独立小页，数据面全靠主窗桥的镜像推送（track/sync，见
// src/lib/desktop-lyrics.ts），操作面全是「遥控器」命令（发回主窗执行）。
//
// 渲染引擎 = 宿主内置 AMLL（src/lyrics/amll.ts 的 builtinKaraokeProvider）：
// 主窗推来的逐字行（QRC/TTML 解析产物，含振假名 ruby）原样进 render；行级兜底
// （LRC 时代的 player.lyrics）在这里整形为「整行单音节」再进 render —— 与内置引擎
// 对 LRC 的形状约定一致。翻译/音译档位的**消费口径**也与正在播放页同规：
// 驱动时钟取 ctx.time() − lyricDelay()（扣减在 amll.ts 内部实现，本文件只保证 ctx
// 喂的是对的数）。行点击跳转（点行 seek）按产品决定关闭：覆盖层只读，见 ctx.seek。
//
// 字体：家族走独立的 [DesktopLyrics] Font，与正在播放页的 Style.DefaultLyricsFonts 解绑；
// 字号倍率走 [DesktopLyrics] Scale、字重走 Weight、文字描边走 Border、阴影走 Shadow/ShadowBlur/
// ShadowOpacity/ShadowX/ShadowY、歌词层不透明度走 Opacity、窗体不透明度（背板）走 Backdrop
// （都经配置广播实时跟随）。字重同时写 font-weight 与 wght 轴，静态/可变字体各取所需。
// 阴影用单层 text-shadow 而非整块 filter:drop-shadow，强度可调到 0；描边与阴影互不替代。
// 歌词层另有一道「悬停地板」：鼠标停在覆盖层上（= 可拖动那个状态）时内容至少 0.3，
// 设置高于 0.3 就照设置来 —— 见 prefs 的 DL_HOVER_OPACITY_FLOOR，值由 applyStyle 算成
// --dl-hover-opacity（悬停控件不跟随，恒满值）。
//
// 版面：可见条带（clip-path）恒居中于视口，当前行**整块文字**（主行 + 翻译/音译）的实测
// 中心钉在视口中心；水平方向只有「单行 + 单行居中=开」居中，单行关居中与双行恒左对齐。
// 超长行一行到底、那一行自己横向滚（翻译/音译各判各的）。内核公式在
// ./lib/desktop-lyrics-layout.ts，DOM 量测在下面的「排版内核」一节。
//
// 窗体形态：未锁定时是纯 CSD —— 整层是拖拽区（-webkit-app-region: drag，见 desktop-lyrics.css），
// 拖哪都能挪窗；控制条/进度条/缩放手把是 no-drag，各自收点击。macOS / Windows / X11 支持
// 固定/鼠标透穿：锁定后原生窗不再接收任何鼠标事件，控制条与缩放手把同步隐藏。
// 交互分层：
//   • 拖动任意歌词区 = 挪窗（CSD 拖拽区，由窗口管理器做交互移动）；
//   • 右下角把手 = 缩放（无对应的 CSS 能力，走指针位移 → 主进程；高度那条钉死的轴要连提示一起改）；
//   • 顶部悬停控制条：左侧小封面 + 歌名 - 歌手，右侧 ⏮ ⏯ ⏭ ｜ A−/A+ B400 ｜
//     延迟 −/读数(点=归零)/＋ ｜ 关窗；
//   • 底部细进度条：点击 seek。
import "./desktop-lyrics.css";
import { loadConfig } from "./lib/config";
import { fontCssOf, getDesktopLyricsBackdrop, getDesktopLyricsBorder, getDesktopLyricsColor, getDesktopLyricsColorMode, getDesktopLyricsFontList, getDesktopLyricsHoverOpacity, getDesktopLyricsMode, getDesktopLyricsOpacity, getDesktopLyricsScale, getDesktopLyricsShadow, getDesktopLyricsShadowBlur, getDesktopLyricsShadowOpacity, getDesktopLyricsShadowX, getDesktopLyricsShadowY, getDesktopLyricsSingleCenter, getDesktopLyricsWeight, getLyricAux } from "./lib/prefs";
import { fmtLyricDelay, LYRIC_DELAY_MAX_MS, LYRIC_DELAY_STEP_MS } from "./lib/lyric-delay";
import { alignFor, bandFor, scrollRange, sequenceOverlappingLines } from "./lib/desktop-lyrics-layout";
import { CLOCK_COMP_MS, type DlCmd, type DlLine, type DlStateSnapshot, type DlSyncPayload, type DlTrackPayload } from "./lib/desktop-lyrics-protocol";
import { LayoutAlignAnchor, LayoutReason } from "@applemusic-like-lyrics/core";
import { amllPlayerByHost, builtinKaraokeProvider } from "./lyrics/amll";
import type { SparkleKaraokeLine } from "@quaver/sparkle";

const bridge = window.quaverDesktopLyrics;
const docEl = document.documentElement;

// —— DOM ——
const root = document.getElementById("dl-root") as HTMLDivElement;
const clip = document.getElementById("dl-clip") as HTMLDivElement;
const empty = document.getElementById("dl-empty") as HTMLDivElement;
const trackInfo = document.getElementById("dl-track-info") as HTMLDivElement;
const trackSep = document.getElementById("dl-track-sep") as HTMLSpanElement;
const trackMeta = document.getElementById("dl-track-meta") as HTMLSpanElement;
const coverImg = document.getElementById("dl-cover") as HTMLImageElement;
const coverFallback = document.getElementById("dl-cover-fallback") as HTMLSpanElement;
let failedCover = "";
const prevBtn = document.getElementById("dl-prev") as HTMLButtonElement;
const playBtn = document.getElementById("dl-play") as HTMLButtonElement;
const nextBtn = document.getElementById("dl-next") as HTMLButtonElement;
const fontDec = document.getElementById("dl-font-dec") as HTMLButtonElement;
const fontInc = document.getElementById("dl-font-inc") as HTMLButtonElement;
const weightVal = document.getElementById("dl-weight-val") as HTMLButtonElement;
const delayDec = document.getElementById("dl-delay-dec") as HTMLButtonElement;
const delayVal = document.getElementById("dl-delay-val") as HTMLButtonElement;
const delayInc = document.getElementById("dl-delay-inc") as HTMLButtonElement;
const lockBtn = document.getElementById("dl-lock") as HTMLButtonElement;
const closeBtn = document.getElementById("dl-close") as HTMLButtonElement;
const progress = document.getElementById("dl-progress") as HTMLDivElement;
const progressFill = document.getElementById("dl-progress-fill") as HTMLElement;
const grip = document.getElementById("dl-resize") as HTMLDivElement;

// 图标两种画法：solid=填充（播放形态），line=描边（方向条/加号/叉）——样式见 desktop-lyrics.css
const ICON = {
  prev: '<svg class="solid" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.4v14H6zM19 5 8.6 12 19 19z"/></svg>',
  next: '<svg class="solid" viewBox="0 0 24 24" aria-hidden="true"><path d="M15.6 5H18v14h-2.4zM5 5l10.4 7L5 19z"/></svg>',
  play: '<svg class="solid" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5 20 12 7 19.5z"/></svg>',
  pause: '<svg class="solid" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h3.4v15H6.5zM14.1 4.5h3.4v15h-3.4z"/></svg>',
  close: '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  minus: '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  plus: '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  lock: '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
};
prevBtn.innerHTML = ICON.prev;
nextBtn.innerHTML = ICON.next;
playBtn.innerHTML = ICON.play;
closeBtn.innerHTML = ICON.close;
delayDec.innerHTML = ICON.minus;
delayInc.innerHTML = ICON.plus;
lockBtn.innerHTML = ICON.lock;
coverImg.addEventListener("error", () => {
  failedCover = coverImg.getAttribute("src") ?? "";
  coverImg.hidden = true;
  coverFallback.hidden = false;
});

// Crotchet 调试模式（QUAVER_CROTCHET=1）：未捕获异常/拒绝也进主日志流水线（preload console 桥在，
// console.error 本身已可达；这里补上 window.onerror 与 unhandledrejection 两条漏网鱼）
if ((window as any).quaverCrotchet) {
  window.addEventListener("error", (e) => console.error("[dl-window-error]", e.message, `${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener("unhandledrejection", (e) => console.error("[dl-unhandled-rejection]", String((e.reason && (e.reason as any).stack) || e.reason)));
}

// —— 镜像状态 ——
let track: DlTrackPayload | null = null;
let sync: DlSyncPayload | null = null;
let syncAt = 0; // 收到 sync 时的 performance.now()（本地单调钟的外推起点）
const notifyCbs = new Set<() => void>();
let disposeRender: (() => void) | null = null;
let renderedFp = "";

/** 行级兜底 → AMLL 的「整行单音节」形状（口径对齐内置引擎对 LRC 的整形：行尾=下一行头）。 */
function linesToKaraoke(lines: DlLine[]): SparkleKaraokeLine[] {
  const sorted = [...lines].sort((a, b) => a.t - b.t);
  return sorted.map((l, i) => {
    const start = Math.max(0, Math.round(l.t * 1000));
    const next = sorted[i + 1]?.t;
    const end = next != null ? Math.max(start + 100, Math.round(next * 1000)) : start + 60_000;
    return {
      words: [{ word: l.text, startTime: start, endTime: end }],
      startTime: start,
      endTime: end,
      translatedLyric: l.trans || undefined,
      romanLyric: l.roma || undefined,
    };
  });
}

/** 裸播放头的外推（毫秒）：快照 + 本地单调钟；不含 +0.2s 补偿、不含歌词延迟（口径见桥模块头）。 */
function rawPosMs(): number {
  if (!sync) return 0;
  return sync.posMs + (sync.playing ? performance.now() - syncAt : 0);
}

const ctx = {
  // 与主窗 NowPlaying 组装 render ctx 处同口径：(player.time + 0.2) * 1000 → 这里
  // 外推等价物 = rawPosMs() + CLOCK_COMP_MS。歌词时钟 = time() − lyricDelay()（在 amll.ts 内做）。
  time: () => rawPosMs() + CLOCK_COMP_MS,
  paused: () => !(sync?.playing ?? false),
  expanded: () => true, // 覆盖层没有「收起」一档：窗口在=恒展开
  showTrans: () => getLyricAux() !== "off",
  lyricAux: () => getLyricAux(),
  lyricDelay: () => sync?.delayMs ?? 0,
  // 行点击 seek 被产品决定关掉：桌面歌词是「贴」在桌面上的只读层，跳转回主窗做。
  // （renderAmll 会把 AMLL 的 line-click 事件统一送进这里，no-op 即整条路静音。）
  seek: (_ms: number) => {},
  onNotify: (cb: () => void) => {
    notifyCbs.add(cb);
    return () => notifyCbs.delete(cb);
  },
};

function sendCmd(cmd: DlCmd): void {
  bridge?.sendCmd(cmd);
}
function windowOp(msg: Record<string, unknown>): void {
  bridge?.windowOp(msg);
}

/** 锁定态由主进程给真相：页面只负责隐藏交互控件与拖拽区，原生输入穿透不在 DOM 层模拟。 */
function syncInteractionMode(): void {
  let state: DlStateSnapshot | null = null;
  try {
    state = bridge?.activeSync?.() ?? null;
  } catch {
    state = null;
  }
  const canLock = !!state?.canLock;
  const locked = canLock && !!state?.locked;
  lockBtn.hidden = !canLock;
  root.classList.toggle("dl-locked", locked);
  root.classList.toggle("dl-lockable", canLock);
}

// —— 渲染生命周期 ——

function paintEmpty(): void {
  if (track && track.lyricState === "ok" && (track.karaoke.length || track.lines.length)) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  clip.innerHTML = "";
  empty.textContent =
    !track || !track.key ? "等待播放"
      : track.lyricState === "loading" ? "歌词加载中…"
        : "暂无歌词";
}

/** 顶部控制条的曲目抬头：小封面 +「歌名 - 歌手」。字段随 track 整包到达，文本只走 textContent。 */
function syncTrackInfo(): void {
  const hasTrack = !!track?.key;
  trackInfo.hidden = !hasTrack;
  trackSep.hidden = !hasTrack;
  if (!hasTrack) {
    trackMeta.textContent = "";
    trackMeta.removeAttribute("title");
    coverImg.removeAttribute("src");
    coverImg.hidden = true;
    coverFallback.hidden = true;
    failedCover = "";
    return;
  }
  const title = String(track?.title ?? "").trim();
  const artist = String(track?.artist ?? "").trim();
  const label = title && artist ? `${title} - ${artist}` : title || artist || "未知曲目";
  trackMeta.textContent = label;
  trackMeta.title = label;
  const cover = String(track?.cover ?? "").trim();
  const broken = !!cover && cover === failedCover;
  coverImg.hidden = !cover || broken;
  coverFallback.hidden = !!cover && !broken;
  if (cover && !broken) {
    if (coverImg.getAttribute("src") !== cover) coverImg.src = cover;
  } else {
    coverImg.removeAttribute("src");
  }
}

function reRender(force = false): void {
  paintEmpty();
  const fp = track
    ? `${track.key}|${track.lyricState}|${track.lyricRevision ?? 0}|${track.karaoke.length}|${track.lines.length}`
    : "empty";
  if (!force && fp === renderedFp) return;
  renderedFp = fp;
  if (disposeRender) {
    try { disposeRender(); } catch (e) { console.warn("[dl] 渲染清理失败", e); }
    disposeRender = null;
  }
  clip.innerHTML = "";
  resetMarquee(); // 旧行元素已随 innerHTML 一起没了：滚动状态/在滚类名一并清掉
  if (!track || track.lyricState !== "ok") return;
  const lines = sequenceOverlappingLines(track.karaoke.length ? track.karaoke : linesToKaraoke(track.lines));
  if (!lines.length) return;
  // 新播放器 = 新行表：条带几何清空重估（applyPlayerLayout 里会先给个估计锚位）
  stripApplied = -1;
  stripTop = -1;
  stripPending = -1;
  stripPendingTop = -1;
  disposeRender = builtinKaraokeProvider.render(clip, lines, ctx) ?? null;
  applyPlayerLayout();
  // 首帧弹簧布局还没落位：稳定期再补两刀（AMLL 排版是 rAF 逐帧的，静态一次量不准）
  window.setTimeout(tightenStrip, 160);
  window.setTimeout(tightenStrip, 480);
}

// —— 控制条状态 ——

function syncTools(): void {
  playBtn.innerHTML = sync?.playing ? ICON.pause : ICON.play;
  prevBtn.disabled = nextBtn.disabled = !(sync?.canPrev ?? false);
  const d = sync?.delayMs ?? 0;
  delayVal.textContent = fmtLyricDelay(d);
  delayDec.disabled = d <= -LYRIC_DELAY_MAX_MS;
  delayInc.disabled = d >= LYRIC_DELAY_MAX_MS;
  const dur = sync?.durationSec ?? 0;
  const ratio = dur > 0 ? Math.min(1, Math.max(0, rawPosMs() / 1000 / dur)) : 0;
  progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
}

/** 染色混色公式与 .np-kara-host（正在播放页逐字歌词）同源：accent 55% 洗白进 #fff。
 *  取色源（封面 accent / 系统 systemAccent）由主窗桥随曲目镜像带来 —— 本窗不调 API；
 *  控制条封面只是镜像里给的缩略图 URL。 */
const mixInk = (hex: string | null | undefined): string =>
  hex ? `color-mix(in srgb, ${hex} 55%, #fff)` : "#fff";

function lyricInk(): string {
  const mode = getDesktopLyricsColorMode();
  if (mode === "cover") return mixInk(track?.accent);
  if (mode === "system") return mixInk(track?.systemAccent);
  if (mode === "custom") return getDesktopLyricsColor();
  return "#fff";
}

/**
 * ── 排版内核：固定视口 + clip-path 窗口 + 「文字块」测心 ──
 *
 * 播放器宿主（#dl-clip）高度恒定（字号×7.5），换行/加行都不改它 —— 没有重排风暴；
 * 可见条带用 clip-path inset 开在这个恒定视口上（合成器属性 + CSS transition 平滑伸缩）。
 *
 * 位置与高度全部从**实测的文字盒**推导，不再用「行盒顶 + 1em」这类估算：
 *   ① 垂直居中：条带恒居中于视口，当前行要显示的**整块文字**（主行 + 翻译/音译；
 *      单行关居中 / 双行再把和声与下一行算进来）的几何中心钉到视口中心。
 *      旧版钉的是行盒顶 + 1em（≈ 主行中心）—— 翻译一挂上就变成「主行居中、整块下坠」，
 *      观感就是歌词整体偏下，这一版把整块的实测中心钉住。
 *   ② 条带高度 = 文字块高度 + 上下各 0.25em 呼吸位（< core 行间 gap 0.3em）：
 *      切不到字，也不会把上一行/和声行露进条带。
 *   ③ 一行到底 + 超长横滚：nowrap + 藏 core 的平衡 <br>（见 desktop-lyrics.css）保证不折行；
 *      文字仍比可用宽度长时，**那一行**自己横向滚 —— 翻译/音译各判各的，互不牵连。
 *      滚法是**来回滚（三角波）**：停顿 → 匀速走到末尾 → 停顿 → 匀速退回开头 → 再走…
 *      两头都不跳帧：既不会正唱着一半「闪回开头」，也不会走到末尾就死在那边不动。
 */
const BAND_PAD_EM = 0.25;      // 条带在文字块上下各留的呼吸位（em）
const MARQUEE_HOLD_MS = 700;   // 两端的停顿：给眼睛落点
const MARQUEE_SPEED_PX_S = 72; // 横向滚动速度（px/s，与字号无关，长句快慢一致）

interface Box { top: number; bottom: number; left: number; right: number }

const classOf = (el: Element): string => String((el as HTMLElement).className ?? "");
/** 任一行元素：.xxx_lyricLine（和声行是 .xxx_lyricBgLine）；排除行容器 .xxx_lyricLineWrapper。 */
const isAnyLineEl = (el: Element): boolean =>
  classOf(el).includes("lyricLine") && !classOf(el).includes("Wrapper");
/** 本行（主行组）的行元素：主行 + 翻译 + 音译挂它下面；和声行整组另行挂在 bgWrapper 里。 */
const isLineEl = (el: Element): boolean => isAnyLineEl(el) && !classOf(el).includes("BgLine");
/** 和声行容器（.xxx_bgWrapper，AMLL 把 isBG 行整组放进它；播放器的底栏容器名字也带
 *  Wrapper，一并排除）。 */
const isBgWrap = (el: Element): boolean => {
  const c = classOf(el);
  return c.includes("Wrapper") && !c.includes("lyricLine") && !c.includes("bottomLine");
};

/**
 * 文字盒：遍历元素内所有非空文本节点，取 Range 客户矩形并集。
 * 为什么不用元素矩形：AMLL 给行/词盒铺了 ±1em 的 margin/padding（逐字扫色与强调缩放
 * 要的余量），量盒子会把块高/宽虚增近一倍；文本节点的 Range 才是**肉眼看到的字**。
 */
function textBox(el: Element | null): Box | null {
  if (!el) return null;
  // 滑出去的和声行（bgWrapperHidden）只改 visibility，几何仍在 —— 显式排除，
  // 否则会把「藏起来的行」算进文字块，条带被拉长、块心被拽偏
  if (getComputedStyle(el).visibility === "hidden") return null;
  const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const rg = document.createRange();
  let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
  for (let n = nodes.nextNode(); n; n = nodes.nextNode()) {
    if (!n.nodeValue?.trim()) continue;
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {
      if (r.width <= 0 && r.height <= 0) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
    }
  }
  return Number.isFinite(top) ? { top, bottom, left, right } : null;
}

const unionBox = (bs: Array<Box | null>): Box | null => {
  let o: Box | null = null;
  for (const b of bs) {
    if (!b) continue;
    o = o
      ? { top: Math.min(o.top, b.top), bottom: Math.max(o.bottom, b.bottom), left: Math.min(o.left, b.left), right: Math.max(o.right, b.right) }
      : { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }
  return o;
};

/** 一行的「文字行元素」：主行 + 翻译 + 音译（AMLL 行元素的直接子节点，空行天然量不出盒）；
 *  withBg 时再把和声容器里的行一起收进来（单行关居中 / 双行档）。 */
function rowsOf(wrapper: HTMLElement, withBg: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  const rowsIn = (lineEl: Element): void => {
    out.push(...(Array.from(lineEl.children) as HTMLElement[]));
  };
  for (const kid of Array.from(wrapper.children) as HTMLElement[]) {
    if (isLineEl(kid)) rowsIn(kid);
    else if (withBg && isBgWrap(kid))
      for (const bg of Array.from(kid.children) as HTMLElement[]) if (isAnyLineEl(bg)) rowsIn(bg);
  }
  return out;
}

function emPx(): number {
  const v = parseFloat(getComputedStyle(root).getPropertyValue("--dl-font-size"));
  return Number.isFinite(v) && v > 0 ? v : 24;
}

/** 实测前的锚位估计：主行文字中心约在「行容器顶 + 1em」（行容器 .4em 内边距 + 行盒内 1em）。 */
function calcAlignP(): number {
  return alignFor(clip.clientHeight, emPx());
}

function setWindow(topPx: number, hPx: number): void {
  clip.style.setProperty("--dl-win-t", `${Math.round(topPx)}px`);
  clip.style.setProperty("--dl-win-h", `${Math.round(hPx)}px`);
}

/** 已生效的锚位（选行判据 s 用它：理论目标值，弹簧途中也能锁住正在到位的那行）。 */
let alignApplied = 0.35;
/** 锚位迟滞：行容器本身上下弹不影响实测块心（块与容器一起动），但和声滑入这类
 *  「块内元素自己动」的过渡帧会让读数晃 —— 第一次直接落位，之后要连续两次同读数才改。 */
let alignPending = -1;
let alignLocked = false;
/** 最近一次量到的「文字块中心 − 行容器顶边」（px）；只给调试缝看，逻辑不读它。 */
let lastCenterRel = 0;

// —— 超长行横向滚动（marquee）——
// 相位记在**行元素**上（marqueeStart）：4Hz 重测、瞬时掉出滚动集合（比如 content-visibility
// 的可见性抖动）都不能把文字弹回开头 —— 只有真的换到别一行才会拿到新的起点。
interface ScrollRow { el: HTMLElement; from: number; to: number; dist: number; tx: number; t0: number }
let scrollRows: ScrollRow[] = [];
let scrollParents = new Set<HTMLElement>();
let marqueeRaf = 0;
const marqueeStart = new Map<HTMLElement, number>();

/** 走完这段溢出距离要多久（px → ms）。 */
const marqueeTravelMs = (dist: number): number => Math.max(1, (dist / MARQUEE_SPEED_PX_S) * 1000);

/**
 * 三角波进度：0（停顿）→ 1（走到末尾）→ 1（停顿）→ 0（退回开头）→ 循环。
 * 用「绝对时间对周期取模」而不是累加位移：4Hz 重测换了 from/to 也不会让相位错位，
 * 而且两端都是连续点（掉头不回跳）—— 观感是「来回蹭」，不是「闪回开头」/「死在末尾」。
 */
function marqueeProgress(age: number, travel: number): number {
  const cycle = (MARQUEE_HOLD_MS + travel) * 2;
  const t = ((age % cycle) + cycle) % cycle;
  if (t < MARQUEE_HOLD_MS) return 0;
  if (t < MARQUEE_HOLD_MS + travel) return (t - MARQUEE_HOLD_MS) / travel;
  if (t < MARQUEE_HOLD_MS * 2 + travel) return 1;
  return 1 - (t - MARQUEE_HOLD_MS * 2 - travel) / travel;
}

function stopMarquee(): void {
  if (marqueeRaf) window.cancelAnimationFrame(marqueeRaf);
  marqueeRaf = 0;
}

function resetMarquee(): void {
  stopMarquee();
  for (const r of scrollRows) r.el.style.removeProperty("translate");
  for (const p of scrollParents) p.classList.remove("dl-scrolling");
  scrollRows = [];
  scrollParents = new Set();
  marqueeStart.clear(); // 行元素随渲染一起没了，起点表跟着清
}

function marqueeTick(): void {
  marqueeRaf = 0;
  if (!scrollRows.length) return;
  const now = performance.now();
  for (const r of scrollRows) {
    const k = marqueeProgress(now - r.t0, marqueeTravelMs(r.dist));
    const tx = r.from + (r.to - r.from) * k;
    r.tx = tx;
    r.el.style.translate = `${tx.toFixed(1)}px 0`;
  }
  // 长句还在，就继续转（来回滚是常态，不是一次性动画）
  marqueeRaf = window.requestAnimationFrame(marqueeTick);
}

/** 登记要滚的行：可用宽度 = 行容器的**内容盒**（core 给了 1em 左右内边距，
 *  滚动起止都停在这条内边距上，字不会顶到窗口边）。
 *  量测必须先减掉该行当前已施加的位移，否则 4Hz 的重测会把「滚到一半」当成新宽度。 */
function updateMarquee(rows: HTMLElement[], wrapper: HTMLElement): void {
  const wr = wrapper.getBoundingClientRect();
  const cs = getComputedStyle(wrapper);
  const aL = wr.left + (parseFloat(cs.paddingLeft) || 0);
  const aR = wr.right - (parseFloat(cs.paddingRight) || 0);
  const applied = new Map<HTMLElement, number>();
  for (const r of scrollRows) applied.set(r.el, r.tx);
  const next: ScrollRow[] = [];
  for (const row of rows) {
    const b = textBox(row);
    if (!b) continue;
    const cur = applied.get(row) ?? 0;
    const range = scrollRange(aL, aR, b.left - cur, b.right - cur);
    if (!range) continue;
    const lineEl = row.parentElement ?? row; // 「同一行」相位按行元素记（主行/翻译/音译同一条）
    let t0 = marqueeStart.get(lineEl);
    if (t0 === undefined) { t0 = performance.now(); marqueeStart.set(lineEl, t0); }
    next.push({ el: row, ...range, tx: cur, t0 });
  }
  for (const r of scrollRows) if (!next.some((n) => n.el === r.el)) r.el.style.removeProperty("translate");
  scrollRows = next;
  scrollParents = new Set();
  for (const r of scrollRows) {
    const parent = r.el.parentElement; // 行元素（.xxx_lyricLine）：.dl-scrolling 摘掉它的 paint containment
    if (parent) { parent.classList.add("dl-scrolling"); scrollParents.add(parent); }
  }
  if (scrollRows.length) { if (!marqueeRaf) marqueeRaf = window.requestAnimationFrame(marqueeTick); }
  else stopMarquee();
}

function applyPlayerLayout(): void {
  const player = amllPlayerByHost.get(clip);
  if (player) {
    player.setHidePassedLines(true);
    player.setAlignAnchor(LayoutAlignAnchor.Top);
    alignApplied = calcAlignP(); // 先用估计值起手：选中当前行后由 tightenStrip 换成实测值
    alignPending = -1;
    alignLocked = false;
    player.setAlignPosition(alignApplied);
  }
  stripApplied = -1;
  stripTop = -1;
  stripPending = -1;
  stripPendingTop = -1;
  resetMarquee();
  tightenStrip(true);
}

// —— 逐行窗口几何 ——
// 选行判据：行容器**顶边**最贴近 s（s = 已生效锚位 × 视口高 = 理论目标位置；
// 弹簧过渡帧里也能稳定选中正在到位的那一行）。双行的下一行 = 顶边 ≥ 当前行底边的最小者。
const STRIP_MIN_MS = 120;
let stripApplied = -1; // 已写入的条带高度（迟滞基准；-1 = 本次渲染还没写过）
let stripTop = -1;     // 已写入的条带顶边
let stripPending = -1;
let stripPendingTop = -1;
let stripLastAt = 0;

function tightenStrip(force = false): void {
  const now = performance.now();
  if (!force && now - stripLastAt < STRIP_MIN_MS) return;
  stripLastAt = now;
  const H0 = clip.clientHeight;
  if (H0 < 40) return;
  const playerEl = clip.firstElementChild as HTMLElement | null; // renderAmll 挂进来的 .amll-lyric-player
  if (!playerEl) return;
  const clipTop = clip.getBoundingClientRect().top;
  const s = alignApplied * H0;
  const dual = getDesktopLyricsMode() === "dual";
  const boxes: Array<{ el: HTMLElement; top: number; bottom: number; height: number }> = [];
  for (const kid of Array.from(playerEl.children) as HTMLElement[]) {
    if (!kid.innerText?.trim()) continue; // 间奏点等无字元素不算行
    const r = kid.getBoundingClientRect();
    boxes.push({ el: kid, top: r.top - clipTop, bottom: r.bottom - clipTop, height: r.height });
  }
  let active: (typeof boxes)[number] | null = null;
  let bestD = Infinity;
  for (const b of boxes) {
    const d = Math.abs(b.top - s);
    if (d < bestD) { bestD = d; active = b; }
  }
  // 认不出当前行就不写：落位前所有行都挤在 0，谁都不该被当真（0.5 行高 = 明显偏离锚点）
  if (!active || bestD > active.height * 0.5) return;

  // 当前行要显示的整块文字：主行 + 翻译/音译；单行关居中 / 双行再把和声与下一行并进来
  const withBg = dual || !getDesktopLyricsSingleCenter();
  const rows = rowsOf(active.el, withBg);
  if (dual) {
    let nextBox: (typeof boxes)[number] | null = null;
    for (const b of boxes) {
      if (b === active) continue;
      if (b.top >= active.bottom - 2 && (!nextBox || b.top < nextBox.top)) nextBox = b;
    }
    // 下一行的和声还没到激活态（滑在外面）——不带它，免得把条带拉成两倍高
    if (nextBox) rows.push(...rowsOf(nextBox.el, false));
  }
  const block = unionBox(rows.map(textBox));
  if (!block) return;

  // ① 锚位：把文字块**中心**钉到视口中心（旧版钉的是行盒顶 + 1em —— 翻译一挂上就整体偏低）
  const wr = active.el.getBoundingClientRect();
  const centerRel = (block.top + block.bottom) / 2 - wr.top;
  lastCenterRel = centerRel;
  const p = alignFor(H0, centerRel);
  const player = amllPlayerByHost.get(clip);
  if (player && Math.abs(p - alignApplied) > 0.002) {
    if (!alignLocked || (alignPending >= 0 && Math.abs(p - alignPending) < 0.004)) {
      alignApplied = p;
      alignLocked = true;
      alignPending = -1;
      player.setAlignPosition(p);
      // AMLL 的 calcLayout 只在**时间线状态真的变了**时才跑（换行/间奏/seek/重建…），
      // 光写 layoutConfig 不会立刻重排 —— 实测：不补这一刀，新锚位要等到下一行才生效，
      // 当前行整块就一直吊在旧位置上（这正是「歌词整体偏下」的残留来源）。
      // 用 ConfigChange 策略（snapPosY=false）是平滑重定向，不会把行切换动画拍平。
      player.calcLayout(LayoutReason.ConfigChange);
    } else {
      alignPending = p;
    }
  }

  // ② 条带：文字块高度 + 上下呼吸位；块心钉在视口中心 → 条带恒居中（与弹簧位置无关）
  const { top, h } = bandFor(H0, block.bottom - block.top, emPx() * BAND_PAD_EM);

  // ③ 超长行横向滚动（翻译/音译各判各的，互不牵连）
  updateMarquee(rows, active.el);

  // 首次直接落位（别让首帧空着等迟滞），之后连续两次同读数才写 ——
  // 过渡帧里的半排行不算数；写入只是 clip-path 数值，平滑伸缩与零重排由 CSS transition 兜着。
  if (stripApplied < 0) {
    stripApplied = h;
    stripTop = top;
    setWindow(top, h);
    return;
  }
  if (top === stripTop && h === stripApplied) { stripPending = -1; stripPendingTop = -1; return; }
  if (stripPending !== h || stripPendingTop !== top) { stripPending = h; stripPendingTop = top; return; }
  stripApplied = h;
  stripTop = top;
  stripPending = -1;
  stripPendingTop = -1;
  setWindow(top, h);
}

function applyStyle(): void {
  const font = fontCssOf(getDesktopLyricsFontList());
  if (font) root.style.setProperty("--dl-font", font);
  else root.style.removeProperty("--dl-font");
  const scale = getDesktopLyricsScale();
  root.style.setProperty("--dl-font-size", `${Math.round(24 * scale)}px`);
  const weight = getDesktopLyricsWeight();
  root.style.setProperty("--dl-font-weight", String(weight));
  weightVal.textContent = `B${weight}`;
  weightVal.title = `字重 ${weight}（点击切换 300/400/500/600/700/800/900）`;
  weightVal.setAttribute("aria-label", `当前字重 ${weight}，点击切换`);
  // 水平对齐：只有「单行 + 单行居中=开」才居中；单行关居中与双行都是左对齐。
  // 双行设置项里没有第二个对齐开关，默认左对齐是既定行为，不能被通用居中规则吃掉。
  const centerLyrics = getDesktopLyricsMode() === "single" && getDesktopLyricsSingleCenter();
  root.classList.toggle("dl-align-left", !centerLyrics);
  root.style.setProperty("--dl-border", `${getDesktopLyricsBorder()}px`);
  // 单层 text-shadow：便宜、可关、参数全由设置页控制；0 不透明度直接撤掉变量。
  const shadowOpacity = getDesktopLyricsShadowOpacity();
  if (getDesktopLyricsShadow() && shadowOpacity > 0) {
    root.style.setProperty(
      "--dl-shadow",
      `${getDesktopLyricsShadowX()}px ${getDesktopLyricsShadowY()}px ${getDesktopLyricsShadowBlur()}px rgb(0 0 0 / ${shadowOpacity})`,
    );
  } else {
    root.style.removeProperty("--dl-shadow");
  }
  root.style.setProperty("--dl-ink", lyricInk());
  // 两层不透明度分开，各管各的（别再混成一个）：
  //   • --dl-opacity（[DesktopLyrics] Opacity）= **歌词层**：淡出内容（字 + 空态提示）；悬停控件不连坐；
  //   • --dl-win-alpha（[DesktopLyrics] Backdrop）= **窗体的面**：#dl-board 那块铺满整扇窗的背板。
  // 一个挂 root（在 root 之内消费），一个挂 <html>（#dl-board 是 root 的兄弟，挂 root 传不过去）。
  docEl.style.setProperty("--dl-win-alpha", String(getDesktopLyricsBackdrop()));
  root.style.setProperty("--dl-opacity", String(getDesktopLyricsOpacity()));
  // 悬停地板：停在覆盖层上（= 要拖动的那个状态）时，内容抬到 max(设置, 0.3) —— 变量挂在 root 上
  // 供后代继承，CSS 只在 :hover 里消费，离开悬停自动回落 --dl-opacity。控件不参与（见 CSS 同段注释）。
  root.style.setProperty("--dl-hover-opacity", String(getDesktopLyricsHoverOpacity()));
  applyPlayerLayout();
}

// —— 桥事件 ——

if (bridge) {
  bridge.onTrack?.((p) => {
    track = p as DlTrackPayload;
    reRender();
    // 染色字段（accent/systemAccent）与歌词同包到货：整包重推（取色迟到补刀）时指纹未变
    // 不重渲染，但颜色必须重算 —— 否则「封面染色」档永远停在上一首的色
    root.style.setProperty("--dl-ink", lyricInk());
    syncTrackInfo();
    syncTools();
    for (const cb of [...notifyCbs]) cb();
  });
  bridge.onSync?.((p) => {
    sync = p as DlSyncPayload;
    syncAt = performance.now();
    syncTools();
    tightenStrip();
    for (const cb of [...notifyCbs]) cb();
  });
  // 主进程写盘（托盘/其它窗）后的增量广播 → 字体/字号即时跟随（lib/config 的订阅先合并快照，
  // 监听按注册顺序执行：本模块 import 时先注册 lib/config 的合并器）
  const cfgBridge = (window as any).quaverConfig;
  cfgBridge?.onChanged?.(() => {
    void Promise.resolve(loadConfig()).then(() => { applyStyle(); syncInteractionMode(); });
    syncTools();
  });
} else {
  empty.hidden = false;
  empty.textContent = "桌面歌词仅在桌面端可用（浏览器 dev 无覆盖层窗口）";
}

// —— 按钮 ——

prevBtn.onclick = () => sendCmd({ cmd: "prev" });
fontDec.onclick = () => sendCmd({ cmd: "scale", dir: -1 });
fontInc.onclick = () => sendCmd({ cmd: "scale", dir: 1 });
weightVal.onclick = () => sendCmd({ cmd: "weight", op: "cycle" });
playBtn.onclick = () => sendCmd({ cmd: "playpause" });
nextBtn.onclick = () => sendCmd({ cmd: "next" });
delayDec.onclick = () => sendCmd({ cmd: "delay", op: "step", dir: -1 });
delayInc.onclick = () => sendCmd({ cmd: "delay", op: "step", dir: 1 });
delayVal.onclick = () => sendCmd({ cmd: "delay", op: "zero" });
lockBtn.onclick = () => windowOp({ op: "lock", on: true });
closeBtn.onclick = () => windowOp({ op: "close" });
progress.onclick = (e) => {
  const dur = sync?.durationSec ?? 0;
  if (dur <= 0) return;
  const rect = progress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  sendCmd({ cmd: "seek", ms: ratio * dur * 1000 });
};

// —— 边缘缩放 ——
// 挪窗**不在这里**：整层是 CSD 拖拽区（desktop-lyrics.css 的 -webkit-app-region: drag），
// 由窗口管理器做交互移动 —— 这也是 Wayland 下唯一真能挪窗的路（setPosition 会被合成器无视）。
// 缩放没有对应的 CSS/合成器能力，只能走「指针位移 → 主进程」这条路：主进程拖动期间把**两条轴**的
// min/max 一起重钉（合成器据此夹取 —— Wayland 下 setSize 只改我们这边的视口，改不动窗体盒，
// 两个值一脱钩歌词就跑到看不见的那半张宽里去了，见 electron/desktop-lyrics-core.ts 的 pinnedHintsFor），
// 松手再发一发 resize-end 让宽度放回区间。两个分量都发。

function startDragResize(e: PointerEvent): void {
  let lastX = e.screenX;
  let lastY = e.screenY;
  let total = 0;
  const pid = e.pointerId;
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pid) return;
    const dx = ev.screenX - lastX;
    const dy = ev.screenY - lastY;
    lastX = ev.screenX;
    lastY = ev.screenY;
    if (!dx && !dy) return;
    total += Math.abs(dx) + Math.abs(dy);
    if (total > 4) windowOp({ op: "resize-by", dx, dy });
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    // 松手：把宽度那条轴放回区间（拖动期间两条轴都钉着，见主进程 releaseWidth）
    if (total > 4) windowOp({ op: "resize-end" });
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

grip.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  startDragResize(e);
});


applyStyle();
syncInteractionMode();
paintEmpty();
syncTrackInfo();
syncTools();

// 窗体尺寸（用户拖右下角把手 / 档位变化后主进程贴高）/字体迟到都会改文字盒 → 立刻重估条带、锚位与滚动量
window.addEventListener("resize", () => tightenStrip(true));
void document.fonts?.ready.then(() => tightenStrip(true));

// Crotchet 调试活体注入缝（与主窗 __player/dev 钩子同口径）：CDP / 控制台可直接喂镜像快照验渲染链路。
// 无桥页（纯浏览器开的 desktop-lyrics.html）没有实时镜像抢写状态，缝恒开 —— 排版量测就用这条确定性路。
if ((window as any).quaverCrotchet || !bridge) {
  (window as any).__dl = {
    injectTrack: (p: unknown) => { track = p as DlTrackPayload; reRender(true); syncTrackInfo(); syncTools(); for (const cb of [...notifyCbs]) cb(); },
    // 与 bridge.onSync 的生产路径逐行对齐（含 tightenStrip 的 4Hz 驱动），量测才有代表性
    injectSync: (p: unknown) => { sync = p as DlSyncPayload; syncAt = performance.now(); syncTools(); tightenStrip(); for (const cb of [...notifyCbs]) cb(); },
    applyStyle,
    stripDiag: () => ({
      applied: stripApplied, top: stripTop, pending: stripPending, pendingTop: stripPendingTop,
      viewH: clip.clientHeight, win: getComputedStyle(clip).clipPath.slice(0, 64),
      p: alignApplied, centerRel: +lastCenterRel.toFixed(2), pWant: +alignFor(clip.clientHeight, lastCenterRel).toFixed(4),
      pLocked: alignLocked, pPending: alignPending,
      scroll: scrollRows.map((r) => ({
        from: +r.from.toFixed(1), to: +r.to.toFixed(1), tx: +r.tx.toFixed(1),
        age: Math.round(performance.now() - r.t0),
      })),
    }),
  };
}
