// Quaver — 用户偏好（外观主题 / 字体 / 窗口装饰 CSD·SSD / 解码后端 / 音频设备 / 淡入淡出 / 音质）。
//
// 全部持久化到 quaver.conf（INI，见 electron/config.ts），通过 src/lib/config.ts 读写：
// 桌面端落 <配置目录>/quaver.conf，浏览器 dev 落 localStorage。本模块只负责
// 「内部枚举 ⇄ 配置文件取值」的映射与即时生效（CSS 变量 / Electron 桥）。
//
// 主题与字体在本模块直接落到 <html>：data-theme 驱动 style.css 的变量组，
// CSS 变量 --font-ui / --font-lyric 分别作用于界面与歌词。

import { cfg, cfgSet, cfgSetSoon } from "./config";
import { TTML_DB_DEFAULT_URL, isTtmlDatabaseUrl } from "./ttml";
import { parseHex, toHex } from "./color";
import { normalizeEqState, type EqState } from "../../electron/audio/eq-config.ts";
import type { UpdateChannel } from "./update-core";

export type ThemeMode = "system" | "light" | "dark";

export type DecorMode = "csd" | "ssd";

// —— 外观模式 ——
// 配置文件取值：dark / light / follow-system（未来还有自定义主题的 kebab-case 名）。
// 自定义主题系统未上线前，未知取值的主题名按「跟随系统」处理（不至于把人锁在坏值上）。
const CONF_TO_THEME: Record<string, ThemeMode> = { dark: "dark", light: "light", "follow-system": "system" };
const THEME_TO_CONF: Record<ThemeMode, string> = { system: "follow-system", light: "light", dark: "dark" };

export function getTheme(): ThemeMode {
  return CONF_TO_THEME[cfg("Style.Style", "dark")] ?? "system";
}

const mq = window.matchMedia("(prefers-color-scheme: dark)");

export function effectiveTheme(mode: ThemeMode = getTheme()): "light" | "dark" {
  return mode === "system" ? (mq.matches ? "dark" : "light") : mode;
}

export function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
}

export function setTheme(m: ThemeMode) {
  cfgSet({ "Style.Style": THEME_TO_CONF[m] ?? "follow-system" });
  applyTheme();
}

mq.addEventListener("change", () => { if (getTheme() === "system") applyTheme(); });

// —— 字体 ——
// 配置文件里存的就是 CSS font-family 列表（与模板示例 `Source Han Sans,Microsoft Yahei UI` 一致），
// 空值 = 不覆盖，走 style.css 的 --font-default 内置栈。设置页给的是预设，选中后把对应列表写进配置。
export interface FontPreset { label: string; css: string }

