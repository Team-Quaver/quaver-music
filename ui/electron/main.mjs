// Quaver — Electron 主进程（ESM）
// 起一个进程内 vite preview（dist/ + /api 中继插件），窗口加载 http://127.0.0.1:<port>
// frame:false：无原生标题栏——窗口右上角平铺三个窗口按钮（min/max/close）+抓握点，经 preload IPC 接管。
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Tray, nativeImage, nativeTheme, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 音频引擎（mpv 后端）：窗口 URL 确定后 init（需要 baseUrl 绝对化 /api/stream 中继地址）
import { audioEngine } from "./audio/engine.mjs";
// 配置文件（quaver.conf）与跨平台目录规则：路径单一真相，渲染层与 sidecar 都对齐这一份
import { configDir, configFile, ensureConfigDir, logFile, readValues, resetConfig, writeValues } from "./config.mjs";
// 系统深浅色探测（Linux 桌面各自的真相来源，见模块头）：「跟随系统」要靠它才真的跟得上；
// macOS 侧的菜单栏深浅（托盘图用）也在这里——两者是不同的问题，别混
import { readMacShellTheme, readSystemTheme, watchMacShellTheme, watchSystemTheme } from "./systheme.mjs";
// 托盘图标：尺寸口径 + 明暗两份素材的映射（纯逻辑，见模块头）
import { TRAY_ICON_PT, trayIconFile } from "./tray-icon.mjs";
// 托盘菜单的曲目标题行：成型 + 按显示列宽截断（纯逻辑，见模块头 —— 原生菜单不折行，长歌名会撑宽菜单）
import { trayTitleLine } from "./tray-title.mjs";
// Linux 桌面集成自装（<app_id>.desktop 身份文件 + hicolor 图标）：各桌面/门户按 app_id 反查
// 桌面文件取图标，AppImage 裸跑与开发态都没人代劳，必须自己装（模块头有完整链路说明）
import { DESKTOP_ID, installLinuxDesktopIntegration, quoteExecPath } from "./linux-desktop.mjs";
// 全局热键（win/mac = Electron globalShortcut；Linux = XDG 门户 GlobalShortcuts，见模块头）
import { createGlobalHotkeys, GLOBAL_CONF_KEYS } from "./global-hotkeys.mjs";
// 应用自更新（GitHub Releases 代理 / 流式下载 / AppImage 原位替换 / Gear Lever·AppManager 联动）
import { setupUpdaterIPC } from "./update.mjs";
// 凭证的密钥环存取（系统密钥管理器 + credential.enc 密文）与 sidecar 交接信封
import {
  CredentialStore, credentialSummary, decodeHandoff, drainLines, encodeHandoff,
  evaluateKeyring, pickPasswordStore,
} from "./keyring.mjs";
// 注意：vite 不能在顶层 import——实测其在 Electron 主进程有副作用，会让 app.whenReady() 永不兑现。
// 只在 createWindow 里动态 import()。

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(__dirname, "..");
const DIST = join(UI_ROOT, "dist");
// package.json 元数据（description 等给桌面集成用）：Electron 的 app 对象没有 getDescription（实测 44），
// 直接读一份 —— 打包态命中 asar 内的 package.json，开发态命中 ui/package.json，同一份元数据。
import { createRequire } from "node:module";
const PKG_META = createRequire(import.meta.url)("../package.json");

// ——— 配置根目录 ———
// Linux ~/.config/quaver-music ｜ Windows %AppData%/Quaver Music ｜ macOS Application Support。
// 必须在任何 app.getPath("userData") 之前落定：AppImage 每次挂载点都不同，不把 userData 钉死，
// Chromium 的 localStorage/IndexedDB/Cache 目录就会跟着漂（设置「保不住」的另一半原因）。
const CONFIG_DIR = configDir();
let configDirOk = true;
try {
  ensureConfigDir();
  app.setPath("userData", CONFIG_DIR);
} catch (e) {
  configDirOk = false;
  console.error("[quaver] 配置目录不可用，回退 Electron 默认 userData:", String(e));
}

// 打包态 asar 不可写，日志落配置目录；配置目录不可用则退回 Electron 默认 userData。
// 开发态维持 ui/electron-dev.log（relay.ts 也读这个）。
const LOG = app.isPackaged
  ? (configDirOk ? logFile() : join(app.getPath("userData"), "electron-dev.log"))
  : join(UI_ROOT, "electron-dev.log");
import { appendFileSync } from "node:fs";
const log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" "); try { appendFileSync(LOG, s + "\n"); } catch {} console.log(s); };

// Sparkle 插件目录（第三方插件安装根）：QUAVER_SPARKLE_DIR 优先（开发调试），
// 否则配置目录下 plugins/。native-server（文件服务）与 quaver:sparkle IPC 共用这一份。
const SPARKLE_PLUGINS_ROOT = String(process.env.QUAVER_SPARKLE_DIR ?? "").trim() || join(CONFIG_DIR, "plugins");
const SPARKLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// 落盘一个第三方插件（market 下载与本地手装共用同一布局）：plugins/<id>/main.js + plugin.json
const sparkleInstall = async (id, buf, meta) => {
  const dir = join(SPARKLE_PLUGINS_ROOT, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "main.js"), buf, { mode: 0o600 });
  // category（theme/plugin/extension）随索引元数据持久化：设置页据此把已装内容归入 主题/插件/扩展
  const category = ["theme", "plugin", "extension"].includes(meta?.category) ? String(meta.category) : undefined;
  const manifest = {
    id,
    name: String(meta?.name ?? id),
    version: String(meta?.version ?? "0.0.0"),
    author: meta?.author ? String(meta.author) : undefined,
    description: meta?.description ? String(meta.description) : undefined,
    category,
    main: "main.js",
  };
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
};

// 启动即按磁盘配置定初值：窗口装饰只在构造时能给定 frame，晚一步就得拆窗重建（用户会看到闪一下）。
let bootConf = {};
try {
  const r = readValues();
  bootConf = r.values;
  for (const w of r.warnings) log("[quaver] config:", w);
} catch (e) {
  log("[quaver] 配置读取失败，全部走默认值:", String(e));
}
const bootTheme = bootConf["Style.Style"] ?? "dark";
// 窗口底色：按 quaver.conf 的主题预判，避免加载首帧白闪（dark、或跟随系统且系统为深色 → 深底）。
// 跟随系统的判据走我们自己的探测：nativeTheme 在 whenReady 之前不可靠，且 Linux 上它只认 GTK
// 那份静态快照（见 systheme.mjs），拿它当兜底而不是主判据。
const bootDark = bootTheme === "dark"
  || (bootTheme !== "light" && (readSystemTheme() === "dark" || nativeTheme.shouldUseDarkColors));

// 当前主题偏好："dark" / "light" / 其余（follow-system 及将来的自定义主题）= 跟随系统。
// 渲染层每次改主题都会经 quaver:config set 落盘，主进程在这里同步这一份。
let themePref = bootTheme;

