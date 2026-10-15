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
// **没有「最大化/全屏」这一档**：歌词是一张贴纸，铺满整屏既读不了也拖不回来。
// maximizable/fullscreenable=false 只是「不给按钮」，拦不住窗口管理器的手势（Windows 顶边
// Aero Snap、KDE/GNOME 平铺与 Super+Up、无边框窗双击拖拽区），所以主进程那边还有一道
// 「被最大化就立刻退回」的反应式兜底（见 desktop-lyrics.ts:open 的 maximize 守卫）。
//
// **尺寸：高度是一条「钉死的轴」，但值可以拖**（sizeHintsFor）。这一对提示（minHeight == maxHeight）
// 同时是「申请浮窗」：平铺合成器把「有一条不可变的轴」的窗判成浮窗（Hyprland 0.56 的 shouldBeFloated
// 就是这条判据，详见 sizeHintsFor 的注释）。被平铺的后果是真机踩过的：合成器给的窗体盒由布局决定
// （整块屏宽、高度也不由我们定），而客户端表面被自己的 max 提示夹住 —— 窗体的下半截就空着露桌面，
// 页面的 #dl-board（inset:0）只能盖到客户端表面，那一块谁也画不了。
// 注意「钉死」钉的是**值的唯一性**，不是「不许改」：拖把手 = 把 min/max 一起改到新值（真机验过
// Hyprland 会随即把浮窗夹到新高度，所以 Wayland 下这条路比 setSize 更可靠），拖动过程仍恒有那一对
// 相等的轴，浮窗不会掉。宽度常态是 260..2560 的区间（WM 拖边改宽照旧），只在**拖动那几帧**连同
// 宽度一起钉（pinnedHintsFor：Wayland 下 setSize 改不动窗体盒，钉提示才跟得上），松手再放回区间。
//
// **记忆尺寸要过筛**：老版本落过盘的 720×150 空带（isLegacyDefaultSize）与 compositor 事故留下的
// 越界尺寸（isSaneSavedSize：H=1224 这种只可能来自「合成器把窗拉爆后静默落盘」）都不算用户偏好 ——
// 位置照旧恢复，尺寸回落当前贴合值；合格的记忆高度照旧恢复（那是用户拖出来的）。
//
// 窗口位置/大小持久化在 quaver.conf 的 [DesktopLyrics]（主进程写，渲染层只读写入开关/字号/透明度）。

/** 屏幕矩形（Electron bounds/workArea 的形状；core 不 import electron，类型自备）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口尺寸夹取范围：下限要容得下「最小字号的一行」（想压到极扁的人得有条活路），上限防遮屏；
 *  宽度上限给超宽屏留量。 */
export const DL_SIZE_MIN: { width: number; height: number } = { width: 260, height: 44 };
export const DL_SIZE_MAX: { width: number; height: number } = { width: 2560, height: 480 };

/** 覆盖层字号基准（px）：src/desktop-lyrics.ts 的 applyStyle 写 `--dl-font-size = 24 × Scale`，
 *  默认尺寸与它同源（verify-desktop-lyrics 有一条正则钉住那边的 24 字面量，改一处两处都会红）。 */
export const DL_FONT_BASE_PX = 24;
/** 默认窗宽（px）：一条横带的口径。长句另有横向滚动兜着，不跟着字号变。
 *  宽度是**唯一留给用户拖**的那条轴（高度自本版起由 app 独占，见 sizeHintsFor）。 */
export const DL_DEFAULT_WIDTH = 560;
/* 文字块容量 —— 下面几个系数是**实测标定**的（headless Chromium 跑 desktop-lyrics.html，
 * 按档位量 __dl.stripDiag().applied = 条带高），不是拍脑袋：
 *   字号24 单行·无辅助 47 ｜ 单行·带辅助 62 ｜ 双行·无辅助 94 ｜ 双行·带辅助 128
 *   字号48 单行·带辅助 123 ｜ 双行·带辅助 253 ｜ 字号12 单行·带辅助 37（辅助行有 10px 字号下限）
 * 反推：主行行盒 1.5em（宁可不切字多留一点），条带上下呼吸位各 0.25em（= 覆盖层的 BAND_PAD_EM），
 * 一行辅助 ≈ 0.65em 但小字号时不跟着缩（--amll-lp-bottom-line-font-size: max(0.62em, 10px)）。
 * 上面 12 种档位组合逐一核过：算出来的窗高都 ≥ 实测条带高（最紧的是字号 2 + 双行 + 辅助 = 258 vs 253）。 */
