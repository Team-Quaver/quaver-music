// Quaver — Electron preload：窗口控制桥（悬浮三钮）+ 装饰模式（CSD/SSD）切换 + MPRIS IPC 桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quaverCSD", {
  min: () => ipcRenderer.send("quaver:win", "min"),
  max: () => ipcRenderer.send("quaver:win", "max"),
  close: () => ipcRenderer.send("quaver:win", "close"),
  setDecor: (mode) => ipcRenderer.send("quaver:decor", mode),
  // 关闭按钮行为偏好（tray=缩放到托盘 / quit=退出程序）同步给主进程
  setCloseAction: (action) => ipcRenderer.send("quaver:close-action", action === "quit" ? "quit" : "tray"),
});

// MPRIS：渲染层 ↔ mpris daemon（经主进程中转，daemon 走 stdio NDJSON）。
// state 为播放器快照（结构化克隆可序列化）；命令回调只收纯数据。
contextBridge.exposeInMainWorld("quaverMpris", {
  send: (state) => ipcRenderer.send("quaver:mpris", state),
  onCommand: (cb) =>
    ipcRenderer.on("quaver:mpris-cmd", (_e, msg) => {
      try { cb(msg); } catch (err) { console.warn("mpris cmd failed", err); }
    }),
});

// 配置文件（quaver.conf）：启动时**同步**取一份快照，之后改一项写一项。
// 为什么是 sendSync：渲染层模块（player 实例化 / prefs 读值）在 ESM import 阶段就跑完，
// 静态 import 提升让任何 await 都排在它们之后 —— 异步取配置会让启动期全落在默认值上。
// 主进程负责平台路径解析 / 值域校验 / 原子落盘与权限，渲染层只认 "Section.Key" → 字符串。
let configBoot = { ok: false };
try { configBoot = ipcRenderer.sendSync("quaver:config-sync") || configBoot; } catch { /* 壳层没起 handler：走默认值 */ }
contextBridge.exposeInMainWorld("quaverConfig", {
  boot: configBoot,
  all: () => ipcRenderer.invoke("quaver:config", { op: "all" }),
  set: (patch) => ipcRenderer.invoke("quaver:config", { op: "set", patch }),
  reset: () => ipcRenderer.invoke("quaver:config", { op: "reset" }),
  reveal: () => ipcRenderer.invoke("quaver:config", { op: "reveal" }),
});

// 凭证存储状态（只读、不含凭证本体）：确认这次走的是系统密钥管理器还是 0600 明文。
contextBridge.exposeInMainWorld("quaverSecurity", {
  info: () => ipcRenderer.invoke("quaver:credential-info"),
});

// Sparkle 插件系统（第三方插件管理）：list/install/uninstall/market 均由主进程执行，
// 渲染层只拿结果。安装 ≠ 启用：装完默认不加载，需用户在设置页手动开启。
contextBridge.exposeInMainWorld("quaverSparkle", {
  list: () => ipcRenderer.invoke("quaver:sparkle", { op: "list" }),
  install: (msg) => ipcRenderer.invoke("quaver:sparkle", { op: "install", ...msg }),
  uninstall: (msg) => ipcRenderer.invoke("quaver:sparkle", { op: "uninstall", ...msg }),
  market: (msg) => ipcRenderer.invoke("quaver:sparkle", { op: "market", ...msg }),
});

// 音频引擎（mpv 后端）：invoke 走请求/应答（handle 返回值可序列化），事件为主进程主动推。
// 渲染层 Transport 抽象（src/lib/transport.ts）据此实现 EngineTransport；
// 浏览器 dev（无 preload）下 window.quaverAudio 不存在 → 自动落到 <audio> WebTransport。
contextBridge.exposeInMainWorld("quaverAudio", {
  invoke: (cmd) => ipcRenderer.invoke("quaver:audio", cmd),
  onEvent: (cb) =>
    ipcRenderer.on("quaver:audio-event", (_e, ev) => {
      try { cb(ev); } catch (err) { console.warn("audio engine event failed", err); }
    }),
});
