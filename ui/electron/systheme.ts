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
// 来源与优先级（Linux）：
//   1. KDE 会话        ~/.config/kdeglobals 的 [Colors:Window] BackgroundNormal → **按亮度判**，不猜方案名
//                      （「BreezeLight」「noctalia」这类名字无法可靠分类，RGB 一定可以）
//   2. gsettings       org.gnome.desktop.interface color-scheme = prefer-dark / prefer-light
//                      （现代桌面的标准口子；'default' = 没表态，不算数，继续往下问）
//   3. GTK 配色产物     ~/.config/gtk-{3,4}.0/*.css 里**最后被写**的那份定义的 window/view 底色。
//                      这一层是为 Hyprland 这类**没有系统级深浅色 API** 的桌面加的：外壳配色由
//                      bar/主题生成器（noctalia / matugen / pywal…）自己算，它们每次换主题都会
//                      重写自己的 css —— 实测（Hyprland + Noctalia）切一次深浅，gsettings 在
//                      prefer-light / prefer-dark / default 之间跳，settings.ini 两边的值自相矛盾，
//                      而 noctalia.css 的 window_bg_color 一直是当前外壳的真底色。
//   4. GTK settings.ini prefer-dark / 主题名（**已知会被钉死**：桌面换了配色它未必跟着改 → 只能垫底）
//   都拿不到            null —— 交回 Electron 自己的判断，不硬掰
//
// 另有一条**独立**的 mac 侧需求：托盘图要的是「外壳（菜单栏）的深浅」，那个只认系统设置、不能跟
// 应用自己的 themeSource 走（应用默认主题是 dark，跟它就永远挑成深色外壳）→ 见文件后半段的
// parseAppleInterfaceStyle / readMacShellTheme / watchMacShellTheme。
// Windows 侧同款需求走注册表（SystemUsesLightTheme = 任务栏/通知区域），见后半段的 Windows 一节 ——
// Electron 的 shouldUseDarkColorsForSystemIntegratedUI 名义上就是干这个的，但它在首次 native theme
// 通知前会退回应用主题，正是要防的坑。
import { readdirSync, readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** 监视间隔：配色切换是低频操作，1.5s 的 stat 轮询开销可忽略（读文件只在 stat 报变时才发生） */
const WATCH_INTERVAL_MS = 1500;
/** 兜底轮询间隔。为什么不能只靠文件监视：gsettings 的值落在 dconf 库里，写入未必改文件 mtime
 *  （mmap 就地写），而且有些桌面只发 D-Bus 通知 —— 单调一次值（一次字符串比较）最不亏。 */
const BACKSTOP_POLL_MS = 10000;

const configHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const kdeGlobalsPath = () => join(configHome(), "kdeglobals");
const gtkIniPaths = () => [3, 4].map((v) => join(configHome(), `gtk-${v}.0`, "settings.ini"));
const gtkCssDirs = () => [3, 4].map((v) => join(configHome(), `gtk-${v}.0`));
/** dconf 用户库：gsettings 的落盘处（GIO 的 dconf 后端写这里） */
const dconfDbPath = () => join(configHome(), "dconf", "user");
/** GTK 命名色里能代表「窗口/视图底色」的几个（GTK4 的 libadwaita 命名 + GTK3 常见的 window_bg_color） */
const GTK_BG_KEYS = ["window_bg_color", "theme_bg_color", "view_bg_color"];

/** 探测函数的注入口（全部可选）：单测传假路径 / 假子进程用，生产调用一律缺省。 */
export interface ProbeOpts {
  desktop?: string;
  kdeGlobals?: string;
  gtkInis?: string[];
  gtkCssDirs?: string[];
  dconfDb?: string;
  run?: typeof spawnSync;
  timeoutMs?: number;
  pollMs?: number;
  /** mac / win 侧 */
  platform?: NodeJS.Platform;
  globalPrefs?: string;
  personalizeKey?: string;
}

/** 读文本；读不到（不存在/无权限）返回空串，探测逻辑一律按「没这个来源」处理 */
function readText(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

/** 取 INI 段里某个键的值。KDE 与 GTK 的 ini 都是平铺 `键=值`，段名与键名大小写不敏感；
 *  行首 # / ; 是注释，值尾的行内 # 注释一并剥掉。找不到返回空串。 */
export function iniValue(text: string, section: string, key: string): string {
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
export function isLightRGB(triple: string): boolean | null {
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec((triple || "").trim());
  if (!m) return null;
  const [r, g, b] = m.slice(1).map(Number);
  if (r > 255 || g > 255 || b > 255) return null;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127;
}

/** KDE 配色 → 深浅。窗口底色是配色的主背景，View 段兜底（少数方案只覆盖其一）。 */
export function kdeTheme(text: string): "dark" | "light" | null {
  const v = iniValue(text, "Colors:Window", "BackgroundNormal") || iniValue(text, "Colors:View", "BackgroundNormal");
  const light = v ? isLightRGB(v) : null;
  return light === null ? null : light ? "light" : "dark";
}

/** GTK 设置 → 深浅。prefer-dark 只认「显式开」；关掉不等于浅色（主题名可能是 Adwaita-dark），
 *  所以关掉时继续看主题名 —— 两个键都读，与 GTK 自己的判定顺序一致。 */
export function gtkTheme(text: string): "dark" | "light" | null {
  if (/^(true|1|yes)$/i.test(iniValue(text, "Settings", "gtk-application-prefer-dark-theme"))) return "dark";
  const name = iniValue(text, "Settings", "gtk-theme-name");
  if (!name) return null;
  return /dark/i.test(name) ? "dark" : "light";
}

/** 探测当前系统深浅色（"dark" | "light"），拿不到返回 null。
 *  kdeglobals 只在 KDE 会话下认账 —— 别的桌面残留一份旧 KDE 配置会把结果带偏。
 *  opts 全为测试注入用（默认走真实路径与 XDG_CURRENT_DESKTOP）。 */
/** hex "#rrggbb" → 是否浅色底（与 isLightRGB 同一把尺：Rec.709 亮度取中灰为界）。格式不合法返回 null。 */
export function isLightHex(hex: string): boolean | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127;
}

/** gsettings 的 color-scheme 原始输出 → 深浅。
 *  只有 'prefer-dark' / 'prefer-light' 算表态；'default'（= 没偏好）返回 null 让它继续往下问。 */
export function parseColorScheme(raw: unknown): "dark" | "light" | null {
  const v = String(raw ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (v === "prefer-dark") return "dark";
  if (v === "prefer-light") return "light";
  return null;
}

/** 问 gsettings 要 color-scheme（跨桌面的标准口子）。拿不到（没有 gsettings / 连不上会话总线）返回 null。
 *  必须带 timeout：这是 spawnSync，会话总线半死时它会一直挂着 —— 主进程（以及那个 10s 兜底轮询）
 *  会被它卡住，表现为整个应用假死。超时按「判不出来」处理。 */
export function gsettingsColorScheme(opts: ProbeOpts = {}): "dark" | "light" | null {
  const run = opts.run ?? spawnSync;
  const r = run("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"],
    { encoding: "utf8", timeout: opts.timeoutMs ?? 2000 });
  if (r.error) return null;
  return parseColorScheme(r.stdout);
}

/** GTK 配色 css 里定义的窗口底色 → 深浅。
 *  取 `@define-color <window_bg_color|theme_bg_color|view_bg_color> #rrggbb` —— 主题生成器
 *  （noctalia / matugen / pywal / Gradience…）写的就是这几个命名色。认不出返回 null。 */
export function gtkCssTheme(text: string): "dark" | "light" | null {
  const src = String(text ?? "");
  for (const key of GTK_BG_KEYS) {
    const m = new RegExp(`@define-color\\s+${key}\\s+(#[0-9a-fA-F]{6})`).exec(src);
    if (!m) continue;
    const light = isLightHex(m[1]);
    if (light !== null) return light ? "light" : "dark";
  }
  return null;
}

/** 从 GTK 配置目录里挑**最后被写**的那份 css（同目录常有好几份：colors.css / <bar>.css / gtk.css）。
 *  返回路径；一份都没有返回 null。 */
export function gtkCssNewest(dirs: string[]): string | null {
  let best = null; // { mtime, path }
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".css")) continue;
      const p = join(dir, name);
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (!best || mtime > best.mtime) best = { mtime, path: p };
    }
  }
  return best ? best.path : null;
}