// ——— 应用身份 ———
// 名字必须是「Quaver Music」：一是 XDG 门户/桌面环境按 app ID（red.0w0.quaver）归档应用，
// 二是不少软件会把「Quaver」错认成同名音游。各平台身份的真相与来源：
//   • Windows：setAppUserModelId（通知/任务栏分组/SMTC）。
//   • Linux：package.json 顶层 desktopName（= "red.0w0.quaver.desktop"）——Electron init 在本模块
//     之前就读它并设进 CHROME_DESKTOP，X11 WM_CLASS 与 Wayland app_id 都取它去掉 .desktop 后缀的值；
//     xdg-desktop-portal（GlobalShortcuts）与各桌面反查的也是这个 ID（门户 1.21+ 对解析不到桌面
//     文件的 app ID 直接拒会话）。这里**不要再 setDesktopName**：两个真相迟早写岔，桌面上就是
//     「图标对不上」这类怪象。桌面文件与 hicolor 图标由 linux-desktop 自装（见 whenReady）。
app.setAppUserModelId("red.0w0.quaver");

// ——— 凭证存储：密钥管理器后端必须在 app ready 之前钉死 ———
// Chromium 的 OSCrypt 只在初始化时读一次 --password-store，ready 之后再 appendSwitch 是空操作。
// 不钉的代价在自建会话（Hyprland / sway…）上很实在：桌面认不出来 → 静默退到 basic_text，
// 那是「硬编码口令」的对称加密，而 isEncryptionAvailable() 照样返回 true —— 看着加密了，其实等于明文。
// 所以这里按 quaver.conf + 桌面/进程探测显式钉一个真后端；ready 之后再用
// safeStorage.getSelectedStorageBackend() 校验（见 keyring.mjs:evaluateKeyring），假加密一律不启用。
const securityConf = {
  store: bootConf["Security.CredentialStore"] ?? "auto",
  backend: bootConf["Security.KeyringBackend"] ?? "auto",
};
const keyringPick = pickPasswordStore({ platform: process.platform, env: process.env, backend: securityConf.backend });
if (keyringPick.switchValue) app.commandLine.appendSwitch("password-store", keyringPick.switchValue);

// —— 把「系统深浅色」翻译成 Chromium 听得懂的话 ——
// nativeTheme.themeSource 只有 system / light / dark 三档，没有「用我自己探测到的系统色」这一档，
// 所以跟随系统时我们自己探测（systheme.mjs），再写死成 dark/light ——
// Electron 会把它同步给渲染进程的 prefers-color-scheme，渲染层原有的 mq 监听照旧生效。
// 留 'system' 是不行的：Electron 在 Linux 上走 GTK 判断，而 KDE 下那份 GTK 设置是静态快照，
// 与桌面配色脱钩 —— 那正是「跟随系统不生效」的根因。
function applyThemeSource() {
  if (themePref === "dark" || themePref === "light") { nativeTheme.themeSource = themePref; return; }
  nativeTheme.themeSource = readSystemTheme() ?? "system";
}

// 打包态页面固定端口：origin 稳定，Chromium 侧的 localStorage/IndexedDB/Cache 才能跨启动延续。
// 端口被占时 native-server 自动回落系统分配（设置本来就在 conf 里，不受影响）。
const STABLE_PORT = 4174;

// 兜底护栏：主进程任何未捕获异常/未处理 rejection 都会让 Electron 弹
// 「A JavaScript error occurred in the main process」并可能带走整个应用 —— 一次后台网络
// 中断不该炸掉正在放歌的窗口。这里只记账不退场；真出问题时看日志定位，而不是让用户点 Ok。
process.on("uncaughtException", (e) => log("[quaver] uncaught exception:", String((e && e.stack) || e)));
process.on("unhandledRejection", (r) => log("[quaver] unhandled rejection:", String((r && r.stack) || r)));

let win = null;
let cachedUrl = null; // preview 服务器只起一次；CSD/SSD 重建窗口时复用
let sidecar = null;   // 打包态自拉起的 Python sidecar 子进程
let credentialStore = null; // 凭证存档（ready 之后才能建：safeStorage 要 ready 才可用）
// 窗口装饰模式：csd=自绘（frame:false，右上角按钮簇）；ssd=系统标题栏。初值取 quaver.conf 的 [Window] Decor。
let decorMode = bootConf["Window.Decor"] === "ssd" ? "ssd" : "csd";
let rebuilding = false;
let tray = null; // Linux 走 D-Bus StatusNotifierItem（KDE/GNOME 托盘）

// 关闭按钮行为（quaver:close-action 同步；初值取 quaver.conf 的 [Window] CloseAction）：
// tray = 拦截 window close 改 hide（CSD 按钮簇✕、SSD 标题栏✕、Alt+F4 全部生效，托盘菜单可恢复）；
// quit = 走默认关闭流程（window-all-closed → app.quit）。
let closeAction = bootConf["Window.CloseAction"] === "quit" ? "quit" : "tray";
let quitting = false;
app.on("before-quit", () => (quitting = true));

// ——— 全局热键（系统级）———
// 绑定值每次现读 quaver.conf（readValues 带默认值兜底 + 值域校验）；动作转发给渲染层执行
// （播放器是唯一事实源，与 MPRIS 命令同一去向）。渲染层不在线（拆窗间隙）时消息自然丢弃。
const hotkeys = createGlobalHotkeys({
  log,
  readBindings: () => {
    const { values } = readValues();
    const out = {};
    for (const [action, confKey] of Object.entries(GLOBAL_CONF_KEYS)) out[action] = values[confKey] ?? "";
    return out;
  },
  sendToRenderer: (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send("quaver:hotkey", payload);
  },
  globalShortcut,
});

// 菜单栏治理：CSD（frameless）下 Electron 会把默认菜单画成窗口顶部菜单条，直接摘掉；
// SSD 还原默认菜单。不用 setMenuBarVisibility(false)——它不缩 Linux 的内容区（留一条空白）。
function applyMenu() {
  Menu.setApplicationMenu(decorMode === "ssd" ? defaultMenu : null);
}

