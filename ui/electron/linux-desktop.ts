// Quaver — Linux 桌面集成自装（<app_id>.desktop + hicolor 图标），纯 Node ESM，零依赖，可脱离 Electron 单测。
//
// 为什么应用要自己装这两样：桌面环境/Shell 对「窗口 → 应用 → 图标」这条链的要求各不相同，但入口
// 是同一个——窗口的 app_id / WM_CLASS（本应用 = red.0w0.quaver，真相在 package.json 的 desktopName，
// Electron init 经 CHROME_DESKTOP 生效，见 main.ts）。拿到 ID 之后，各环境都去反查
// `<ID>.desktop`，再用里面的 Icon= 去图标主题里找图：
//   • Plasma 严格按 app_id 精确匹配 <ID>.desktop——文件不存在或 Icon 是通配名（如 audio-x-generic，
//     在 Tela 下渲染成「音符」）就直接显示错图；GNOME 会再退一步做basename模糊匹配，Noctalia/其它
//     Quickshell 类壳走 Qt 的 icon theme 查找。所以「同一个应用在不同桌面图标不一样」的根因
//     几乎总是 <ID>.desktop 缺失或内容不对，而不是图标本身。
//   • 条目必须**可见**（不能带 NoDisplay/Hidden）：Noctalia 解析 desktop 时整条丢弃隐藏条目
//     （noctalia-dev/noctalia#4626 同因），窗口 app_id 反查不到自己，退到 id 尾段模糊匹配就可能
//     撞上集成工具留下的别的条目（如 quaver.desktop，Icon=quaver 在 Qt 图标链里查不到），表现就是
//     Dock/任务栏无图标。GNOME 的 g_app_info_get_all 连隐藏条目也索引、又按精确 id 优先，所以同样
//     的文件在 GNOME 上看不出问题——不要据此认为 NoDisplay 无害。
//   • xdg-desktop-portal（GlobalShortcuts）同样按 ID 找桌面文件，1.21+ 解析不到直接拒会话。
//   • AppImage 只有被集成工具（AppImageLauncher 等）接管时才把内部的 desktop 文件/图标装进用户
//     目录；裸跑（直接执行 AppImage）时什么都没有。开发态更不会有任何东西替我们装。
//   • distro 包（electron-builder 的 deb/rpm/pacman，装到 /opt/<productName>，带
//     resources/package-type）**已经**把可见的 <ID>.desktop 装在 /usr/share/applications，还带一份
//     /usr/share/icons/hicolor/.../apps/<ID>.png。这种布局里没有任何 AppRun，用户目录再写一份不是
//     「补装」而是**遮蔽**：XDG 搜索顺序里 $XDG_DATA_HOME 在 /usr/share 之前，用户那份赢，包升级
//     换了 Exec 也轮不到它生效。所以系统条目在场时本模块整件事都不做（见 findSystemDesktopEntry）。
//
// 自装策略（只动自己的命名空间，幂等，失败不致命）：
//   • 系统级（包管理器装的）可见 <ID>.desktop 存在 → 全部让位，并清掉自己以前写下的那份托管文件；
//   • hicolor/<size>/apps/<app_id>.png —— 每次启动都对齐（内容一致就跳过，不刷 mtime）；
//   • applications/<app_id>.desktop —— 三种情况（幂等，失败不致命）：
//       带我们 X-Quaver-Managed 标记 → 整份强制对齐（自己上次写的那份内容漂移也修回来）；
//       别人写的且 Icon= 已指向我们的图标名且条目可见 → 让位不碰（集成工具装的可见启动条目以它
//         为准，避免启动器里出现重复项）；
//       其余（缺失 / Icon 是通配名等坏值 / 被 Hidden 或 NoDisplay 藏起来了）→ 改写成**可见**条目：
//         身份文件必须可见，否则 Noctalia 这类壳整条丢弃，app_id 反查不到就丢图标（见上）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir as readdirAsync } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export const DESKTOP_ID = "red.0w0.quaver"; // = appId = app_id = WM_CLASS（.desktop 去后缀）

/** 用户级 XDG data 根：$XDG_DATA_HOME 优先，默认 ~/.local/share。 */
export function xdgDataHome(env = process.env, home = homedir()) {
  const xdg = String(env.XDG_DATA_HOME ?? "").trim();
  return xdg || join(home, ".local", "share");
}

/** 系统级 XDG data 根：$XDG_DATA_DIRS 优先，默认 /usr/local/share:/usr/share（XDG 规范的默认值）。 */
export function xdgDataDirs(env = process.env) {
  const dirs = String(env.XDG_DATA_DIRS ?? "").trim();
  return (dirs || "/usr/local/share:/usr/share").split(":").filter(Boolean);
}