const EM_MAIN_ROW = 1.5;
const EM_AUX_ROW = 0.65;
const AUX_ROW_MIN_PX = 14;
const EM_BAND_PAD = 0.5;
/** 容量之上的留量：极端档位（字号 2 + 双行 + 两路辅助）实测比线性估算高几像素，留 5% 不切字。 */
const CAPACITY_MARGIN = 1.05;
/** 条带之外的落位余量（px）：进度线/右下角把手贴窗体下缘，字也不该顶到窗边 ——
 *  这是「不切字的那口气」，不是给控制条单独留的一条带（留了就没有贴着一条字的紧凑感了；
 *  悬停控制条本来就浮在内容之上，见 src/desktop-lyrics.css 的 #dl-tools）。 */
const CHROME_PX = 16;

/** 当前档位下要容纳的文字块高度（px，不含落位余量）。 */
export function blockHeightFor(scale: number, mode: DlMode, aux: boolean): number {
  const font = DL_FONT_BASE_PX * normalizeScale(String(scale));
  const rows = mode === "dual" ? 2 : 1;
  const auxRowPx = Math.max(EM_AUX_ROW * font, AUX_ROW_MIN_PX);
  return rows * EM_MAIN_ROW * font + (aux ? rows * auxRowPx : 0) + EM_BAND_PAD * font;
}

/** 初始窗高 = 文字块容量 × 留量 + 落位余量，再过一遍尺寸夹取。
 *  aux 传的是全局「辅助行」档位（[Style] LyricAux ≠ off）—— 开着翻译/音译就是要多一行的高度，
 *  不给留位就会被条带切掉；某一首歌恰好没有翻译，只是多留一点白，不影响正确性。 */
export function defaultHeightFor(scale: number, mode: DlMode = "single", aux = true): number {
  const h = Math.round(blockHeightFor(scale, mode, aux) * CAPACITY_MARGIN) + CHROME_PX;
  return Math.min(DL_SIZE_MAX.height, Math.max(DL_SIZE_MIN.height, h));
}

/** 初始整窗尺寸（默认值口径 = 字号 1 + 单行 + 辅助行开；调用方有设置时传 defaultSizeFor）。 */
export const DL_DEFAULT_SIZE: { width: number; height: number } = {
  width: DL_DEFAULT_WIDTH,
  height: defaultHeightFor(1, "single", true),
};

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

/** 行数档位（与 [DesktopLyrics] Mode、渲染层 src/lib/prefs.ts 的 DlMode 同规：别的值回落单行）。 */
export type DlMode = "single" | "dual";
export function normalizeMode(v: string | undefined): DlMode {
  return String(v ?? "").trim() === "dual" ? "dual" : "single";
}

/** 从配置表读桌面歌词设置（键名与 electron/config.ts 的 [DesktopLyrics] 段一一对应）。 */
export interface DlSettings {
  enabled: boolean;
  scale: number;
  opacity: number;
  mode: DlMode;
  /** 全局「辅助行」（[Style] LyricAux）是否开着 —— 覆盖层真的会多渲染翻译/音译那一行，
   *  初始窗高要按它留位（主进程拿不到渲染层的 prefs，只能同键同判据自己读）。 */
  aux: boolean;
  bounds: Rect | null;
}