function showWindow() {
  if (!win) { createWindow().catch((e) => log("[quaver] tray show failed:", String(e))); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Wayland 下 isVisible() 在 hide→Activate 往返后会短暂滞后（实测），据此判断会把 toggle 做反。
// 托盘可见性只以自维护标志为准；show/hide 事件仅同步外部路径（如 close 隐藏到托盘时）。
let winShown = true;

function toggleWindow() {
  if (!win) { winShown = true; showWindow(); return; }
  if (winShown) { winShown = false; win.hide(); }
  else { winShown = true; showWindow(); }
}

// MPRIS cmd 里 raise/quit 由主进程消费，其余转发给渲染层执行

function mprisDaemonPath() {
  // 打包态：electron-builder extraResources 把编译产物放到 <resources>/mpris/
  if (app.isPackaged) return join(process.resourcesPath, "mpris", "mpris-daemon.cjs");
  // 开发态：vendor/Typhoeus/mpris/dist/（pnpm run mpris:build 产物，缺失则跳过 MPRIS）
  return resolve(UI_ROOT, "..", "vendor", "Typhoeus", "mpris", "dist", "mpris-daemon.cjs");
}

let mprisBuf = "";      // daemon stdout 行缓冲
let mprisReady = false; // 收到 hello 前缓存最新 state，避免总线未就绪时丢首帧
let mprisPending = null;
let mprisRetries = 0;
let mprisDaemon = null; // 当前 daemon 子进程
let mprisSpawnedAt = 0; // 上次拉起时刻（崩溃重拉的存活判据）

function startMpris() {
  if (process.platform !== "linux") return; // Linux MPRIS；win/mac 由渲染层 navigator.mediaSession 直驱（src/mpris.ts）
  const script = mprisDaemonPath();
  if (!existsSync(script)) {
    log("[quaver] mpris daemon missing, skipped:", script);
    return;
  }
  log("[quaver] spawning mpris daemon:", script);
  // Electron 自带 node 跑 .cjs（ELECTRON_RUN_AS_NODE），打包态无需系统 node
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", QUAVER_MPRIS_NAME: "quaver", QUAVER_MPRIS_IDENTITY: "Quaver Music" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    mprisBuf += chunk;
    let i;
    while ((i = mprisBuf.indexOf("\n")) >= 0) {
      const line = mprisBuf.slice(0, i).trim();
      mprisBuf = mprisBuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log("[mpris] bad stdout line:", line.slice(0, 120)); continue; }
      if (msg.t === "hello") {
        mprisReady = true;
        log("[quaver] mpris daemon up:", msg.identity);
        if (mprisPending) mprisWrite(mprisPending);
      } else if (msg.t === "cmd") {
        if (msg.cmd === "raise") {
          if (!win) createWindow().catch(() => {});
          else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); winShown = true; }
        } else if (msg.cmd === "quit") {
          app.quit();
        } else if (win && !win.isDestroyed()) {
          win.webContents.send("quaver:mpris-cmd", msg);
        }
      }
    }
  });
  child.stderr.on("data", (d) => log(String(d).trimEnd()));
  child.on("exit", (code) => {
    log("[quaver] mpris daemon exited:", code);
    mprisReady = false;
    mprisDaemon = null;
    // 快速退出 = D-Bus 会话不可用（无总线/头环境），重试无意义；存活过的崩溃才重拉
    if (code !== 0 && mprisRetries < 3 && Date.now() - mprisSpawnedAt > 5000) {
      mprisRetries++;
      setTimeout(startMpris, 2000 * mprisRetries);
    }
  });
  mprisSpawnedAt = Date.now();
  mprisDaemon = child;
}

function mprisWrite(state) {
  mprisPending = state; // 始终留最新一帧：hello 未到先缓存，到了补发
  if (!mprisReady || !mprisDaemon || mprisDaemon.killed || !mprisDaemon.stdin.writable) return;
  try {
    mprisDaemon.stdin.write(JSON.stringify(state) + "\n");
  } catch (e) {
    log("[quaver] mpris state write failed:", String(e));
  }
}

// 渲染层快照（preload quaverMpris.send）→ 直写 daemon stdin（win/mac 无 daemon，
// 系统媒体控件由渲染层 navigator.mediaSession 直驱，不经主进程）；
// 同一份快照顺带喂托盘菜单（曲目行/播放态/循环档/随机勾选）
ipcMain.on("quaver:mpris", (_e, state) => {
  if (state && state.t === "state") {
    updateTrayMenu(state);
    mprisWrite(state);
  }
});

// build-res 资源定位：打包态在 <resources>/build-res，开发态在 ui/build-res。
const buildRes = (name) => join(app.isPackaged ? process.resourcesPath : UI_ROOT, "build-res", name);

// 托盘外壳（面板/菜单栏/任务栏）的深浅 —— 判据是**外壳底色**，不是应用窗口主题。
// 这里踩过坑：最初拿 nativeTheme 当判据，而它被我们写进 themeSource 的**应用主题**钉住（本应用
// 默认主题就是 dark）→ 托盘图永远被判成「深色外壳」，系统切到浅色时菜单栏/面板变浅、图标还是
// 浅色那份，直接看不见。所以每个平台都去取「系统给自己外壳的颜色」：
//   Linux  自己探测（readSystemTheme，见 systheme.mjs —— nativeTheme 在 KDE 下只认那份静态 GTK 快照）
//   macOS  读系统设置的 AppleInterfaceStyle（readMacShellTheme）—— 菜单栏底色只认它；nativeTheme
//          在 mac 上（含 shouldUseDarkColorsForSystemIntegratedUI 那一档）跟着 themeSource 走，用不得
//   Windows 用 shouldUseDarkColorsForSystemIntegratedUI：Electron 专门给「系统集成 UI（任务栏/通知区）」
//          开的判据，明说是**系统**主题，跟应用自己 set 的 themeSource 解耦
// 全判不出来才退回 nativeTheme，再不行交给 trayIconFile 兜底（按深色处理）。
function trayAppearance() {
  const detected = readSystemTheme() // Linux 桌面配色
    ?? (process.platform === "darwin" ? readMacShellTheme() : null) // macOS 系统设置
    ?? (process.platform === "win32"
      ? (nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? "dark" : "light") // Windows 系统主题
      : null);
  return detected ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
}

/** 托盘图：按 TRAY_ICON_PT 统一出图 + 附一张 @2x（mac 高 DPI 菜单栏不糊）。
 *  尺寸必须显式 resize —— macOS 按点的原尺寸画 NSImage，素材直塞就是「托盘图标巨大」的成因。 */
function trayImage() {
  const appearance = trayAppearance();
  const rel = trayIconFile(appearance);
  // 一行日志记下判断结果：这套「外壳底色」的判据在 Linux 上依桌面而定（Hyprland 这类没有系统级
  // 深浅色 API），出问题时只看日志就知道是判错了还是没刷新
  log(`[quaver] tray icon: 外壳=${appearance} → build-res/${rel}`);
  const src = nativeImage.createFromPath(buildRes(rel));
  if (src.isEmpty()) return nativeImage.createEmpty(); // 素材缺失也别让 Tray 构造抛错
  const image = nativeImage.createEmpty();
  const rep = (px) => src.resize({ width: px, height: px, quality: "best" }).toDataURL();
  image.addRepresentation({ scaleFactor: 1, dataURL: rep(TRAY_ICON_PT) });
  image.addRepresentation({ scaleFactor: 2, dataURL: rep(TRAY_ICON_PT * 2) });
  return image;
}

/** 外壳外观变了就换图（系统配色切换 / 应用主题档位切换都会走到这里）。Tray 没建好时是空操作。 */
function refreshTrayImage() {
  if (!tray) return;
  try { tray.setImage(trayImage()); } catch (e) { log("[quaver] tray image update failed:", String(e)); }
}

function createTray() {
  // Linux 下 Electron Tray 实现 StatusNotifierItem（D-Bus），Plasma 原生支持；
  // AppIndicator 扩展没有 XEmbed 回退，老版 GNOME 看不到属正常。
  // 图标见 tray-icon.mjs：明暗两份按外壳底色挑，尺寸三平台统一（mac 上「图标巨大」就是这里修掉的）。
  tray = new Tray(trayImage());
  tray.setToolTip("Quaver Music");
  // 首帧兜底菜单：渲染层快照到达后由 updateTrayMenu 整体替换
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => toggleWindow()); // 左键 = 显示/隐藏（SNI Activate → click）
}

