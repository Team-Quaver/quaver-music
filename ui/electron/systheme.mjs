// Quaver — 系统深浅色探测（主进程侧，纯 Node / 可单测）
//
// 为什么要自己探测：Chromium 在 Linux 上判断 `prefers-color-scheme` 只认 GTK 设置
// （`gtk-theme-name` 里含 dark，或 `gtk-application-prefer-dark-theme=true`）。而 KDE 下那份
// GTK 设置是 kde-gtk-config 写的**静态快照**，不跟 KDE 配色方案联动 —— 于是 KDE 用户切深浅色时
// 媒体查询纹丝不动，「跟随系统」形同虚设。
// 实测（KDE Plasma + Wayland）：kdeglobals 的配色在 noctalia ⇄ BreezeLight 之间来回切，
// `~/.config/gtk-{3,4}.0/settings.ini` 始终是 `gtk-theme-name=adw-gtk3`（浅）；
// gsettings 里那个 `prefer-dark` 是 GNOME 的键，KDE 下没有任何人读它。
//
// 做法：按各桌面自己的真相来源探测 → 主进程把结果显式写进 `nativeTheme.themeSource`。
// Electron 会把它同步给渲染进程的 `prefers-color-scheme`，渲染层原有的 mq 监听照旧生效，
// 完全不必知道这套探测的存在。
//
// 来源与优先级：
//   KDE 会话   ~/.config/kdeglobals 的 [Colors:Window] BackgroundNormal → **按亮度判**，不猜方案名
//              （「BreezeLight」「noctalia」这类名字无法可靠分类，RGB 一定可以）
//   其他桌面   ~/.config/gtk-{3,4}.0/settings.ini（与 Chromium 自己的判断同源，只作兜底）
//   都拿不到   null —— 交回 Electron 自己的判断，不硬掰
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 监视间隔：配色切换是低频操作，1.5s 的 stat 轮询开销可忽略（读文件只在 stat 报变时才发生） */
const WATCH_INTERVAL_MS = 1500;

const configHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const kdeGlobalsPath = () => join(configHome(), "kdeglobals");
const gtkIniPaths = () => [3, 4].map((v) => join(configHome(), `gtk-${v}.0`, "settings.ini"));

/** 读文本；读不到（不存在/无权限）返回空串，探测逻辑一律按「没这个来源」处理 */
function readText(p) {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

/** 取 INI 段里某个键的值。KDE 与 GTK 的 ini 都是平铺 `键=值`，段名与键名大小写不敏感；
 *  行首 # / ; 是注释，值尾的行内 # 注释一并剥掉。找不到返回空串。 */
export function iniValue(text, section, key) {
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    if (line[0] === "[") {
      inSection = line.replace(/^\[|\]$/g, "").trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      return line.slice(eq + 1).split("#")[0].trim();
    }
  }
  return "";
}

/** "239,240,241" → 是否浅色底（Rec.709 亮度取中灰为界）。格式不合法返回 null。 */
export function isLightRGB(triple) {
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec((triple || "").trim());
  if (!m) return null;
  const [r, g, b] = m.slice(1).map(Number);
  if (r > 255 || g > 255 || b > 255) return null;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127;
}

/** KDE 配色 → 深浅。窗口底色是配色的主背景，View 段兜底（少数方案只覆盖其一）。 */
export function kdeTheme(text) {
  const v = iniValue(text, "Colors:Window", "BackgroundNormal") || iniValue(text, "Colors:View", "BackgroundNormal");
  const light = v ? isLightRGB(v) : null;
  return light === null ? null : light ? "light" : "dark";
}

/** GTK 设置 → 深浅。prefer-dark 只认「显式开」；关掉不等于浅色（主题名可能是 Adwaita-dark），
 *  所以关掉时继续看主题名 —— 两个键都读，与 GTK 自己的判定顺序一致。 */
export function gtkTheme(text) {
  if (/^(true|1|yes)$/i.test(iniValue(text, "Settings", "gtk-application-prefer-dark-theme"))) return "dark";
  const name = iniValue(text, "Settings", "gtk-theme-name");
  if (!name) return null;
  return /dark/i.test(name) ? "dark" : "light";
}

/** 探测当前系统深浅色（"dark" | "light"），拿不到返回 null。
 *  kdeglobals 只在 KDE 会话下认账 —— 别的桌面残留一份旧 KDE 配置会把结果带偏。
 *  opts 全为测试注入用（默认走真实路径与 XDG_CURRENT_DESKTOP）。 */
export function readSystemTheme(opts = {}) {
  const desktop = opts.desktop ?? process.env.XDG_CURRENT_DESKTOP ?? "";
  if (/(^|[^a-z])(kde|plasma)([^a-z]|$)/i.test(desktop)) {
    const kde = kdeTheme(readText(opts.kdeGlobals ?? kdeGlobalsPath()));
    if (kde) return kde;
  }
  for (const f of opts.gtkInis ?? gtkIniPaths()) {
    const gtk = gtkTheme(readText(f));
    if (gtk) return gtk;
  }
  return null;
}

/** 盯住全部来源文件，值真的变了才回调（返回停止函数）。
 *  用 watchFile（stat 轮询）而不是 watch：KDE 走 KConfig 重写，inode 会换，fs.watch 会跟丢。 */
export function watchSystemTheme(onChange, opts = {}) {
  const files = [opts.kdeGlobals ?? kdeGlobalsPath(), ...(opts.gtkInis ?? gtkIniPaths())];
  let last = readSystemTheme(opts);
  const tick = () => {
    const now = readSystemTheme(opts);
    if (now === last) return;
    last = now;
    onChange(now);
  };
  for (const f of files) watchFile(f, { interval: WATCH_INTERVAL_MS }, tick);
  return () => { for (const f of files) unwatchFile(f, tick); };
}