/**
 * 包管理器装好的 <ID>.desktop（第一个**可见**的那份），没有返回 null。
 * 找到它就意味着「有人替我们装过了」，而且是比我更权威的人：那份文件属于包，升级时跟着包一起换。
 * 用户目录里的副本会把它整个盖住（$XDG_DATA_HOME 在 XDG_DATA_DIRS 之前），所以系统条目在场时
 * 我们连写都不写——这不只是避免重复项，是避免用一个过期的 Exec 顶掉包管理器的真相。
 * 隐藏条目（NoDisplay/Hidden）不算数：Noctalia 会整条丢弃（见模块头 #4626），那种情况照旧由我们收编。
 */
export function findSystemDesktopEntry(desktopId, env = process.env) {
  for (const root of xdgDataDirs(env)) {
    const file = join(root, "applications", `${desktopId}.desktop`);
    try {
      if (!existsSync(file)) continue;
      if (readDesktopHidden(readFileSync(file, "utf8"))) continue;
      return file;
    } catch { /* 读不动就当这个根没有，继续看下一个 */ }
  }
  return null;
}

// desktop 文件值转义：反斜杠与换行按 spec 转义；本项目自己的字段不会出现这些，防御性兜一下
const escapeEntryValue = (v) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");

/** Exec 的参数引号（double-quote 规则）：路径带空格（如 ~/Applications/Quaver Music）必须包住。 */
export function quoteExecPath(p) {
  return `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * 生成桌面条目内容（键序固定，输出确定 → 可与磁盘内容逐字比对实现幂等）。
 * **必须可见**（不带 NoDisplay/Hidden）：Noctalia 整条丢弃隐藏条目，隐藏 = app_id 反查不到 =
 * 窗口/Dock 没图标（noctalia-dev/noctalia#4626）。想从启动器藏应用得用启动器自己的隐藏功能。
 */
export function desktopEntryContent({ desktopId, name, comment, exec, icon = desktopId, categories = "AudioVideo;Audio;" }) {
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeEntryValue(name)}`,
    ...(comment ? [`Comment=${escapeEntryValue(comment)}`] : []),
    `Exec=${exec}`,
    `Icon=${escapeEntryValue(icon)}`,
    "Terminal=false",
    `Categories=${categories}`,
    `StartupWMClass=${escapeEntryValue(desktopId)}`,
    "X-Quaver-Managed=true",
  ];
  return lines.join("\n") + "\n";
}

/** 从现有 desktop 文件抓 [Desktop Entry] 的 Icon= 值；没有/不是 Application 类型返回 null。 */
export function readDesktopIcon(text) {
  return readDesktopEntryValue(text, "Icon");
}

/** 抓 [Desktop Entry] 段里任意键的值（大小写不敏感）；没有返回 null。 */
export function readDesktopEntryValue(text, key) {
  const want = String(key).toLowerCase();
  let inEntry = false;
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("[")) { inEntry = t === "[Desktop Entry]"; continue; }
    if (!inEntry) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    if (t.slice(0, eq).trim().toLowerCase() === want) return t.slice(eq + 1).trim();
  }
  return null;
}

const parseDesktopBool = (v) => ["true", "1", "yes"].includes(String(v ?? "").trim().toLowerCase());

/**
 * 该 desktop 文件是否被藏起来了（NoDisplay 或 Hidden）。两者语义不同但后果一样：
 * Noctalia 解析时整条丢弃，app_id 反查不到就丢图标（noctalia-dev/noctalia#4626），必须改写可见。
 */
export function readDesktopHidden(text) {
  return parseDesktopBool(readDesktopEntryValue(text, "NoDisplay")) || parseDesktopBool(readDesktopEntryValue(text, "Hidden"));
}

const SIZE_RE = /^(\d+)x\1\.png$/;

