// Quaver — Electron 主进程（ESM）
// 起一个进程内 vite preview（dist/ + /api 中继插件），窗口加载 http://127.0.0.1:<port>
// frame:false：无原生标题栏——窗口右上角平铺三个窗口按钮（min/max/close）+抓握点，经 preload IPC 接管。
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 音频引擎（mpv 后端）：窗口 URL 确定后 init（需要 baseUrl 绝对化 /api/stream 中继地址）
import { audioEngine } from "./audio/engine.mjs";
// 配置文件（quaver.conf）与跨平台目录规则：路径单一真相，渲染层与 sidecar 都对齐这一份
import { configDir, configFile, ensureConfigDir, logFile, readValues, resetConfig, writeValues } from "./config.mjs";
// 系统深浅色探测（Linux 桌面各自的真相来源，见模块头）：「跟随系统」要靠它才真的跟得上
import { readSystemTheme, watchSystemTheme } from "./systheme.mjs";
// 注意：vite 不能在顶层 import——实测其在 Electron 主进程有副作用，会让 app.whenReady() 永不兑现。
// 只在 createWindow 里动态 import()。

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(__dirname, "..");
const DIST = join(UI_ROOT, "dist");

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
  // 开发态：vendor/Typhoeus/mpris/dist/（npm run build:mpris 产物，缺失则跳过 MPRIS）
  return resolve(UI_ROOT, "..", "vendor", "Typhoeus", "mpris", "dist", "mpris-daemon.cjs");
}

let mprisBuf = "";      // daemon stdout 行缓冲
let mprisReady = false; // 收到 hello 前缓存最新 state，避免总线未就绪时丢首帧
let mprisPending = null;
let mprisRetries = 0;
let mprisDaemon = null; // 当前 daemon 子进程
let mprisSpawnedAt = 0; // 上次拉起时刻（崩溃重拉的存活判据）

