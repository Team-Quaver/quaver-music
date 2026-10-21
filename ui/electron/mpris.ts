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
  on(event: string, cb: (...args: unknown[]) => void): void;
  metadata: Record<string, unknown>;
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
  tracks?: Record<string, unknown>[];
  getPosition(): number;
  seeked(posUs: number): void;
  objectPath(sub: string): string;
  _bus?: { disconnect?(): void };
}

export interface MprisPlayerFactory {
  (opts: Record<string, unknown>): MprisPlayerInstance;
}

export interface MprisBridge {
  applyState(state: unknown): void;
  destroy(): void;
}

export interface MprisBridgeOptions {
  onCommand: (msg: MprisCommand) => void;
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

type MprisMetadata = Record<string, unknown>;

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeLoop(value: string, fallback: MprisLoop): MprisLoop {
  return value === "Track" || value === "Playlist" || value === "None" ? value : fallback;
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
  return metadata;
}

function loadFactory(): MprisPlayerFactory {
  return requireFromHere("mpris-service") as MprisPlayerFactory;
}

/** 创建 Linux MPRIS 服务；非 Linux / 无会话总线依赖时返回 null，不阻断应用启动。 */
export function createMprisBridge({
  onCommand,
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

  player.on("error", (e) => {
    // 无会话总线（headless / SSH 无 DBUS_SESSION_BUS_ADDRESS）不是致命错误：
    // 应用继续可用，只是系统媒体控件缺席。
    log("[mpris] dbus error:", String((e as Error)?.message ?? e));
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
    const e = event as { trackId?: unknown; position?: unknown };
    const posUs = Number(e.position);
    emit({
      v: 1,
      t: "cmd",
      cmd: "seekTo",
      posSec: Number.isFinite(posUs) ? Math.floor(posUs) / 1e6 : 0,
      trackId: String(e.trackId ?? ""),
    });
  });
  player.on("open", (event) => {
    const e = event as { uri?: unknown };
    emit({ v: 1, t: "cmd", cmd: "openUri", uri: String(e.uri ?? "") });
  });
  player.on("goTo", (trackId) => emit({ v: 1, t: "cmd", cmd: "jump", trackId: String(trackId ?? "") }));

  const applyState = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const state = raw as Partial<MprisState>;
    if (state.t !== "state" || state.v !== PROTOCOL_VERSION) {
      log("[mpris] ignored incompatible state:", String(state.v ?? "?"));
      return;
    }
    if (!state.can || !Array.isArray(state.queue)) {
      log("[mpris] ignored incomplete state");
      return;
    }
    if (state.status !== "Playing" && state.status !== "Paused" && state.status !== "Stopped") {
      log("[mpris] ignored invalid status:", String(state.status));
      return;
    }
    if (state.loop !== "None" && state.loop !== "Track" && state.loop !== "Playlist") {
      log("[mpris] ignored invalid loop:", String(state.loop));
      return;
    }

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
    if (trackKey !== lastTrackKey) {
      lastTrackKey = trackKey;
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

  log("[mpris] service initialized on", MPRIS_PATH);
  return {
    applyState,
    destroy() {
      try { player._bus?.disconnect?.(); } catch (e) { log("[mpris] disconnect failed:", String(e)); }
    },
  };
}
