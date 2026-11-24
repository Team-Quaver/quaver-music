// Quaver — preload 桥的线契约（类型面）。
//
// preload 只做搬运：渲染层 ↔ 主进程之间的每条通道都在这儿落一份形状，preload 用它们
// 标注回调参数，渲染层用同一份声明消费结果。零运行时依赖（纯类型 + 少量常量），
// `.cts` 里 `import type` 会被 Node 的类型剥离原样抹掉，不改变 preload 的 CJS 语义。
import type { DlControlMsg } from "./dl-wire.ts";
import type { EqState } from "./audio/eq-config.ts";
import type { JsonValue } from "../src/lib/json-value.ts";

/** 单条热键注册失败/未绑定的信息（让渲染层提示哪条键没生效）。 */
export interface HotkeyFailure {
  action: string;
  accel?: string;
  why?: string;
  label?: string;
}

/** 全局热键桥下发的负载（`quaver:hotkey`）。 */
export type HotkeyEvent =
  | { t: "action"; action: string }
  | { t: "failed"; items: HotkeyFailure[] }
  | { t: "partial"; items: HotkeyFailure[]; wayland: boolean }
  | { t: "status"; state: string; reason?: string; missing?: string[] };

/** 全局热键桥的同步/异步探测结果（`quaver:hotkeys-info[-sync]`）。 */
export interface HotkeyInfo {
  wayland: boolean;
  portal: boolean;
  state: string;
  reason?: string;
  missing?: string[];
  bindings?: Record<string, string>;
}

/** 配置桥（`quaver:config`）的应答：`all` 带整表，`set/reset` 只带结果。 */
export interface ConfigAllReply {
  ok: boolean;
  dir?: string;
  path?: string;
  values?: Record<string, string>;
  writable?: boolean;
  crotchet?: boolean;
  redflag?: boolean;
  error?: string;
}

export interface ConfigWriteReply {
  ok: boolean;
  written?: string[];
  warnings?: string[];
  error?: string;
  /** 音乐缓存位置变更后的现状（只有换缓存目录那一分支会带）。 */
  cache?: { ok: boolean; dir?: string; items?: number; bytes?: number; error?: string } | null;
  /** 重置配置后主进程回读的整表（reset 分支）。 */
  values?: Readonly<Record<string, string>>;
}

/** 配置增量广播（`quaver:config-changed`）：增量给 keys/values，重置给 all=true。 */
export type ConfigChangedPayload =
  | { keys: string[]; values: Record<string, string> }
  | { all: true };

/** 调试桥（设置 → 通用 → 调试）：开发者控制台开关应答。 */
export interface DebugReply {
  ok: boolean;
  error?: string;
  open?: boolean;
}

/** 进程/内存自检：Chromium 进程（app.getAppMetrics 投影）。 */
export interface DebugProcessRow {
  pid: number;
  type: string;
  tag: string;
  rssKB: number;
  peakKB: number;
  /** Linux = Pss，win32 = privateBytes，读不到的平台为 null。 */
  privKB: number | null;
  /** 自上次采样以来的 CPU 均值；首次采样为 0。 */
  cpu: number;
}

/** 进程/内存自检：外部子进程（sidecar / mpv / 看门狗）。 */
export interface DebugExternalRow {
  pid: number;
  tag: string;
  rssKB: number | null;
  privKB: number | null;
}

/** 进程/内存自检应答（主进程一次拍平所有事实源，渲染层只负责摆出来）。 */
export interface DebugMetricsReply {
  ok: boolean;
  error?: string;
  app: {
    version: string;
    packaged: boolean;
    platform: string;
    arch: string;
    electron: string;
    chrome: string;
    node: string;
    configDir: string;
  };
  main: {
    pid: number;
    rssKB: number;
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    uptimeSec: number;
  };
  windows: { mainPid: number; dlPid: number };
  procs: DebugProcessRow[];
  external: DebugExternalRow[];
  totals: {
    chromiumRSSKB: number;
    externalRSSKB: number;
    privKB: number;
    privKnown: boolean;
    count: number;
  };
}