// ——— 托盘菜单扩展：播放控制块 ———
// 状态来自渲染层快照（quaver:mpris → updateTrayMenu），命令回发 quaver:mpris-cmd ——
// 与 MPRIS daemon 命令同一通道，播放器仍是唯一事实源，主进程只转发不动播放状态。
// 渲染层不在线（窗口未起/拆窗间隙）时快照缺位 → 控制项按兜底灰置，点击自然丢弃（同热键语义）。
let trayState = null;
let trayMenuSig = "";

// 值来自 src/mpris.ts snapshot 的 loop 映射（player.mode），文案与播放条播放模式菜单一致
const TRAY_LOOP_LABELS = { None: "顺序播放", Playlist: "列表循环", Track: "单曲循环" };

function trayCmd(cmd, extra = {}) {
  if (win && !win.isDestroyed()) win.webContents.send("quaver:mpris-cmd", { cmd, ...extra });
}

function buildTrayMenu() {
  const s = trayState;
  const t = s?.track ?? null;
  const playing = s?.status === "Playing";
  const loop = TRAY_LOOP_LABELS[s?.loop] ? s.loop : "None";
  // 曲目行：歌名（title=主名+版本后缀，不含说明文字）- 歌手（" / " 连接，与界面同款）。
  // 成型与**截断**都在 tray-title.mjs：win/mac 的原生菜单不折行，菜单宽度 = 最宽那一项，
  // 一首长中文歌名 + 多位歌手就能把托盘菜单撑成横贯屏幕的一条（Linux 面板宿主自己会省略）。
  const songLine = trayTitleLine(t);
  return Menu.buildFromTemplate([
    { label: songLine, enabled: false }, // 纯展示项
    { label: "上一曲", enabled: !!s?.can?.prev, click: () => trayCmd("prev") }, // 渲染层 prevPress：单按遵循 PrevReplay，快速连按=跳上一首
    { label: playing ? "暂停" : "播放", enabled: !!(playing ? s?.can?.pause : s?.can?.play), click: () => trayCmd(playing ? "pause" : "play") },
    { label: "下一曲", enabled: !!s?.can?.next, click: () => trayCmd("next") },
    {
      // 与播放条的播放模式菜单同构：循环三档 + 随机（每日一套顺序）
      label: "循环模式",
      submenu: [
        { label: "顺序播放", type: "radio", checked: loop === "None", click: () => trayCmd("setLoop", { loop: "None" }) },
        { label: "列表循环", type: "radio", checked: loop === "Playlist", click: () => trayCmd("setLoop", { loop: "Playlist" }) },
        { label: "单曲循环", type: "radio", checked: loop === "Track", click: () => trayCmd("setLoop", { loop: "Track" }) },
        { type: "separator" },
        { label: "随机播放", type: "checkbox", checked: !!s?.shuffle, click: () => trayCmd("setShuffle", { on: !s?.shuffle }) },
      ],
    },
    { type: "separator" },
    { label: "显示/隐藏 Quaver Music", click: toggleWindow },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
}

// 快照持续到达（离散变化 + 5s 心跳）：签名不变不重建，免得空刷 DBus 菜单
function updateTrayMenu(state) {
  trayState = state;
  const t = state?.track;
  const sig = [
    state?.status ?? "",
    t?.key ?? "",
    t?.name ?? "",
    (t?.artists ?? []).join("/"),
    state?.loop ?? "",
    state?.shuffle ? "s" : "n",
    state?.can ? [state.can.prev, state.can.next, state.can.play, state.can.pause].map(Number).join("") : "",
  ].join("|");
  if (sig === trayMenuSig) return;
  trayMenuSig = sig;
  try { tray?.setContextMenu(buildTrayMenu()); } catch (e) { log("[quaver] tray menu update failed:", String(e)); }
}

/** sidecar 交回新凭证（登录 DONE / 令牌刷新）或登出（null）→ 加密落盘 / 清存档。 */
function applySidecarCredential(cred) {
  if (!credentialStore) return;
  if (!cred) {
    credentialStore.clear();
    log("[quaver] sidecar 已登出，凭证存档已清除");
    return;
  }
  if (credentialStore.write(cred)) log("[quaver] 登录凭证已存入密钥环:", credentialSummary(cred));
  else log(`[quaver] 凭证未写入存档（persist=${credentialStore.status().persist}）—— 本次登录只在内存里:`, credentialSummary(cred));
}

/**
 * 开发态 sidecar 的启动方式（Go 后端 vendor/Typhoeus-go）：优先仓库里已编译的二进制
 * （go build -o typhoeus-go ./cmd/quaver-server，快、不依赖 PATH），没有就 go run 现编。
 * 为什么开发态也要主进程来拉：凭证只走 stdin/stdout 交接，而手工起的 sidecar 拿不到那条管道
 * —— 它只能去读写明文 credential.json，而明文已经不允许存在了。
 */
function devSidecarCommand() {
  const dir = resolve(UI_ROOT, "..", "vendor", "Typhoeus-go");
  if (!existsSync(join(dir, "go.mod"))) return null;
  const bin = join(dir, process.platform === "win32" ? "typhoeus-go.exe" : "typhoeus-go");
  if (existsSync(bin)) return { cmd: bin, args: [], cwd: dir, label: bin };
  // go run 会把自身 stdio 转发给编译产物 —— 凭证交接管道（QCRED1）不受影响
  return { cmd: "go", args: ["run", "./cmd/quaver-server"], cwd: dir, label: "go run ./cmd/quaver-server (vendor/Typhoeus-go)" };
}

function sidecarCommand() {
  if (app.isPackaged) {
    // electron-builder 把 Go sidecar 产物放在 <resources>/bin/（Windows 上是 .exe）
    const bin = join(process.resourcesPath ?? "", "bin", process.platform === "win32" ? "quaver-server.exe" : "quaver-server");
    return existsSync(bin) ? { cmd: bin, args: [], cwd: undefined, label: bin } : null;
  }
  // 开发态：环境里已经给好 QUAVER_API（手工起的 sidecar / 联调）就不抢 —— 那种情况下
  // sidecar 拿不到交接管道，登录只在内存里活着，日志会说明。
  if (String(process.env.QUAVER_API ?? "").trim()) {
    log("[quaver] QUAVER_API 已由环境给出，本进程不自拉 sidecar（凭证不落盘，只驻内存）:", process.env.QUAVER_API);
    return null;
  }
  return devSidecarCommand();
}

function spawnSidecar() {
  const command = sidecarCommand();
  if (!command) {
    if (app.isPackaged) log("[quaver] sidecar binary missing, /api 将回退到环境里的 QUAVER_API");
    else log("[quaver] 未找到 vendor/Typhoeus-go（缺 go.mod），开发态 sidecar 需自行提供（QUAVER_API）");
    return null;
  }
  // 随机端口：从 3201 起 —— 3200 是「手工跑 sidecar」的默认端口，开发态很可能正被占着
  const port = 3201 + Math.floor(Math.random() * 200);
  process.env.QUAVER_API = `http://127.0.0.1:${port}`; // native-server.mjs / vite relay 的中继目标
  // 凭证交接：sidecar 自己不落盘 —— 主进程把已存凭证写进它的 stdin，
  // 之后每次登录/刷新/登出，它再从 stdout 交回来（前缀 QCRED1）。
  // 顺序要紧：注入行必须在 spawn 之后立刻写 —— sidecar 在 import 阶段**阻塞**读这一行。
  const handoff = credentialStore ? credentialStore.read() : null;
  log("[quaver] spawning sidecar:", command.label, "port", port, `凭证=交接（${handoff ? credentialSummary(handoff) : "无已存凭证"}）`);
  const child = spawn(command.cmd, command.args, {
    cwd: command.cwd,
    // QUAVER_CONFIG_DIR 显式下发：让 sidecar 的设备指纹与 Electron 落在同一目录，
    // 两边各有一套平台规则做兜底。QUAVER_CREDENTIAL_MODE=external 声明「凭证不在你手上」。
    env: {
      ...process.env,
      QUAVER_PORT: String(port),
      QUAVER_CONFIG_DIR: CONFIG_DIR,
      QUAVER_CREDENTIAL_MODE: "external",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    child.stdin.on("error", (e) => log("[quaver] sidecar stdin 写入失败:", String(e))); // EPIPE：子进程已退出
    child.stdin.write(encodeHandoff(handoff));
  } catch (e) {
    log("[quaver] sidecar 凭证注入失败:", String(e));
  }
  // stdout 必须**先分行再判前缀**：里面混着普通日志和凭证交接行，而交接行含有 musickey
  // —— 这个日志文件是要给人看、也会贴进 issue 的，凭证一个字符都不许进去。
  let outBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const { lines, rest } = drainLines(outBuf, chunk);
    outBuf = rest;
    for (const line of lines) {
      const msg = decodeHandoff(line);
      if (msg) applySidecarCredential(msg.credential);
      else log("[sidecar]", line);
    }
  });
  child.stderr.on("data", (d) => log("[sidecar]", String(d).trimEnd()));
  child.on("exit", (code) => log("[quaver] sidecar exited:", code));
  child.quaverPort = port;
  return child;
}

// 等 sidecar 可响应再开窗：Onefile PyInstaller 首启要解包，慢于页面首屏请求（实测竞态）。
async function waitSidecar(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/login/status`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        log("[quaver] sidecar healthy");
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  log("[quaver] sidecar NOT healthy after", timeoutMs, "ms — 继续启动（页面会显示错误态）");
  return false;
}

function serveStatic() {
  // dist 缺失时的友好错误页（先 pnpm run build）
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".json": "application/json", ".jpg": "image/jpeg" };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = join(DIST, path === "/" ? "/index.html" : path);
    if (!existsSync(file) && !extname(file)) file += ".html";
    if (!existsSync(file) || !file.startsWith(DIST)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
        <h2>dist/ 不存在</h2><p>先构建再启动应用：<code>cd ui &amp;&amp; pnpm run build &amp;&amp; pnpm run app</code></p></body>`);
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  });
  return server;
}

