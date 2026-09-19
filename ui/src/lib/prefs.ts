// Quaver — 用户偏好（外观主题 / 字体 / 窗口装饰 CSD·SSD / 解码后端 / 音频设备 / 淡入淡出 / 音质）。
//
// 全部持久化到 quaver.conf（INI，见 electron/config.mjs），通过 src/lib/config.ts 读写：
// 桌面端落 <配置目录>/quaver.conf，浏览器 dev 落 localStorage。本模块只负责
// 「内部枚举 ⇄ 配置文件取值」的映射与即时生效（CSS 变量 / Electron 桥）。
//
// 主题与字体在本模块直接落到 <html>：data-theme 驱动 style.css 的变量组，
// CSS 变量 --font-ui / --font-lyric 分别作用于界面与歌词。

import { cfg, cfgSet, cfgSetSoon } from "./config";

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
 *  逗号两侧统一成一个空格，空项丢掉。空串合法（= 不覆盖）。比 electron/config.mjs 的
 *  isFontList（拦结构字符与 url(）更严 —— 前端清洗后的值一定能过后端校验。 */
export function normalizeFontList(s: string): string {
  return (s || "")
    .replace(/[^\p{L}\p{N}\s,'"_.+\-]/gu, " ")
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

// —— 解码后端：MPV=原生引擎（默认，Electron 壳层经主进程 mpv 播放）；
//    Chromium=浏览器 <audio>（兜底/对照用，配置文件里写 Chromium，内部标识沿用 Blink）。
//    偏好只决定启动选择；引擎不可用时播放器自动落 Blink 并在设置页提示。 ——
export type DecodeBackend = "MPV" | "Blink";
export function getDecode(): DecodeBackend {
  const v = cfg("Playing.Backend");
  return v === "Chromium" || v === "Blink" ? "Blink" : "MPV";
}
export function setDecode(v: DecodeBackend) {
  cfgSet({ "Playing.Backend": v === "Blink" ? "Chromium" : "MPV" });
}

// —— 音频输出设备（MPV 后端）：mpv audio-device 名（"auto" = 系统默认）。
//    引擎拉起/重拉后据此应用；Blink 后端不消费此偏好。 ——
export function getAudioDevice(): string {
  return cfg("Playing.AudioDevice") || "auto";
}
export function setAudioDevice(id: string) {
  cfgSet({ "Playing.AudioDevice": id || "auto" });
}

// —— 淡入淡出（仅 MPV 后端）：起播淡入 / 暂停与切歌淡出。时长交给引擎做振幅包络。 ——
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

// —— 歌词翻译行开关（默认开） ——
export function getShowTrans(): boolean {
  return !/^(false|0|no)$/i.test(cfg("Style.ShowTranslation", "True"));
}
export function setShowTrans(v: boolean) {
  cfgSet({ "Style.ShowTranslation": v ? "True" : "False" });
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