/** 通用「主进程执行结果」：各桥的失败面统一成 ok/error 两键。 */
export interface BridgeReply {
  ok: boolean;
  error?: string;
}

/** 配置桥请求（`quaver:config`）。 */
export type ConfigRequest =
  | { op: "all" }
  | { op: "set"; patch: Record<string, string>; apply?: boolean }
  | { op: "reset" }
  | { op: "reveal" };

/** 背景图桥请求（`quaver:background`）。 */
export type BackgroundRequest = { op: "pick" } | { op: "info" };

/** 本地曲库桥请求（`quaver:local`）。 */
export type LocalRequest =
  | { op: "pick-folder"; purpose?: string }
  | { op: "reveal"; id: string };

/** Sparkle 桥请求（`quaver:sparkle`）。 */
export type SparkleRequest =
  | { op: "list" }
  | ({ op: "install" } & SparkleInstallRequest)
  | { op: "uninstall"; id: string }
  | { op: "market"; url: string }
  | { op: "pick-local" }
  | ({ op: "install-local" } & SparkleInstallLocalRequest);

/** 调试桥请求（`quaver:devtools`）。 */
export type DebugRequest =
  | { op: "toggle" }
  | { op: "open" }
  | { op: "close" }
  | { op: "state" };

/** preload 能交给 `invoke` 的负载：标量或上面列出的命名请求。 */
export type IpcPayload =
  | string
  | number
  | boolean
  | ConfigRequest
  | BackgroundRequest
  | LocalRequest
  | SparkleRequest
  | DebugRequest
  | UpdateRequest
  | DlControlMsg
  | AudioCommand;

/** Sparkle 插件 manifest 只做透传：主进程读盘原样下发，渲染层自己按字段取用。 */
export type PluginManifest = Readonly<Record<string, string | boolean | undefined>>;

/** 音乐缓存位置（`quaver:config` 的 music-cache-dir 分支）。 */
export interface MusicCacheReply extends BridgeReply {
  dir?: string;
  items?: number;
  bytes?: number;
}

/** 自定义背景图桥（`quaver:background`）。 */
export interface BackgroundReply extends BridgeReply {
  canceled?: boolean;
  path?: string;
  exists?: boolean;
}

/** 本地/NAS 曲库桥（`quaver:local`）。 */
export interface LocalReply extends BridgeReply {
  canceled?: boolean;
  path?: string;
}

/** Sparkle 插件管理桥（`quaver:sparkle`）的各分支应答。 */
export interface SparkleListReply extends BridgeReply {
  plugins?: Array<{ id: string; dir: string; manifest: PluginManifest; installedAt: number }>;
}

export interface SparkleInstallReply extends BridgeReply {
  id?: string;
}

export interface SparklePickReply extends BridgeReply {
  canceled?: boolean;
  name?: string;
  dataBase64?: string;
}

export interface SparkleMarketReply extends BridgeReply {
  index?: { plugins?: Array<PluginManifest & { id: string; name: string; version: string; download: string }> };
}

/** Sparkle 安装请求（下载 + 校验 + 落盘）。 */
export interface SparkleInstallRequest {
  url: string;
  sha256?: string;
  meta?: PluginManifest;
}

/** Sparkle 本地安装请求（渲染层校验过形状后回传本体）。 */
export interface SparkleInstallLocalRequest {
  dataBase64: string;
  meta?: PluginManifest;
}

/** 凭证存储状态（`quaver:credential-info`，只读、不含凭证本体）。 */
export interface CredentialInfoReply extends BridgeReply {
  backend?: string;
  path?: string;
  exists?: boolean;
}

/** 自更新进度（`quaver:update-progress`）。 */
export interface UpdateProgress {
  id: string;
  received: number;
  total: number;
}

/** 自更新安装结束（`quaver:update-install-done`）。 */
export interface UpdateInstallDone {
  id: string;
  ok: boolean;
  completed: boolean;
  removed: boolean;
  error: string;
}

