// Quaver — Electron preload：窗口控制桥（悬浮三钮）+ 装饰模式（CSD/SSD）切换 + MPRIS IPC 桥
import type {
  AudioCommand, AudioEvent, AudioReply, BackgroundReply, BridgeReply, ConfigAllReply, ConfigChangedPayload, IpcPayload,
  ConfigWriteReply, CredentialInfoReply, DebugMetricsReply, DebugReply, HotkeyEvent, HotkeyInfo, LocalReply, MusicCacheReply,
  SparkleInstallLocalRequest, SparkleInstallReply, SparkleListReply, SparkleMarketReply, SparklePickReply,
  SparkleInstallRequest, DebugRequest, UpdateInstallDone, UpdateProgress, UpdateReply, UpdateRequest,
} from "./bridge-types.ts";
import type { DlCommand, DlControlMsg, DlControlResult, DlState, DlSync, DlTrack, DlWindowAction } from "./dl-wire.ts";
import type { MprisCommand, MprisState } from "./mpris.ts";

const { contextBridge, ipcRenderer } = require("electron");

/** 主进程同步快照（`sendSync`）在壳层未就绪时可能拿不到，统一兜 null。 */
function syncSnapshot<T>(channel: string): T | null {
  try { return ipcRenderer.sendSync(channel) ?? null; } catch { return null; }
}

