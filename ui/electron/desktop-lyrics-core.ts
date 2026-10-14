// Quaver — 桌面歌词（主进程侧）的**纯逻辑**：配置解析与边界兜底。
//
// 拆成独立模块的理由与 splash-page.ts / csp.ts 同套路：不 import electron，裸 node 可载入，
// verify-desktop-lyrics.ts 直接对函数做行为断言；窗口生命周期全在 desktop-lyrics.ts。
//
// ——— 桌面歌词的形态：纯 CSD 窗口 ———
// 一个独立、无边框、**全透明背景**、置顶、不进任务栏的覆盖层窗口，内容只有两样：
//   • AMLL 歌词渲染区（复用宿主内置引擎 src/lyrics/amll.ts 的提供器，经主窗口 → 主进程
//     → 本窗的快照桥驱动，数据面与「正在播放页」同源同口径）；
//   • 悬停浮现的控制条：播放控制（上一曲/播放暂停/下一曲 + 进度条）与歌词延迟（−/+ 一档
//     0.1s、点数值归零）。字体跟随本体「歌词字体」设置（Style.DefaultLyricsFonts）。
//
// **没有「点击穿透」这一档**：窗体就是 CSD —— 拖拽区由页面自己划
// （-webkit-app-region: drag，见 src/desktop-lyrics.css），整层可拖、可悬停出控制条。
// 不做「固定穿透」的理由：输入穿透在 Linux/Wayland 没有通用协议出口（合成器说了算），
// 一个在部分平台静默失效的开关比没有更糟；用户要「不挡桌面」时把窗口拖到空闲处即可。
//
// 窗口位置/大小持久化在 quaver.conf 的 [DesktopLyrics]（主进程写，渲染层只读写入开关/字号/透明度）。

/** 屏幕矩形（Electron bounds/workArea 的形状；core 不 import electron，类型自备）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口尺寸夹取范围：太窄放不下两行歌词，太大遮屏；上限给超宽屏留量。 */
export const DL_SIZE_MIN: { width: number; height: number } = { width: 260, height: 70 };
export const DL_SIZE_MAX: { width: number; height: number } = { width: 2560, height: 480 };
/** 无有效历史位置时的初始尺寸：约两行歌词的一条横带。 */
export const DL_DEFAULT_SIZE: { width: number; height: number } = { width: 720, height: 150 };

const TRUTHY = /^(true|1|yes)$/i;
const FALSY = /^(false|0|no)$/i;

/** 布尔配置解析（与 prefs 其余布尔项同一判据）；无法识别的值回落到传入默认。 */
export function confBool(v: string | undefined, dflt: boolean): boolean {
  const s = String(v ?? "").trim();
  if (TRUTHY.test(s)) return true;
  if (FALSY.test(s)) return false;
  return dflt;
}

/** 字号倍率：0.5..2，坏值/留空回落 1（readValues 已按 schema 校验过一轮，这里是第二道闸；
 *  注意 Number("") === 0 —— 空串必须先短路，否则「没配」会被当成「配了个 0」夹成下限）。 */
export function normalizeScale(v: string | undefined): number {
  const t = String(v ?? "").trim();
  if (!t) return 1;
  const n = Number(t);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
}

/** 从配置表读桌面歌词设置（键名与 electron/config.ts 的 [DesktopLyrics] 段一一对应）。 */
export interface DlSettings {
  enabled: boolean;
  scale: number;
  opacity: number;
  bounds: Rect | null;
}

/**
 * 整层不透明度：0.1..1，坏值/留空回落 1（与 normalizeScale 同规矩：空串先短路，
 * 免得「没配」被 Number("") === 0 夹成下限）。
 */
export function normalizeOpacity(v: string | undefined): number {
  const t = String(v ?? "").trim();
  if (!t) return 1;
  const n = Number(t);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0.1, Math.round(n * 100) / 100));
}

export function parseSettings(values: Record<string, string>): DlSettings {
  const num = (k: string): number | null => {
    const s = String(values[k] ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const x = num("DesktopLyrics.X");
  const y = num("DesktopLyrics.Y");
  const width = num("DesktopLyrics.W");
  const height = num("DesktopLyrics.H");
  const bounds = x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
  return {
    enabled: confBool(values["DesktopLyrics.Enabled"], false),
    scale: normalizeScale(values["DesktopLyrics.Scale"]),
    opacity: normalizeOpacity(values["DesktopLyrics.Opacity"]),
    bounds,
  };
}

/** 尺寸夹取（下限保证歌词可读，上限防遮屏）。 */
export function clampSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.min(DL_SIZE_MAX.width, Math.max(DL_SIZE_MIN.width, Math.round(width))),
    height: Math.min(DL_SIZE_MAX.height, Math.max(DL_SIZE_MIN.height, Math.round(height))),
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 初始位置：所在屏幕（默认取第一块）底部居中的一条横带 —— 桌面歌词的经典落位。
 *  size 可带「用户记忆过的尺寸」：坐标失效回落时只换位置、不改宽窄。 */
export function defaultBounds(area: Rect, size?: { width: number; height: number }): Rect {
  const width = Math.min(size?.width ?? DL_DEFAULT_SIZE.width, Math.max(DL_SIZE_MIN.width, area.width));
  const height = Math.min(size?.height ?? DL_DEFAULT_SIZE.height, Math.max(DL_SIZE_MIN.height, area.height));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - Math.min(120, area.height * 0.1)),
    width,
    height,
  };
}

/**
 * 落位决策：优先记忆位置，但必须**与某块屏幕的工作区有交集** —— 拔掉一块副屏后
 * 陈旧坐标会把歌词窗丢在虚空里（拉不回也看不见），这时回落初始落位而不是硬夹。
 * 尺寸恒过 clampSize。displays 空数组（headless/异常探测）返回 null，调用方自便。
 */
export function pickBounds(saved: Rect | null, displays: Rect[]): Rect | null {
  if (!displays.length) return null;
  const size = clampSize(saved?.width ?? DL_DEFAULT_SIZE.width, saved?.height ?? DL_DEFAULT_SIZE.height);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const rect: Rect = { x: Math.round(saved.x), y: Math.round(saved.y), ...size };
    if (displays.some((d) => intersects(rect, d))) return rect;
  }
  return defaultBounds(displays[0]!, size);
}

/** 配置写入补丁（边界 → 键值）。X/Y/W/H 分开存：readValues 的键级回落互不牵连。 */
export function boundsToPatch(b: Rect): Record<string, string> {
  return {
    "DesktopLyrics.X": String(Math.round(b.x)),
    "DesktopLyrics.Y": String(Math.round(b.y)),
    "DesktopLyrics.W": String(Math.round(b.width)),
    "DesktopLyrics.H": String(Math.round(b.height)),
  };
}
