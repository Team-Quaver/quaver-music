// Quaver — Linux MPRIS 2.0 服务（主进程内，不是子进程）。
//
// 这里只负责把渲染层的播放器快照投影成 D-Bus 接口，并把总线侧控制动作原样交回
// 主进程。播放器仍然是唯一事实源：本模块不缓存队列、不执行播放、不碰 UI。
//
// 位置模型沿用原守护进程：快照带 posUs 基准，主进程用 monotonic 时钟外推；Playing
// 时客户端轮询 Position 就能得到平滑值，不必每秒跨 IPC 推一次进度。
//
// mpris-service@2.1.2 没有类型声明，所以运行时 require + 最小接口。把它放进主进程
// 的直接收益：不需要额外 Node 子进程、不需要 esbuild 产物、不会因为漏跑 mpris:build
// 让整个 Linux 系统集成静默消失。Windows/macOS 仍由渲染层 navigator.mediaSession
// 直驱（见 src/mpris.ts），本模块在这两个平台直接返回 null。
import { createRequire } from "node:module";
import { isJsonArray, isJsonObject, jsonBoolean, jsonNumber, jsonString, type JsonValue } from "../src/lib/json-value.ts";

const requireFromHere = createRequire(import.meta.url);

export type MprisStatus = "Playing" | "Paused" | "Stopped";

export type MprisLoop = "None" | "Track" | "Playlist";

export interface MprisTrack {
  mid: string;
  key: string;
  name: string;
  artists: string[];
  album: string;
  artUrl: string;
  durationSec: number;
  /** 当前歌词的纯文本行（MPRIS 扩展元数据 `xesam:asText`）；无歌词时缺省。 */
  asText?: string;
}

export interface MprisState {
  v: 1;
  t: "state";
  status: MprisStatus;
  posUs: number;
  volume: number;
  loop: MprisLoop;
  shuffle: boolean;
  seeked?: boolean;
  track: MprisTrack | null;
  queue: MprisTrack[];
  can: {
    next: boolean;
    prev: boolean;
    play: boolean;
    pause: boolean;
    seek: boolean;
    control: boolean;
  };
}

export type MprisCommand =
  | { v: 1; t: "cmd"; cmd: "play" | "pause" | "playpause" | "stop" | "next" | "prev" | "raise" | "quit" }
  | { v: 1; t: "cmd"; cmd: "volume"; value: number }
  | { v: 1; t: "cmd"; cmd: "setLoop"; loop: MprisLoop }
  | { v: 1; t: "cmd"; cmd: "setShuffle"; on: boolean }
  | { v: 1; t: "cmd"; cmd: "seek"; deltaUs: number }
  | { v: 1; t: "cmd"; cmd: "seekTo"; posSec: number; trackId?: string }
  | { v: 1; t: "cmd"; cmd: "jump"; trackId: string }
  | { v: 1; t: "cmd"; cmd: "openUri"; uri: string };

export interface MprisPlayerInstance {
  /** mpris-service 的事件回调：参数是总线侧的原始值（字符串/数字/对象），按事件各自解析。 */
  on(event: string, cb: (...args: (JsonValue | undefined)[]) => void): void;
  metadata: Partial<MprisMetadata>;
  playbackStatus: string;
  loopStatus: string;
  shuffle: boolean;
  volume: number;
  canGoNext: boolean;
  canGoPrevious: boolean;
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
  canControl: boolean;
  hasTrackList: boolean;
  tracks?: MprisMetadata[];
  getPosition(): number;
  seeked(posUs: number): void;
  objectPath(sub: string): string;
  _bus?: MprisBus;
}

/** dbus-next 的 MessageBus 只用到这两个口子；send 是库里出错时最后会走到的路径。 */
interface MprisBusMessage {
  serial?: number | null;
  _sent?: boolean;
}

interface MprisBus {
  disconnect?(): void;
  send?(msg: MprisBusMessage): void;
}