async function createWindow() {
  let url = cachedUrl;
  if (!url) {
  log("[quaver] module loaded; dist exists:", existsSync(join(DIST, "index.html")));
  if (existsSync(join(DIST, "index.html"))) {
    if (app.isPackaged) {
      // 打包态：纯 Node 服务（静态 dist + /api 中继，见 native-server.mjs），不依赖 vite；
      // 同时拉起随包 sidecar 二进制（extraResources 里的 quaver-server）。
      // 顺序要紧：先 spawn 设好 QUAVER_API，再 import native-server（它在模块加载时读 env）。
      sidecar = spawnSidecar();
      if (sidecar) await waitSidecar(sidecar.quaverPort);
      const { startQuaverServer } = await import("./native-server.mjs");
      const s = await startQuaverServer({ dist: DIST, logFile: LOG, port: STABLE_PORT, pluginsRoot: SPARKLE_PLUGINS_ROOT });
      log("[quaver] native server started:", s.url);
      url = s.url;
    } else {
      // 开发态：也由本进程拉 sidecar（凭证只走 stdin/stdout 交接，明文已不允许落盘）。
      // 顺序要紧：必须在 vite 加载前 spawn —— relay.ts 在模块加载时读一次 QUAVER_API。
      sidecar = spawnSidecar();
      if (sidecar) await waitSidecar(sidecar.quaverPort);
      // 开发态：vite preview（产物 + /api 中继 relay.ts 插件）同进程；动态 import 规避顶层导入副作用
      log("[quaver] starting vite preview…");
      const { preview } = await import("vite");
      const server = await preview({ configFile: join(UI_ROOT, "vite.config.ts"), preview: { host: "127.0.0.1", port: 4174, strictPort: false } });
      log("[quaver] preview started");
      url = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:4174/";
    }
  } else {
    // 兜底静态服务（无 /api 中继）：只为给出构建提示，不起 Electron 空转
    const s = serveStatic();
    s.listen(4175, "127.0.0.1");
    url = "http://127.0.0.1:4175/";
  }
  cachedUrl = url;
  }
  if (process.env.QUAVER_URL) url = process.env.QUAVER_URL; // 集成测试：指向 vite dev server（含 __quaverPlayer 钩子）
  // 引擎拿真实加载地址的 origin 做流中继（幂等：重建窗口只刷新引用与 baseUrl）
  try {
    audioEngine.init({ baseUrl: new URL(url).origin, getWin: () => win, log });
  } catch (e) { log("[quaver] audio engine init failed:", String(e)); }
  log("[quaver] loading", url);

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,   // 布局已适配窄窗（搜索框独立顶带 + 播放条流内收缩），半屏吸附不再挤压重叠
    minHeight: 520,   // 播放条为 .frame 流内固定行：任何高度下都占位可见
    frame: decorMode === "ssd", // CSD=无原生标题栏（右上角按钮簇）；SSD=系统标题栏
    backgroundColor: bootDark ? "#131417" : "#f7f7f8", // 同 style.css 的 --bg 明暗两值
    title: "Quaver Music",
    icon: buildRes("icon.png"), // X11 窗口图标（_NET_WM_ICON）；Wayland 的图标走 app_id → 桌面文件 → hicolor（见 linux-desktop 自装）
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false, // preload 只用 ipcRenderer/contextBridge；Linux chrome-sandbox 权限链路复杂，先绕开
    },
  });
  // —— 关闭浏览器式「全局导航」（中键不许跳转/开新窗口）——
  // 应用内跳转只有两条正路：渲染层 hash 路由（不经过 will-navigate）与登录流程的
  // 同 origin 整页 location.href。其余浏览器级导航一律关死：
  //   • 中键/Ctrl+点击链接、window.open、target=_blank —— Electron 缺省会弹一个
  //     新 BrowserWindow（「中键打开新窗口」的来源），setWindowOpenHandler 一律拒绝；
  //   • 离开应用 origin 的顶层导航（拖文件进窗、误触 form 提交等）—— will-navigate 拦下。
  // 渲染层还有一份中键就地拦截（src/main.ts）：浏览器 dev 态没有主进程兜底，靠那份生效。
  const appOrigin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    log("[quaver] 已拒绝新窗口请求:", openUrl);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, navUrl) => {
    try { if (new URL(navUrl).origin === appOrigin) return; } catch {}
    e.preventDefault();
    log("[quaver] 已拦截页面跳转:", navUrl);
  });
  win.loadURL(url);
  win.webContents.on("did-finish-load", () => log("[quaver] page loaded OK"));
  win.webContents.on("did-fail-load", (_e, code, desc) => log("[quaver] load FAIL", code, desc));
  win.on("close", (e) => {
    // 缩放到托盘：任何路径的 close（按钮簇✕/系统标题栏✕/Alt+F4）都改 hide；
    // 重建窗口（decor 切换）、真退出（托盘菜单/quit 行为）时放行。
    // 注意不因 tray 创建失败而放行 close：隐藏窗口仍可靠 second-instance/MPRIS raise 找回。
    if (closeAction === "tray" && !quitting && !rebuilding) {
      e.preventDefault();
      winShown = false;
      win?.hide();
      log("[quaver] close -> hide (tray:", tray ? "ok" : "MISSING", ")");
    }
  });
  win.on("show", () => (winShown = true));
  win.on("hide", () => (winShown = false));
  win.on("closed", () => (win = null));
  // 全屏态广播（画廊模式据此回同步；WM 手势/快捷键进出全屏同样送达渲染层）
  win.on("enter-full-screen", () => win?.webContents.send("quaver:fullscreen-state", true));
  win.on("leave-full-screen", () => win?.webContents.send("quaver:fullscreen-state", false));
}