/** 那份最新 css 判出来的深浅（认不出返回 null）。 */
export function gtkCssThemeFromDirs(dirs: string[]): "dark" | "light" | null {
  const p = gtkCssNewest(dirs);
  return p ? gtkCssTheme(readText(p)) : null;
}

/** 探测当前系统深浅色（"dark" | "light"），拿不到返回 null。优先级见文件头。
 *  opts 全为测试注入用（默认走真实路径、真实 gsettings 与 XDG_CURRENT_DESKTOP）。 */
export function readSystemTheme(opts: ProbeOpts = {}): "dark" | "light" | null {
  const desktop = opts.desktop ?? process.env.XDG_CURRENT_DESKTOP ?? "";
  // 1) KDE 会话：kdeglobals 的窗口底色（只在 KDE 会话下认账 —— 别的桌面残留一份旧 KDE 配置会把结果带偏）
  if (/(^|[^a-z])(kde|plasma)([^a-z]|$)/i.test(desktop)) {
    const kde = kdeTheme(readText(opts.kdeGlobals ?? kdeGlobalsPath()));
    if (kde) return kde;
  }
  // 2) gsettings color-scheme（GNOME / 多数现代桌面 / 不少 rice 都会写它）
  const gsettings = gsettingsColorScheme(opts);
  if (gsettings) return gsettings;
  // 3) 主题生成器写的 GTK 配色 css（Hyprland 这类没系统级 API 的桌面上，这份产物才是外壳真底色）
  const css = gtkCssThemeFromDirs(opts.gtkCssDirs ?? gtkCssDirs());
  if (css) return css;
  // 4) GTK settings.ini：与 Chromium 自己的判断同源，但会被钉死，只能垫底
  for (const f of opts.gtkInis ?? gtkIniPaths()) {
    const gtk = gtkTheme(readText(f));
    if (gtk) return gtk;
  }
  return null;
}