export interface MprisPlayerFactory {
  (opts: MprisPlayerOptions): MprisPlayerInstance;
}

/** mpris-service 的构造参数：只列本模块真正传的那几项。 */
export interface MprisPlayerOptions {
  name: string;
  identity: string;
  desktopEntry: string;
  supportedUriSchemes: string[];
  supportedMimeTypes: string[];
  supportedInterfaces: string[];
}

export interface MprisBridge {
  applyState(state: JsonValue): void;
  destroy(): void;
}

export interface MprisBridgeOptions {
  onCommand: (msg: MprisCommand) => void;
  /** 总线已经不可救（连接关闭 / EPIPE）时回调；主进程据此销毁并择机重建。 */
  onFatal?: (reason: string) => void;
  log?: (...parts: unknown[]) => void;
  platform?: NodeJS.Platform;
  factory?: MprisPlayerFactory;
  nowMs?: () => number;
}

const PROTOCOL_VERSION = 1;
const BUS_NAME = "quaver";
const IDENTITY = "Quaver Music";
const DESKTOP_ENTRY = process.env.FLATPAK_ID || "red.0w0.quaver";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const NO_TRACK_PATH = "/org/mpris/MediaPlayer2/TrackList/NoTrack";

/** D-Bus Metadata：只放本应用真的会写的键（MPRIS 规范的 mpris:/xesam: 两组）。 */
interface MprisMetadata {
  "mpris:trackid": string;
  "mpris:length"?: number;
  "xesam:title": string;
  "xesam:artist": string[];
  "xesam:album"?: string;
  "mpris:artUrl"?: string;
  "xesam:asText"?: string;
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.max(0, Math.min(1, value));
}

function errorText(error: Error | string | null | undefined): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/** dbus-next 在 socket 已关闭、但 `end` 事件还没落地时会直接 throw。 */
function isClosedBusError(error: Error | string | null | undefined): boolean {
  return /cannot send message, stream is closed|tried to write a message to a closed stream|write (?:epipe|after end)|econnreset|enotconn/i.test(errorText(error));
}

function normalizeLoop(value: string, fallback: MprisLoop): MprisLoop {
  return value === "Track" || value === "Playlist" || value === "None" ? value : fallback;
}

function isMprisStatus(value: JsonValue | undefined): value is MprisStatus {
  return value === "Playing" || value === "Paused" || value === "Stopped";
}

function isMprisLoop(value: JsonValue | undefined): value is MprisLoop {
  return value === "None" || value === "Track" || value === "Playlist";
}

/** 队列项 / 当前曲目：只取本应用自己投影的那几个字段。 */
function parseTrack(value: JsonValue | undefined): MprisTrack | null {
  if (!isJsonObject(value)) return null;

  const artists = isJsonArray(value.artists)
    ? value.artists.flatMap((artist) => (Object.prototype.toString.call(artist) === "[object String]" ? [String(artist)] : []))
    : [];

  return {
    mid: jsonString(value.mid),
    key: jsonString(value.key),
    name: jsonString(value.name),
    artists,
    album: jsonString(value.album),
    artUrl: jsonString(value.artUrl),
    durationSec: jsonNumber(value.durationSec),
    asText: jsonString(value.asText),
  };
}

/**
 * 渲染层快照（quaver:mpris IPC）→ 领域状态。
 * 版本/状态/循环档不合法或队列缺失时返回 null（调用方按「不兼容快照」丢弃）。
 */