// ——— quaver.conf 读写桥 ———
// 渲染层启动拉一次全量（all），之后每次改一项就整键写回（set）。路径解析、值域校验、
// 原子落盘、权限都在主进程这一侧，渲染层只认 "Section.Key" → 字符串。
//
// 为什么有一个 sendSync 版本：渲染层模块（player 实例化、prefs 读值）在 ESM import 阶段就
// 跑完了，任何 await 都排在它们之后 —— 异步取配置会让启动期全部落在默认值上。
// 同步读一个小文件（<10ms，每个窗口一次）换时序确定性，值。
ipcMain.on("quaver:config-sync", (e) => {
  try {
    const { values, warnings } = readValues();
    for (const w of warnings) log("[quaver] config:", w);
    e.returnValue = { ok: true, dir: CONFIG_DIR, path: configFile(), values, writable: configDirOk };
  } catch (err) {
    log("[quaver] config-sync failed:", String(err));
    e.returnValue = { ok: false, error: String(err) };
  }
});

ipcMain.handle("quaver:config", (_e, msg) => {
  const op = msg?.op;
  try {
    if (op === "all") {
      const { values, warnings } = readValues();
      for (const w of warnings) log("[quaver] config:", w);
      return { ok: true, dir: CONFIG_DIR, path: configFile(), values, writable: configDirOk };
    }
    if (op === "set") {
      const written = writeValues(msg?.patch ?? {});
      // 主题偏好刚变：立刻重算 Chromium 的深浅色来源（跟随系统 ⇄ 明/暗 之间切时这条最关键，
      // 否则要么系统变了不跟、要么切回固定档后还挂着探测值）
      const pref = msg?.patch?.["Style.Style"];
      if (pref !== undefined && written.includes("Style.Style")) {
        themePref = pref;
        applyThemeSource();
      }
      // 全局热键绑定刚变：重注册（注意只看 Global 段 —— Focus 段由渲染层 keydown 实时读，
      // 门户重绑会走「关旧会话再建」，GNOME 上还要重弹授权框，焦点键的改动犯不着）
      if (written.some((k) => k.startsWith("Hotkeys.Global."))) hotkeys.apply();
      return { ok: true, written };
    }
    if (op === "reset") {
      const values = resetConfig();
      themePref = values["Style.Style"] ?? "dark";
      applyThemeSource();
      hotkeys.apply(); // 绑定整体回到默认
      return { ok: true, values };
    }
    if (op === "reveal") {
      const p = configFile();
      if (existsSync(p)) shell.showItemInFolder(p); // 文件管理器里高亮选中
      else void shell.openPath(CONFIG_DIR);
      return { ok: true };
    }
    return { ok: false, error: `unknown op: ${op}` };
  } catch (e) {
    log("[quaver] config op failed:", String(op), String(e));
    return { ok: false, error: String(e) };
  }
});

