// Quaver — 用户偏好（外观主题 / 字体 / 窗口装饰 CSD·SSD / 解码后端 / 音频设备 / 淡入淡出 / 音质）。
//
// 全部持久化到 quaver.conf（INI，见 electron/config.ts），通过 src/lib/config.ts 读写：
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
 *  逗号两侧统一成一个空格，空项丢掉。空串合法（= 不覆盖）。比 electron/config.ts 的
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

// —— 默认主题的背景（环境色层）：模式 + 自定义图 + 模糊强度 ——
// 模式落在 quaver.conf 的 [Style] Background（off / cover / custom，**默认 off**：不开环境色层，
// 只有主题底色），自定义图的路径落在 BackgroundImage（由设置页的原生选图写进来，主进程读它、
// 经同源 /api/bg 交给界面）。
// 这里**只**管「内部枚举 ⇄ 配置取值」：DOM 归 src/lib/ambient.ts —— prefs 被 player/api
// 反向依赖，不能反过来 import 渲染层的东西（成环）。改完要自己调 applyBackground()。
export type BackgroundMode = "off" | "cover" | "custom";
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

export const BG_BLUR_MIN = 0;
export const BG_BLUR_MAX = 120;
export const BG_BLUR_DEFAULT = 70;

/** 模糊强度（px 高斯半径）。空值/非数值回落默认；越界夹紧（手改 conf 写 9999 不该把界面糊死）。 */
export function getBackgroundBlur(): number {
  const raw = cfg("Style.BackgroundBlur", String(BG_BLUR_DEFAULT)).trim();
  if (!raw) return BG_BLUR_DEFAULT; // Number("") === 0 的坑：空值 ≠ 不模糊
  const n = Number(raw);
  if (!Number.isFinite(n)) return BG_BLUR_DEFAULT;
  return Math.min(BG_BLUR_MAX, Math.max(BG_BLUR_MIN, Math.round(n)));
}
/** 拖滑块是高频项 → 合并落盘（与音量同一套）。 */
export function setBackgroundBlur(px: number) {
  const clamped = Math.max(BG_BLUR_MIN, Math.min(BG_BLUR_MAX, Math.round(px)));
  cfgSetSoon({ "Style.BackgroundBlur": String(clamped) });
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
//    执行端在 Go sidecar（vendor/Typhoeus-go/inhibit）：Linux=xdg 门户 Suspend 位、
//    门户假成功走 Logind 直连；Windows=PowerRequestSystemRequired；
//    macOS=IOKit PreventUserIdleSystemSleep。渲染层经 src/lib/inhibit.ts 驱动。 ——
export function getInhibitSleep(): boolean {
  // 默认开：只有明确写 False 档才关闭，手误写进来的值回落默认
  return !/^(false|0|no)$/i.test(cfg("Playing.InhibitSleep", "True"));
}
export function setInhibitSleep(v: boolean) {
  cfgSet({ "Playing.InhibitSleep": v ? "True" : "False" });
}

// —— 歌词翻译行开关（默认开） ——
export function getShowTrans(): boolean {
  return !/^(false|0|no)$/i.test(cfg("Style.ShowTranslation", "True"));
}
export function setShowTrans(v: boolean) {
  cfgSet({ "Style.ShowTranslation": v ? "True" : "False" });
}

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

// —— 应用更新（设置-通用）：自动检查开关 / 渠道（stable｜nightly）/ 已提醒版本标识。 ——
// 检查与安装的执行端在主进程（electron/update.ts），编排见 src/lib/updater.ts。
export type UpdateChannel = "stable" | "nightly";

export function getAutoCheck(): boolean {
  // 默认开：只有明确写 False 档才关闭，手误写进来的值回落默认
  return !/^(false|0|no)$/i.test(cfg("Update.AutoCheck", "True"));
}
export function setAutoCheck(v: boolean) {
  cfgSet({ "Update.AutoCheck": v ? "True" : "False" });
}

export function getUpdateChannel(): UpdateChannel {
  return cfg("Update.Channel") === "nightly" ? "nightly" : "stable";
}
export function setUpdateChannel(v: UpdateChannel) {
  cfgSet({ "Update.Channel": v === "nightly" ? "nightly" : "stable" });
}

/** 上次已提醒/被「跳过此版本」的版本标识（`渠道:版本`）：命中时启动检查不再弹窗，手动检查不受影响。 */
export function getLastNotified(): string {
  return cfg("Update.LastNotified");
}
export function setLastNotified(v: string) {
  cfgSet({ "Update.LastNotified": v.slice(0, 128) });
}