/**
 * 歌词层不透明度：0.1..1，坏值/留空回落 1（与 normalizeScale 同规矩：空串先短路，
 * 免得「没配」被 Number("") === 0 夹成下限）。主进程这边只拿它做判断，真正落地面在渲染层
 * （CSS 变量），悬停地板那条 max(设置, 0.3) 也在渲染层 src/lib/prefs.ts 算。
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
    mode: normalizeMode(values["DesktopLyrics.Mode"]),
    aux: String(values["Style.LyricAux"] ?? "").trim().toLowerCase() !== "off",
    bounds,
  };
}

/** 「用户从没拖过角」的指纹：v1 的初始尺寸是 720×150 那条大横带（太高，一条 24px 的字吊在半空）。
 *  磁盘上的记忆尺寸正好等于它 = 默认值被原样落过盘，不当作用户偏好：位置照旧恢复，尺寸换成
 *  新的贴合值。真有人手动拖成 720×150 的概率约等于零，而且新算法也可能算出同一个数（无害）。 */
const DL_LEGACY_DEFAULT_SIZE = { width: 720, height: 150 };
export function isLegacyDefaultSize(b: Rect | null): boolean {
  return !!b && b.width === DL_LEGACY_DEFAULT_SIZE.width && b.height === DL_LEGACY_DEFAULT_SIZE.height;
}

/** 记忆尺寸是否可用：两条轴都落在我们自己会写的范围内（clampSize 的上下限）。
 *  越界的条目只可能来自「合成器把窗拉爆 → persistBoundsNow 把合成器给的窗体盒原样落盘」——
 *  真机踩过 H=1224（一整块屏高）：那不是用户偏好，是事故现场，读回来只会让每次开窗都吊着一条
 *  半空的带。宽度的下限也顺手挡掉「被拉成一条缝」的落盘。 */
export function isSaneSavedSize(b: Rect | null): boolean {
  return !!b
    && b.width >= DL_SIZE_MIN.width && b.width <= DL_SIZE_MAX.width
    && b.height >= DL_SIZE_MIN.height && b.height <= DL_SIZE_MAX.height;
}

/** 记忆里那个「能用的尺寸」：两条轴都合理（isSaneSavedSize）且不是 v1 的 720×150 空带。
 *  两条轴一起判、一起用 —— 越界条目的宽度也一并不可信（那份落盘出自同一次事故）。 */
function usableSavedSize(b: Rect | null): Rect | null {
  return b && isSaneSavedSize(b) && !isLegacyDefaultSize(b) ? b : null;
}

/** 按当前设置给初始尺寸（主进程开窗用；渲染层改了字号/行数/辅助行后重开也走这条路）。
 *  这是「没有可用记忆」时的口径：宽 DL_DEFAULT_WIDTH、高按字号×行数贴合内容。
 *  记忆里有能用的尺寸时由 pickBounds 顶掉（用户拖过的宽和高都要留着）。 */
export function defaultSizeFor(s: Pick<DlSettings, "scale" | "mode" | "aux">): { width: number; height: number } {
  return { width: DL_DEFAULT_WIDTH, height: defaultHeightFor(s.scale, s.mode, s.aux) };
}