// Sparkle 插件管理桥：list = 扫描已装插件；install = 主进程代下载（规避渲染层 CORS）+ 可选
// sha256 校验 + 落盘；pick-local / install-local = 「添加本地插件」两步（选文件读回 → 校验后落盘）；
// uninstall = 删目录；market = 主进程代取索引 JSON。
// 安全边界：插件 id 一律过 ^[a-z0-9][a-z0-9-]*$（同时是目录名，防穿越）；
// 安装 ≠ 启用 —— 渲染层默认不加载新装的插件，需用户手动开开关。
ipcMain.handle("quaver:sparkle", async (_e, msg) => {
  const op = msg?.op;
  try {
    if (op === "list") {
      const out = [];
      if (existsSync(SPARKLE_PLUGINS_ROOT)) {
        for (const name of await readdir(SPARKLE_PLUGINS_ROOT, { withFileTypes: true })) {
          if (!name.isDirectory() || !SPARKLE_ID_RE.test(name.name)) continue;
          const dir = join(SPARKLE_PLUGINS_ROOT, name.name);
          try {
            const manifest = JSON.parse(await readFile(join(dir, "plugin.json"), "utf8"));
            const st = await stat(join(dir, "plugin.json"));
            out.push({ id: name.name, dir, manifest, installedAt: Math.floor(st.mtimeMs) });
          } catch (err) {
            log("[quaver] sparkle: 跳过坏插件目录", name.name, String(err));
          }
        }
      }
      return { ok: true, plugins: out };
    }
    if (op === "install") {
      const url = String(msg?.url ?? "");
      if (!/^https?:\/\//.test(url)) return { ok: false, error: "download URL 必须是 http(s)" };
      const meta = msg?.meta ?? {};
      const id = String(meta?.id ?? "").trim();
      if (!SPARKLE_ID_RE.test(id)) return { ok: false, error: "插件 id 不合法" };
      const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
      if (msg?.sha256) {
        const want = String(msg.sha256).toLowerCase();
        const got = createHash("sha256").update(buf).digest("hex");
        if (want && want !== got) return { ok: false, error: `sha256 校验失败（期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）` };
      }
      await sparkleInstall(id, buf, meta);
      log("[quaver] sparkle: installed", id, `(${buf.length} bytes)`);
      return { ok: true, id };
    }
    if (op === "pick-local") {
      // 「添加本地插件」第一步：native 文件选择器 + 读文件。内容 base64 交渲染层做形状校验
      // （default export 需为 SparklePlugin），元数据从插件本体读出后再走 install-local。
      const r = await dialog.showOpenDialog(win ?? undefined, {
        title: "选择 Sparkle 插件文件",
        filters: [{ name: "Sparkle 插件（单文件 ESM）", extensions: ["js", "mjs"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      const buf = await readFile(r.filePaths[0]);
      return { ok: true, name: basename(r.filePaths[0]), dataBase64: buf.toString("base64") };
    }
    if (op === "install-local") {
      // 第二步：渲染层已校验插件形状并回传本体与元数据；这里只负责落盘（与 market install 同布局）
      const meta = msg?.meta ?? {};
      const id = String(meta?.id ?? "").trim();
      if (!SPARKLE_ID_RE.test(id)) return { ok: false, error: "插件 id 不合法" };
      const buf = Buffer.from(String(msg?.dataBase64 ?? ""), "base64");
      if (!buf.length) return { ok: false, error: "插件内容为空" };
      await sparkleInstall(id, buf, meta);
      log("[quaver] sparkle: installed (local)", id, `(${buf.length} bytes)`);
      return { ok: true, id };
    }
    if (op === "uninstall") {
      const id = String(msg?.id ?? "");
      if (!SPARKLE_ID_RE.test(id)) return { ok: false, error: "插件 id 不合法" };
      const dir = join(SPARKLE_PLUGINS_ROOT, id);
      if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
      log("[quaver] sparkle: uninstalled", id);
      return { ok: true };
    }
    if (op === "market") {
      const url = String(msg?.url ?? "");
      if (!/^https?:\/\//.test(url)) return { ok: false, error: "索引 URL 必须是 http(s)" };
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      return { ok: true, index: await r.json() };
    }
    return { ok: false, error: `unknown op: ${op}` };
  } catch (e) {
    log("[quaver] sparkle op failed:", String(op), String(e));
    return { ok: false, error: String(e) };
  }
});

// 应用自更新（设置-通用）：检查/下载/安装的执行端在 update.mjs，渲染层负责编排与提醒
setupUpdaterIPC({ log });

// 凭证存储状态（**不含凭证本体**）：确认这次到底走的是密钥环还是 0600 明文，排查用。
// 只读，不提供「读取凭证」的入口 —— 凭证永不进渲染层。
ipcMain.handle("quaver:credential-info", () => {
  const st = credentialStore?.status() ?? { persist: "memory", backend: "none", reason: "主进程尚未初始化" };
  return { ok: true, ...st, dir: CONFIG_DIR, switch: keyringPick.switchValue ?? null, pickWhy: keyringPick.why };
});

ipcMain.on("quaver:close-action", (_e, action) => {  closeAction = action === "quit" ? "quit" : "tray";
  writeValues({ "Window.CloseAction": closeAction }); // 幂等兜底：渲染层已写过，值相同不产生抖动
  log("[quaver] close-action ->", closeAction);
});

// 焦点内热键 Ctrl+Q（渲染层转发）：真退出，不走「缩回托盘」的 close 拦截（before-quit 已置位）
ipcMain.on("quaver:quit", () => app.quit());

// 设置页查询全局热键注册现状（Linux 门户状态 / win·mac 登记数）
ipcMain.handle("quaver:hotkeys-info", () => hotkeys.info());

ipcMain.on("quaver:win", (_e, action) => {
  if (!win) return;
  if (action === "min") win.minimize();
  // 全屏下「最大化」钮语义 = 还原（画廊模式从全屏退出），否则按最大化 ⇄ 还原切换
  else if (action === "max") {
    if (win.isFullScreen()) win.setFullScreen(false);
    else win.isMaximized() ? win.unmaximize() : win.maximize();
  }
  else if (action === "close") win.close();
  // 画廊模式（渲染层「正在播放页」全屏化）：显式给目标态而不是翻转 —— 渲染层据此维护
  // 「全屏由正在播放页接管」的标志，避免与用户的 WM 手势互相打架
  else if (action === "fullscreen") win.setFullScreen(true);
  else if (action === "unfullscreen") win.setFullScreen(false);
});

// 渲染层同步读全屏态（sendSync：与 config-sync 同理，装载期就要拿到确定值）
ipcMain.on("quaver:win-sync", (e) => {
  e.returnValue = { fullscreen: !!win?.isFullScreen() };
});

// 装饰模式切换（CSD<->SSD）：frame 只能在构造时给定 → 记住几何、拆掉旧窗、重建。
// rebuilding 标志防止 window-all-closed 在拆窗瞬间退出应用。
ipcMain.on("quaver:decor", (_e, mode) => {
  const next = mode === "ssd" ? "ssd" : "csd";
  writeValues({ "Window.Decor": next }); // 幂等兜底：渲染层已写过，这里保证主进程侧落盘
  if (next === decorMode) return;
  const bounds = win?.getBounds();
  const maximized = win?.isMaximized();
  decorMode = next;
  log("[quaver] decor ->", next);
  // 拆窗**不暂停**：mpv 引擎活在渲染层之外，播放跨重建自然延续（声音不断）。
  // 重建后的新页面启动时经 quaver:audio snapshot 问引擎要真实播放态（位置/时长/暂停），
  // 直接接管引擎里正在放的那条流 —— 引擎随后照常向新窗口广播 state 进度。
  // 拆窗前让渲染层立刻落一次会话存档：接管后 UI 显示的队列/指针要与 mpv 正在放的
  // 对齐（平时存档走 5s 节流 + pagehide，而 destroy() 不保证触发 pagehide）。
  rebuilding = true;
  const wc = win?.webContents;
  const rebuild = () => {
    if (!defaultMenu) defaultMenu = Menu.getApplicationMenu(); // 兜底：切走前若默认菜单已被摘，无从还原
    win?.destroy();
    createWindow().then(() => {
      if (win && bounds) win.setBounds(bounds);
      if (win && maximized) win.maximize();
      applyMenu();
    }).finally(() => (rebuilding = false));
  };
  // 页面若已挂死别卡住重建：flush 最多等 1s
  const flush = wc && !wc.isDestroyed()
    ? wc.executeJavaScript("window.dispatchEvent(new Event('quaver:flush-session'))").catch(() => {})
    : Promise.resolve();
  Promise.race([flush, new Promise((r) => setTimeout(r, 1000))]).then(rebuild);
});

// Wayland：本机 Electron 44 默认 ozone 平台即可，不加任何 ozone 相关开关。
// 但要关掉 Electron 内嵌 Chromium 的 MPRIS mediator：渲染层 HTML5 音频开播后，
// Chromium 自己会注册 org.mpris.MediaPlayer2.chromium.instance<pid>（Identity 用页面标题），
// 与 Quaver 的 mpris daemon 在总线上双条目并存、互抢桌面部件/媒体键（实测 electron#18253 workaround）。
// Quaver 不用 navigator.mediaSession 挂 MPRIS，全局媒体键由我们自己的 daemon 提供。
// MediaSessionService 仅 Linux 关：win/mac 的系统媒体控件（SMTC / Now Playing）恰恰依赖
// 渲染层 navigator.mediaSession（src/mpris.ts），关掉 MediaSessionService 它们就全瞎了。
// AutofillServerCommunication 与媒体键无关，全平台关：本应用没有表单自动填充，省掉它的
// 服务端通信与常驻状态（内存优化）。合成一次 appendSwitch —— disable-features 不发两次。
const disabledFeatures = ["AutofillServerCommunication"];
if (process.platform === "linux" && !process.env.QUAVER_KEEP_MEDIATOR) {
  disabledFeatures.push("MediaSessionService", "HardwareMediaKeyHandling");
}
app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));
// 渲染进程 V8 老生代上限：本应用的数据面很小（千首级歌单/队列也就几 MB 的 JS 对象），V8 默认
// 无上限会按堆增长启发式惰性扩堆，渲染进程 RSS 轻松上 400MB。钉一个 256MB 顶部逼 V8 提前回收，
// 行为零变化（正常使用远碰不到这个顶）。js-flags 只作用于 Chromium 子进程（渲染层/工具进程），
// 主进程的 Node V8 不受影响。
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");
log("[quaver] main.mjs entered, app name:", app.name || "(unset)");
// 先抓一份 Electron 默认菜单（SSD 模式用），随后按 decorMode 应用。
let defaultMenu = Menu.getApplicationMenu();
applyMenu();
// 单实例：重复启动聚焦已有窗口（防止误开多份 preview/日志串台）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 缩放到托盘时再次启动 = 唤回窗口（showWindow 处理 min/hidden 两种情况）
    showWindow();
  });
}
// 勿用顶层 await：Electron 对 ESM 主进程中挂起在 await 的模块引导不完整（实测 whenReady 永不兑现）
app.whenReady().then(() => {
  log("[quaver] app ready");
  // ——— 凭证存储：ready 之后第一件事就是把「这次到底拿到了什么后端」问清楚 ———
  // 探测（选开关）与校验（认不认）是两件事：这里只信 safeStorage 的自报，落在 basic_text 一律不用。
  let plan;
  try {
    plan = evaluateKeyring({ platform: process.platform, safeStorage, requested: securityConf.backend, mode: securityConf.store });
  } catch (e) {
    plan = { persist: "memory", backend: "none", reason: `探测失败：${String(e)}` };
  }
  credentialStore = new CredentialStore({ dir: CONFIG_DIR, safeStorage, plan, log });
  log(`[quaver] 凭证存储: ${plan.persist}（${plan.backend}）— ${plan.reason}`);
  if (keyringPick.switchValue) log(`[quaver] --password-store=${keyringPick.switchValue}（${keyringPick.why}）`);
  if (plan.persist === "keyring") {
    // 升级遗留的明文 credential.json：读一次 → 加密存进密钥环 → 回读校验 → 删掉。之后磁盘上只有密文。
    if (credentialStore.migrateLegacy() === "migrated") log("[quaver] 明文 credential.json 已迁入密钥环并删除");
  } else {
    log("[quaver] 警告：系统密钥管理器不可用，凭证只驻内存 —— 本次登录关掉应用就没了，需要重新扫码。",
        "修法：起 KWallet / gnome-keyring，或在 quaver.conf 的 [Security] KeyringBackend 里显式指定后端。",
        "（本应用不会把凭证以明文写到磁盘上，所以没有「退回明文」这一档。）");
  }
  // 深浅色来源必须在建窗之前定好：窗口一创建，渲染进程就会带着当时的 color scheme 起来
  try {
    applyThemeSource();
    // 系统配色变化：只在「跟随系统」时接管（明/暗固定档下系统怎么变都与本应用无关）。
    // 不用 nativeTheme 的 updated 事件 —— 我们把 themeSource 写死成 dark/light 之后，
    // Electron 就不再去问系统了，那个事件自然不会来；盯文件才是真来源。
    watchSystemTheme(() => {
      if (themePref !== "dark" && themePref !== "light") applyThemeSource();
      refreshTrayImage(); // 桌面配色变了：托盘图跟外壳底色走，跟应用窗口主题档位无关
    });
    // macOS：菜单栏的深浅只认系统设置（见 trayAppearance 那段注释），单独盯一份 —— 非 mac 上
    // 这个 watcher 自己什么都不做（readMacShellTheme 恒 null）。
    watchMacShellTheme(() => refreshTrayImage());
  } catch (e) {
    log("[quaver] system theme watch failed:", String(e));
  }
  // —— Linux 桌面集成自装（模块 linux-desktop.mjs）——
  // app_id（red.0w0.quaver）→ applications/<ID>.desktop → hicolor 图标，是各桌面取窗口图标、
  // 任务栏分组与门户鉴权的唯一链路。打包态只有被集成工具接管才有人装、开发态永远没人装。
  // 异步放行不挡启动；失败只在日志记账（图标显示退化，不影响功能）。
  if (process.platform === "linux") {
    // Exec 指向「当前这份应用」：打包态 = AppImage 本体（$APPIMAGE 由运行时注入；从解包目录
    // 直跑时退回 AppRun），开发态 = 当前 electron + 仓库 ui/ 目录
    const exec = process.env.APPIMAGE
      ? `${quoteExecPath(process.env.APPIMAGE)} --no-sandbox %U`
      : app.isPackaged
        ? `${quoteExecPath(join(dirname(process.execPath), "AppRun"))} --no-sandbox %U`
        : `${quoteExecPath(process.execPath)} ${quoteExecPath(UI_ROOT)} %U`;
    installLinuxDesktopIntegration({
      desktopId: DESKTOP_ID,
      name: app.getName(),
      comment: PKG_META.description ?? "",
      exec,
      iconSourceDir: buildRes("icons"),
      log,
    }).then((r) => {
      if (r.desktopAction === "written") log("[quaver] linux-desktop: 已写", r.desktopFile);
      if (r.iconsWritten.length) log("[quaver] linux-desktop: hicolor 图标已同步:", r.iconsWritten.join(" "));
    }).catch((e) => log("[quaver] linux-desktop failed:", String(e)));
  }
  // 开发态 macOS：Dock 显示的是 electron 壳的图标；打包态用 bundle 内嵌 icns，无需此步
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    try { app.dock.setIcon(buildRes("icon.png")); } catch {}
  }
  createWindow().catch((e) => {
    log("[quaver] startup failed:", String(e && e.stack || e));
    app.quit();
  });
  try { createTray(); } catch (e) { log("[quaver] tray init failed:", String(e)); }
  // 换托盘图的两条触发：①nativeTheme 的 updated（应用主题档位切换、以及 win/mac 上的系统配色切换
  // 都会发）②Linux 的 watchSystemTheme（Electron 在 KDE 下看不见真实配色变化，见 systheme.mjs）。
  // 换图本身很便宜（两张 256² 缩到 16/32），不做去重。
  nativeTheme.on("updated", () => refreshTrayImage());
  try { startMpris(); } catch (e) { log("[quaver] mpris init failed:", String(e)); }
  try { hotkeys.apply(); } catch (e) { log("[quaver] hotkeys init failed:", String(e)); }
});
app.on("window-all-closed", () => { if (!rebuilding) app.quit(); });
// 注销/登出：会话管理器对本进程发 SIGTERM（超时后 SIGKILL）。不接住的话默认行为是立刻死，
// will-quit 等收尾不会跑 —— sidecar/mpris/mpv 全成孤儿，mpv 继续放歌。这里先清子进程再退；
// 期间被 SIGKILL 的极端场景由 mpv 看门狗兜底（父死 → 管道断 → mpv 必死，见 engine.mjs）。
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    log("[quaver] signal:", sig, "— 清理子进程后退出");
    try { audioEngine.shutdown(); } catch {}
    try { sidecar?.kill(); } catch {}
    try { mprisDaemon?.kill(); } catch {}
    // app.exit 不触发 will-quit（上面已手动清理）；显式接信号后也不再用默认终止
    app.exit(0);
  });
}
app.on("will-quit", () => {
  try { hotkeys.destroy(); } catch {} // win/mac 反注册系统级热键；Linux 关门户会话
  try { sidecar?.kill(); } catch {}
  try { mprisDaemon?.kill(); } catch {}
  try { audioEngine.shutdown(); } catch {}
});