/** 盯住全部来源，值真的变了才回调（返回停止函数）。
 *  文件侧用 watchFile（stat 轮询）而不是 watch：KDE 走 KConfig 重写、dconf 就地写，inode 会换，fs.watch 跟丢。
 *  再叠一个兜底轮询：gsettings 的值只落在 dconf 库里、未必动了文件 mtime，纯文件监视会漏（一次字符串比较而已）。 */
export function watchSystemTheme(onChange: (theme: "dark" | "light" | null) => void, opts: ProbeOpts = {}): () => void {
  const files = [
    opts.kdeGlobals ?? kdeGlobalsPath(),
    ...(opts.gtkInis ?? gtkIniPaths()),
    ...gtkCssFiles(opts),
    opts.dconfDb ?? dconfDbPath(),
  ];
  let last = readSystemTheme(opts);
  const tick = () => {
    const now = readSystemTheme(opts);
    if (now === last) return;
    last = now;
    onChange(now);
  };
  for (const f of files) watchFile(f, { interval: WATCH_INTERVAL_MS }, tick);
  const timer = setInterval(tick, opts.pollMs ?? BACKSTOP_POLL_MS);
  timer.unref?.(); // 兜底轮询不许拽住事件循环（不挡应用退出）
  return () => {
    for (const f of files) unwatchFile(f, tick);
    clearInterval(timer);
  };
}

/** 现有 GTK 配置目录里的全部 css（监视用；新出现的 css 由兜底轮询兜住） */
function gtkCssFiles(opts: ProbeOpts): string[] {
  const out = [];
  for (const dir of opts.gtkCssDirs ?? gtkCssDirs()) {
    try {
      for (const name of readdirSync(dir)) if (name.endsWith(".css")) out.push(join(dir, name));
    } catch { /* 目录不存在 → 这个来源没有 */ }
  }
  return out;
}

// ——— macOS：菜单栏（外壳）的深浅 ———
// 为什么不能拿 nativeTheme 充数：nativeTheme 的深浅跟着我们写进 themeSource 的**应用主题**走
// （shouldUseDarkColorsForSystemIntegratedUI 在 mac 上就等于 shouldUseDarkColors），而本应用默认主题
// 就是 dark → 托盘图永远被判成「深色外壳」，系统切到浅色时菜单栏变浅、图标还是浅色那份，直接看不见。
// 菜单栏底色只认**系统设置**，系统设置的口子就是 AppleInterfaceStyle（键不存在 = 浅色，mac 默认档）。
// 注意这不是「应用跟随系统」那条链：那条链在 Linux 上要自己探测（readSystemTheme），在 mac 上
// 交给 Electron 的 themeSource="system" 就够，两者互不干涉。
const globalPrefsPath = () => join(homedir(), "Library", "Preferences", ".GlobalPreferences.plist");