/**
 * 窗体的 min/max 尺寸提示 —— **「申请浮窗」的全部机制在这里**。
 *
 * 主进程把它原样喂给 BrowserWindow 的 minWidth/maxWidth/minHeight/maxHeight（Electron 侧就是
 * setMinimumSize/setMaximumSize），最终落到 Wayland 的 xdg_toplevel.set_min_size/set_max_size
 * （链路：NativeWindow::InitFromOptions → views::Widget::OnSizeConstraintsChanged →
 * DesktopWindowTreeHostPlatform → WaylandToplevelWindow::SetSizeConstraints）。
 *
 * 为什么这一手等于「申请浮窗」：**高度那条轴 min == max** —— 对平铺合成器来说这是「这条轴由
 * 客户端定，布局别动它」，而它正是各家判浮窗的判据。Hyprland 0.56 的
 * CHyprXWaylandManager::shouldBeFloated（Wayland 分支）：
 *     if (toplevel->m_parent ||
 *         (minSize.x != 0 && minSize.y != 0 && (minSize.x == maxSize.x || minSize.y == maxSize.y)))
 *       → 浮窗
 * 浮窗之后 Hyprland 再用同一对提示把窗体夹到该尺寸（Window.cpp:clampWindowSize），
 * 于是「合成器给的窗体盒」和「客户端表面」就永远一样大 —— 背板盖不满的病根也一并没了。
 * 宽度留区间（DL_SIZE_MIN/MAX.width）：WM 拖边改宽照旧，那两条轴不等所以不影响判据。
 *
 * height 传的是**当前该多高**（记忆里能用的值 ?? 内容贴合值，拖把手时就是拖到的新值）。
 * 钉死的是值的唯一性、不是「不许改」：改高度 = 把 min/max 一起改到新值，恒有那一对相等的轴，
 * 浮窗不掉（真机验过 Hyprland 会随即把浮窗夹到新高度 —— Wayland 下这比 setSize 可靠，
 * 客户端本来就定不了自己的尺寸）。别把高度改成**区间**：提示里一旦没有相等的轴，
 * 窗会被重新平铺回布局给的格子，盒子和表面的错位就回来了。
 */
export function sizeHintsFor(height: number): {
  minWidth: number; maxWidth: number; minHeight: number; maxHeight: number;
} {
  const h = clampHeight(height);
  return { minWidth: DL_SIZE_MIN.width, maxWidth: DL_SIZE_MAX.width, minHeight: h, maxHeight: h };
}

/**
 * 两条轴都钉死的尺寸提示：**拖动中**每帧用它，松手再回到 sizeHintsFor（宽度放回区间）。
 *
 * 为什么宽度也得推提示而不用 setSize：Wayland 下客户端定不了自己的尺寸，setSize 只改**我们这边**
 * 的视口，合成器给的窗体盒不动 —— 真机量过：`setSize(900)` 之后 renderer 的 innerWidth 是 900，
 * 而合成器的盒子仍是 560。两个值一脱钩，歌词就在那半张看不见的宽度里居中、进度条与把手也跑到框外。
 * 推提示（min == max）+ 合成器夹取是唯一让盒子跟上的路，所以拖动期间两条轴都钉，松手才放开宽度。
 */
export function pinnedHintsFor(width: number, height: number): {
  minWidth: number; maxWidth: number; minHeight: number; maxHeight: number;
} {
  const h = clampHeight(height);
  const w = clampSize(width, h).width;
  return { minWidth: w, maxWidth: w, minHeight: h, maxHeight: h };
}

/** 高度夹取（下限让窗压得到极扁，上限防遮屏）—— clampSize 的单轴版，尺寸提示只钉这一条。 */
export function clampHeight(height: number): number {
  return Math.min(DL_SIZE_MAX.height, Math.max(DL_SIZE_MIN.height, Math.round(height)));
}

/** 尺寸夹取（下限保证歌词可读，上限防遮屏）。 */
export function clampSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.min(DL_SIZE_MAX.width, Math.max(DL_SIZE_MIN.width, Math.round(width))),
    height: clampHeight(height),
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
 * 尺寸 = 记忆尺寸（「旧默认尺寸」与越界条目除外，见 isLegacyDefaultSize / isSaneSavedSize）
 * ?? hint（默认 DL_DEFAULT_SIZE），恒过 clampSize。**高度也是记忆值**（用户拖过的高度要留着）——
 * 它随后会以 min == max 的形式钉进尺寸提示（见 sizeHintsFor）。
 * displays 空数组（headless/异常探测）返回 null，调用方自便。
 */
export function pickBounds(
  saved: Rect | null,
  displays: Rect[],
  hint: { width: number; height: number } = DL_DEFAULT_SIZE,
): Rect | null {
  if (!displays.length) return null;
  // 记忆尺寸优先（两条轴都合理 + 不是旧的 720×150 空带），回落当前的贴合值
  const kept = usableSavedSize(saved);
  const size = clampSize(kept?.width ?? hint.width, kept?.height ?? hint.height);
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