// GTK 家（GNOME 等）在 hicolor 有 icon-theme.cache 时**不会**因为目录里多了新文件而重扫
// （实测：新装图标 GtkIconTheme 查不到，gtk-update-icon-cache 之后立刻能查到）。所以图标有实际
// 写入时刷一次缓存；工具不存在的系统本就没有缓存、走实时扫描，同样不需要它。尽力而为，不等待。
function refreshIconCache(hicolorDir) {
  try {
    const child = spawn("gtk-update-icon-cache", ["-f", "-t", hicolorDir], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // ENOENT：没装这个工具，忽略
    child.unref();
  } catch { /* 与上面同因 */ }
}

/**
 * 把 iconSourceDir 下的 <N>x<N>.png 对齐到 <dataHome>/icons/hicolor/<N>x<N>/apps/<desktopId>.png。
 * 内容一致跳过（不碰 mtime，免得反复打掉图标缓存的有效性）。返回实际写入的尺寸列表。
 */
async function syncHicolorIcons({ iconSourceDir, dataHome, desktopId }) {
  const written = [];
  let files = [];
  try {
    files = await readdirAsync(iconSourceDir);
  } catch {
    return written; // 素材目录缺失（打包漏配/开发态刚拉仓库）：静默跳过，图标走 fallback
  }
  for (const name of files) {
    const m = SIZE_RE.exec(name);
    if (!m) continue;
    const sizeDir = `${m[1]}x${m[1]}`;
    const src = join(iconSourceDir, name);
    const destDir = join(dataHome, "icons", "hicolor", sizeDir, "apps");
    const dest = join(destDir, `${desktopId}.png`);
    try {
      if (existsSync(dest) && readFileSync(dest).equals(readFileSync(src))) continue;
      mkdirSync(destDir, { recursive: true, mode: 0o755 });
      writeFileSync(dest, readFileSync(src), { mode: 0o644 });
      written.push(sizeDir);
    } catch {
      // 单个尺寸失败不挡其余尺寸（比如目录只读）
    }
  }
  return written;
}

/**
 * 安装/升级桌面集成。policy：系统级（包管理器装的）可见条目在场 → 全让位；否则 desktop 文件
 * 「Icon 已正确且条目可见 → 让位，否则收编」，图标「对齐为准」。
 * **只碰带 X-Quaver-Managed 标记的文件**：用户自己复制一份改启动参数（Exec 加 --xxx、或换 Icon）
 * 属于用户自己的条目，本模块一个字都不动 —— 那也正是 XDG 允许的用法。
 * 返回 { desktopFile, desktopAction: "kept"|"written"|"absent"|"system"|"system-cleaned",
 * systemDesktopFile, iconsWritten }，全程不抛（失败靠日志观察）。
 */
export async function installLinuxDesktopIntegration({
  desktopId = DESKTOP_ID,
  name,
  comment = "",
  exec,
  categories,
  iconSourceDir,
  dataHome = xdgDataHome(),
  env = process.env, // 系统 XDG_DATA_DIRS 的来源（测试注入，免得踩到宿主机真装了包）
  refreshCache = true, // 测试注入 false：不对外部 gtk-update-icon-cache 产生时序依赖
  log = () => {},
}) {
  const result = { desktopFile: null, desktopAction: "absent", systemDesktopFile: null, iconsWritten: [] };
  const appsDir = join(dataHome, "applications");
  const file = join(appsDir, `${desktopId}.desktop`);
  result.desktopFile = file;
  // 包管理器装的可见系统条目在场 → 本模块整件事都不做（图标也是它那份包的一部分）。而且要顺手清掉
  // 自己以前写下的托管文件：留着的后果是启动器一直用一个死的 Exec —— 真踩过：rpm 装到
  // /opt/<productName>，我们按「解包 AppImage」猜出的 /opt/<productName>/AppRun 根本不存在。
  // 清理**只认自己那枚标记**：用户复制系统条目、自己改启动参数的那份没有 X-Quaver-Managed，
  // 一律不碰（它本来就该赢 —— 用户目录优先正是这么用的）。
  const systemEntry = findSystemDesktopEntry(desktopId, env);
  if (systemEntry) {
    result.systemDesktopFile = systemEntry;
    result.desktopAction = "system";
    try {
      if (existsSync(file) && readDesktopEntryValue(readFileSync(file, "utf8"), "X-Quaver-Managed") === "true") {
        rmSync(file, { force: true });
        result.desktopAction = "system-cleaned";
      }
    } catch (e) {
      log("[quaver] linux-desktop: 清理被系统条目盖住的旧副本失败:", String(e));
    }
    return result;
  }
  try {
    result.iconsWritten = await syncHicolorIcons({ iconSourceDir, dataHome, desktopId });
    if (result.iconsWritten.length && refreshCache) refreshIconCache(join(dataHome, "icons", "hicolor"));
  } catch (e) {
    log("[quaver] linux-desktop: hicolor 图标同步失败:", String(e));
  }
  try {
    const content = desktopEntryContent({ desktopId, name, comment, exec, categories });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    const existingIcon = existing == null ? null : readDesktopIcon(existing);
    // 三种情况：我们的托管文件（带 X-Quaver-Managed）→ 整份强制对齐（Exec 漂移也修回来）；
    // 别人写的、Icon 已指向我们且**可见** → 让位（集成工具的可见条目以它为准，避免启动器重复项）；
    // 其余（Icon 不对 / 条目被 NoDisplay、Hidden 藏起来）→ 改写成可见条目。内容一字未变时一律 kept。
    // 隐藏条目必须收编：Noctalia 整条丢弃它们，app_id 反查不到就丢图标（#4626），Icon 再对也没用。
    const managed = existing != null && readDesktopEntryValue(existing, "X-Quaver-Managed") === "true";
    const hidden = existing != null && readDesktopHidden(existing);
    if (existing === content) {
      result.desktopAction = "kept";
    } else if (existing != null && !managed && !hidden && existingIcon === desktopId) {
      result.desktopAction = "kept"; // 集成工具（或用户手工）放好的正确条目：让位，不碰
    } else {
      mkdirSync(appsDir, { recursive: true, mode: 0o755 });
      const tmp = join(appsDir, `.${desktopId}.desktop.tmp`);
      writeFileSync(tmp, content, { mode: 0o644 });
      renameSync(tmp, file); // 同目录 rename：读到半份内容的窗口不存在
      result.desktopAction = "written";
    }
  } catch (e) {
    log("[quaver] linux-desktop: desktop 文件安装失败:", String(e));
  }
  return result;
}
