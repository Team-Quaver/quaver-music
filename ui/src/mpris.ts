// Quaver — MPRIS 桥（渲染层发布/订阅）
// 职责：把 player 状态快照经 preload 桥推给 Electron 主进程（再由它喂给 mpris daemon），
// 并执行 daemon 回推的控制命令。仅 Electron 壳层生效（window.quaverMpris 存在）；
// 浏览器 / dev 模式下 startMprisBridge() 直接返回，零副作用。
//
// 节流：timeupdate 约 4Hz 已在触发 notify()，但位置由 daemon 端单调时钟外推，
// 所以渲染层只在「离散状态变化」（曲目/播放态/音量/循环/队列）时推送，外加 5s 一次的
// 低频心跳纠偏。播放中无需逐秒 IPC。
import { player } from "./player";
import { coverUrl, songTitle } from "./lib/api";

type MprisBridge = {
  send(state: unknown): void;
  onCommand(cb: (msg: { cmd: string; [k: string]: unknown }) => void): void;
};

declare global {
  interface Window {
    quaverMpris?: MprisBridge;
  }
}

const HEARTBEAT_MS = 5000;

function currentKey(): string {
  const c = player.current;
  return c ? String(c._key ?? c.mid) : "";
}

function snapshot(seeked = false) {
  const c = player.current;
  const status = player.playing ? "Playing" : player.current && player.time > 0 ? "Paused" : "Stopped";
  return {
    v: 1,
    t: "state",
    status,
    posUs: Math.floor((player.time || 0) * 1e6),
    volume: player.muted ? 0 : player.volume,
    loop: player.mode === "one" ? "Track" : player.mode === "all" ? "Playlist" : "None",
    shuffle: false, // Quaver 无随机播放：显式上报 false，总线 Shuffle 反映真实能力
    seeked,
    track: c
      ? {
          mid: c.mid,
          key: currentKey(),
          name: songTitle(c),
          artists: (c.singer ?? []).map((s) => s.name),
          album: (c.album as { name?: string } | undefined)?.name ?? "",
          artUrl: coverUrl(c, 300),
          durationSec: c.interval ?? player.duration ?? 0,
        }
      : null,
    queue: player.queue.slice(0, 200).map((s) => ({
      mid: s.mid,
      key: String(s._key ?? s.mid),
      name: songTitle(s),
      artists: (s.singer ?? []).map((x) => x.name),
      album: (s.album as { name?: string } | undefined)?.name ?? "",
      artUrl: coverUrl(s, 300),
      durationSec: s.interval ?? 0,
    })),
    can: {
      next: player.queue.length > 0,
      prev: player.queue.length > 0,
      play: !!player.current,
      pause: !!player.current,
      seek: !!player.current,
      control: !!player.current,
    },
  };
}

/** 离散状态指纹：只有它变化才推快照（位置交给 daemon 外推） */
function fingerprint(): string {
  const c = player.current;
  return [
    currentKey(),
    player.playing ? "1" : "0",
    player.mode,
    player.muted ? "m" : "u",
    Math.round(player.volume * 50), // 音量分 2% 粒度，避免拖滑块刷爆 IPC
    player.queue.length,
    player.queue.length ? String(player.queue[0]?._key ?? player.queue[0]?.mid) : "",
    c ? Math.floor((c.interval ?? player.duration) / 5) : "0", // 时长粗归一：Stopped→Paused 首次拿到 duration 时补推
  ].join("|");
}

let started = false;

export function startMprisBridge(): void {
  const bridge = window.quaverMpris;
  if (!bridge || started) return;
  started = true;

  let lastFp = "";
  const push = (seeked = false) => {
    try {
      bridge.send(snapshot(seeked));
    } catch (e) {
      console.warn("mpris push failed", e);
    }
  };

  // Seeked 信号：time 相邻两次间隔 >2s 视为位置突跳（拖动进度条/点击跳点）。
  // 缓冲卡顿不算：stall 时位置冻结，恢复后从原处继续，无跳变。
  let lastTime = player.time || 0;
  player.on(() => {
    const fp = fingerprint();
    const t = player.time || 0;
    const jumped = Math.abs(t - lastTime) > 2;
    lastTime = t;
    if (fp !== lastFp || jumped) {
      lastFp = fp;
      push(jumped);
    }
  });

  // 低频心跳：纠偏 daemon 外推漂移（缓冲卡顿、时钟跳变）
  setInterval(() => push(false), HEARTBEAT_MS);

  bridge.onCommand((msg) => {
    switch (msg.cmd) {
      case "play":
        if (player.paused) player.resume(); // 复用错误重试/起播语义
        break;
      case "pause":
        if (!player.paused) player.pause();
        break;
      case "playpause":
        player.toggle();
        break;
      case "stop":
        player.pause();
        player.seek(0);
        player.notifyPublic();
        break;
      case "next":
        player.next();
        break;
      case "prev":
        player.prev();
        break;
      case "volume": {
        const v = Number(msg.value);
        if (isFinite(v)) player.setVolume(v);
        break;
      }
      case "setLoop": {
        const want = msg.loop;
        const target = want === "Track" ? "one" : want === "Playlist" ? "all" : "off";
        for (let i = 0; i < 3 && player.mode !== target; i++) player.cycleMode(); // 无 setter，靠循环推进
        break;
      }
      case "setShuffle":
        break; // 无随机播放：忽略（daemon 端已上报 shuffle=false）
      case "seek": {
        const delta = Number(msg.deltaUs) / 1e6;
        if (isFinite(delta)) player.seek(player.time + delta);
        break;
      }
      case "seekTo": {
        const pos = Number(msg.posSec);
        const tid = String(msg.trackId ?? "");
        // 仅当目标 trackid 对应当前曲目才跳转（mpris 语义）
        if (isFinite(pos) && (!tid || tid === trackPathOf(currentKey()))) player.seek(pos);
        break;
      }
      case "jump": {
        const tid = String(msg.trackId ?? "");
        const i = player.queue.findIndex((s) => trackPathOf(String(s._key ?? s.mid)) === tid);
        if (i >= 0) player.jump(i);
        break;
      }
      case "openUri":
        break; // 无 quaver:// 深链协议，忽略
      default:
        break;
    }
  });

  // 首次快照（握手）
  lastFp = fingerprint();
  push(false);
}

/** 与 daemon 端 trackPath 同规则（vendor/Typhoeus/mpris/src/types.ts） */
function trackPathOf(key: string): string {
  const safe = (key || "unknown").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "unknown";
  return `/org/quaver/track/${safe}`;
}