/** 自更新请求（`quaver:update`）：op 决定其余字段。 */
export type UpdateRequest =
  | { op: "platform" }
  | { op: "fetch-release"; channel: "stable" | "beta" | "nightly" }
  | { op: "download"; id: string; url: string; mode: "replace-appimage" | "downloads" | "installer"; sha256?: string }
  | { op: "cancel-download"; id: string }
  | { op: "apply-appimage"; path: string }
  | { op: "install-windows"; path: string }
  | { op: "install-linux-package"; id: string; kind: "deb" | "rpm" | "pacman" | "flatpak"; path: string }
  | { op: "open-path"; path: string }
  | { op: "open-releases"; channel: "stable" | "beta" | "nightly" }
  | { op: "relaunch" }
  | { op: "quit" };

/** 自更新应答：检查/下载/安装各分支的可选字段合集。 */
export interface UpdateReply {
  ok: boolean;
  error?: string;
  platform?: string;
  releases?: ReadonlyArray<{ tag_name?: string; name?: string; body?: string; prerelease?: boolean; assets?: ReadonlyArray<{ name: string; browser_download_url: string; size?: number }> }>;
  version?: string;
  url?: string;
  path?: string;
  /** 下载去重命中（磁盘上已有同 sha256 的包）。 */
  deduped?: boolean;
  /** AppImage 原位替换时发现当前文件已是目标版本。 */
  alreadyReplaced?: boolean;
  /** 包管理器命令（手动执行兜底 / 已起终端时的展示）。 */
  command?: string;
  /** 单条 release（fetch-release 分支）。 */
  release?: { tag?: string; name?: string; body?: string; prerelease?: boolean; assets?: ReadonlyArray<{ name: string; browser_download_url: string; size?: number; sha256?: string }> };
  /** 平台档案（platform 分支）。 */
  arch?: string;
  appimage?: string | null;
  pkg?: string | null;
  store?: string | null;
  packaged?: boolean;
}

/** 音频引擎命令（`quaver:audio`）：主进程按 cmd 分派，参数随命令走。 */
export type AudioCommand =
  | { cmd: "status" }
  | { cmd: "backend"; value: string }
  | { cmd: "mode"; mode: string }
  | { cmd: "pcm-ready" }
  | { cmd: "snapshot" }
  | { cmd: "load"; url: string; paused?: boolean; startAt?: number; epoch?: number; client?: string; mime?: string; tier?: string }
  | { cmd: "play" }
  | { cmd: "pause" }
  | { cmd: "stop" }
  | { cmd: "seek"; sec: number; epoch?: number; immediate?: boolean }
  | { cmd: "volume"; value: number }
  | { cmd: "mute"; value: boolean }
  | { cmd: "fade"; inMs: number; outMs: number }
  | { cmd: "eq"; state: EqState }
  | { cmd: "devices" }
  | { cmd: "device"; id: string }
  | { cmd: "pcm-progress"; pos: number; queued: number }
  | { cmd: "pcm-ended"; epoch: number; pos: number }
  | { cmd: "boot"; backend?: string };

/** 音频引擎应答：成功/失败都走同一张可选字段表。 */
export interface AudioReply {
  ok: boolean;
  error?: string;
  backend?: string;
  mode?: string;
  available?: boolean;
  reason?: string;
  source?: string;
  payload?: JsonValue;
  version?: string;
  running?: boolean;
  device?: string;
  current?: string;
  /** 运行时切换后端时的补充说明（例如目标后端不可用、已保留旧后端）。 */
  note?: string;
  /** 音频引擎事件转发（`quaver:audio-event`）的负载形状：事件名 + 各分支字段。 */
  ev?: string;
}

/** 音频引擎主动事件（`quaver:audio-event`）：t 是事件种类，其余字段按分支各取。 */
export interface AudioEvent {
  t: "state" | "loaded" | "ended" | "error" | "pcm" | "pcm-progress" | "pcm-ended" | "start-file" | "file-loaded" | "end-file";
  pos?: number;
  dur?: number;
  paused?: boolean;
  buffering?: boolean;
  idle?: boolean;
  epoch?: number;
  message?: string;
  data?: Uint8Array;
}