/** `defaults read -g AppleInterfaceStyle` 的输出 → "dark" | "light"（纯函数，可单测）。
 *  键存在时值是 "Dark"；键不存在（浅色）时输出为空 —— 空即浅色。 */
export function parseAppleInterfaceStyle(stdout: unknown): "dark" | "light" {
  return /dark/i.test(String(stdout ?? "")) ? "dark" : "light";
}

/** 读 macOS 菜单栏深浅。非 macOS、或系统里没有 defaults（spawn 自己失败）返回 null，交调用方兜底。
 *  opts 全为测试注入用。 */
export function readMacShellTheme(opts: ProbeOpts = {}): "dark" | "light" | null {
  if ((opts.platform ?? process.platform) !== "darwin") return null;
  const run = opts.run ?? spawnSync;
  // 与 gsettings 同理必须带 timeout：spawnSync 挂住 = 主进程假死
  const r = run("defaults", ["read", "-g", "AppleInterfaceStyle"], { encoding: "utf8", timeout: opts.timeoutMs ?? 2000 });
  if (r.error) return null;                   // 拉不起 defaults → 判不出来，别硬说成浅色
  return parseAppleInterfaceStyle(r.stdout);  // 退出码 1 = 键不存在 = 浅色，是有效答案
}

/** 盯 .GlobalPreferences.plist 的 mtime，值真的变了才回调（返回停止函数）。
 *  与 watchSystemTheme 同款：用 watchFile 而不是 watch（cfprefsd 会重写文件、换 inode）。
 *  非 macOS 上 readMacShellTheme 恒为 null → 这个 watcher 静默不做事。 */
export function watchMacShellTheme(onChange: (theme: "dark" | "light") => void, opts: ProbeOpts = {}): () => void {
  const file = opts.globalPrefs ?? globalPrefsPath();
  let last = readMacShellTheme(opts);
  const tick = () => {
    const now = readMacShellTheme(opts);
    if (now === null || now === last) return;
    last = now;
    onChange(now);
  };
  watchFile(file, { interval: WATCH_INTERVAL_MS }, tick);
  return () => unwatchFile(file, tick);
}

// ——— Windows：任务栏 / 通知区域（外壳）的深浅 ———
// 为什么不直接吃 nativeTheme.shouldUseDarkColorsForSystemIntegratedUI —— Electron 那边的实现是
//     should_use_dark_colors_for_system_integrated_ui_.value_or(ShouldUseDarkColors())
// 而那个 optional **只在 OnNativeThemeUpdatedOnUI() 里被赋值**（Windows 分支才去读同一把注册表钥匙），
// 于是有两个口子：
//   ① 启动后到第一次 native theme 通知之前，它取的是兜底值 ShouldUseDarkColors() = **应用自己的主题**
//      （本应用默认 dark）→ 托盘图按「应用主题」挑，也就是跟着用户选的深浅色档位走 —— 正是托盘挂在
//      **外壳**上要防的那件事（实测症状：浅色模式配浅色图标、深色模式配深色图标）；
//   ② 构造函数那次 HKCU\...\Themes\Personalize 的 Open 失败（新 profile 里该键可能还没被创建），
//      optional 永远是 nullopt → 此后**永远**吃应用主题。
// 所以与 Linux/macOS 同一口径：自己读系统自己的真相 —— 注册表里那两把钥匙的区别要认清：
//   SystemUsesLightTheme → 任务栏 / 通知区域（**托盘就挂它上面，这才是判据**）
//   AppsUseLightTheme    → 应用窗口底色（不是外壳，拿它判托盘就是上面那个坑的另一种写法）
const WIN_PERSONALIZE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
/** 轮询间隔。注册表没有 mtime 可盯（watchSystemTheme 那套文件监视在这儿没有对应物），
 *  只能定时问一次 reg.exe —— 一次只读查询几毫秒，2s 一次的开销可以忽略。
 *  与 nativeTheme 的 updated 事件并存：那条路免费且立即，这条路是「Chromium 没发事件时」的兜底。 */
const WIN_WATCH_INTERVAL_MS = 2000;

/** `reg query ...\Themes\Personalize` 的输出 → "light" | "dark"（外壳），认不出返回 null。
 *  只看 SystemUsesLightTheme（任务栏/通知区域 = 托盘所在的那层）；0x0 = 深色外壳，0x1 = 浅色外壳。 */
