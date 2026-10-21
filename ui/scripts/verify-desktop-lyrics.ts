// Quaver — 桌面歌词（desktop-lyrics）单测与源码护栏。跑：  node scripts/verify-desktop-lyrics.ts
//
// 抓的三类回归：
//   • 纯逻辑（electron/desktop-lyrics-core.ts 不 import electron，直接函数断言）：
//     边界回落/夹取、配置解析的坏值韧性（开关/字号/透明度/行数/坐标）、**初始尺寸贴合内容**
//     （defaultHeightFor 按字号×行数算窗高；旧的 720×150 大空带与合成器拉爆后的越界尺寸都不当用户偏好）、
//     **「申请浮窗」的尺寸提示**（sizeHintsFor：高度那条轴 min == max —— 平铺合成器判浮窗的判据；
//     钉的是值的唯一性，拖把手改高度 = 把这对提示一起重钉）。
//   • 双写红线：[DesktopLyrics] 的 schema 默认值 ⇄ src/lib/config.ts FALLBACK 逐键一致。
//   • 覆盖层几何（src/lib/desktop-lyrics-layout.ts 纯函数）：块心对齐、条带居中、超长行滚动区间。
//   • 固定/鼠标透穿：平台闸门（macOS / Windows / X11，Wayland 关闭）与原生落地
//     （setIgnoreMouseEvents + 托盘/设置页解除入口 + 歌词页锁定态）。
//   • 接线护栏（源码正则）：主进程开窗选项（透明/置顶/不抢焦点/movable/**min==max 的尺寸提示**）、
//     CSD 拖拽区与 no-drag 例外、歌词层/窗体两层不透明度与悬停地板、退出连带关窗不写 Enabled、
//     桥的 active 门与曲目指纹去抖、DL 页零 player 依赖、时钟补偿与 NowPlaying 同值、vite 入口与 CSP。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "../electron/config.ts";
import {
  boundsToPatch, clampSize, confBool, defaultBounds, defaultHeightFor, defaultSizeFor,
  DL_DEFAULT_SIZE, DL_SIZE_MAX, DL_SIZE_MIN, isLegacyDefaultSize, isSaneSavedSize,
  normalizeOpacity, normalizeScale, parseSettings, pickBounds, pinnedHintsFor, sizeHintsFor,
  supportsDlLock,
} from "../electron/desktop-lyrics-core.ts";
import { alignFor, bandFor, scrollRange, sequenceOverlappingLines, BAND_MIN_PX } from "../src/lib/desktop-lyrics-layout.ts";
import { viewsSource } from "./views-source.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, "..");
const src = (p: string) => readFileSync(join(UI, p), "utf8");

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ——— 1. 固定/鼠标透穿：平台闸门 + 原生落地 ———
section("固定/鼠标透穿");
{
  eq("macOS 开放", supportsDlLock("darwin", {}), true);
  eq("Windows 开放", supportsDlLock("win32", {}), true);
  eq("Linux X11 开放", supportsDlLock("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), true);
  eq("Linux XDG 缺失时按 DISPLAY 兜底", supportsDlLock("linux", { DISPLAY: ":0" }), true);
  eq("Wayland 关闭", supportsDlLock("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }), false);
  eq("Linux 无图形会话关闭", supportsDlLock("linux", {}), false);
  eq("其它 Unix 关闭", supportsDlLock("freebsd", { DISPLAY: ":0" }), false);
  const dl = src("electron/desktop-lyrics.ts");
  check("主进程按锁档调用 setIgnoreMouseEvents（锁定 true / 解锁 false 同一入口）",
    /win\.setIgnoreMouseEvents\(locked, locked \? \{ forward: true \} : undefined\)/.test(dl));
  check("锁定同时取消可移动位（Linux no-op，但 X11 的输入穿透已切断拖拽）", /win\.setMovable\(!locked\)/.test(dl));
  check("构造参数在锁定启动时先不可移动", /const locked = this\.lockedNow\(\);/.test(dl) && /movable: !locked/.test(dl));
  check("锁定应用在 show 前与 did-finish-load 各落一次（持久锁定不闪挡桌面）",
    /this\.applyInteractionMode\(win\);\s*win\.on\("ready-to-show"/.test(dl)
    && /this\.pageReady = true;\s*this\.applyInteractionMode\(win\);/.test(dl));
  check("窗口操作通道可锁定，但解除仍必须从托盘/设置页进来",
    /case "lock":\s*this\.setLocked\(!!msg\?\.on\);/.test(dl) && /windowOp\(\{ op: "lock", on: true \}\)/.test(src("src/desktop-lyrics.ts")));
  check("core 的设置形状含锁定档 + 样式 + 坐标",
    /enabled: boolean;[\s\S]*?locked: boolean;[\s\S]*?scale: number;[\s\S]*?opacity: number;[\s\S]*?bounds: Rect \| null;/.test(src("electron/desktop-lyrics-core.ts")));
  check("歌词页 CSS 锁定后停掉拖拽区与全部交互控件",
    /#dl-root\.dl-locked\s*\{[\s\S]*?no-drag/.test(src("src/desktop-lyrics.css"))
    && /#dl-root\.dl-locked #dl-tools,[\s\S]*?#dl-root\.dl-locked #dl-resize\s*\{[\s\S]*?display: none/.test(src("src/desktop-lyrics.css")));
}

// ——— 1.5 没有「最大化/全屏」这一档（覆盖层是一条横带，不是普通窗口） ———
section("不支持最大化/全屏");
{
  const dl = src("electron/desktop-lyrics.ts");
  check("构造参数关掉最大化与全屏（连同 minimizable 一起）",
    /maximizable: false/.test(dl) && /fullscreenable: false/.test(dl) && /minimizable: false/.test(dl));
  check("反应式兜底：被 WM 最大化 → unmaximize 还原（maximizable 拦不住 Snap/平铺手势与双击拖拽区）",
    /win\.on\("maximize", \(\) => rejectState\("最大化"\)\);/.test(dl) && /win\.isMaximized\(\)\) win\.unmaximize\(\)/.test(dl));
  check("反应式兜底：被拉进全屏 → setFullScreen(false)",
    /win\.on\("enter-full-screen", \(\) => rejectState\("全屏"\)\);/.test(dl) && /win\.isFullScreen\(\)\) win\.setFullScreen\(false\)/.test(dl));
  check("反应式兜底：被最小化 → restore（skipTaskbar 的窗缩进去就再也点不回来，只能靠托盘）",
    /win\.on\("minimize", \(\) => rejectState\("最小化"\)\);/.test(dl) && /win\.isMinimized\(\)\) win\.restore\(\)/.test(dl));
  check("还原前先判一次现值（事件抢跑时不重复动手、也不刷日志）",
    /if \(!win\.isMaximized\(\) && !win\.isMinimized\(\) && !win\.isFullScreen\(\)\) return;/.test(dl));
  check("尺寸提示只在两个方法里**成对**更新（pinHeight / pinSize；单独 setMaximumSize 会把浮窗那条轴打散）",
    (dl.match(/setMaximumSize\(/g) ?? []).length === 2
    && (dl.match(/setMinimumSize\(/g) ?? []).length === 2
    && /win\.setMaximumSize\(hints\.maxWidth, hints\.maxHeight\);/.test(dl)
    && /win\.setMinimumSize\(hints\.minWidth, hints\.minHeight\);/.test(dl)
    && /win\.setMaximumSize\(hints\.maxWidth, hints\.maxHeight\);/.test(dl.slice(dl.indexOf("private pinSize"), dl.indexOf("private releaseWidth")))
    && /win\.setMinimumSize\(hints\.minWidth, hints\.minHeight\);/.test(dl.slice(dl.indexOf("private pinSize"), dl.indexOf("private releaseWidth"))));
  check("本模块从不主动 maximize（只有 unmaximize 这个还原方向）", !/(^|[^n])maximize\(/m.test(dl.replace(/unmaximize\(/g, "@")));
}

// ——— 2. 配置解析与兜底 ———
section("parseSettings / normalizeScale / normalizeOpacity / confBool");
eq("缺省：关 + 未锁定 + 字号1 + 透明度1 + 单行 + 辅助行开 + 无坐标", parseSettings({}),
  { enabled: false, locked: false, scale: 1, opacity: 1, mode: "single", aux: true, bounds: null });
eq("辅助行=off 时初始窗高少留一行（覆盖层真的不渲染那一路）",
  parseSettings({ "Style.LyricAux": "off" }).aux, false);
eq("辅助行=roman 也算开", parseSettings({ "Style.LyricAux": "roman" }).aux, true);
eq("行数只认 dual（别的值回落单行，与渲染层 prefs 同规）", parseSettings({ "DesktopLyrics.Mode": "triple" }).mode, "single");
eq("行数 dual 生效（初始窗高要按它算）", parseSettings({ "DesktopLyrics.Mode": "dual" }).mode, "dual");
eq("True/yes/1 都算开", parseSettings({ "DesktopLyrics.Enabled": "yes" }).enabled, true);
eq("字号越界夹回", normalizeScale("9"), 2);
eq("字号坏值回落 1", normalizeScale("abc"), 1);
eq("透明度越界夹回（下限 0.1）", normalizeOpacity("0"), 0.1);
eq("透明度越界夹回（上限 1）", normalizeOpacity("3"), 1);
eq("透明度坏值回落 1", normalizeOpacity("abc"), 1);
eq("透明度空串回落 1（没配 ≠ 配了个 0）", normalizeOpacity(""), 1);
eq("透明度保留两位", normalizeOpacity("0.345"), 0.35);
eq("parseSettings 走同一把夹子", parseSettings({ "DesktopLyrics.Opacity": "9" }).opacity, 1);
eq("坐标残缺（只有 X）视为未记忆", parseSettings({ "DesktopLyrics.X": "10", "DesktopLyrics.Y": "20" }).bounds, null);
eq("负坐标合法（副屏在左）", parseSettings({ "DesktopLyrics.X": "-1920", "DesktopLyrics.Y": "0", "DesktopLyrics.W": "720", "DesktopLyrics.H": "150" }).bounds, { x: -1920, y: 0, width: 720, height: 150 });
eq("confBool 未识别回落默认", confBool("maybe", true), true);

section("pickBounds / clampSize / defaultBounds");
const AREA_MAIN: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 1920, height: 1080 };
const AREA_SUB = { x: 1920, y: 0, width: 1280, height: 1024 };
const remembered = pickBounds({ x: 2000, y: 300, width: 640, height: 120 }, [AREA_MAIN, AREA_SUB]);
check("记忆位置在副屏 → 原样恢复", remembered?.x === 2000 && remembered?.width === 640, JSON.stringify(remembered));
const offscreen = pickBounds({ x: 99999, y: 99999, width: 640, height: 120 }, [AREA_MAIN]);
check("拔掉副屏后陈旧坐标回落初始落位（不丢进虚空）", !!offscreen && offscreen.x >= 0 && offscreen.y > 600 && offscreen.width === 640, JSON.stringify(offscreen));
const tiny = pickBounds({ x: 100, y: 100, width: 40, height: 20 }, [AREA_MAIN]);
check("尺寸过小的记忆条目同样不算数（我们自己从不会写 <260×44 的值）→ 回落默认口径，而不是夹成一条缝",
  tiny?.width === DL_DEFAULT_SIZE.width && tiny?.height === DL_DEFAULT_SIZE.height, JSON.stringify(tiny));
eq("无屏幕数据返回 null（调用方自便）", pickBounds(null, []), null);
const def = defaultBounds(AREA_MAIN);
check("初始落位=底部居中的横带", def.width === 560 && def.y + def.height <= 1080 && def.y > 700, JSON.stringify(def));
eq("bounds→补丁字符串", boundsToPatch({ x: 12.6, y: -8, width: 300.2, height: 80 }), { "DesktopLyrics.X": "13", "DesktopLyrics.Y": "-8", "DesktopLyrics.W": "300", "DesktopLyrics.H": "80" });

section("初始尺寸 = 字号 × 行数档位（不再一律 150px 大空带）");
// 下面这些期望值 = headless 实测条带高（47/62/94/128 …）套同一公式的落点，改动系数要重新量
eq("字号1 单行·辅助开 = 83（旧版一律 150，实测条带只要 62）", defaultHeightFor(1, "single", true), 83);
eq("字号1 单行·辅助关 = 66", defaultHeightFor(1, "single", false), 66);
eq("字号1 双行·辅助开 = 137（实测条带 128）", defaultHeightFor(1, "dual", true), 137);
eq("字号0.5 单行·辅助开 = 56", defaultHeightFor(0.5, "single", true), 56);
eq("字号2 双行·辅助开 = 258（最紧的一档：实测条带 253）", defaultHeightFor(2, "dual", true), 258);
check("字号越大越高、双行不低于单行、辅助行不低于纯主行",
  defaultHeightFor(2, "single") > defaultHeightFor(1, "single")
  && defaultHeightFor(1, "dual") > defaultHeightFor(1, "single")
  && defaultHeightFor(1, "single", true) > defaultHeightFor(1, "single", false));
check("恒在夹取范围内（越界字号也长不出屏）",
  [0.5, 1, 2].every((sc) => (["single", "dual"] as const).every((m) => ([true, false]).every((aux) =>
    defaultHeightFor(sc, m, aux) >= DL_SIZE_MIN.height && defaultHeightFor(sc, m, aux) <= DL_SIZE_MAX.height))));
eq("DL_DEFAULT_SIZE = 「字号1 + 单行 + 辅助开」口径", DL_DEFAULT_SIZE, { width: 560, height: defaultHeightFor(1, "single", true) });
eq("defaultSizeFor 宽走默认口径、高走档位", defaultSizeFor({ scale: 2, mode: "dual", aux: true }), { width: 560, height: 258 });

section("尺寸提示 = 「申请浮窗」（高度那条轴 min == max，值可重钉）");
eq("高度 83：宽度留区间，高度两轴相等",
  sizeHintsFor(83),
  { minWidth: DL_SIZE_MIN.width, maxWidth: DL_SIZE_MAX.width, minHeight: 83, maxHeight: 83 });
check("12 档组合的贴合高度全过浮窗判据：两条 min 轴非 0，且高度 min == max（平铺合成器的判据）",
  [0.5, 1, 1.6, 2].every((sc) => (["single", "dual"] as const).every((m) => ([true, false]).every((aux) => {
    const h = sizeHintsFor(defaultSizeFor({ scale: sc, mode: m, aux }).height);
    return h.minWidth > 0 && h.minHeight > 0 && h.minHeight === h.maxHeight;
  }))));
check("宽度两条轴不相等（WM 拖边改宽照旧，不影响浮窗判据）",
  [0.5, 1, 2].every((h) => sizeHintsFor(h).minWidth !== DL_SIZE_MAX.width));
check("重钉自由高度（用户拖过的高度照旧钉得进去，仍恒 min == max）",
  [44, 83, 120, 150, 300, 480].every((h) => { const x = sizeHintsFor(h); return x.minHeight === h && x.maxHeight === h; }));
check("越界高度过夹取（拖到天边也不会把窗钉出屏）",
  sizeHintsFor(9999).minHeight === DL_SIZE_MAX.height && sizeHintsFor(1).minHeight === DL_SIZE_MIN.height);
eq("拖动中：两条轴都钉死（合成器才跟得上 —— Wayland 下 setSize 只改我们这边的视口）",
  pinnedHintsFor(700, 150), { minWidth: 700, maxWidth: 700, minHeight: 150, maxHeight: 150 });
check("拖动中的提示也过夹取（宽度/高度都拉不出去）",
  pinnedHintsFor(99999, 99999).minWidth === DL_SIZE_MAX.width && pinnedHintsFor(0, 0).minHeight === DL_SIZE_MIN.height
  && pinnedHintsFor(0, 0).minWidth === DL_SIZE_MIN.width);
check("旧默认 720×150 认成「从没拖过角」，新的贴合值不算",
  isLegacyDefaultSize({ x: 0, y: 0, width: 720, height: 150 })
  && !isLegacyDefaultSize({ x: 0, y: 0, width: 720, height: 75 })
  && !isLegacyDefaultSize({ x: 0, y: 0, width: 640, height: 150 })
  && !isLegacyDefaultSize(null));
check("越界记忆尺寸不算数（只可能来自合成器把窗拉爆后的静默落盘）",
  isSaneSavedSize({ x: 0, y: 0, width: 1000, height: 83 })
  && !isSaneSavedSize({ x: 0, y: 0, width: 1000, height: 1224 })
  && !isSaneSavedSize({ x: 0, y: 0, width: 40, height: 83 })
  && !isSaneSavedSize(null));
{
  const legacy = pickBounds({ x: 300, y: 400, width: 720, height: 150 }, [AREA_MAIN], { width: 560, height: 83 });
  check("旧默认尺寸：位置照旧恢复，尺寸换成贴合值",
    legacy?.x === 300 && legacy?.y === 400 && legacy?.height === 83 && legacy?.width === 560, JSON.stringify(legacy));
  const mine = pickBounds({ x: 300, y: 400, width: 500, height: 120 }, [AREA_MAIN], { width: 560, height: 83 });
  check("用户拖过的尺寸照旧恢复（高度也是用户拖的，要留着）",
    mine?.width === 500 && mine?.height === 120, JSON.stringify(mine));
  const blown = pickBounds({ x: 300, y: 400, width: 1000, height: 1224 }, [AREA_MAIN], { width: 560, height: 83 });
  check("被拉爆的记忆尺寸（H=1224）两条轴都不认，回落默认口径",
    blown?.width === 560 && blown?.height === 83 && blown?.x === 300, JSON.stringify(blown));
  const hinted = pickBounds(null, [AREA_MAIN], { width: 800, height: 90 });
  check("无记忆尺寸时按 hint 落位", hinted?.width === 800 && hinted?.height === 90, JSON.stringify(hinted));
}

// ——— 3. 双写红线：schema 默认 ⇄ 渲染层 FALLBACK ———
section("[DesktopLyrics] 默认值双写一致");
const fallbackSrc = src("src/lib/config.ts");
for (const key of ["Enabled", "Locked", "Opacity", "Backdrop", "Scale", "Weight", "Font", "Border", "Shadow", "ShadowBlur", "ShadowOpacity", "ShadowX", "ShadowY", "Mode", "SingleCenter", "ColorMode", "Color", "X", "Y", "W", "H"]) {
  const want = defaults()[`DesktopLyrics.${key}`];
  const re = new RegExp(`"DesktopLyrics\\.${key}":\\s*"${String(want).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  check(`FALLBACK 含 DesktopLyrics.${key}=${JSON.stringify(want)}`, re.test(fallbackSrc));
}

// ——— 4. 主进程接线 ———
section("electron/main.ts 接线");
const main = src("electron/main.ts");
check("导入控制器", /import \{ DesktopLyricsController \} from "\.\/desktop-lyrics\.ts"/.test(main));
check("控制器在 whenReady 里构造且依赖五件套齐", /desktopLyrics = new DesktopLyricsController\(\{[\s\S]*?getUrl[\s\S]*?getMainWindow[\s\S]*?isQuitting[\s\S]*?refreshTrayMenu[\s\S]*?\}\)/.test(main));
check("构造先于 whenReady 的 createWindow 调用（IPC 在页面加载前就位）",
  main.indexOf("new DesktopLyricsController") < main.indexOf("startup failed"));
check("createWindow 尾部 boot（磁盘开着则拉起床）", /desktopLyrics\?\.boot\(\)/.test(main) && /appUrl = url;/.test(main));
check("config set 落 DesktopLyrics.* → syncFromConf（单一写路，设置页不必再 control）", /written\.some\(\(k\) => k\.startsWith\("DesktopLyrics\."\)\)\) desktopLyrics\?\.syncFromConf\(\)/.test(main));
check("config set 广播 quaver:config-changed（跨窗同步字体/字号/档位）", /broadcastConfigChanged\(written, msg\?\.patch \?\? \{\}\)/.test(main));
check("托盘子菜单含显示开关 + 固定/鼠标透穿（能力按平台 gate）",
  /显示桌面歌词/.test(main) && /buildDesktopLyricsMenu/.test(main)
  && /固定（鼠标透穿）/.test(main) && /setLocked\(!st\.locked\)/.test(main)
  && /enabled: !!st\.canLock/.test(main));

section("electron/desktop-lyrics.ts 窗口形态");
const dl = src("electron/desktop-lyrics.ts");
check("无边框 + 全透明 + 无投影 + 不进任务栏", /frame: false/.test(dl) && /transparent: true/.test(dl) && /backgroundColor: "#00000000"/.test(dl) && /skipTaskbar: true/.test(dl) && /hasShadow: false/.test(dl));
check("置顶用 screen-saver 层 + 全工作区可见", /setAlwaysOnTop\(true, "screen-saver"\)/.test(dl) && /setVisibleOnAllWorkspaces/.test(dl));
check("ready-to-show 后 showInactive（不抢焦点）", /ready-to-show.*showInactive/s.test(dl));
check("preload 与主窗同桥", /preload: join\(__dirname, "preload\.cts"\)/.test(dl));
check("未锁定时窗口可移动（movable: !locked；解锁时由原生入口恢复）",
  /movable: !locked/.test(dl) && /win\.setMovable\(!locked\)/.test(dl));
check("加载同源 desktop-lyrics.html", /new URL\("desktop-lyrics\.html", base\)/.test(dl));
check("初始尺寸来自「字号 × 行数」的贴合值（不再写死 720/150 那条大空带）",
  /const hint = defaultSizeFor\(this\.settings\);/.test(dl)
  && /pickBounds\(this\.settings\.bounds, displays, hint\)/.test(dl)
  && /width: bounds\?\.width \?\? hint\.width/.test(dl)
  && /height: bounds\?\.height \?\? hint\.height/.test(dl)
  && !/\?\? 150/.test(dl) && !/\?\? 720/.test(dl));
{
  // 开窗构造块：从尺寸提示那一行到标题（四个 min/max 选项都在这一段里）
  const ctorBody = dl.slice(dl.indexOf("const hints = sizeHintsFor(bounds?.height"), dl.indexOf("title: \"Quaver 桌面歌词\""));
  check("**申请浮窗**：min/max 尺寸提示进构造参数，吃的是「记忆里能用的高度 ?? 贴合高度」（映射那一刻合成器就判浮窗，show 之后再补就晚了一帧）",
    /const hints = sizeHintsFor\(bounds\?\.height \?\? hint\.height\);/.test(ctorBody)
    && /minWidth: hints\.minWidth/.test(ctorBody) && /maxWidth: hints\.maxWidth/.test(ctorBody)
    && /minHeight: hints\.minHeight/.test(ctorBody) && /maxHeight: hints\.maxHeight/.test(ctorBody));
  const refitBody = (dl.match(/private refitHeight\(\)[\s\S]*?\n  \}/) ?? [""])[0];
  check("档位（字号/行数/辅助行）变了把窗高重新贴合，且**只长不缩**（用户拖出来的高度不该被配置改动抹掉）",
    /const capacityChanged = this\.settings\.scale !== next\.scale\s*\|\| this\.settings\.mode !== next\.mode \|\| this\.settings\.aux !== next\.aux;/.test(dl)
    && /else if \(capacityChanged\) this\.refitHeight\(\);/.test(dl)
    && /const from = this\.pinnedHeight \|\| h;/.test(refitBody)
    && /const want = Math\.max\(defaultSizeFor\(this\.settings\)\.height, from\);/.test(refitBody)
    && /if \(from >= want\) return;/.test(refitBody)
    && /this\.pinHeight\(w, want\);/.test(refitBody));
  const pinHBody = (dl.match(/private pinHeight\([\s\S]*?\n  \}/) ?? [""])[0];
  const pinBody = (dl.match(/private pinSize\([\s\S]*?\n  \}/) ?? [""])[0];
  const relBody = (dl.match(/private releaseWidth\([\s\S]*?\n  \}/) ?? [""])[0];
  check("pinHeight = 只钉高度（宽度留区间）+ setSize：档位变化/开窗/松手走它，提示是 Wayland 下唯一真生效的那步",
    /const hints = sizeHintsFor\(height\);/.test(pinHBody)
    && /win\.setMinimumSize\(hints\.minWidth, hints\.minHeight\);/.test(pinHBody)
    && /win\.setMaximumSize\(hints\.maxWidth, hints\.maxHeight\);/.test(pinHBody)
    && /win\.setSize\(width, hints\.minHeight\);/.test(pinHBody)
    && /this\.pinnedHeight = hints\.minHeight;/.test(pinHBody));
  check("pinSize = 拖动中**两条轴一起钉**（pinnedHintsFor）：Wayland 下 setSize 改不动窗体盒，只推提示才跟得上",
    /const hints = pinnedHintsFor\(width, height\);/.test(pinBody)
    && /win\.setMinimumSize\(hints\.minWidth, hints\.minHeight\);/.test(pinBody)
    && /win\.setMaximumSize\(hints\.maxWidth, hints\.maxHeight\);/.test(pinBody)
    && /win\.setSize\(hints\.minWidth, hints\.minHeight\);/.test(pinBody)
    && /this\.pinnedWidth = hints\.minWidth;/.test(pinBody) && /this\.pinnedHeight = hints\.minHeight;/.test(pinBody));
  check("releaseWidth = 松手把宽度放回区间（拖完仍交给 WM 拖边），高度继续钉死",
    /this\.pinHeight\(this\.pinnedWidth \|\| w, this\.pinnedHeight \|\| h\);/.test(relBody));
}
check("did-finish-load 补发 track/sync（晚到的窗；this.win 身份门防拆窗竞态）", /did-finish-load[\s\S]*?this\.win !== win[\s\S]*?latestTrack[\s\S]*?latestSync/.test(dl));
check("关闭覆盖层落 Enabled=False，但随应用退出被销毁时不写", /isQuitting\(\)[\s\S]{0,120}DesktopLyrics\.Enabled"\: "False"/.test(dl) || (/if \(!this\.deps\.isQuitting\(\)\)/.test(dl) && /"DesktopLyrics\.Enabled": "False"/.test(dl)));
check('命令/窗口操作有 sender 校验（dl-cmd 只收覆盖层、dl-track 只收主窗）', /fromDlWin\(e\.sender\)/.test(dl) && /fromMainWin\(e\.sender\)/.test(dl));
check("位置落盘去抖（别一帧一次 INI）", /setTimeout\(\(\) => this\.persistBoundsNow\(\), 500\)/.test(dl));
check("挪窗不再走 IPC（move-by 整条路删掉：setPosition 在 Wayland 上本就无效）",
  !/move-by/.test(dl) && !/move-by/.test(src("src/desktop-lyrics.ts"))
  && /resize-by/.test(dl) && /op: "resize-by"/.test(src("src/desktop-lyrics.ts")));
check("resize-by 两条轴都走 pinSize（拖动期间两条轴都钉）；resize-end 才放回宽度",
  /const dx = Number\(msg\?\.dx\) \|\| 0;/.test(dl) && /const dy = Number\(msg\?\.dy\) \|\| 0;/.test(dl)
  && /const size = clampSize\(fromW \+ dx, fromH \+ dy\);/.test(dl)
  && /this\.pinSize\(size\.width, size\.height\);/.test(dl)
  && /case "resize-end":/.test(dl) && /this\.releaseWidth\(\);/.test(dl)
  && /windowOp\(\{ op: "resize-by", dx, dy \}\)/.test(src("src/desktop-lyrics.ts"))
  && /windowOp\(\{ op: "resize-end" \}\)/.test(src("src/desktop-lyrics.ts")));
check("拖动的基准取 pinned* 镜像，不读 win.getSize()（Wayland 上后者滞后，逐帧增量会被吃掉）",
  /const fromW = this\.pinnedWidth \|\| w;/.test(dl)
  && /const fromH = this\.pinnedHeight \|\| h;/.test(dl)
  && !/clampSize\(w \+ dx, h \+ dy\)/.test(dl)
  && /this\.pinnedWidth = bounds\?\.width \?\? hint\.width;/.test(dl.slice(dl.indexOf("this.win = win;"), dl.indexOf("win.loadURL")))
  && /this\.pinnedHeight = hints\.minHeight;/.test(dl.slice(dl.indexOf("this.win = win;"), dl.indexOf("win.loadURL"))));
check("把手照旧是右下角斜向（两条轴都有反馈）",
  /cursor: nwse-resize/.test(src("src/desktop-lyrics.css"))
  && /right: 0;\s*\n\s*bottom: 0;/.test(src("src/desktop-lyrics.css")));
check("窗体不透明度不做原生 setOpacity（Linux 不实现会造成三平台口径分叉）：一律用「背板」这一层表达",
  !/NATIVE_WIN_OPACITY|winOpacity|setOpacity/.test(dl)
  && /key: "Backdrop"/.test(src("electron/config.ts")));const syncBody = (dl.match(/syncFromConf\(\)[\s\S]*?\n  \}/) ?? [""])[0];
check("syncFromConf 不写盘（幂等对齐，无回流循环）", /parseSettings\(this\.readConf\(\)\)/.test(syncBody) && !/writeValues|persistConf/.test(syncBody));
// 回归红线（真机踩坑：关了再也打不开）——主进程直写 quaver.conf 若不广播增量，
// 渲染层内存快照过期，cfgSet 的「值没变」短路会吃掉下一次开启的写盘，syncFromConf 永不触发。
check("Enabled 的直写恒走 persistConf（写盘+广播成对，杜绝静默写）",
  /persistConf\(\{ "DesktopLyrics\.Enabled": on \? "True" : "False" \}\)/.test(dl)
  && /persistConf\(\{ "DesktopLyrics\.Enabled": "False" \}\)/.test(dl));
check("persistConf = writeValues + broadcastConfig 成对（函数体内两步，缺一不可）",
  /private persistConf\(values[^{]*\{[\s\S]*?writeValues\(values\);[\s\S]*?this\.deps\.broadcastConfig\(values\);[\s\S]*?\n  \}/.test(dl));
check("main.ts 把广播接到 quaver:config-changed（与设置页写盘同一门）",
  /broadcastConfig: \(values\) => broadcastConfigChanged\(Object\.keys\(values\), values\)/.test(main));
const boundsBody = (dl.match(/private persistBoundsNow[\s\S]*?\n  \}/) ?? [""])[0];
check("记忆坐标 X/Y/W/H 保持静默直写（本模块私事，拖窗不刷全窗广播）",
  /writeValues\(boundsToPatch\(b\)\)/.test(boundsBody) && !/broadcastConfig/.test(boundsBody));

// ——— 5. preload ———
section("electron/preload.cts 桥");
const preload = src("electron/preload.cts");
check("quaverDesktopLyrics 双面（主窗推/收 + 覆盖层收/发）齐", /sendTrack[\s\S]*sendSync[\s\S]*control[\s\S]*activeSync[\s\S]*onActive[\s\S]*onCmd[\s\S]*onTrack[\s\S]*onSync[\s\S]*sendCmd[\s\S]*windowOp/.test(preload));
check("quaverConfig.onChanged 暴露（跨窗配置广播）", /onChanged[\s\S]{0,120}quaver:config-changed/.test(preload));

// ——— 6. 主窗桥（渲染层） ———
section("src/lib/desktop-lyrics.ts 桥（契约在 desktop-lyrics-protocol.ts）");
const bridge = src("src/lib/desktop-lyrics.ts");
const proto = src("src/lib/desktop-lyrics-protocol.ts");
check("时钟补偿 200ms 与 NowPlaying 组 ctx 的 +0.2 同值", proto.includes("CLOCK_COMP_MS = 200")
  && /\(player\.time \+ 0\.2\) \* 1000/.test(src("src/components/NowPlaying.ts")));
check("posMs 是裸播放头（不含补偿不含延迟）", /posMs: Math\.max\(0, \(player\.time \|\| 0\) \* 1000\)/.test(bridge));
check("只在覆盖层在线时推镜像（active 门）", /if \(active\) pushAll\(\)/.test(bridge));
check("曲目整包按指纹去抖（歌词不跟 4Hz 重推）", /trackFp/.test(bridge) && /fp !== lastTrackFp/.test(bridge));
check("覆盖层晚到 → 当前包重推（清指纹）", /lastTrackFp = "";\s*\/\/ 覆盖层晚到/.test(bridge) || (/if \(open && !wasOpen\)/.test(bridge) && /lastTrackFp = ""/.test(bridge)));
check("命令执行全在主窗：prev 走 prevPress、延迟走 setLyricDelayMs + notifyPublic", /player\.prevPress\(\)/.test(bridge) && /setLyricDelayMs\(player\.current, v\)/.test(bridge) && /player\.notifyPublic\(\)/.test(bridge));
check("延迟钳制口径与菜单一致（±10s、0.1s 档）", /LYRIC_DELAY_MAX_MS/.test(bridge) && /LYRIC_DELAY_STEP_MS/.test(bridge));
check("歌词两路原文透传（档位由覆盖层现选，桥不代挑）", /lines: player\.lyrics\.map/.test(bridge) && /trans: l\.trans, roma: l\.roma/.test(bridge));
check("曲目抬头随整包镜像：songTitle + 多歌手连接 + 播放控制条同款 150px 封面 URL",
  /title: c \? songTitle\(c\) : ""/.test(bridge)
  && /artist: \(c\?\.singer \?\? \[\]\)\.map\(\(s\) => s\?\.name\)\.filter\(Boolean\)\.join\(" \/ "\)/.test(bridge)
  && /cover: c \? coverUrl\(c, 150\) : ""/.test(bridge)
  && /coverUrl\(s, 150\)/.test(src("src/components/PlayerBar.ts")));
check("标题/歌手/封面进曲目指纹（原地改元数据也能推新抬头）",
  /\$\{t\.title\}\|\$\{t\.artist\}\|\$\{t\.cover\}/.test(bridge));

// ——— 7. 覆盖层页 ———
section("src/desktop-lyrics.ts 覆盖层页");
const page = src("src/desktop-lyrics.ts");
check("歌词内容版本进桥指纹与覆盖层重绘判据（同曲重导入可覆盖）",
  /lyricRevision: player\.lyricRevision/.test(bridge) && /t\.lyricRevision/.test(bridge)
  && /track\.lyricRevision/.test(page));
check("渲染引擎 = 宿主内置 AMLL（复用 builtinKaraokeProvider，不复制渲染实现）", /import \{ amllPlayerByHost, builtinKaraokeProvider \} from "\.\/lyrics\/amll"/.test(page) && /builtinKaraokeProvider\.render\(clip, lines, ctx\)/.test(page));
check("零 player 依赖（镜像窗不许再持有一个播放器）", !/from "\.\.\/player"|from "\.\/player"/.test(page) && !/import \{ player \}/.test(page));
check("不调 API（无 fetch / /api：歌词与封面 URL 都随桥镜像来）", !/fetch\(/.test(page) && !/\/api\//.test(page));
check("恒展开（覆盖层没有收起一档）", /expanded: \(\) => true/.test(page));
check("时钟 = 快照外推 + 补偿（延迟扣减在 amll.ts 内做）", /time: \(\) => rawPosMs\(\) \+ CLOCK_COMP_MS/.test(page));
check("歌词延迟取镜像现值（正=延后口径不动）", /lyricDelay: \(\) => sync\?\.delayMs \?\? 0/.test(page));
check("字体家族走独立的 [DesktopLyrics] Font（不再读本体 Style.DefaultLyricsFonts）",
  /fontCssOf\(getDesktopLyricsFontList\(\)\)/.test(page) && !/cfg\([\s\S]{0,50}Style\.DefaultLyricsFonts/.test(page));
check("文字描边走 [DesktopLyrics] Border，写成 --dl-border 供 CSS 消费",
  /getDesktopLyricsBorder\(\)/.test(page) && /--dl-border/.test(page));
check("文字阴影走 Shadow* 一组，合成单层 text-shadow 到 --dl-shadow",
  /getDesktopLyricsShadow\(\)/.test(page) && /getDesktopLyricsShadowBlur\(\)/.test(page)
  && /getDesktopLyricsShadowOpacity\(\)/.test(page) && /getDesktopLyricsShadowX\(\)/.test(page)
  && /getDesktopLyricsShadowY\(\)/.test(page) && /--dl-shadow/.test(page));
check("字号走专属 [DesktopLyrics] Scale", /getDesktopLyricsScale\(\)/.test(page) && /--dl-font-size/.test(page));
check("字重走专属 [DesktopLyrics] Weight：--dl-font-weight 同时供 font-weight 与 wght 轴",
  /getDesktopLyricsWeight\(\)/.test(page) && /--dl-font-weight/.test(page));
check("缩放把手走窗口操作通道（挪窗交给 CSD 拖拽区，不走 IPC）",
  /windowOp\(\{ op: "resize-by", dx, dy \}\)/.test(page) && /windowOp\(\{ op: "close" \}\)/.test(page)
  && !/"move-by"/.test(page) && !/setPosition\(/.test(page));
check("覆盖层锁定按钮只在平台支持时出现；点击只发「锁上」，解锁走托盘/设置页",
  /id="dl-lock"/.test(src("desktop-lyrics.html")) && /lockBtn\.onclick = \(\) => windowOp\(\{ op: "lock", on: true \}\)/.test(page)
  && /lockBtn\.hidden = !canLock/.test(page) && /root\.classList\.toggle\("dl-locked", locked\)/.test(page));
check("行点击不跳转（产品决定：覆盖层只读，seek 只走进度条）", /seek: \(_ms: number\) => \{\}/.test(page) && !/suppressSeekUntil/.test(page));
check("进度条点击 seek 保留（播放控制器的一部分）", /progress\.onclick[\s\S]*sendCmd\(\{ cmd: "seek", ms: ratio \* dur \* 1000 \}\)/.test(page));
check("行级兜底整形为整行单音节（对齐内置引擎对 LRC 的约定）", /function linesToKaraoke/.test(page) && /words: \[\{ word: l\.text/.test(page));
check("两层不透明度各管各的：歌词层走 --dl-opacity（内容两处：#dl-clip/#dl-empty），窗体背板走 --dl-win-alpha（<html> → #dl-board）",
  /root\.style\.setProperty\("--dl-opacity", String\(getDesktopLyricsOpacity\(\)\)\)/.test(page)
  && /docEl\.style\.setProperty\("--dl-win-alpha", String\(getDesktopLyricsBackdrop\(\)\)\)/.test(page)
  && /getDesktopLyricsBackdrop/.test(src("src/lib/prefs.ts")));
check("字号基准两处同源：core 的 DL_FONT_BASE_PX ⇄ 覆盖层 applyStyle 的 `24 * scale`（默认窗高靠它算）",
  /root\.style\.setProperty\("--dl-font-size", `\$\{Math\.round\(24 \* scale\)\}px`\)/.test(page)
  && /export const DL_FONT_BASE_PX = 24;/.test(src("electron/desktop-lyrics-core.ts")));
const pageHtml = src("desktop-lyrics.html");
check("页面壳存在且入口为外链模块（CSP script-src 无 inline）", /<script type="module" src="\/src\/desktop-lyrics\.ts"><\/script>/.test(pageHtml) && !/<script>(?!<)/.test(pageHtml.replace(/<script [^>]*><\/script>/g, "")));
check("控制条左侧有曲目抬头（小封面 + 歌名 - 歌手），文本节点由 JS 回填",
  /id="dl-track-info"/.test(pageHtml) && /id="dl-cover"/.test(pageHtml)
  && /id="dl-track-meta"/.test(pageHtml) && /const label = title && artist \? `\$\{title\} - \$\{artist\}`/.test(page)
  && /trackMeta\.textContent = label/.test(page));
check("CSP 样式允许注入（style-src 'unsafe-inline' 覆盖内联 style 属性，勿改 script 姿态）", /style-src 'self' 'unsafe-inline'/.test(src("electron/csp.ts")));
check("vite PAGES 收录 desktop-lyrics", /const PAGES = \[[^\]]*"desktop-lyrics"/.test(src("vite.config.ts")));
const css = src("src/desktop-lyrics.css");
const layout = src("src/lib/desktop-lyrics-layout.ts");
check("透明页面：body 无底色", /html, body \{[\s\S]*?background: transparent/.test(css));
check("CSD 拖拽区：整层 drag + 三处控件 no-drag（同一子树内才挖得动洞）",
  /#dl-root \{[\s\S]*?-webkit-app-region: drag;/.test(css)
  && /#dl-tools,[\s\S]{0,120}#dl-progress,[\s\S]{0,120}#dl-resize,[\s\S]{0,120}#dl-tools button \{[\s\S]{0,80}-webkit-app-region: no-drag;/.test(css));
check("歌词层透明度吃 --dl-opacity，且挂在内容而不是整层 #dl-root（控件与背板都不该被它连坐）",
  /#dl-clip,[\s\S]{0,40}?#dl-empty \{[\s\S]{0,60}?opacity: var\(--dl-opacity, 1\);/.test(css)
  && !/#dl-root \{[\s\S]{0,400}?opacity: var\(--dl-opacity/.test(css));
{
  const prefsText = src("src/lib/prefs.ts");
  check("悬停地板的常量与判据在 prefs：max(设置, 0.3) —— 高于 0.3 完全照设置来；不新增配置键、不碰原生 setOpacity",
    /export const DL_HOVER_OPACITY_FLOOR = 0\.3;/.test(prefsText)
    && /return Math\.max\(clampDlOpacity\(opacity\), DL_HOVER_OPACITY_FLOOR\)/.test(prefsText)
    && /hoverOpacityOf\(getDesktopLyricsOpacity\(\)\)/.test(prefsText)
    && !/DesktopLyrics\.HoverOpacity/.test(prefsText)
    && !/win\.setOpacity\(/.test(prefsText));
  check("覆盖层把地板算成一个 CSS 变量挂在 root 上（内容两处继承它），控件不连坐",
    /root\.style\.setProperty\("--dl-hover-opacity", String\(getDesktopLyricsHoverOpacity\(\)\)\)/.test(page)
    && !/--dl-hover-comp/.test(page) && !/hoverCompOf/.test(prefsText));
  check("CSS：悬停时内容吃 --dl-hover-opacity（JS 缺席回落 --dl-opacity），进出悬停淡一下不跳",
    /#dl-root:hover #dl-clip,[\s\S]{0,140}?opacity: var\(--dl-hover-opacity, var\(--dl-opacity, 1\)\);/.test(css)
    && /#dl-clip \{[\s\S]*?transition: clip-path [\d.]+m?s ease-out, opacity [\d.]+m?s ease-out;/.test(css));
  check("悬停控件恒满值：opacity 会被浏览器夹回 1，「整层压低再给控件乘补偿」在 CSS 里根本不成立 —— 拆开才是对的",
    /#dl-root:hover #dl-tools \{[\s\S]{0,200}?opacity: 1;/.test(css)
    && /#dl-root:hover #dl-progress \{ opacity: 1; \}/.test(css)
    && /#dl-root:hover #dl-resize \{ opacity: 1; \}/.test(css));
  check("控制条浮窗贴窗体顶部（不再压在下缘）",
    /#dl-tools \{[\s\S]*?top: 6px;[\s\S]*?bottom: auto;/.test(css));
}
check("控制条顶部左侧：小封面固定尺寸、曲目文本可省略但不挤掉按钮",
  /#dl-track-info \{[\s\S]*?display: flex;[\s\S]*?flex: 0 1 190px;[\s\S]*?min-width: 0;/.test(css)
  && /\.dl-cover \{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/.test(css)
  && /\.dl-track-meta \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;/.test(css)
  && /#dl-tools button \{[\s\S]*?flex: none;/.test(css));
check("字重双通道：静态字体走 font-weight，可变字体走 font-variation-settings 的 wght 轴",
  /font-weight: var\(--dl-font-weight, 400\)/.test(css)
  && /font-variation-settings: "wght" var\(--dl-font-weight, 400\)/.test(css)
  && /font-synthesis-weight: auto/.test(css));
check("窗体背板 = 铺满**整扇窗**的一层（inset:0 的 #dl-board，不是只包歌词条带的窄条）",
  /#dl-board \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;[\s\S]*?background: rgb\(0 0 0 \/ var\(--dl-win-alpha, 0\)\);/.test(css)
  && /<div id="dl-board"><\/div>/.test(src("desktop-lyrics.html")));
check("背板是 #dl-root 的兄弟（在 root 之外）+ 变量挂 <html>：不被「歌词不透明度」连坐乘一遍",
  src("desktop-lyrics.html").indexOf('id="dl-board"') < src("desktop-lyrics.html").indexOf('id="dl-root"')
  && /docEl\.style\.setProperty\("--dl-win-alpha"/.test(page)
  && /const docEl = document\.documentElement;/.test(page));

// ——— 7.5 行数（单行/双行/居中）与染色 ———
section("src/lyrics/amll.ts 实例对照表");
const amllSrc = src("src/lyrics/amll.ts");
check("host→LyricPlayer WeakMap 导出（宿主集成方调排版旋钮的唯一出路，渲染实现不复制第二份）",
  /export const amllPlayerByHost = new WeakMap<HTMLElement, LyricPlayer>\(\)/.test(amllSrc));
check("render 挂表 / cleanup 摘表成对", /amllPlayerByHost\.set\(host, player\)/.test(amllSrc) && /amllPlayerByHost\.delete\(host\)/.test(amllSrc));

section("src/desktop-lyrics.ts 排版内核（固定视口 + clip-path 窗口）");
check("抽帧根治：宿主容器高度恒定（换行不 resize 播放器），窗口走 clip-path inset",
  /disposeRender = builtinKaraokeProvider\.render\(clip, lines, ctx\)/.test(page)
  && /setProperty\("--dl-win-t"/.test(page) && /setProperty\("--dl-win-h"/.test(page));
check("锚点 Top + 实测锚位（先给估计值起手，量到文字块中心后改写）",
  /player\.setAlignAnchor\(LayoutAlignAnchor\.Top\)/.test(page)
  && /alignApplied = calcAlignP\(\);/.test(page) && /player\.setAlignPosition\(alignApplied\)/.test(page)
  && /setAlignPosition\(p\)/.test(page));
check("垂直居中钉的是**整块文字**的实测中心（主行 + 翻译/音译），不是行盒顶 + 1em —— 旧版整体偏下的根",
  /const centerRel = \(block\.top \+ block\.bottom\) \/ 2 - wr\.top;/.test(page)
  && /const p = alignFor\(H0, centerRel\)/.test(page)
  && /return Math\.min\(max, Math\.max\(min, \(viewH \/ 2 - centerRel\) \/ viewH\)\)/.test(layout));
check("换锚位后补一刀 calcLayout(ConfigChange)：AMLL 只在时间线**状态变化**时才重排，不补这刀新锚位要等下一行才生效（当前行吊在旧位置 = 偏下）",
  /import \{ LayoutAlignAnchor, LayoutReason \} from "@applemusic-like-lyrics\/core"/.test(page)
  && /player\.setAlignPosition\(p\);[\s\S]{0,400}player\.calcLayout\(LayoutReason\.ConfigChange\);/.test(page));
check("文字盒走文本节点 Range（剔掉 core 给行/词铺的 ±1em 余量，量到的才是肉眼看到的字）",
  /document\.createTreeWalker\(el, NodeFilter\.SHOW_TEXT\)/.test(page) && /rg\.selectNodeContents\(n\)/.test(page)
  && /for \(const r of rg\.getClientRects\(\)\)/.test(page));
check("条带恒居中于视口 + 高 = 文字块高 + 上下呼吸位（切不到字，也不露上一行/和声）",
  /const \{ top, h \} = bandFor\(H0, block\.bottom - block\.top, emPx\(\) \* BAND_PAD_EM\);/.test(page)
  && /BAND_PAD_EM = 0\.25/.test(page)
  && /let top = Math\.round\(\(viewH - h\) \/ 2\)/.test(layout));
check("档位 = 要显示的整块：单行居中开=主行+翻译（和声裁掉）｜单行关居中/双行=并进和声",
  /function rowsOf\(wrapper: HTMLElement, withBg: boolean\)/.test(page)
  && /const withBg = dual \|\| !getDesktopLyricsSingleCenter\(\);/.test(page)
  && /isBgWrap/.test(page) && /includes\("BgLine"\)/.test(page));
check("超长行横向滚动：按行各自判断（主行滚时翻译不动，翻译自己太长才滚）",
  /function updateMarquee\(rows: HTMLElement\[\], wrapper: HTMLElement\): void/.test(page)
  && /for \(const row of rows\)[\s\S]{0,220}scrollRange\(aL, aR, b\.left - cur, b\.right - cur\)/.test(page)
  && /const from = aL - left;[\s\S]*?const to = aR - right;/.test(layout));
check("滚动只动「那一行」自己的 translate，并按行摘 paint containment（否则滚动被行盒裁掉）",
  /r\.el\.style\.translate = /.test(page) && /classList\.add\("dl-scrolling"\)/.test(page)
  && /#dl-clip \.amll-lyric-player \.dl-scrolling \{[\s\S]*?content-visibility: visible;[\s\S]*?contain: layout style;/.test(css));
check("长句来回滚（三角波）：两端都连续 —— 既不闪回开头，也不死在末尾",
  /function marqueeProgress\(age: number, travel: number\): number/.test(page)
  && /return 1 - \(t - MARQUEE_HOLD_MS \* 2 - travel\) \/ travel;/.test(page)
  && /const k = marqueeProgress\(now - r\.t0, marqueeTravelMs\(r\.dist\)\)/.test(page)
  && /marqueeRaf = window\.requestAnimationFrame\(marqueeTick\);\n\}/.test(page));
check("滚动相位按行元素记（4Hz 重测/瞬时掉出滚动集合都不重锚）",
  /const marqueeStart = new Map<HTMLElement, number>\(\)/.test(page)
  && /let t0 = marqueeStart\.get\(lineEl\)/.test(page));
check("滑出/隐藏的行（和声滑走只改 visibility）不算进文字块，否则条带被拉长、块心被拽偏",
  /if \(getComputedStyle\(el\)\.visibility === "hidden"\) return null;/.test(page));
check("锚位迟滞：首次直接落位，之后连续两次同读数才改（和声滑入这类帧会晃读数）",
  /let alignLocked = false;/.test(page)
  && /if \(!alignLocked \|\| \(alignPending >= 0 && Math\.abs\(p - alignPending\) < 0\.004\)\)/.test(page));
check("一行到底：nowrap + 藏 core 的平衡 <br> + 行盒 fit-content 居中（桌面歌词专属，主窗不受影响）",
  /#dl-clip \.amll-lyric-player > div \{[\s\S]*?white-space: nowrap;[\s\S]*?align-items: center;/.test(css)
  && /#dl-clip \.amll-lyric-player > div > div \{[\s\S]*?width: fit-content/.test(css)
  && /#dl-clip br \{\s*display: none;/.test(css));
check("控制条字号 A−/A+：命令走 scale 档，写 [DesktopLyrics] Scale 与设置页滑条同源",
  /sendCmd\(\{ cmd: "scale", dir: -1 \}\)/.test(page) && /sendCmd\(\{ cmd: "scale", dir: 1 \}\)/.test(page)
  && /case "scale"/.test(bridge) && /setDesktopLyricsScale\(next\)/.test(bridge));
check("控制条字重单键循环标准档：命令走 weight，写 [DesktopLyrics] Weight 同源",
  /id="dl-weight-val"/.test(pageHtml) && /sendCmd\(\{ cmd: "weight", op: "cycle" \}\)/.test(page)
  && /case "weight"/.test(bridge) && /setDesktopLyricsWeight\(next\)/.test(bridge));
check("动态窗口只写 inset 数值；首次直接落位 + 迟滞防过渡帧",
  /setWindow\(top, h\)/.test(page)
  && /if \(stripApplied < 0\) \{/.test(page)
  && /if \(stripPending !== h \|\| stripPendingTop !== top\) \{ stripPending = h; stripPendingTop = top; return; \}/.test(page));
check("选行判据：顶边最贴近锚点 s（已生效锚位的理论值，弹簧途中也能锁定到位中的当前行）",
  /const s = alignApplied \* H0;/.test(page) && /Math\.abs\(b\.top - s\)/.test(page));
check("染色四档映射（default 白｜cover=track.accent｜system=track.systemAccent｜custom= prefs 现值）",
  /mode === "cover"\) return mixInk\(track\?\.accent\)/.test(page)
  && /mode === "system"\) return mixInk\(track\?\.systemAccent\)/.test(page)
  && /mode === "custom"\) return getDesktopLyricsColor\(\)/.test(page));
check("混色公式与正在播放页同源（color-mix 55% 洗白）",
  /color-mix\(in srgb, \$\{hex\} 55%, #fff\)/.test(page) && /--amll-lp-color: color-mix\(in srgb, var\(--cvg-accent, var\(--cyan\)\) 55%, #fff\)/.test(src("src/style.css")));
check("整包重推（取色迟到补刀）时重算 --dl-ink 而不重渲染", /setProperty\("--dl-ink", lyricInk\(\)\)/.test(page));
check("行点击不跳转（产品决定：覆盖层只读，seek 只走进度条）", /seek: \(_ms: number\) => \{\}/.test(page) && !/suppressSeekUntil/.test(page));
check("进度条点击 seek 保留（播放控制器的一部分）", /progress\.onclick[\s\S]*sendCmd\(\{ cmd: "seek", ms: ratio \* dur \* 1000 \}\)/.test(page));

section("src/desktop-lyrics.css 视口与窗口");
check("视口高度 = 字号×7.5 恒定", /#dl-clip \{[\s\S]*?height: calc\(var\(--dl-font-size, 24px\) \* 7\.5\)/.test(css));
check("clip-path inset 吃 --dl-win-t/--dl-win-h，且带 transition（伸缩平滑）",
  /clip-path: inset\(var\(--dl-win-t\) 0 calc\(100% - var\(--dl-win-t\) - var\(--dl-win-h\)\) 0\)/.test(css)
  && /transition: clip-path [\d.]+m?s/.test(css));
check("初值即「单行」窗口且居中于视口（JS 缺席也显示正确形态）",
  /--dl-win-t: calc\(\(100% - var\(--dl-font-size, 24px\) \* 1\.7\) \/ 2\)/.test(css)
  && /--dl-win-h: calc\(var\(--dl-font-size, 24px\) \* 1\.7\)/.test(css));
check("AMLL 取色变量吃 --dl-ink（默认白）", /--amll-lp-color: var\(--dl-ink, #fff\)/.test(css));
check("桌面歌词不再用昂贵的 filter:drop-shadow；描边与单层 text-shadow 都可调",
  !/filter\s*:[^;]*drop-shadow\(|ink-default/.test(css)
  && /#dl-clip,[\s\S]{0,80}?#dl-empty[\s\S]{0,180}?-webkit-text-stroke: var\(--dl-border, 0px\)/.test(css)
  && /text-shadow: var\(--dl-shadow, none\)/.test(css));
check("旧「逐行改条带高度」路径已死（--dl-strip-h / mode-single 高度规则不残留）",
  !/--dl-strip-h/.test(css) && !/--dl-strip-h/.test(page) && !/mode-single #dl-stage/.test(css));

// ——— 7.9 覆盖层几何（纯函数，真断言，不是正则） ———
section("src/lib/desktop-lyrics-layout.ts 覆盖层几何");
{
  // 块心 = 视口中心：不管量出来的块心在哪，p × viewH + 块心都必须回到 viewH / 2
  const viewH = 180;
  // 只取夹取区间内的块心（|centerRel| ≤ 75.6 = 视口高的一半 − 8%）：出了这区间就是「宁可牺牲精确居中」
  for (const centerRel of [-70, -24, 0, 12, 24, 31.7, 60, 70]) {
    const p = alignFor(viewH, centerRel);
    check(`锚位把块心送回视口中心（centerRel=${centerRel}）`,
      Math.abs(p * viewH + centerRel - viewH / 2) < 1e-9, `p=${p.toFixed(4)}`);
  }
}
check("锚位夹在 [0.08,0.92]（块心离谱时也不把整块顶出视口）",
  alignFor(180, 1000) === 0.08 && alignFor(180, -1000) === 0.92);
check("视口高度异常（<40）回落 0.5", alignFor(20, 10) === 0.5);

{
  const viewH = 180, blockH = 44, pad = 6;
  const { top, h } = bandFor(viewH, blockH, pad);
  eq("条带高 = 块高 + 上下呼吸位", h, 56);
  check("条带两侧余量对称（中心恒 = 视口中心，块不会挂在下半）", top + h / 2 === viewH / 2, `top=${top}`);
  check("条带包得住整块（呼吸位真的留出来了）", h >= blockH + pad * 2 - 1);
}
check("超矮块也撑到最小高度（免得把字切出豁口）", bandFor(180, 4, 0).h === BAND_MIN_PX);
check("块比视口还高时夹进视口、不出负 top",
  (() => { const { top, h } = bandFor(180, 400, 6); return top === 0 && h === 180; })());

eq("横滚：装得下 → 不滚", scrollRange(0, 100, 10, 90), null);
eq("横滚：超宽居中 → 两端各露一半（dist = 溢出量）",
  scrollRange(0, 100, -50, 150), { from: 50, to: -50, dist: 100 });
eq("横滚：比可用区窄 1px 也算装得下（边缘不抖）", scrollRange(0, 100, 0.5, 99.5), null);
check("横滚：主行滚、翻译不滚 —— 翻译要滚只能是它自己太长",
  scrollRange(0, 100, -100, 200) !== null && scrollRange(0, 100, -100, -60) === null);

section("桌面歌词时间线：重叠主行按「当前句」顺序收口");
{
  // 《Cries In A Distance》真实 QRC 的两句：第二句 18.686s 开始，第一句 18.986s 才结束。
  // AMLL 会把这个重叠当成一个高亮组；桌面歌词必须让第二句在 18.686s 接手焦点。
  const input = [
    { startTime: 16681, endTime: 18986, words: [
      { word: "Cries ", startTime: 16681, endTime: 17321 },
      { word: "distance", startTime: 18091, endTime: 18985 },
    ] },
    { startTime: 18686, endTime: 21149, words: [{ word: "Can't stop the tremble", startTime: 18686, endTime: 21143 }] },
    { startTime: 20849, endTime: 25020, words: [{ word: "I'm just awaiting my turn", startTime: 20849, endTime: 25016 }] },
  ];
  const out = sequenceOverlappingLines(input);
  eq("第一句结束点推进到第二句起点（行级）", out[0]!.endTime, 18686);
  eq("第一句最后一个词同步收口（AMLL 会用它反推行时间）", out[0]!.words?.[1]?.endTime, 18686);
  eq("第二句也不越过后一句", out[1]!.endTime, 20849);
  eq("第三句是末句，保持原结束点", out[2]!.endTime, 25020);
  check("输入不被原地修改（镜像副本不污染 player.karaoke）",
    input[0]!.endTime === 18986 && input[0]!.words![1]!.endTime === 18985);

  const withBg = sequenceOverlappingLines([
    { startTime: 0, endTime: 3000, words: [{ startTime: 0, endTime: 3000 }] },
    { startTime: 1000, endTime: 2800, isBG: true, words: [{ startTime: 1000, endTime: 2800 }] },
    { startTime: 2600, endTime: 5000, words: [{ startTime: 2600, endTime: 5000 }] },
  ]);
  eq("跳过后面的背景和声，找下一条主行做边界", withBg[0]!.endTime, 2600);
  eq("背景和声自己的时间轴不动", withBg[1]!.endTime, 2800);
}
check("桌面歌词渲染前走顺序时间线副本，不碰主窗与歌词原始数据",
  /const lines = sequenceOverlappingLines\(track\.karaoke\.length \? track\.karaoke : linesToKaraoke\(track\.lines\)\);/.test(page));

// ——— 8. 设置页 ———
section("src/views/settings.ts 设置页");
const views = viewsSource();
check("歌词面板出现桌面歌词组（启用/独立字体/字号/描边/阴影/歌词不透明度/窗体不透明度）", /桌面歌词/.test(views)
  && /id="dl-enable-cards"/.test(views) && /id="dl-font"/.test(views) && /id="dl-scale"/.test(views)
  && /id="dl-border"/.test(views) && /id="dl-shadow-cards"/.test(views)
  && /id="dl-opacity"/.test(views) && /id="dl-backdrop"/.test(views)
  && /歌词不透明度/.test(views) && /窗体不透明度/.test(views));
check("固定/鼠标透穿开关存在，且按主进程的平台能力显隐",
  /id="dl-lock-cards"/.test(views) && /固定（鼠标透穿）/.test(views)
  && /dlLockRow\.hidden = !desktopLyricsStateSync\(\)\?\.canLock/.test(views)
  && /setDesktopLyricsLocked\(v === "on"\)/.test(views));
check("歌词面板含行数（单/双）与颜色四档 + 自定义色行", /id="dl-mode-cards"/.test(views) && /data-opt="single"/.test(views) && /data-opt="dual"/.test(views)
  && /id="dl-color-cards"/.test(views) && /data-opt="cover"/.test(views) && /data-opt="system"/.test(views) && /id="dl-color-row" hidden/.test(views));
check("自定义色行只在 custom 档显形；HEX 输入回显「当前生效值」", /dlColorRow\.hidden = getDesktopLyricsColorMode\(\) !== "custom"/.test(views) && /dlColorHex\.onchange[\s\S]*?paintDlColorRow\(\);/.test(views));
check("单行居中开关存在，且仅在行数=单行时显示", /id="dl-center-cards"/.test(views) && /setDesktopLyricsSingleCenter\(v === "on"\)/.test(views)
  && /dlCenterRow\.hidden = getDesktopLyricsMode\(\) !== "single"/.test(views));
check("prefs 门面对象齐全（Mode/ColorMode/Color getter+setter）",
  /getDesktopLyricsMode, setDesktopLyricsMode/.test(src("src/lib/prefs.ts")) || (/export function getDesktopLyricsMode\(\)/.test(src("src/lib/prefs.ts")) && /export function setDesktopLyricsColor\(v: string\)/.test(src("src/lib/prefs.ts"))));
check("开关只写配置（生效走主进程 syncFromConf 单路）", /setDesktopLyrics\(v === "on"\)/.test(views) && /setDesktopLyricsLocked\(v === "on"\)/.test(views));
check("字号滑条 50..200%", /min="50" max="200"/.test(views) && /setDesktopLyricsScale\(Number\(dlScale\.value\) \/ 100\)/.test(views));
check("字重滑条 100..900（10 一档），绑定独立 setDesktopLyricsWeight",
  /id="dl-weight" type="range" min="100" max="900" step="10"/.test(views)
  && /setDesktopLyricsWeight\(Number\(dlWeight\.value\)\)/.test(views));
check("桌面歌词字体独立绑定 [DesktopLyrics] Font（不调用 applyFonts）",
  /setDesktopLyricsFontList, setDesktopLyricsFontPreset, getDesktopLyricsFontList\(\)/.test(views)
  && !/setDesktopLyricsFontList[\s\S]{0,160}applyFonts/.test(views));
check("描边滑条 0..4px，绑定 setDesktopLyricsBorder",
  /id="dl-border" type="range" min="0" max="4" step="0\.5"/.test(views)
  && /setDesktopLyricsBorder\(Number\(dlBorder\.value\)\)/.test(views));
check("阴影系统：开关 + 模糊/透明度/X/Y 四个滑条都接独立写路",
  /id="dl-shadow-cards"/.test(views) && /setDesktopLyricsShadow\(v === "on"\)/.test(views)
  && /id="dl-shadow-blur" type="range" min="0" max="32"/.test(views)
  && /id="dl-shadow-opacity" type="range" min="0" max="100"/.test(views)
  && /id="dl-shadow-x" type="range" min="-12" max="12"/.test(views)
  && /id="dl-shadow-y" type="range" min="-12" max="12"/.test(views)
  && /setDesktopLyricsShadowBlur/.test(views) && /setDesktopLyricsShadowOpacity/.test(views)
  && /setDesktopLyricsShadowX/.test(views) && /setDesktopLyricsShadowY/.test(views));
check("歌词不透明度滑条 10..100%（调的是字）",
  /id="dl-opacity" type="range" min="10" max="100" step="5"/.test(views)
  && /歌词不透明度/.test(views)
  && /setDesktopLyricsOpacity\(Number\(dlOpacity\.value\) \/ 100\)/.test(views));
check("桌面歌词说明只保留固定功能的平台限制",
  /固定（鼠标透穿）」仅在 macOS \/ Windows \/ X11 会话开放/.test(views)
  && !/悬停地板/.test(views) && !/不支持最大化/.test(views) && !/申请浮窗/.test(views));
check("窗体不透明度滑条 0..100%（调背板，默认 0 = 只有字）——与歌词那条分开、命名不混",
  /id="dl-backdrop" type="range" min="0" max="100" step="5"/.test(views)
  && /窗体不透明度/.test(views)
  && /setDesktopLyricsBackdrop\(Number\(dlBackdrop\.value\) \/ 100\)/.test(views)
  && /getDesktopLyricsBackdrop\(\)/.test(src("src/lib/prefs.ts")));

// ——— 9. 启动接线 ———
section("src/main.ts 启动");
check("主窗启动桥（Electron 壳层外 no-op）", /startDesktopLyricsBridge\(\)/.test(src("src/main.ts")));
check("lib/config 订阅广播做增量合并（未知键不接收）", /mergeFromBroadcast[\s\S]*?if \(!\(k in values\)\) continue/.test(src("src/lib/config.ts")));

// ——— 10. package.json ———
section("package.json：verify 脚本与总闸");
const pkg = JSON.parse(src("package.json"));
check("verify:desktop-lyrics 脚本存在", pkg.scripts?.["verify:desktop-lyrics"]?.includes("verify-desktop-lyrics.ts"));
check("verify:static 收录了 verify-desktop-lyrics（新脚本必须进总闸，否则等于没测）", String(pkg.scripts?.["verify:static"]).includes("node scripts/verify-desktop-lyrics.ts"));

console.log(`\n${fail ? "❌" : "✅"} verify-desktop-lyrics: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