export const FONT_PRESETS: Record<string, FontPreset> = {
  system: { label: "系统默认", css: "" },
  sans: { label: "黑体（无衬线）", css: '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
  serif: { label: "宋体（衬线）", css: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif' },
  mono: { label: "等宽", css: 'ui-monospace, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace' },
};

export const FONT_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(FONT_PRESETS).map(([k, v]) => [k, v.label]),
);

/** 手改配置文件写进来的字体族列表在设置页里的占位选项值。 */
export const FONT_CUSTOM = "custom";

const normCss = (s: string) => s.trim().replace(/^["']|["']$/g, "").replace(/\s*,\s*/g, ", ").toLowerCase();

/** 配置值 → 预设名（命中预设）；否则 FONT_CUSTOM（用户自己填的字体族列表）。 */
export function fontKeyOf(value: string): string {
  const v = normCss(value || "");

  if (!v) return "system"; // 空 = 不覆盖 = 系统默认

  if (v in FONT_PRESETS) return v; // 直接写预设名（system/sans/serif/mono）也认

  for (const [k, p] of Object.entries(FONT_PRESETS)) {
    if (p.css && normCss(p.css) === v) return k;
  }

  return FONT_CUSTOM;
}

/** 清洗 + 规范化手填的 font-family 列表：只留字体名里合法的字符
 *  （字母 / 数字 / CJK / 空格 / 逗号 / 引号 / 点 / 连字符 / 下划线 / 加号），内部空白收敛，
 *  逗号两侧统一成一个空格，空项丢掉。空串合法（= 不覆盖）。比 electron/config.ts 的
 *  isFontList（拦结构字符与 url(）更严 —— 前端清洗后的值一定能过后端校验。 */
export function normalizeFontList(s: string): string {
  return (s || "")
    .replace(/[^\p{L}\p{N}\s,'"_.+-]/gu, " ")
    .split(",")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ");
}

/** 配置值 → 可直接写入 CSS 变量的 font-family；空串表示不覆盖。
 *  预设名简写（手填 conf 写 `sans`）在这里展开成族列表 —— 否则 `font-family: sans`
 *  是无效声明，会整条 font 简写失效、字变成浏览器默认的衬线体。 */
export function fontCssOf(value: string): string {
  const v = (value || "").trim();

  if (!v) return "";

  return v in FONT_PRESETS ? FONT_PRESETS[v].css : v;
}

export const getUiFont = () => fontKeyOf(cfg("Style.DefaultUIFonts"));
export const getLyricFont = () => fontKeyOf(cfg("Style.DefaultLyricsFonts"));

/** 设置页输入框回填用：配置里写的是什么就显示什么（保留用户的大小写与引号，不走归一）。 */
export const getUiFontList = () => cfg("Style.DefaultUIFonts");
export const getLyricFontList = () => cfg("Style.DefaultLyricsFonts");

/** 直接写 font-family 列表（设置页输入框用）。
 *  输入是逐字符的 → 落盘合并到 400ms；applyFonts 读的是已同步更新的内存快照，预览即时。 */
export function setUiFontList(css: string) {
  cfgSetSoon({ "Style.DefaultUIFonts": normalizeFontList(css) }, 400);
  applyFonts();
}

export function setLyricFontList(css: string) {
  cfgSetSoon({ "Style.DefaultLyricsFonts": normalizeFontList(css) }, 400);
  applyFonts();
}

/** 下拉选预设：把该预设的族列表写进配置（FONT_CUSTOM = 保持输入框现有内容，不动配置）。 */
export function setUiFontPreset(key: string) {
  if (key === FONT_CUSTOM) return;
  setUiFontList(FONT_PRESETS[key]?.css ?? "");
}

export function setLyricFontPreset(key: string) {
  if (key === FONT_CUSTOM) return;
  setLyricFontList(FONT_PRESETS[key]?.css ?? "");
}

export function applyFonts() {
  const r = document.documentElement.style;
  const ui = fontCssOf(cfg("Style.DefaultUIFonts"));
  const ly = fontCssOf(cfg("Style.DefaultLyricsFonts"));

  if (ui) r.setProperty("--font-ui", ui); else r.removeProperty("--font-ui");

  if (ly) r.setProperty("--font-lyric", ly); else r.removeProperty("--font-lyric");
}

// —— 默认主题的背景（环境色层）：模式 + 自定义图 + 流动速度 ——
// 模式落在 quaver.conf 的 [Style] Background（off / cover / custom，**默认 off**：不开环境色层，
// 只有主题底色），自定义图的路径落在 BackgroundImage（由设置页的原生选图写进来，主进程读它、
// 经同源 /api/bg 交给界面），流动速度落在 BackgroundFlow（AMLL setFlowSpeed 的系数）。
// 这里**只**管「内部枚举 ⇄ 配置取值」：DOM 归 src/lib/ambient.ts —— prefs 被 player/api
// 反向依赖，不能反过来 import 渲染层的东西（成环）。改完要自己调 applyBackground()。
export type BackgroundMode = "off" | "cover" | "custom";

/** 背景呈现风格：quaver = Quaver Design 封面模糊铺底（默认）；mesh = AMLL 网格流动渐变。 */
export type BackgroundRenderer = "quaver" | "mesh";

const CONF_TO_BG: Record<string, BackgroundMode> = { off: "off", cover: "cover", custom: "custom" };

export function getBackgroundMode(): BackgroundMode {
  return CONF_TO_BG[cfg("Style.Background", "off")] ?? "off";
}

export function setBackgroundMode(m: BackgroundMode) {
  cfgSet({ "Style.Background": CONF_TO_BG[m] ?? "off" });
}

export function getBackgroundImage(): string {
  return cfg("Style.BackgroundImage").trim();
}

export function setBackgroundImage(path: string) {
  cfgSet({ "Style.BackgroundImage": (path ?? "").trim() });
}

const CONF_TO_BG_RENDERER: Record<string, BackgroundRenderer> = { quaver: "quaver", mesh: "mesh" };

/** 首页（主窗环境层）的背景风格。 */
export function getBackgroundRenderer(): BackgroundRenderer {
  return CONF_TO_BG_RENDERER[cfg("Style.BackgroundRenderer", "quaver")] ?? "quaver";
}

export function setBackgroundRenderer(r: BackgroundRenderer) {
  cfgSet({ "Style.BackgroundRenderer": CONF_TO_BG_RENDERER[r] ?? "quaver" });
}

/** 正在播放页（歌词页）的背景风格 —— 与首页互不影响。 */
export function getNpBackgroundRenderer(): BackgroundRenderer {
  return CONF_TO_BG_RENDERER[cfg("Style.NpBackgroundRenderer", "quaver")] ?? "quaver";
}

export function setNpBackgroundRenderer(r: BackgroundRenderer) {
  cfgSet({ "Style.NpBackgroundRenderer": CONF_TO_BG_RENDERER[r] ?? "quaver" });
}

export const BG_FLOW_MIN = 0;
export const BG_FLOW_MAX = 2;
export const BG_FLOW_DEFAULT = 1;

/** AMLL 背景流动速度（setFlowSpeed 系数）。空值/非数值回落默认；越界夹紧。 */
export function getBackgroundFlow(): number {
  const raw = cfg("Style.BackgroundFlow", String(BG_FLOW_DEFAULT)).trim();

  if (!raw) return BG_FLOW_DEFAULT; // Number("") === 0 的坑：空值 ≠ 停住
  const n = Number(raw);

  if (!Number.isFinite(n)) return BG_FLOW_DEFAULT;

  return Math.min(BG_FLOW_MAX, Math.max(BG_FLOW_MIN, n));
}

/** 拖滑块是高频项 → 合并落盘（与音量同一套）。 */
export function setBackgroundFlow(v: number) {
  const clamped = Math.max(BG_FLOW_MIN, Math.min(BG_FLOW_MAX, Number.isFinite(v) ? v : BG_FLOW_DEFAULT));
  cfgSetSoon({ "Style.BackgroundFlow": String(clamped) });
}

// —— 界面毛玻璃（[Style] MenuBlur）——
// 一棵开关：开 = 半透明玻璃底 + backdrop 模糊（侧栏 / Content View / 浮窗播放列表 /
// 右键菜单 / 音质·播放模式·音量浮窗 / 正在播放页「更多操作」菜单 / 音频流信息浮窗）；
// 关 = 菜单换实底；侧栏 / Content View / 播放条保持透明表面但完全不模糊。
// 这里同样**只**管「布尔 ⇄ 配置取值」：写 DOM 属性的那侧在 src/lib/menu-glass.ts
// （prefs 被 player/api 反向依赖，不能反过来 import 渲染层模块），主题归属策略在
// src/sparkle/theme-menus.ts。默认开（与 schema 的 def 同值）。
export function getMenuBlur(): boolean {
  return !/^(false|0|no)$/i.test(cfg("Style.MenuBlur", "True"));
}

export function setMenuBlur(v: boolean) {
  cfgSet({ "Style.MenuBlur": v ? "True" : "False" });
}

// —— 正在播放页频谱可视化（[Style] Spectrum / SpectrumMode）——
// 模式 id 统一走小写 kebab-case：宿主内置 bars/mirror/wave，Sparkle 插件可注册更多。
// 插件被停用/未安装时，持久化的插件模式会自然回落 bars（见 lib/spectrum-render.ts 的查找）。
export type BuiltinSpectrumMode = "bars" | "mirror" | "wave";

export const BUILTIN_SPECTRUM_MODES: readonly BuiltinSpectrumMode[] = ["bars", "mirror", "wave"];
const SPECTRUM_MODE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function getSpectrumEnabled(): boolean {
  return !/^(false|0|no)$/i.test(cfg("Style.Spectrum", "False"));
}

export function setSpectrumEnabled(v: boolean) {
  cfgSet({ "Style.Spectrum": v ? "True" : "False" });
}

export function getSpectrumMode(): string {
  const v = cfg("Style.SpectrumMode", "bars").trim().toLowerCase();

  return SPECTRUM_MODE_ID.test(v) ? v : "bars";
}

export function setSpectrumMode(id: string) {
  const v = String(id ?? "").trim().toLowerCase();

  if (!SPECTRUM_MODE_ID.test(v)) return;
  cfgSet({ "Style.SpectrumMode": v });
}

// —— 播放控制条：底部停靠（默认）｜Content View 内悬浮 ——
// 配置值落在 [Style] ControlBar；DOM 状态挂 body（class + data-control-bar），
// 布局与动画只消费 style.css 的 --control-bar-* 令牌。Sparkle 主题/样式层可直接覆盖
// 这些令牌或按 body[data-control-bar="floating"] 重画形态，不需要改渲染层。
export type ControlBarMode = "bottom" | "floating";

const CONTROL_BAR_MODES: readonly string[] = ["bottom", "floating"];

export function getControlBarMode(): ControlBarMode {
  const v = cfg("Style.ControlBar");

  return CONTROL_BAR_MODES.includes(v) ? (v as ControlBarMode) : "bottom";
}

export function applyControlBarMode(mode: ControlBarMode = getControlBarMode()) {
  document.body.classList.toggle("control-bar-floating", mode === "floating");
  document.body.dataset.controlBar = mode;
}

export function setControlBarMode(m: ControlBarMode) {
  cfgSet({ "Style.ControlBar": CONTROL_BAR_MODES.includes(m) ? m : "bottom" });
  applyControlBarMode();
}

// —— 歌单显示模式：菜单栏（默认）｜歌单集合页 ——
// 配置值落在 [Style] PlaylistMode；DOM 状态挂 body（data-playlist-mode + body.playlist-collection），
// 侧栏布局与歌单集合页只按这两个状态走，不互相找节点。Sparkle 主题可用 theme.playlistMode
// 接管（策略在 src/sparkle/theme-playlist-mode.ts，应用入口在 src/lib/playlist-mode.ts）。
export type PlaylistMode = "menu" | "collection";

const PLAYLIST_MODES: readonly string[] = ["menu", "collection"];

export function getPlaylistMode(): PlaylistMode {
  const v = cfg("Style.PlaylistMode");

  return PLAYLIST_MODES.includes(v) ? (v as PlaylistMode) : "menu";
}

// 切换形态走「淡出 → 换布局 → 淡入」两拍：两态之间差的正是 display:none 的整块撤走/回来、
// 再加上导航按钮从顶部挪到居中 —— 这些都是瞬间跳变，直接切很生硬。做法：先挂 body.pl-mode-out
// 让侧栏「导航 + 歌单区」淡出，等淡出走完再落新布局（换布局那一瞬正好落在透明度 0，看不见跳变），
// 再换成 body.pl-mode-in 淡入。用 keyframes 而不是 transition，是因为刚 display:none→block 的节点
// 没有「前值」可插值、带动画的 from 才可靠地从 0 起播（两套动画与时长都在 style.css）。
// 首屏（还没上过屏）与同态重放（换了主题但形态没变）都不播，免得开屏闪一下。
const MODE_FADE_OUT_MS = 150; // 与 style.css .pl-mode-out 的动画时长对齐
const MODE_FADE_IN_MS = 180; // 与 style.css .pl-mode-in 的动画时长对齐

/** 上一次真正落到 body 的形态；null = 首屏还没上过屏（用来区分「真变了」与「同态重放」）。 */
let paintedPlaylistMode: PlaylistMode | null = null;

/** 在途两拍的票据：连点 / 主题连切时只认最后一次，旧回调作废。 */
let modeFadeTicket = 0;

const commitPlaylistMode = (mode: PlaylistMode) => {
  document.body.classList.toggle("playlist-collection", mode === "collection");
  document.body.dataset.playlistMode = mode;
};

export function applyPlaylistModeKind(mode: PlaylistMode = getPlaylistMode()) {
  const prev = paintedPlaylistMode;
  paintedPlaylistMode = mode;
  const body = document.body;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 首屏 / 同态重放 / 用户关了动效：直接落终态，并把在途的两拍一并作废。
  if (prev === null || prev === mode || still) {
    modeFadeTicket++;
    body.classList.toggle("pl-mode-out", false);
    body.classList.toggle("pl-mode-in", false);
    commitPlaylistMode(mode);

    return;
  }

  const ticket = ++modeFadeTicket;
  body.classList.toggle("pl-mode-in", false); // 上一拍的淡入若没走完，先撤掉再淡出
  body.classList.toggle("pl-mode-out", true);
  window.setTimeout(() => {
    if (ticket !== modeFadeTicket) return; // 期间又切了：交给最新那次接管
    commitPlaylistMode(mode);
    body.classList.toggle("pl-mode-out", false);
    body.classList.toggle("pl-mode-in", true); // 与换布局同一拍挂上：from(0) 起播，新露面的节点也吃得到
    window.setTimeout(() => {
      if (ticket === modeFadeTicket) body.classList.toggle("pl-mode-in", false);
    }, MODE_FADE_IN_MS);
  }, MODE_FADE_OUT_MS);
}

export function setPlaylistMode(m: PlaylistMode) {
  cfgSet({ "Style.PlaylistMode": PLAYLIST_MODES.includes(m) ? m : "menu" });
  applyPlaylistModeKind();
}

// —— 界面高亮色（tint）：--cvg-accent / --cvg-glow 的来源 ——
// 四档落在 quaver.conf 的 [Style] Tint（default=固定青色｜cover=跟随封面｜system=系统强调色｜
// custom=自定义色），自定义色的取值落在 TintColor（#rrggbb）。这里同样**只**管「枚举 ⇄ 配置取值」：
// 写 CSS 变量的 DOM 侧在 src/lib/tint.ts（prefs 被 player/api 反向依赖，不能反过来 import 渲染层模块）。
export type TintMode = "default" | "cover" | "system" | "custom";

const TINT_MODES: readonly string[] = ["default", "cover", "system", "custom"];

/** 默认档的固定色 —— 就是主题里那条「播放进度条青色」（style.css 的 --cyan）。
 *  它是本功能的出厂色：不跟封面跑，也不随明暗主题换色相（只有亮度锚在主题 token 上）。 */
export const TINT_DEFAULT_COLOR = "#19c2d8";

export function getTintMode(): TintMode {
  const v = cfg("Style.Tint", "default");

  return TINT_MODES.includes(v) ? (v as TintMode) : "default";
}

export function setTintMode(m: TintMode) {
  cfgSet({ "Style.Tint": TINT_MODES.includes(m) ? m : "default" });
}

/** 自定义色。读回来一律是规范小写 6 位（手改 conf 写 `#0ff` 也归一）；
 *  解析不了的取值（手误写进来的别的字符串）回落默认色，不让它流进 CSS 变量。 */
export function getTintColor(): string {
  const c = parseHex(cfg("Style.TintColor"));

  return c ? toHex(c) : TINT_DEFAULT_COLOR;
}

/** 写自定义色：只接受能解析的颜色字面量（输入框里正在敲的半截值直接丢弃，不改色也不落盘）。 */
export function setTintColor(hex: string) {
  const c = parseHex(hex);

  if (!c) return;
  // 拖色相条 / 连打数字是高频项 → 合并落盘；改色本身即时生效（调用方补一次 applyTint()）
  cfgSetSoon({ "Style.TintColor": toHex(c) }, 200);
}

// —— 窗口装饰：CSD=自绘（右上角平铺按钮簇，无标题栏/无浮窗底）；SSD=系统标题栏（Electron 重建窗口生效） ——
export function getDecor(): DecorMode {
  return cfg("Window.Decor") === "ssd" ? "ssd" : "csd";
}

export function applyDecor() {
  document.body.classList.toggle("ssd", getDecor() === "ssd");
}

export function setDecor(m: DecorMode) {
  cfgSet({ "Window.Decor": m });
  applyDecor();
  const bridge = (window as any).quaverCSD;

  if (bridge?.setDecor) bridge.setDecor(m); // Electron：主进程改 frame 并重建窗口
}

// —— 播放模式：
//    MPV        = 原生直出（默认，mpv 自己打开音频设备）
//    MPVCompat  = 原生（兼容）：mpv 解码，PCM 交给 renderer WebAudio 出声
//    Blink      = 浏览器 <audio>（兜底/对照，配置文件里写 Chromium）
//    偏好只决定启动选择；引擎不可用时播放器自动落 Blink 并在设置页提示。 ——
export type DecodeBackend = "MPV" | "MPVCompat" | "Blink";

export function getDecode(): DecodeBackend {
  const v = cfg("Playing.Backend");

  if (v === "Chromium" || v === "Blink") return "Blink";

  if (v === "MPVCompat") return "MPVCompat";

  return "MPV";
}

export function setDecode(v: DecodeBackend) {
  cfgSet({ "Playing.Backend": v === "Blink" ? "Chromium" : v });
}

// —— 音频输出设备（仅原生直出）：mpv audio-device 名（"auto" = 系统默认）。
//    引擎拉起/重拉后据此应用；原生兼容与 Blink 后端都不消费此偏好。 ——
export function getAudioDevice(): string {
  return cfg("Playing.AudioDevice") || "auto";
}

export function setAudioDevice(id: string) {
  cfgSet({ "Playing.AudioDevice": id || "auto" });
}

// —— 淡入淡出（仅原生后端）：起播淡入 / 暂停与切歌淡出。直出走 MPV 包络，兼容走 renderer GainNode。 ——
export type FadePreset = "off" | "short" | "normal" | "long";

export const FADE_PRESETS: Record<FadePreset, { inMs: number; outMs: number }> = {
  off: { inMs: 0, outMs: 0 },
  short: { inMs: 150, outMs: 120 },
  normal: { inMs: 400, outMs: 250 },
  long: { inMs: 800, outMs: 500 },
};

export function getFade(): FadePreset {
  const v = cfg("Playing.Fade");

  return v === "off" || v === "short" || v === "long" ? v : "normal";
}

export function setFade(v: FadePreset) {
  cfgSet({ "Playing.Fade": v });
}

export function getFadeMs() { return FADE_PRESETS[getFade()]; }

// —— 音量 / 静音：0..1 浮点，静音时保留原值（恢复即回）。音量是拖拽高频项 → 合并落盘。 ——
export function getVolume(): number {
  const v = Number(cfg("Playing.Volume", "0.8"));

  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
}

export function setVolume(v: number) {
  cfgSetSoon({ "Playing.Volume": String(Math.max(0, Math.min(1, v))) });
}

export function getMuted(): boolean {
  return /^(true|1|yes)$/i.test(cfg("Playing.Muted"));
}

export function setMuted(m: boolean) {
  cfgSet({ "Playing.Muted": m ? "True" : "False" });
}

// —— Quark EQ（仅原生后端）：直出走 MPV af，兼容走 renderer BiquadFilter；整段 JSON 存在 [Playing] Equalizer。
//    读写都经过共享 normalize：手改配置的坏字段/越界值不会把 mpv 的 af 串搞坏。
//    拖节点是高频写 → cfgSetSoon 合并落盘；播放器侧另有一条实时下发链，不等磁盘。 ——
export function getEqualizerState(): EqState {
  const raw = cfg("Playing.Equalizer", "");

  if (!raw.trim()) return normalizeEqState(null);

  try { return normalizeEqState(JSON.parse(raw)); }
  catch { return normalizeEqState(null); }
}

export function setEqualizerState(s: EqState) {
  const next = normalizeEqState(s);
  cfgSetSoon({ "Playing.Equalizer": JSON.stringify(next) }, 300);
}

// —— 「上一首」按钮逻辑：replay=单击先把当前曲从头重放、双击跳到队列里的上一首（默认）；previous=单击直接跳到队列里的上一首。
//    播放条按钮与 MPRIS/媒体键共用 player.prev() 一个入口，每次点击现读内存快照 → 设置页改完即时生效；
//    双击=播放条原生 dblclick；媒体键/热键走 player.prevPress() 的时间窗连按判定（400ms）。 ——
export type PrevBehavior = "replay" | "previous";

export function getPrevBehavior(): PrevBehavior {
  // 默认开（重放）：只有明确写 False 档才关闭，手误写进来的值回落默认
  return /^(false|0|no)$/i.test(cfg("Playing.PrevReplay", "True")) ? "previous" : "replay";
}

export function setPrevBehavior(v: PrevBehavior) {
  cfgSet({ "Playing.PrevReplay": v === "replay" ? "True" : "False" });
}

// —— 播放音频时睡眠禁止（默认开）：仅阻止系统睡眠，屏幕熄灭/锁屏策略不受影响。
//    执行端在 Go sidecar（vendor/Typhoeus-go/inhibit）：Linux=Logind sleep inhibitor
//    （Hyprland 门户会假成功，故不以门户应答为准）；Windows=PowerRequestSystemRequired；
//    macOS=IOKit PreventUserIdleSystemSleep。渲染层经 src/lib/inhibit.ts 驱动。 ——
export function getInhibitSleep(): boolean {
  // 默认开：只有明确写 False 档才关闭，手误写进来的值回落默认
  return !/^(false|0|no)$/i.test(cfg("Playing.InhibitSleep", "True"));
}

export function setInhibitSleep(v: boolean) {
  cfgSet({ "Playing.InhibitSleep": v ? "True" : "False" });
}

// 听歌时长上报（[Playing] ReportListenTime，默认开）：只统计真实出声时间，
// 满 60 秒经 sidecar 提交到 QQ 音乐音响力；关闭立即停止累计并丢弃未发送尾段。
export function getReportListenTime(): boolean {
  return !/^(false|0|no)$/i.test(cfg("Playing.ReportListenTime", "True"));
}

export function setReportListenTime(v: boolean) {
  cfgSet({ "Playing.ReportListenTime": v ? "True" : "False" });
}

// —— 在线音乐本地缓存（设置-通用）：上限 / 清理。加密与落盘执行端在 Go sidecar。 ——
export const MUSIC_CACHE_MIN_MB = 256;
export const MUSIC_CACHE_MAX_MB = 32768;

export function getMusicCacheLimitMB(): number {
  const v = Number(cfg("Playing.MusicCacheLimitMB", "2048"));

  if (!Number.isInteger(v) || v < 0) return 2048;
  return Math.min(v, MUSIC_CACHE_MAX_MB);
}

export function setMusicCacheLimitMB(v: number) {
  const n = Math.max(0, Math.min(MUSIC_CACHE_MAX_MB, Math.round(v)));

  cfgSet({ "Playing.MusicCacheLimitMB": String(n) });
}

// —— 歌词辅助行：关闭 / 翻译 / 音译。翻译与音译是替换关系，且都在歌词**下方**那一行 ——
//    翻译档：优先翻译，本行没翻译则回落音译；音译档：优先音译，本行没音译则回落翻译。
//    规则只有 src/lyric.ts 的 pickAux 一份：行级视图与内置歌词引擎（src/lyrics/amll.ts）都
//    用它；np-view 交出去的行级 trans 已按档位挑好；vendor 里的 flowscape 主题另有 auxText
//    （在 submodule 里 import 不到宿主，改规则时那一处要手动跟）。
//    清单与理由见 ui/AGENTS.md「歌词辅助行」。音译是 romaji/拼音这类「整行换套读音」，
//    不是日文振假名那种词上方注音（那是 Ruby，来自 QRC 的 [kana:] 标签，见 src/lyrics/qrc-kana.ts）。
export type LyricAuxMode = "off" | "translation" | "romanization";

export const LYRIC_AUX_MODES: LyricAuxMode[] = ["off", "translation", "romanization"];

export function getLyricAux(): LyricAuxMode {
  const raw = cfg("Style.LyricAux", "translation").trim().toLowerCase();

  if (raw === "off" || raw === "romanization") return raw;

  if (raw === "translation") {
    // 翻译档要求 ShowTranslation=True；旧配置只有 ShowTranslation=False 时按关闭处理
    return !/^(false|0|no)$/i.test(cfg("Style.ShowTranslation", "True")) ? "translation" : "off";
  }

  // 瞎写的 LyricAux 回落到 ShowTranslation 布尔
  return !/^(false|0|no)$/i.test(cfg("Style.ShowTranslation", "True")) ? "translation" : "off";
}

export function setLyricAux(mode: LyricAuxMode) {
  cfgSet({ "Style.LyricAux": mode, "Style.ShowTranslation": mode === "translation" ? "True" : "False" });
}

// 旧入口/插件门面：非 off 即显示辅助行（两档都总有一路上屏，所以 off 之外都算「开」）
export function getShowTrans(): boolean { return getLyricAux() !== "off"; }

export function setShowTrans(v: boolean) { setLyricAux(v ? "translation" : "off"); }

// —— 正在播放页行级（LRC）歌词缩放：字号与行距随同一系数放大/缩小（0.7..1.5，1=默认）。
//    只作用于行级歌词；逐字（QRC/AMLL）模式的排版由 AMLL 自己的变量管理。调节走
//    滚轮/按钮连点，属高频项 → cfgSetSoon 合并落盘。 ——
export const LYRIC_SCALE_MIN = 0.7;
export const LYRIC_SCALE_MAX = 1.5;
export const LYRIC_SCALE_STEP = 0.1;

export function getLyricScale(): number {
  const n = Number(cfg("Style.LyricScale", "1"));

  if (!Number.isFinite(n)) return 1;

  return Math.min(LYRIC_SCALE_MAX, Math.max(LYRIC_SCALE_MIN, n));
}

export function setLyricScale(v: number) {
  const clamped = Math.min(LYRIC_SCALE_MAX, Math.max(LYRIC_SCALE_MIN, v));
  cfgSetSoon({ "Style.LyricScale": String(Math.round(clamped * 100) / 100) });
}

// —— 正在播放页歌词列布局：默认 / 全高 / 隐藏已播放行 / 全高并隐藏已播放行。
//     全高由 .np-lyrics-full 控制，并让频谱开启态自动把底边抬到可视化上方；
//     隐藏已播放行由 .np-hide-played（行级）与 AMLL 的 setHidePassedLines（逐字）共同执行。 ——
export type NpLyricLayout = "default" | "full" | "hide-played" | "full-hide-played";

export const NP_LYRIC_LAYOUTS: NpLyricLayout[] = ["default", "full", "hide-played", "full-hide-played"];

export function getNpLyricLayout(): NpLyricLayout {
  const raw = cfg("Style.LyricLayout", "default").trim().toLowerCase() as NpLyricLayout;

  return NP_LYRIC_LAYOUTS.includes(raw) ? raw : "default";
}

export function setNpLyricLayout(v: NpLyricLayout) {
  cfgSet({ "Style.LyricLayout": NP_LYRIC_LAYOUTS.includes(v) ? v : "default" });
}

/** 全高档：歌词/逐字歌词容器铺满安全高度。 */
export const npLyricFullHeight = () => {
  const m = getNpLyricLayout();

  return m === "full" || m === "full-hide-played";
};

/** 隐藏已播放行档：当前行之前的歌词不显示，但仍留在滚动容器里，滚轮翻阅不受影响。 */
export const npLyricHidePlayed = () => {
  const m = getNpLyricLayout();

  return m === "hide-played" || m === "full-hide-played";
};


// —— 歌词设置（[Lyrics] 段）：繁简转换 / 在线 TTML 开关 / TTML 数据库地址 / 本地 TTML 歌词库目录 ——
// 全部走 quaver.conf；渲染层只读快照（启动一次性装载），写盘即时同步主进程。判据与
// electron/config.ts 的 schema 值域同规（改一处要改两处）：TTML 地址模板的合法性由 ttml.ts
// 的 isTtmlDatabaseUrl 把关（与写盘侧 isTtmlDatabaseUrlTemplate 对齐），本地库目录沿用「非控制字符 + 长度」口径。
export type ChineseConvert = "off" | "simplified" | "traditional";

const CONF_CHINESE: Record<string, ChineseConvert> = { off: "off", simplified: "simplified", traditional: "traditional" };

export function getChineseConvert(): ChineseConvert {
  // 未知/瞎写回落 off：转换是锦上添花，坏值宁可显示原文也别拿一套没验证的词典去改歌词
  return CONF_CHINESE[cfg("Lyrics.ChineseConvert", "off").trim().toLowerCase()] ?? "off";
}

export function setChineseConvert(v: ChineseConvert) {
  cfgSet({ "Lyrics.ChineseConvert": v });
}

export function getOnlineTtml(): boolean {
  // 默认开：只有在明确写关闭档才停。逐字缺位时才补一次查询（口径见 src/player.ts + schema 注释）
  return !/^(false|0|no)$/i.test(cfg("Lyrics.OnlineTtml", "True"));
}

export function setOnlineTtml(v: boolean) {
  cfgSet({ "Lyrics.OnlineTtml": v ? "True" : "False" });
}

export function getTtmlDatabase(): string {
  // 空 / 非法一律回落默认模板：地址坏了宁可打公共镜像，也别拼出个必 404 的请求或让歌词链路吃字符串异常
  const raw = cfg("Lyrics.TtmlDatabase", TTML_DB_DEFAULT_URL).trim();

  return isTtmlDatabaseUrl(raw) ? raw : TTML_DB_DEFAULT_URL;
}

export function setTtmlDatabase(v: string) {
  const t = String(v ?? "").trim();
  cfgSet({ "Lyrics.TtmlDatabase": isTtmlDatabaseUrl(t) ? t : TTML_DB_DEFAULT_URL });
}

export function getTtmlLibrary(): string {
  // 本地 TTML 歌词库目录：留空 = 不使用（无独立开关，非空即启用）。非控制字符 + 长度上限与背景图路径同口径。
  const raw = cfg("Lyrics.TtmlLibrary", "").trim();

  return /[\r\n\u0000]/.test(raw) || raw.length > 1024 ? "" : raw;
}

export function setTtmlLibrary(v: string) {
  const t = String(v ?? "").trim();
  cfgSet({ "Lyrics.TtmlLibrary": /[\r\n\u0000]/.test(t) || t.length > 1024 ? "" : t });
}


// —— 桌面歌词（[DesktopLyrics] 段）：总开关 / 独立字体 / 字号 / 描边 / 不透明度 ——
// 覆盖层窗口本体在主进程（electron/desktop-lyrics.ts）；这里只做「开关 + 观感」的偏好门面。
// 判据与 electron/config.ts 的 [DesktopLyrics] schema 同规（改一处要改两处）。
// 注意：开关的**生效**要走主进程控制通道（开窗/关窗），cfgSet 只落盘 —— 设置页与桥
// （src/lib/desktop-lyrics.ts）在写偏好后都会再 call control()。

/** 桌面歌词总开关（默认关）。 */
export function getDesktopLyrics(): boolean {
  return /^(true|1|yes)$/i.test(cfg("DesktopLyrics.Enabled", "False").trim());
}

export function setDesktopLyrics(v: boolean) {
  cfgSet({ "DesktopLyrics.Enabled": v ? "True" : "False" });
}

/** 固定并鼠标透穿（macOS / Windows / X11）。真正落在原生窗口上的动作在主进程；
 *  这里只写偏好，主进程 config 监听会调 syncFromConf() 立即应用。 */
export function getDesktopLyricsLocked(): boolean {
  return /^(true|1|yes)$/i.test(cfg("DesktopLyrics.Locked", "False").trim());
}

export function setDesktopLyricsLocked(v: boolean) {
  cfgSet({ "DesktopLyrics.Locked": v ? "True" : "False" });
}

export const DL_OPACITY_MIN = 0.1;
export const DL_OPACITY_MAX = 1;

/** 悬停地板：鼠标停在覆盖层上（=「可拖动」那个状态）时，歌词层至少要到 0.3。
 *  调得再透明，一悬停也该看得见这扇窗的边界；设置本身高于 0.3 就按设置来 —— 也就是说
 *  悬停只「抬到地板」，不做「hover 一律变最亮」那种重复劳动。
 *  刻意**不是**一个新的设置项：复用 [DesktopLyrics] Opacity 那条链（滑条 + 配置广播 + CSS 变量），
 *  也不碰原生 win.setOpacity（Linux 不实现，见下面 Backdrop 的注释）。 */
export const DL_HOVER_OPACITY_FLOOR = 0.3;

/** 0.1..1 的那把夹子（坏值回落 1，与 electron/desktop-lyrics-core.ts 的 normalizeOpacity 同规）。 */
function clampDlOpacity(n: number): number {
  if (!Number.isFinite(n)) return 1;

  return Math.min(DL_OPACITY_MAX, Math.max(DL_OPACITY_MIN, Math.round(n * 100) / 100));
}

/** 桌面歌词**歌词层**不透明度 0.1..1（1=默认完全不透明）—— 调的是字。覆盖层经配置广播即时跟随。 */
export function getDesktopLyricsOpacity(): number {
  return clampDlOpacity(Number(cfg("DesktopLyrics.Opacity", "1")));
}

/** 悬停时的**内容**不透明度 = max(设置值, 地板)：0.1..0.3 一律给 0.3，高于地板的原样返回。 */
export function hoverOpacityOf(opacity: number): number {
  return Math.max(clampDlOpacity(opacity), DL_HOVER_OPACITY_FLOOR);
}

export function getDesktopLyricsHoverOpacity(): number {
  return hoverOpacityOf(getDesktopLyricsOpacity());
}

export function setDesktopLyricsOpacity(v: number) {
  const clamped = Math.min(DL_OPACITY_MAX, Math.max(DL_OPACITY_MIN, Number(v) || 1));
  cfgSetSoon({ "DesktopLyrics.Opacity": String(Math.round(clamped * 100) / 100) });
}

/** 桌面歌词**窗体不透明度**（背板）0..1，0=没有背板（默认，整扇窗全透明、只有字）。
 *  这块背板铺满整个窗体矩形（就是「窗体的面」），字本身不受它影响。
 *  三平台同一套（不做原生 setOpacity：那条 Linux 不实现，会造成口径分叉）。 */
export function getDesktopLyricsBackdrop(): number {
  const n = Number(cfg("DesktopLyrics.Backdrop", "0"));

  if (!Number.isFinite(n)) return 0;

  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

export function setDesktopLyricsBackdrop(v: number) {
  const clamped = Math.min(1, Math.max(0, Number(v) || 0));
  cfgSetSoon({ "DesktopLyrics.Backdrop": String(Math.round(clamped * 100) / 100) });
}

// 行数：single=只当前句（AMLL 行对齐钉到条带中线 + 裁掉邻行）｜dual=当前句 + 下一句。
export type DlMode = "single" | "dual";

export function getDesktopLyricsMode(): DlMode {
  return cfg("DesktopLyrics.Mode", "single").trim() === "dual" ? "dual" : "single";
}

export function setDesktopLyricsMode(v: DlMode) {
  cfgSet({ "DesktopLyrics.Mode": v });
}


/** 单行居中档（默认开）：开 = 当前句水平居中，条带只装当前句（主行 + 翻译/音译，和声行裁掉）；
 *  关 = 水平左对齐，并连和声行一起装进条带。双行档没有第二个对齐开关，恒为左对齐。
 *  竖直方向仍由条带把整块文字钉在视口中心，见 src/desktop-lyrics.ts。 */
export function getDesktopLyricsSingleCenter(): boolean {
  return !/^(false|0|no)$/i.test(cfg("DesktopLyrics.SingleCenter", "True"));
}

export function setDesktopLyricsSingleCenter(v: boolean) {
  cfgSet({ "DesktopLyrics.SingleCenter": v ? "True" : "False" });
}

// 颜色：default=白字（现状）｜cover=封面染色｜system=系统强调色｜custom=自选 HEX。
// cover/system 的**取色源**由主窗桥随曲目镜像带来（与正在播放页同源，桌面歌词窗不碰网络）；
// 混色公式与 .np-kara-host 一致（color-mix(in srgb, accent 55%, #fff)），改一处要改两处。
export type DlColorMode = "default" | "cover" | "system" | "custom";

const DL_COLOR_MODES: DlColorMode[] = ["default", "cover", "system", "custom"];

export function getDesktopLyricsColorMode(): DlColorMode {
  const raw = cfg("DesktopLyrics.ColorMode", "default").trim() as DlColorMode;

  return DL_COLOR_MODES.includes(raw) ? raw : "default";
}

export function setDesktopLyricsColorMode(v: DlColorMode) {
  cfgSet({ "DesktopLyrics.ColorMode": v });
}

/** 自定义色（HEX）；parseHex 认不下就回落白字（与 tint 自定义色同一进表口径）。 */
export function getDesktopLyricsColor(): string {
  const rgb = parseHex(cfg("DesktopLyrics.Color", "#ffffff"));

  return rgb ? toHex(rgb) : "#ffffff";
}

export function setDesktopLyricsColor(v: string) {
  const rgb = parseHex(String(v ?? ""));
  cfgSet({ "DesktopLyrics.Color": rgb ? toHex(rgb) : "#ffffff" });
}

export const DL_SCALE_MIN = 0.5;
export const DL_SCALE_MAX = 2;

/** 桌面歌词字号倍率 0.5..2（1=默认）。字体家族走独立的 [DesktopLyrics] Font。 */
export function getDesktopLyricsScale(): number {
  const n = Number(cfg("DesktopLyrics.Scale", "1"));

  if (!Number.isFinite(n)) return 1;

  return Math.min(DL_SCALE_MAX, Math.max(DL_SCALE_MIN, Math.round(n * 100) / 100));
}

export function setDesktopLyricsScale(v: number) {
  const clamped = Math.min(DL_SCALE_MAX, Math.max(DL_SCALE_MIN, Number(v) || 1));
  cfgSetSoon({ "DesktopLyrics.Scale": String(Math.round(clamped * 100) / 100) });
}

export const DL_WEIGHT_MIN = 100;
export const DL_WEIGHT_MAX = 900;
export const DL_WEIGHT_DEFAULT = 400;

/** 桌面歌词字重 100..900（CSS 的合法常规区间）。可变字体由 CSS 的 wght 轴连续映射；
 *  静态字重字体由 font-weight 选择最近字面，缺少目标字面时允许浏览器字重合成。 */
export function getDesktopLyricsWeight(): number {
  const raw = String(cfg("DesktopLyrics.Weight", String(DL_WEIGHT_DEFAULT))).trim();

  if (!raw) return DL_WEIGHT_DEFAULT;
  const n = Number(raw);

  if (!Number.isFinite(n)) return DL_WEIGHT_DEFAULT;

  return Math.min(DL_WEIGHT_MAX, Math.max(DL_WEIGHT_MIN, Math.round(n)));
}

export function setDesktopLyricsWeight(v: number) {
  const n = Number(v);
  const clamped = Number.isFinite(n) ? Math.min(DL_WEIGHT_MAX, Math.max(DL_WEIGHT_MIN, Math.round(n))) : DL_WEIGHT_DEFAULT;
  cfgSetSoon({ "DesktopLyrics.Weight": String(clamped) });
}

/** 桌面歌词字体列表：独立于正在播放页的 Style.DefaultLyricsFonts，输入口径与全局字体相同。 */
export const getDesktopLyricsFontList = () => cfg("DesktopLyrics.Font", "Source Han Serif");
export const getDesktopLyricsFont = () => fontKeyOf(getDesktopLyricsFontList());

export function setDesktopLyricsFontList(css: string) {
  cfgSetSoon({ "DesktopLyrics.Font": normalizeFontList(css) }, 400);
}

export function setDesktopLyricsFontPreset(key: string) {
  if (key === FONT_CUSTOM) return;
  setDesktopLyricsFontList(FONT_PRESETS[key]?.css ?? "");
}

export const DL_BORDER_MIN = 0;
export const DL_BORDER_MAX = 4;

/** 桌面歌词文字描边宽度（px）：0..4，默认 1。坏值回落 1；0 是合法的「无描边」。 */
export function getDesktopLyricsBorder(): number {
  const raw = String(cfg("DesktopLyrics.Border", "1")).trim();

  if (!raw) return 1;
  const n = Number(raw);

  if (!Number.isFinite(n)) return 1;

  return Math.min(DL_BORDER_MAX, Math.max(DL_BORDER_MIN, Math.round(n * 10) / 10));
}

export function setDesktopLyricsBorder(v: number) {
  const n = Number(v);
  const clamped = Number.isFinite(n) ? Math.min(DL_BORDER_MAX, Math.max(DL_BORDER_MIN, n)) : 1;
  cfgSetSoon({ "DesktopLyrics.Border": String(Math.round(clamped * 10) / 10) });
}

export const DL_SHADOW_BLUR_MAX = 32;
export const DL_SHADOW_OFFSET_MAX = 12;

function clampDlNum(raw: string, fallback: number, min: number, max: number, digits = 1): number {
  const s = String(raw ?? "").trim();

  if (!s) return fallback;
  const n = Number(s);

  if (!Number.isFinite(n)) return fallback;
  const k = 10 ** digits;

  return Math.min(max, Math.max(min, Math.round(n * k) / k));
}

/** 桌面歌词文字阴影总开关。关闭后仍保留描边。 */
export function getDesktopLyricsShadow(): boolean {
  return !/^(false|0|no|off)$/i.test(cfg("DesktopLyrics.Shadow", "True").trim());
}

export function setDesktopLyricsShadow(v: boolean) {
  cfgSetSoon({ "DesktopLyrics.Shadow": v ? "True" : "False" });
}

/** 阴影模糊半径 0..32px；0 = 硬边。 */
export function getDesktopLyricsShadowBlur(): number {
  return clampDlNum(cfg("DesktopLyrics.ShadowBlur", "8"), 8, 0, DL_SHADOW_BLUR_MAX);
}

export function setDesktopLyricsShadowBlur(v: number) {
  cfgSetSoon({ "DesktopLyrics.ShadowBlur": String(clampDlNum(String(v), 8, 0, DL_SHADOW_BLUR_MAX)) });
}

/** 阴影不透明度 0..1；0 视觉上等于关闭。 */
export function getDesktopLyricsShadowOpacity(): number {
  return clampDlNum(cfg("DesktopLyrics.ShadowOpacity", "0.45"), 0.45, 0, 1, 2);
}

export function setDesktopLyricsShadowOpacity(v: number) {
  cfgSetSoon({ "DesktopLyrics.ShadowOpacity": String(clampDlNum(String(v), 0.45, 0, 1, 2)) });
}

/** 阴影水平/垂直偏移 -12..12px。 */
export function getDesktopLyricsShadowX(): number {
  return clampDlNum(cfg("DesktopLyrics.ShadowX", "0"), 0, -DL_SHADOW_OFFSET_MAX, DL_SHADOW_OFFSET_MAX);
}

export function setDesktopLyricsShadowX(v: number) {
  cfgSetSoon({ "DesktopLyrics.ShadowX": String(clampDlNum(String(v), 0, -DL_SHADOW_OFFSET_MAX, DL_SHADOW_OFFSET_MAX)) });
}

export function getDesktopLyricsShadowY(): number {
  return clampDlNum(cfg("DesktopLyrics.ShadowY", "2"), 2, -DL_SHADOW_OFFSET_MAX, DL_SHADOW_OFFSET_MAX);
}

export function setDesktopLyricsShadowY(v: number) {
  cfgSetSoon({ "DesktopLyrics.ShadowY": String(clampDlNum(String(v), 2, -DL_SHADOW_OFFSET_MAX, DL_SHADOW_OFFSET_MAX)) });
}


// —— 音质 Fallback 排序：False=自动/回退时不优先落到臻品全景声（默认，母带优先），
//    True=按标准 rank 降序回退（全景声在其 rank 位置自然参与） ——
export type FallbackSort = "no-atmos" | "rank";

export function getFallbackSort(): FallbackSort {
  return /^(true|1|yes)$/i.test(cfg("Quality.FallbackToQMAtmos")) ? "rank" : "no-atmos";
}

export function setFallbackSort(v: FallbackSort) {
  cfgSet({ "Quality.FallbackToQMAtmos": v === "rank" ? "True" : "False" });
}

// —— 关闭按钮行为：tray=缩放到托盘（默认）；quit=退出程序。CSD 胶囊与 SSD 标题栏共用。
//    偏好经 Electron 桥同步到主进程（主进程拦截 window close 决定 hide 还是真退出）。 ——
export type CloseAction = "tray" | "quit";

export function getCloseAction(): CloseAction {
  return cfg("Window.CloseAction") === "quit" ? "quit" : "tray";
}

export function setCloseAction(v: CloseAction) {
  cfgSet({ "Window.CloseAction": v });
  const bridge = (window as any).quaverCSD;

  if (bridge?.setCloseAction) bridge.setCloseAction(v);
}

// 启动时把已存偏好推给主进程（Electron 壳层）；浏览器 dev 下为 no-op
export function syncCloseAction() {
  const bridge = (window as any).quaverCSD;

  if (bridge?.setCloseAction) bridge.setCloseAction(getCloseAction());
}

// —— 侧栏展开/缩回：缩态只留头像、导航图标、歌单封面与底部按钮（昵称/文字全部收掉）。
//    状态挂在 <body> 的 class 上（与 applyDecor 的 body.ssd 同一套路）：侧栏由 shell.ts
//    在 bootShell 时才注入，CSS 只按 body 状态描述缩态，模块之间不必互相找节点。
//    按钮自身的图标方向/文案由 shell.ts 随状态同步（这里只管 class 与落盘）。 ——
export function getSidebarCollapsed(): boolean {
  return /^(true|1|yes)$/i.test(cfg("Window.SidebarCollapsed", "False"));
}

export function applySidebar() {
  document.body.classList.toggle("side-collapsed", getSidebarCollapsed());
}

export function setSidebarCollapsed(v: boolean) {
  cfgSet({ "Window.SidebarCollapsed": v ? "True" : "False" });
  applySidebar();
}

// —— 面板宽度（侧栏 / 停靠队列）：拖拽分隔条写入。拖拽是高频项 → cfgSetSoon 合并落盘；
//    空值 = 未自定义（CSS 变量不设，回落 style.css 的内置默认宽度）。 ——
const readPx = (key: string): number | null => {
  const v = cfg(key).trim();
  const n = Number(v);

  return v !== "" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

const writePx = (key: string, px: number | null, min: number, max: number) => {
  const v = px == null ? "" : String(Math.round(Math.max(min, Math.min(max, px))));
  cfgSetSoon({ [key]: v });
};

export function getSidebarWidth(): number | null {
  return readPx("Window.SidebarWidth");
}

export function setSidebarWidth(px: number | null) {
  writePx("Window.SidebarWidth", px, 64, 2000);
}

export function getQueueWidth(): number | null {
  return readPx("Window.QueueWidth");
}

export function setQueueWidth(px: number | null) {
  writePx("Window.QueueWidth", px, 64, 2000);
}

// —— 热键（全局 / 焦点内）——
// 取值 = 规范化 accelerator（值域在 electron/config.ts 的 isHotkey）：修饰键 Ctrl/Alt/Shift/
// Super 按固定序组合 + 键名，如 "Ctrl+Alt+F5"；空串 = 停用该热键（合法）。
// 全局热键由主进程注册（Windows/macOS 用 Electron globalShortcut，Linux 走 XDG 桌面门户），
// 焦点内热键由渲染层 keydown 分发（src/lib/hotkeys.ts）；两边都实时读内存快照，改完即生效。
export type HotkeyAction = "toggle" | "prev" | "next" | "volup" | "voldown" | "quit";

export type HotkeyScope = "Global" | "Focus";

/** Global 段没有 quit（退出程序只作为焦点内热键）；UI 据此取各自的行动清单。 */
export const hotkeyConfKey = (scope: HotkeyScope, action: HotkeyAction) => `Hotkeys.${scope}.${HOTKEY_KEY_NAMES[action]}`;

/** 动作 → schema 键名。VolUp/VolDown 是多词键，首字母大写法（volup→Volup）会拼错，
 *  必须显式列全 —— 与 electron/global-hotkeys.ts 的 GLOBAL_CONF_KEYS 逐字一致
 *  （verify-hotkeys 交叉比对两边）。 */
const HOTKEY_KEY_NAMES: Record<HotkeyAction, string> = {
  toggle: "Toggle", prev: "Prev", next: "Next", volup: "VolUp", voldown: "VolDown", quit: "Quit",
};

export function getHotkey(scope: HotkeyScope, action: HotkeyAction): string {
  return cfg(hotkeyConfKey(scope, action));
}

export function setHotkey(scope: HotkeyScope, action: HotkeyAction, accel: string): void {
  cfgSet({ [hotkeyConfKey(scope, action)]: accel });
}

/** KeyboardEvent → 规范化 accelerator；不可录制的组合返回 null（纯键名 / 无修饰键 / 未知键）。 */
export function acceleratorFromEvent(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const KEY_NAMES: Record<string, string> = {
    " ": "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
    "-": "Minus", "=": "Equal", ",": "Comma", ".": "Period",
  };

  const raw = e.key;

  if (!raw) return null;
  let key = KEY_NAMES[raw] ?? "";

  if (/^[a-zA-Z]$/.test(raw)) key = raw.toUpperCase();
  else if (/^[0-9]$/.test(raw)) key = raw;
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(raw)) key = raw;
  else if (["Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Tab"].includes(raw)) key = raw;

  if (!key) return null;
  const mods = [e.ctrlKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", e.metaKey ? "Super" : ""].filter(Boolean);

  if (!mods.length) return null; // 裸键不许录：单键热键会吞掉正常输入

  return [...mods, key].join("+");
}

/** 左侧描述文案：设置页两份清单（Focus 多一个退出；顺序即展示顺序）。 */
export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggle: "暂停 / 播放",
  prev: "上一曲",
  next: "下一曲",
  volup: "音量加大",
  voldown: "音量减小",
  quit: "退出 Quaver Music",
};

export const GLOBAL_HOTKEY_ACTIONS: HotkeyAction[] = ["toggle", "prev", "next", "volup", "voldown"];
export const FOCUS_HOTKEY_ACTIONS: HotkeyAction[] = ["toggle", "quit", "prev", "next", "volup", "voldown"];

// —— 应用更新（设置-通用）：自动检查开关 / 渠道（stable｜beta｜nightly）/ 已提醒版本标识。 ——
// 检查与安装的执行端在主进程（electron/update.ts），编排见 src/lib/updater.ts。
// UpdateChannel 的真相在 update-core（渠道判定的纯逻辑层），这里只为调用方便再导出。
export type { UpdateChannel };

export function getAutoCheck(): boolean {
  // 默认开：只有明确写 False 档才关闭，手误写进来的值回落默认
  return !/^(false|0|no)$/i.test(cfg("Update.AutoCheck", "True"));
}

export function setAutoCheck(v: boolean) {
  cfgSet({ "Update.AutoCheck": v ? "True" : "False" });
}

export function getUpdateChannel(): UpdateChannel {
  const v = cfg("Update.Channel");

  return v === "nightly" || v === "beta" ? v : "stable";
}

export function setUpdateChannel(v: UpdateChannel) {
  cfgSet({ "Update.Channel": v === "nightly" || v === "beta" ? v : "stable" });
}

/** 上次已提醒/被「跳过此版本」的版本标识（`渠道:版本`）：命中时启动检查不再弹窗，手动检查不受影响。 */
export function getLastNotified(): string {
  return cfg("Update.LastNotified");
}

export function setLastNotified(v: string) {
  cfgSet({ "Update.LastNotified": v.slice(0, 128) });
}

// —— Sparkle 插件黑名单（[Sparkle] Blacklist）——
// 逗号分隔的插件 id（kebab-case，与插件目录名 / plugin.json 的 id 同一形状）；空串 = 不拉黑。
// 这里**只**管「配置取值 ⇄ id 列表」：谁被拉黑、拉的哪一步在 src/sparkle/policy.ts —— 启动
// 路径（sparkle/init.ts）与运行期开关（sparkle/host.ts 的 enableSparklePlugin）查同一份。
// 形状判定必须与 electron/config.ts 的 SPARKLE_ID_RE 一致（写错的段直接丢弃，不流进加载器）。
const SPARKLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 黑名单 id 列表（去重、保序；手改配置文件写进来的非法段会被丢掉）。 */
export function getSparkleBlacklist(): string[] {
  const out: string[] = [];

  for (const raw of cfg("Sparkle.Blacklist", "").split(",")) {
    const id = raw.trim();

    if (id && SPARKLE_ID_RE.test(id) && !out.includes(id)) out.push(id);
  }

  return out;
}

export function setSparkleBlacklist(ids: string[]) {
  const kept: string[] = [];

  for (const raw of ids) {
    const id = String(raw ?? "").trim();

    if (id && SPARKLE_ID_RE.test(id) && !kept.includes(id)) kept.push(id);
  }

  cfgSet({ "Sparkle.Blacklist": kept.join(",") });
}