function parseMprisState(raw: JsonValue): MprisState | null {
  if (!isJsonObject(raw)) return null;

  if (raw.t !== "state" || jsonNumber(raw.v) !== PROTOCOL_VERSION) return null;

  if (!isJsonObject(raw.can) || !isJsonArray(raw.queue)) return null;

  if (!isMprisStatus(raw.status) || !isMprisLoop(raw.loop)) return null;

  const can = raw.can;

  return {
    v: PROTOCOL_VERSION,
    t: "state",
    status: raw.status,
    posUs: jsonNumber(raw.posUs),
    volume: jsonNumber(raw.volume),
    loop: raw.loop,
    shuffle: jsonBoolean(raw.shuffle),
    seeked: jsonBoolean(raw.seeked),
    track: parseTrack(raw.track),
    queue: raw.queue.flatMap((track) => {
      const parsed = parseTrack(track);

      return parsed === null ? [] : [parsed];
    }),
    can: {
      next: jsonBoolean(can.next),
      prev: jsonBoolean(can.prev),
      play: jsonBoolean(can.play),
      pause: jsonBoolean(can.pause),
      seek: jsonBoolean(can.seek),
      control: jsonBoolean(can.control),
    },
  };
}

/** mpris:trackid 对象路径：/org/quaver/track/<key 安全化>。 */
export function trackPath(track: { key?: string; mid?: string }): string {
  const raw = track.key || track.mid || "unknown";
  const safe = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "unknown";

  return `/org/quaver/track/${safe}`;
}

/** 快照位置 + 单调时钟外推；playing=false 时停在基准位置。 */
export function extrapolatePositionUs(
  baseUs: number,
  elapsedMs: number,
  playing: boolean,
  durationUs: number,
): number {
  let pos = Math.max(0, Number.isFinite(baseUs) ? baseUs : 0);

  if (playing && Number.isFinite(elapsedMs) && elapsedMs > 0) pos += elapsedMs * 1000;

  if (durationUs > 0) pos = Math.min(pos, durationUs);

  return Math.max(0, Math.floor(pos));
}

function trackMetadata(track: MprisTrack, durationUs?: number): MprisMetadata {
  const metadata: MprisMetadata = {
    "mpris:trackid": trackPath(track),
    "xesam:title": track.name || "未知歌曲",
    "xesam:artist": track.artists.length ? track.artists : ["未知歌手"],
  };

  const lengthUs = Math.floor((track.durationSec || 0) * 1e6);

  if (lengthUs > 0) metadata["mpris:length"] = lengthUs;
  else if (durationUs && durationUs > 0) metadata["mpris:length"] = durationUs;

  if (track.album) metadata["xesam:album"] = track.album;

  if (track.artUrl) metadata["mpris:artUrl"] = track.artUrl;

  // 扩展元数据：Dank Material Shell / Noctalia 的媒体控件会读这份纯文本歌词。
  // 只有当前曲目会带（队列项没有歌词），空串不上总线。
  if (track.asText) metadata["xesam:asText"] = track.asText;

  return metadata;
}

function loadFactory(): MprisPlayerFactory {
  // SAFETY: mpris-service 无类型声明，但 factory 的调用形状就是本文件 MprisPlayerOptions 那几项
  // （见 node_modules/mpris-service 的构造实现），返回实例由 MprisPlayerInstance 约束其使用面。
  return requireFromHere("mpris-service") as MprisPlayerFactory;
}