/** `invoke` 在主进程的 handler 里 resolve 什么就是什么：按桥契约把应答收成领域类型。 */
function ask<T>(channel: string, payload?: IpcPayload): Promise<T> {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld("quaverCSD", {
  min: () => ipcRenderer.send("quaver:win", "min"),
  max: () => ipcRenderer.send("quaver:win", "max"),
  close: () => ipcRenderer.send("quaver:win", "close"),
  setDecor: (mode: string) => ipcRenderer.send("quaver:decor", mode),
  // 关闭按钮行为偏好（tray=缩放到托盘 / quit=退出程序）同步给主进程
  setCloseAction: (action: string) => ipcRenderer.send("quaver:close-action", action === "quit" ? "quit" : "tray"),
  // 全屏（画廊模式）：显式目标态；状态经主进程 enter/leave-full-screen 事件回推
  fullscreen: (on: boolean) => ipcRenderer.send("quaver:win", on ? "fullscreen" : "unfullscreen"),
  isFullscreen: () => {
    return syncSnapshot<{ fullscreen?: boolean }>("quaver:win-sync")?.fullscreen === true;
  },
  onFullscreen: (cb: (on: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, on: boolean) => { try { cb(on === true); } catch (err) { console.warn("fullscreen event failed", err); } };

    ipcRenderer.on("quaver:fullscreen-state", listener);

    return () => ipcRenderer.removeListener("quaver:fullscreen-state", listener);
  },
  isMaximized: () => {
    return syncSnapshot<{ maximized?: boolean }>("quaver:win-sync")?.maximized === true;
  },
  onMaximized: (cb: (on: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, on: boolean) => { try { cb(on === true); } catch (err) { console.warn("maximized event failed", err); } };

    ipcRenderer.on("quaver:maximized-state", listener);

    return () => ipcRenderer.removeListener("quaver:maximized-state", listener);
  },
  // 焦点内热键 Ctrl+Q：真退出（主进程 before-quit 已置位，不会撞「缩回托盘」的 close 拦截）
  quit: () => ipcRenderer.send("quaver:quit"),
});

// 全局热键（主进程注册，动作转发回渲染层执行；Linux 走 XDG 门户，win/mac 走 globalShortcut）。
// payload { t: "action", action } | { t: "failed", items } | { t: "status", state, reason }。
// infoSync 供设置页装载期立即判断 Wayland，避免全局录制项先闪一下再隐藏。
contextBridge.exposeInMainWorld("quaverHotkeys", {
  onEvent: (cb: (payload: HotkeyEvent) => void) =>
    ipcRenderer.on("quaver:hotkey", (_e: Electron.IpcRendererEvent, payload: HotkeyEvent) => {
      try { cb(payload); } catch (err) { console.warn("hotkey event failed", err); }
    }),
  info: () => ask<HotkeyInfo>("quaver:hotkeys-info"),
  infoSync: () => syncSnapshot<HotkeyInfo>("quaver:hotkeys-info-sync"),
});

// MPRIS：渲染层 → 主进程内 MPRIS 服务；总线命令再由主进程中转回来。
// state 为播放器快照（结构化克隆可序列化）；命令回调只收纯数据。
contextBridge.exposeInMainWorld("quaverMpris", {
  send: (state: MprisState) => ipcRenderer.send("quaver:mpris", state),
  onCommand: (cb: (msg: MprisCommand) => void) =>
    ipcRenderer.on("quaver:mpris-cmd", (_e: Electron.IpcRendererEvent, msg: MprisCommand) => {
      try { cb(msg); } catch (err) { console.warn("mpris cmd failed", err); }
    }),
});

// 桌面歌词（Desktop Lyrics）双面桥：同一座 preload 挂在主窗与透明覆盖层窗上，按频道分流。
// 主窗侧（src/lib/desktop-lyrics.ts）：推曲目/时钟快照（sendTrack/sendSync）、读状态/下控制（control/activeSync）、
//   收激活广播与控制命令（onActive/onCmd）。
// 覆盖层侧（src/desktop-lyrics.ts）：收数据（onTrack/onSync）、回控制命令（sendCmd）、
//   窗口级动作（windowOp：边缘缩放/关窗/固定并鼠标透穿）。挪窗走 CSD 拖拽区，不经桥。
// 中转与原生锁定都在主进程 electron/desktop-lyrics.ts；浏览器 dev 没有本桥 → 两侧功能整体缺席。
contextBridge.exposeInMainWorld("quaverDesktopLyrics", {
  // —— 主窗侧 ——
  sendTrack: (payload: DlTrack) => ipcRenderer.send("quaver:dl-track", payload),
  sendSync: (payload: DlSync) => ipcRenderer.send("quaver:dl-sync", payload),
  control: (msg: DlControlMsg) => ask<DlControlResult>("quaver:dl-control", msg),
  activeSync: () => syncSnapshot<DlState>("quaver:dl-active"),
  onActive: (cb: (s: DlState) => void) =>
    ipcRenderer.on("quaver:dl-active", (_e: Electron.IpcRendererEvent, s: DlState) => {
      try { cb(s); } catch (err) { console.warn("desktop-lyrics active failed", err); }
    }),
  onCmd: (cb: (msg: DlCommand) => void) =>
    ipcRenderer.on("quaver:dl-cmd", (_e: Electron.IpcRendererEvent, msg: DlCommand) => {
      try { cb(msg); } catch (err) { console.warn("desktop-lyrics cmd failed", err); }
    }),
  // —— 覆盖层侧 ——（主进程把主窗快照原样转发到 dl 窗的同名频道）
  onTrack: (cb: (p: DlTrack) => void) =>
    ipcRenderer.on("quaver:dl-track", (_e: Electron.IpcRendererEvent, p: DlTrack) => {
      try { cb(p); } catch (err) { console.warn("desktop-lyrics track failed", err); }
    }),
  onSync: (cb: (p: DlSync) => void) =>
    ipcRenderer.on("quaver:dl-sync", (_e: Electron.IpcRendererEvent, p: DlSync) => {
      try { cb(p); } catch (err) { console.warn("desktop-lyrics sync failed", err); }
    }),
  sendCmd: (msg: DlCommand) => ipcRenderer.send("quaver:dl-cmd", msg),
  windowOp: (msg: DlWindowAction) => ipcRenderer.send("quaver:dl-window", msg),
});

// 配置文件（quaver.conf）：启动时**同步**取一份快照，之后改一项写一项。
// 为什么是 sendSync：渲染层模块（player 实例化 / prefs 读值）在 ESM import 阶段就跑完，
// 静态 import 提升让任何 await 都排在它们之后 —— 异步取配置会让启动期全落在默认值上。
// 主进程负责平台路径解析 / 值域校验 / 原子落盘与权限，渲染层只认 "Section.Key" → 字符串。
const configBoot = syncSnapshot<ConfigAllReply>("quaver:config-sync") ?? { ok: false };

// Crotchet 调试模式（QUAVER_CROTCHET=1）：开关随 config-sync 快照下发，渲染层据此
// 跳过本地插件安装的 5 秒警告弹窗（主进程永远是真正的事实源，这里只是搬运）。
contextBridge.exposeInMainWorld("quaverCrotchet", configBoot.crotchet === true);

// Sparkle 安全模式（QUAVER_REDFLAG=1）：主进程读环境变量后随 config-sync 下发；渲染层的加载
// 策略（src/sparkle/policy.ts）据此只放行预装插件。浏览器 dev 没有 preload → 恒为 false。
contextBridge.exposeInMainWorld("quaverRedflag", configBoot.redflag === true);

contextBridge.exposeInMainWorld("quaverConfig", {
  boot: configBoot,
  all: () => ask<ConfigAllReply>("quaver:config", { op: "all" }),
  set: (patch: Record<string, string>, apply?: boolean) =>
    ask<ConfigWriteReply | MusicCacheReply>("quaver:config", { op: "set", patch, apply }),
  reset: () => ask<ConfigWriteReply>("quaver:config", { op: "reset" }),
  reveal: () => ask<BridgeReply>("quaver:config", { op: "reveal" }),
  // 配置变更广播（主进程在任意窗口写盘成功后发给全部窗口）：{ keys, values } = 增量，
  // { all: true } = 重置（监听方整表重载）。多窗共用一份 quaver.conf，靠这条保持同步。
  onChanged: (cb: (p: ConfigChangedPayload) => void) =>
    ipcRenderer.on("quaver:config-changed", (_e: Electron.IpcRendererEvent, p: ConfigChangedPayload) => {
      try { cb(p); } catch (err) { console.warn("config-changed failed", err); }
    }),
});

// 调试（设置 → 通用 → 调试）：开发者控制台开关与进程/内存自检。
// 自检必须问主进程 —— 渲染层看不见主进程、GPU 进程与外部子进程（sidecar/mpv/看门狗）。
contextBridge.exposeInMainWorld("quaverDebug", {
  devtools: (msg: DebugRequest) => ask<DebugReply>("quaver:devtools", msg),
  metrics: () => ask<DebugMetricsReply>("quaver:metrics"),
});

// 开源致谢（设置 → 通用 → 版本号下方）：仓库链接交给系统浏览器，不在应用内开新窗。
contextBridge.exposeInMainWorld("quaverCredits", {
  open: (url: string) => ask<BridgeReply>("quaver:credits-open", url),
});

// 微云音乐授权：只允许打开微云官方授权页；Token 交换由 sidecar 完成，
// 不把授权码或 Token 暴露给渲染层之外的页面。
contextBridge.exposeInMainWorld("quaverWeiyunAuth", {
  open: (url: string) => ask<BridgeReply>("quaver:weiyun-auth-open", url),
});

// 凭证存储状态（只读、不含凭证本体）：确认这次走的是系统密钥管理器还是 0600 明文。
contextBridge.exposeInMainWorld("quaverSecurity", {
  info: () => ask<CredentialInfoReply>("quaver:credential-info"),
});

// 自定义背景图（设置→外观→背景）：pick = 原生选图（主进程把路径写进 quaver.conf），
// info = 回显当前路径/文件是否还在。图片本体不经这里 —— 界面走同源 /api/bg 拿。
contextBridge.exposeInMainWorld("quaverBackground", {
  pick: () => ask<BackgroundReply>("quaver:background", { op: "pick" }),
  info: () => ask<BackgroundReply>("quaver:background", { op: "info" }),
});

// 本地/NAS 曲库：原生选目录 + 在文件管理器中定位（reveal 只传曲目 id，路径在主进程从库现读）。
// 曲目的音频/封面/歌词本体走同源 /api/local/*，不经这里。
contextBridge.exposeInMainWorld("quaverLocal", {
  pickFolder: (purpose?: string) => ask<LocalReply>("quaver:local", { op: "pick-folder", purpose }),
  reveal: (id: string) => ask<BridgeReply>("quaver:local", { op: "reveal", id }),
});

// Sparkle 插件系统（第三方插件管理）：list/install/uninstall/market/pick-local/install-local
// 均由主进程执行，渲染层只拿结果。启用策略在渲染层：主题装完自动启用，普通插件默认关闭。
contextBridge.exposeInMainWorld("quaverSparkle", {
  list: () => ask<SparkleListReply>("quaver:sparkle", { op: "list" }),
  install: (msg: SparkleInstallRequest) =>
    ask<SparkleInstallReply>("quaver:sparkle", { op: "install", ...msg }),
  uninstall: (msg: { id: string }) =>
    ask<BridgeReply>("quaver:sparkle", { op: "uninstall", ...msg }),
  market: (msg: { url: string }) =>
    ask<SparkleMarketReply>("quaver:sparkle", { op: "market", ...msg }),
  pickLocal: () => ask<SparklePickReply>("quaver:sparkle", { op: "pick-local" }),
  installLocal: (msg: SparkleInstallLocalRequest) =>
    ask<SparkleInstallReply>("quaver:sparkle", { op: "install-local", ...msg }),
});

// 应用自更新（设置-通用）：检查/下载/安装编排见 src/lib/updater.ts。
// 进度为主进程主动推（quaver:update-progress，按整百分比节流）。
contextBridge.exposeInMainWorld("quaverUpdate", {
  invoke: (msg: UpdateRequest) => ask<UpdateReply>("quaver:update", msg),
  onProgress: (cb: (p: UpdateProgress) => void) =>
    ipcRenderer.on("quaver:update-progress", (_e: Electron.IpcRendererEvent, p: UpdateProgress) => {
      try { cb(p); } catch (err) { console.warn("update progress failed", err); }
    }),
  // 包管理器安装结束（deb/rpm/pacman/flatpak 在终端里跑完）：渲染层据此问是否退出应用
  onInstallDone: (cb: (p: UpdateInstallDone) => void) =>
    ipcRenderer.on("quaver:update-install-done", (_e: Electron.IpcRendererEvent, p: UpdateInstallDone) => {
      try { cb(p); } catch (err) { console.warn("update install-done failed", err); }
    }),
});

// 音频引擎（MPV 直出 / MPV 解码 + renderer 兼容输出）：invoke 走请求/应答，事件由主进程主动推。
// 渲染层 Transport 抽象（src/lib/transport.ts）据此实现 EngineTransport；
// 浏览器 dev（无 preload）下 window.quaverAudio 不存在 → 自动落到 <audio> WebTransport。
contextBridge.exposeInMainWorld("quaverAudio", {
  invoke: (cmd: AudioCommand) => ask<AudioReply>("quaver:audio", cmd),
  onEvent: (cb: (ev: AudioEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: AudioEvent) => {
      try { cb(ev); } catch (err) { console.warn("audio engine event failed", err); }
    };

    ipcRenderer.on("quaver:audio-event", listener);

    return () => { ipcRenderer.removeListener("quaver:audio-event", listener); };
  },
});
