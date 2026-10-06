// Quaver — Linux 桌面集成自装（<app_id>.desktop + hicolor 图标），纯 Node ESM，零依赖，可脱离 Electron 单测。
//
// 为什么应用要自己装这两样：桌面环境/Shell 对「窗口 → 应用 → 图标」这条链的要求各不相同，但入口
// 是同一个——窗口的 app_id / WM_CLASS（本应用 = red.0w0.quaver，真相在 package.json 的 desktopName，
// Electron init 经 CHROME_DESKTOP 生效，见 main.mjs）。拿到 ID 之后，各环境都去反查
// `<ID>.desktop`，再用里面的 Icon= 去图标主题里找图：
//   • Plasma 严格按 app_id 精确匹配 <ID>.desktop——文件不存在或 Icon 是通配名（如 audio-x-generic，
//     在 Tela 下渲染成「音符」）就直接显示错图；GNOME 会再退一步做basename模糊匹配，Noctalia/其它
//     Quickshell 类壳走 Qt 的 icon theme 查找。所以「同一个应用在不同桌面图标不一样」的根因
//     几乎总是 <ID>.desktop 缺失或内容不对，而不是图标本身。
//   • xdg-desktop-portal（GlobalShortcuts）同样按 ID 找桌面文件，1.21+ 解析不到直接拒会话。
//   • AppImage 只有被集成工具（AppImageLauncher 等）接管时才把内部的 desktop 文件/图标装进用户
//     目录；裸跑（直接执行 AppImage）时什么都没有。开发态更不会有任何东西替我们装。
//
// 自装策略（只动自己的命名空间，幂等，失败不致命）：
//   • hicolor/<size>/apps/<app_id>.png —— 每次启动都对齐（内容一致就跳过，不刷 mtime）；
//   • applications/<app_id>.desktop —— 三种情况（幂等，失败不致命）：
//       带我们 X-Quaver-Managed 标记 → 整份强制对齐（自己上次写的那份内容漂移也修回来）；
//       别人写的且 Icon= 已指向我们的图标名 → 让位不碰（集成工具装的可见启动条目以它为准，
//         避免启动器里出现重复项）；
//       其余（缺失 / Icon 是通配名等坏值）→ 写/改写成 NoDisplay=true 的「身份文件」：
//         它只负责让 app_id 能解析到正确的名字与图标，启动器条目仍归集成工具管。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// desktop 文件值转义：反斜杠与换行按 spec 转义；本项目自己的字段不会出现这些，防御性兜一下
const escapeEntryValue = (v) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");

/** Exec 的参数引号（double-quote 规则）：路径带空格（如 ~/Applications/Quaver Music）必须包住。 */
export function quoteExecPath(p) {
  return `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * 生成「身份文件」内容（键序固定，输出确定 → 可与磁盘内容逐字比对实现幂等）。
 * NoDisplay=true：不进启动器网格，只服务 app_id 解析（窗口图标/任务栏分组/门户）。
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
    "NoDisplay=true",
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
 * 安装/升级桌面集成。policy：desktop 文件「Icon 已正确 → 让位，否则收编」，图标「对齐为准」。
 * 返回 { desktopFile, desktopAction: "kept"|"written"|"absent", iconsWritten }，全程不抛（失败靠日志观察）。
 */
export async function installLinuxDesktopIntegration({
  desktopId = DESKTOP_ID,
  name,
  comment = "",
  exec,
  categories,
  iconSourceDir,
  dataHome = xdgDataHome(),
  refreshCache = true, // 测试注入 false：不对外部 gtk-update-icon-cache 产生时序依赖
  log = () => {},
}) {
  const result = { desktopFile: null, desktopAction: "absent", iconsWritten: [] };
  try {
    result.iconsWritten = await syncHicolorIcons({ iconSourceDir, dataHome, desktopId });
    if (result.iconsWritten.length && refreshCache) refreshIconCache(join(dataHome, "icons", "hicolor"));
  } catch (e) {
    log("[quaver] linux-desktop: hicolor 图标同步失败:", String(e));
  }
  try {
    const content = desktopEntryContent({ desktopId, name, comment, exec, categories });
    const appsDir = join(dataHome, "applications");
    const file = join(appsDir, `${desktopId}.desktop`);
    result.desktopFile = file;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    const existingIcon = existing == null ? null : readDesktopIcon(existing);
    // 三种情况：我们的托管文件（带 X-Quaver-Managed）→ 整份强制对齐（Exec 漂移也修回来）；
    // 别人写的、Icon 已指向我们 → 让位（集成工具的可见条目以它为准，避免启动器重复项）；
    // 别人写的、Icon 不对 → 收编改写。内容一字未变时一律 kept。
    const managed = existing != null && readDesktopEntryValue(existing, "X-Quaver-Managed") === "true";
    if (existing === content) {
      result.desktopAction = "kept";
    } else if (existing != null && !managed && existingIcon === desktopId) {
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