export function parseWindowsPersonalize(output: unknown): "dark" | "light" | null {
  const m = /systemuseslighttheme\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(String(output ?? ""));
  if (!m) return null;
  return parseInt(m[1], 16) === 0 ? "dark" : "light";
}

/** 读 Windows 任务栏/通知区域的深浅（"light" | "dark"）。非 Windows 返回 null。
 *  reg.exe 拉不起来（opts.error）返回 null，交调用方兜底；键或值**不存在**不算错误：Windows 系统
 *  模式的出厂档就是浅色（Electron 自己那次读取也以 1 为初值），所以按浅色外壳处理 —— 宁可挑深色
 *  图标（两种底色上都看得见），也不要退回应用主题（那正是要修的坑）。
 *  opts 全为测试注入用。注意编码：reg.exe 在中文 Windows 上是 GBK 输出，但我们要匹配的键名与
 *  DWORD 都是 ASCII，按 utf8 解不会影响判断。 */
export function readWindowsShellTheme(opts: ProbeOpts = {}): "dark" | "light" | null {
  if ((opts.platform ?? process.platform) !== "win32") return null;
  const run = opts.run ?? spawnSync;
  // 与 gsettings 同理必须带 timeout：spawnSync 挂住 = 主进程假死（这个还是 2s 一次的轮询）
  const r = run("reg.exe", ["query", opts.personalizeKey ?? WIN_PERSONALIZE_KEY],
    { encoding: "utf8", timeout: opts.timeoutMs ?? 2000 });
  if (r.error) return null;
  return parseWindowsPersonalize(r.stdout) ?? "light";
}

/** 轮询注册表，值真的变了才回调（返回停止函数）。非 Windows 上直接返回空停止函数 —— 不建定时器，
 *  也不要让调用方去记「这个平台上它什么都不做」（watchSystemTheme 在非 Linux 上是同名空转的设计，
 *  这里反过来：Windows 是唯一有意义的平台）。 */
export function watchWindowsShellTheme(onChange: (theme: "dark" | "light") => void, opts: ProbeOpts = {}): () => void {
  if ((opts.platform ?? process.platform) !== "win32") return () => {};
  let last = readWindowsShellTheme(opts);
  const tick = () => {
    const now = readWindowsShellTheme(opts);
    if (now === null || now === last) return;
    last = now;
    onChange(now);
  };
  const timer = setInterval(tick, opts.pollMs ?? WIN_WATCH_INTERVAL_MS);
  timer.unref?.(); // 兜底轮询不许拽住事件循环（不挡应用退出）
  return () => clearInterval(timer);
}

// —— CLI：把这次判断的各层原始值摊开（排障用，只读，不动任何设置）——
//   cd ui && node electron/systheme.ts
// 托盘图标选错素材时先跑它：一眼看出是哪一层给了错值，还是所有层都没表态。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const show = (label: string, v: unknown) => console.log(`${label.padEnd(22)}${v ?? "(无)"}`);
  const cssNewest = gtkCssNewest(gtkCssDirs());
  console.log(`XDG_CURRENT_DESKTOP    ${process.env.XDG_CURRENT_DESKTOP || "(空)"}`);
  show("kdeglobals →", kdeTheme(readText(kdeGlobalsPath())));
  show("gsettings →", gsettingsColorScheme());
  show("GTK 配色 css →", cssNewest ? `${gtkCssTheme(readText(cssNewest)) ?? "认不出底色"}  [${cssNewest}]` : null);
  show("GTK settings.ini →", gtkIniPaths().map((p) => gtkTheme(readText(p))).find(Boolean) ?? null);
  const mac = process.platform === "darwin" ? readMacShellTheme() : null;
  if (process.platform === "darwin") show("macOS 菜单栏 →", mac);
  const win = process.platform === "win32" ? readWindowsShellTheme() : null;
  if (process.platform === "win32") show("Windows 系统模式 →", win);
  const verdict = readSystemTheme();
  console.log(`→ 结论                 ${verdict ?? "null（交回 Electron 自己的判断）"}`);
  // 托盘图的实际判据（与 main.ts:trayAppearance 同一口径），这里一眼看出会挑哪份素材
  const shell = verdict ?? mac ?? win;
  console.log(`  托盘图标             ${
    shell === "light" ? "深色图标（配浅色外壳）"
      : shell ? "浅色图标（配深色外壳）" : "浅色图标（判不出来 → 按深色外壳兜底）"}`);
}