/** 创建 Linux MPRIS 服务；非 Linux / 无会话总线依赖时返回 null，不阻断应用启动。 */
export function createMprisBridge({
  onCommand,
  onFatal,
  log = () => {},
  platform = process.platform,
  factory,
  nowMs = monotonicMs,
}: MprisBridgeOptions): MprisBridge | null {
  if (platform !== "linux") return null;

  let player: MprisPlayerInstance;

  try {
    const makePlayer = factory ?? loadFactory();
    player = makePlayer({
      name: BUS_NAME,
      identity: IDENTITY,
      desktopEntry: DESKTOP_ENTRY,
      supportedUriSchemes: ["https", "http"],
      supportedMimeTypes: ["audio/mpeg", "audio/flac", "audio/ogg", "audio/x-flac"],
      supportedInterfaces: ["player", "trackList"],
    });
  } catch (e) {
    log("[mpris] service init failed（在 ui/ 跑 pnpm install）:", String(e));

    return null;
  }

  let failed = false;

  const fail = (error: Error | string | null | undefined): void => {
    if (failed) return;
    failed = true;
    const reason = errorText(error);
    log("[mpris] bus closed:", reason);
    queueMicrotask(() => onFatal?.(reason));
  };

  // dbus-next 0.9.2 的 MessageBus 在收到消息时用 try/catch 兜业务异常，兜底分支
  // 又直接 `this.send(Error)`：如果此刻 socket 已不可写，这个二次发送会从库内部抛
  // 「Cannot send message, stream is closed」，把 Electron 主进程一起带走。
  // 这里只包住这一条发送路径；其它异常照旧抛出，不掩盖真正的协议错误。
  const bus = player._bus;

  if (bus?.send instanceof Function) {
    try {
      const send = bus.send.bind(bus);

      bus.send = (msg: MprisBusMessage): void => {
        if (failed) return;

        try {
          send(msg);
        } catch (e) {
          const text = errorText(e instanceof Error ? e : String(e));

          if (!isClosedBusError(text)) throw e;
          fail(text);
        }
      };
    } catch (e) {
      log("[mpris] bus send guard unavailable:", errorText(e instanceof Error ? e : String(e)));
    }
  }

  player.on("error", (e) => {
    // 无会话总线（headless / SSH 无 DBUS_SESSION_BUS_ADDRESS）不是致命错误：
    // 应用继续可用，只是系统媒体控件缺席。
    const text = errorText(e instanceof Error ? e : String(e));
    log("[mpris] dbus error:", text);

    if (isClosedBusError(text)) fail(text);
  });

  player.canControl = true;
  // mpris-service 建 trackList 接口时没有同步 root.HasTrackList（库疏漏）。
  player.hasTrackList = true;

  let lastStatus: MprisStatus | "" = "";
  let lastLoop: MprisLoop | "" = "";
  let lastShuffle: boolean | null = null;
  let lastVolume = -1;
  let lastCanSig = "";
  let lastTrackKey = "";
  let lastLyricText = "";
  let lastQueueSig = "";

  let baseUs = 0;
  let baseStampMs = nowMs();
  let playing = false;
  let durationUs = 0;

  player.getPosition = () => extrapolatePositionUs(baseUs, nowMs() - baseStampMs, playing, durationUs);

  const emit = (msg: MprisCommand): void => {
    try {
      onCommand(msg);
    } catch (e) {
      log("[mpris] command callback failed:", String(e));
    }
  };

  player.on("play", () => emit({ v: 1, t: "cmd", cmd: "play" }));
  player.on("pause", () => emit({ v: 1, t: "cmd", cmd: "pause" }));
  player.on("playpause", () => emit({ v: 1, t: "cmd", cmd: "playpause" }));
  player.on("stop", () => emit({ v: 1, t: "cmd", cmd: "stop" }));
  player.on("next", () => emit({ v: 1, t: "cmd", cmd: "next" }));
  player.on("previous", () => emit({ v: 1, t: "cmd", cmd: "prev" }));
  player.on("raise", () => emit({ v: 1, t: "cmd", cmd: "raise" }));
  player.on("quit", () => emit({ v: 1, t: "cmd", cmd: "quit" }));
  player.on("volume", (value) => emit({ v: 1, t: "cmd", cmd: "volume", value: clamp01(Number(value)) }));
  player.on("loopStatus", (value) => {
    emit({ v: 1, t: "cmd", cmd: "setLoop", loop: normalizeLoop(String(value), lastLoop || "None") });
  });
  player.on("shuffle", (on) => emit({ v: 1, t: "cmd", cmd: "setShuffle", on: !!on }));
  player.on("seek", (offsetUs) => {
    const delta = Number(offsetUs);
    emit({ v: 1, t: "cmd", cmd: "seek", deltaUs: Number.isFinite(delta) ? Math.floor(delta) : 0 });
  });
  player.on("position", (event) => {
    const payload = isJsonObject(event) ? event : {};
    const posUs = jsonNumber(payload.position);
    emit({
      v: 1,
      t: "cmd",
      cmd: "seekTo",
      posSec: Number.isFinite(posUs) ? Math.floor(posUs) / 1e6 : 0,
      trackId: jsonString(payload.trackId),
    });
  });
  player.on("open", (event) => {
    emit({ v: 1, t: "cmd", cmd: "openUri", uri: jsonString(isJsonObject(event) ? event.uri : undefined) });
  });
  player.on("goTo", (trackId) => emit({ v: 1, t: "cmd", cmd: "jump", trackId: String(trackId ?? "") }));

  const applyStateUnsafe = (raw: JsonValue): void => {
    const state = parseMprisState(raw);

    if (state === null) return;

    playing = state.status === "Playing";
    baseUs = Math.max(0, Math.floor(Number(state.posUs) || 0));
    baseStampMs = nowMs();
    durationUs = Math.floor((state.track?.durationSec || 0) * 1e6);

    if (state.status !== lastStatus) {
      lastStatus = state.status;
      player.playbackStatus = state.status;
    }

    if (state.loop !== lastLoop) {
      lastLoop = state.loop;
      player.loopStatus = state.loop;
    }

    if (state.shuffle !== lastShuffle) {
      lastShuffle = !!state.shuffle;
      player.shuffle = !!state.shuffle;
    }

    const volume = clamp01(Number(state.volume));

    if (Math.abs(volume - lastVolume) > 0.004) {
      lastVolume = volume;
      player.volume = volume;
    }

    const canSig = `${state.can.next}|${state.can.prev}|${state.can.play}|${state.can.pause}|${state.can.seek}|${state.can.control}`;

    if (canSig !== lastCanSig) {
      lastCanSig = canSig;
      player.canGoNext = !!state.can.next;
      player.canGoPrevious = !!state.can.prev;
      player.canPlay = !!state.can.play;
      player.canPause = !!state.can.pause;
      player.canSeek = !!state.can.seek;
      player.canControl = !!state.can.control;
    }

    const trackKey = state.track ? trackPath(state.track) : "";
    // 歌词是异步到的，曲目不变时也要更新 Metadata —— 不能只按 trackid 去重，
    // 否则 asText 永远停在上一次换曲时的空值（心跳快照也救不回来）。
    const lyricText = state.track?.asText ?? "";

    if (trackKey !== lastTrackKey || lyricText !== lastLyricText) {
      lastTrackKey = trackKey;
      lastLyricText = lyricText;
      player.metadata = state.track
        ? trackMetadata(state.track, durationUs)
        : { "mpris:trackid": NO_TRACK_PATH };
    }

    const queueSig = state.queue.map((track) => trackPath(track)).join(",") + "#" + trackKey;

    if (queueSig !== lastQueueSig) {
      lastQueueSig = queueSig;

      try {
        player.tracks = state.queue.map((track) => trackMetadata(track));
      } catch (e) {
        log("[mpris] tracklist update failed:", String(e));
      }
    }

    if (state.seeked) {
      try {
        player.seeked(baseUs);
      } catch (e) {
        log("[mpris] seeked signal failed:", String(e));
      }
    }
  };

  const applyState = (raw: JsonValue): void => {
    if (failed) return;

    try {
      applyStateUnsafe(raw);
    } catch (e) {
      const text = errorText(e instanceof Error ? e : String(e));

      if (isClosedBusError(text)) fail(text);
      else log("[mpris] state projection failed:", text);
    }
  };

  log("[mpris] service initialized on", MPRIS_PATH);

  return {
    applyState,
    destroy() {
      failed = true;

      try { player._bus?.disconnect?.(); } catch (e) { log("[mpris] disconnect failed:", String(e)); }
    },
  };
}