function startMpris() {
  if (process.platform !== "linux") return; // 本期只做 Linux MPRIS；macOS/Windows 原生媒体键另议
  const script = mprisDaemonPath();
  if (!existsSync(script)) {
    log("[quaver] mpris daemon missing, skipped:", script);
    return;
  }
  log("[quaver] spawning mpris daemon:", script);
  // Electron 自带 node 跑 .cjs（ELECTRON_RUN_AS_NODE），打包态无需系统 node
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", QUAVER_MPRIS_NAME: "quaver" },
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

// 渲染层快照（preload quaverMpris.send）→ 直写 daemon stdin
ipcMain.on("quaver:mpris", (_e, state) => {
  if (state && state.t === "state") mprisWrite(state);
});

// build-res 资源定位：打包态在 <resources>/build-res，开发态在 ui/build-res。
const buildRes = (name) => join(app.isPackaged ? process.resourcesPath : UI_ROOT, "build-res", name);

function createTray() {
  // Linux 下 Electron Tray 实现 StatusNotifierItem（D-Bus），Plasma 原生支持；
  // AppIndicator 扩展没有 XEmbed 回退，老版 GNOME 看不到属正常。
  // 托盘图固定用浅色版（tray.png）：面板多为深底，浅米底图标对比更好。
  const iconPath = buildRes("tray.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty(); // 图标缺失也别让 Tray 构造抛错
  tray = new Tray(image);
  tray.setToolTip("Quaver");
  const menu = Menu.buildFromTemplate([
    { label: "显示/隐藏 Quaver", click: toggleWindow },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => toggleWindow()); // 左键 = 显示/隐藏（SNI Activate → click）
}

function spawnSidecar() {
  // electron-builder 把 PyInstaller 产物放在 <resources>/bin/quaver-server
  const bin = join(process.resourcesPath ?? "", "bin", "quaver-server");
  if (!existsSync(bin)) {
    log("[quaver] sidecar binary missing, /api 将回退到环境里的 QUAVER_API:", bin);
    return null;
  }
  const port = 3200 + Math.floor(Math.random() * 200); // 随机端口，避开 dev 遗留的 :3200
  process.env.QUAVER_API = `http://127.0.0.1:${port}`; // native-server.mjs 的中继目标
  log("[quaver] spawning sidecar:", bin, "port", port);
  const child = spawn(bin, [], {
    // QUAVER_CONFIG_DIR 显式下发：让 sidecar 的凭证/设备指纹与 Electron 落在同一目录，
    // 两边各有一套平台规则做兜底（dev 态手工跑 sidecar 时也能落对地方）。
    env: { ...process.env, QUAVER_PORT: String(port), QUAVER_CONFIG_DIR: CONFIG_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log("[sidecar]", String(d).trimEnd()));
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
  // dist 缺失时的友好错误页（先 npm run build）
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".json": "application/json", ".jpg": "image/jpeg" };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = join(DIST, path === "/" ? "/index.html" : path);
    if (!existsSync(file) && !extname(file)) file += ".html";
    if (!existsSync(file) || !file.startsWith(DIST)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
        <h2>dist/ 不存在</h2><p>先构建再启动应用：<code>cd ui &amp;&amp; npm run build &amp;&amp; npm run app</code></p></body>`);
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
      const s = await startQuaverServer({ dist: DIST, logFile: LOG, port: STABLE_PORT });
      log("[quaver] native server started:", s.url);
      url = s.url;
    } else {
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
    title: "Quaver",
    icon: buildRes("icon.png"), // 深色版应用图标（任务栏/窗口管理器等），与 AppImage desktop 图标一致
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false, // preload 只用 ipcRenderer/contextBridge；Linux chrome-sandbox 权限链路复杂，先绕开
    },
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
      return { ok: true, written };
    }
    if (op === "reset") {
      const values = resetConfig();
      themePref = values["Style.Style"] ?? "dark";
      applyThemeSource();
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

ipcMain.on("quaver:close-action", (_e, action) => {
  closeAction = action === "quit" ? "quit" : "tray";
  writeValues({ "Window.CloseAction": closeAction }); // 幂等兜底：渲染层已写过，值相同不产生抖动
  log("[quaver] close-action ->", closeAction);
});

ipcMain.on("quaver:win", (_e, action) => {
  if (!win) return;
  if (action === "min") win.minimize();
  else if (action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
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
  // 拆窗前暂停音频：渲染层会被销毁，而 mpv 活在渲染层之外 —— 不暂停就成了没有 UI 的孤儿播放，
  // 重建后的新页面还是空队列，用户既看不见也停不掉。
  void audioEngine.pauseForRebuild();
  rebuilding = true;
  if (!defaultMenu) defaultMenu = Menu.getApplicationMenu(); // 兜底：切走前若默认菜单已被摘，无从还原
  win?.destroy();
  createWindow().then(() => {
    if (win && bounds) win.setBounds(bounds);
    if (win && maximized) win.maximize();
    applyMenu();
  }).finally(() => (rebuilding = false));
});

// Wayland：本机 Electron 44 默认 ozone 平台即可，不加任何 ozone 相关开关。
// 但要关掉 Electron 内嵌 Chromium 的 MPRIS mediator：渲染层 HTML5 音频开播后，
// Chromium 自己会注册 org.mpris.MediaPlayer2.chromium.instance<pid>（Identity 用页面标题），
// 与 Quaver 的 mpris daemon 在总线上双条目并存、互抢桌面部件/媒体键（实测 electron#18253 workaround）。
// Quaver 不用 navigator.mediaSession，全局媒体键由我们自己的 daemon 经 MPRIS 提供 → 关掉零副作用。
if (!process.env.QUAVER_KEEP_MEDIATOR) {
  app.commandLine.appendSwitch("disable-features", "MediaSessionService,HardwareMediaKeyHandling");
}
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
  // 深浅色来源必须在建窗之前定好：窗口一创建，渲染进程就会带着当时的 color scheme 起来
  try {
    applyThemeSource();
    // 系统配色变化：只在「跟随系统」时接管（明/暗固定档下系统怎么变都与本应用无关）。
    // 不用 nativeTheme 的 updated 事件 —— 我们把 themeSource 写死成 dark/light 之后，
    // Electron 就不再去问系统了，那个事件自然不会来；盯文件才是真来源。
    watchSystemTheme(() => {
      if (themePref !== "dark" && themePref !== "light") applyThemeSource();
    });
  } catch (e) {
    log("[quaver] system theme watch failed:", String(e));
  }
  createWindow().catch((e) => {
    log("[quaver] startup failed:", String(e && e.stack || e));
    app.quit();
  });
  try { createTray(); } catch (e) { log("[quaver] tray init failed:", String(e)); }
  try { startMpris(); } catch (e) { log("[quaver] mpris init failed:", String(e)); }
});
app.on("window-all-closed", () => { if (!rebuilding) app.quit(); });
app.on("will-quit", () => {
  try { sidecar?.kill(); } catch {}
  try { mprisDaemon?.kill(); } catch {}
  try { audioEngine.shutdown(); } catch {}
});
