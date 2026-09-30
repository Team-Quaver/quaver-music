// Quaver — 系统媒体控件桥（渲染层发布/订阅）
// Linux：把 player 状态快照经 preload 桥推给 Electron 主进程（再由它喂给 mpris daemon），
//        并执行 daemon 回推的控制命令。
// win/mac：同一份快照直驱 navigator.mediaSession —— Chromium 内置了 MediaSession 到平台
//        控件的对接（Windows = SMTC，macOS = MPNowPlayingInfoCenter + MPRemoteCommandCenter），
//        纯 TS 零原生代码；命令经 action handler 直接调 player，不经 IPC。
// 仅 Electron 壳层生效（window.quaverMpris 存在）；浏览器 / dev 模式下 startMprisBridge()
// 直接返回，零副作用。
//
// 节流：timeupdate 约 4Hz 已在触发 notify()，但位置由 daemon 端单调时钟外推，
// 所以渲染层只在「离散状态变化」（曲目/播放态/音量/循环/队列）时推送，外加 5s 一次的
// 低频心跳纠偏。播放中无需逐秒 IPC。
// 能力边界（win/mac 相对 Linux MPRIS）：SMTC / Now Playing 标准按钮只有
// play/pause/prev/next/seekto —— 循环/随机/音量系统侧不暴露，纯 TS 方案做不了，
// 与桌面内功能不一致处由播放页自行承担。
import { player } from "./player";
import { coverUrl, songTitle } from "./lib/api";
import { initFakeAudio } from "./fake-audio";

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

/** Windows SMTC / macOS Now Playing：navigator.mediaSession 直驱（仅 win/mac Electron 壳层）。
 *  Linux 上主进程已关掉 MediaSessionService（防与 mpris daemon 抢总线），这里也不接管；
 *  浏览器 dev 模式不接管，避免 dev 页面抢系统媒体控件。返回值把快照喂给平台控件。 */
function makeMediaSessionPush(): ((s: ReturnType<typeof snapshot>) => void) | null {
  if (!window.quaverMpris) return null;
  if (!/Windows|Macintosh/.test(navigator.userAgent)) return null; // Linux 走 MPRIS daemon
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return null;
  const ms = navigator.mediaSession;
  try {
    ms.setActionHandler("play", () => {
      if (player.paused) player.resume(); // 复用错误重试/起播语义，与 MPRIS play 一致
    });
    ms.setActionHandler("pause", () => {
      if (!player.paused) player.pause();
    });
    ms.setActionHandler("previoustrack", () => player.prev());
    ms.setActionHandler("nexttrack", () => player.next());
    ms.setActionHandler("seekto", (d) => {
      const pos = d.seekTime;
      if (typeof pos === "number" && isFinite(pos)) player.seek(pos);
    });
  } catch (e) {
    console.warn("mediaSession action handler failed", e);
    return null;
  }
  return (s) => {
    try {
      const t = s.track;
      if (!t) {
        ms.playbackState = "none";
        return;
      }
      // 封面取 500px 一档：SMTC / Now Playing 显示面积比应用内封面大（无 500 时回落 300）
      const art = player.current ? coverUrl(player.current, 500) || t.artUrl : t.artUrl;
      ms.metadata = new MediaMetadata({
        title: t.name,
        artist: t.artists.join(", "),
        album: t.album,
        artwork: art ? [{ src: art, sizes: "500x500", type: "image/jpeg" }] : [],
      });
      // MPRIS 的 Stopped（无曲目）映射 none；有曲目未播放一律 paused（含停在 0:00）
      ms.playbackState = s.status === "Playing" ? "playing" : "paused";
      const dur = t.durationSec ?? 0;
      const pos = s.posUs / 1e6;
      if (isFinite(dur) && dur > 0 && isFinite(pos) && pos >= 0) {
        ms.setPositionState({ duration: dur, position: Math.min(pos, dur), playbackRate: 1 });
      }
    } catch (e) {
      console.warn("mediaSession push failed", e);
    }
  };
}

export function startMprisBridge(): void {
  const bridge = window.quaverMpris;
  if (!bridge || started) return;
  started = true;

  let lastFp = "";
  const msPush = makeMediaSessionPush();
  // mpv 后端下渲染层没有音频元素，Chromium 媒体会话不激活 → SMTC/Now Playing 不出现。
  // msPush 非 null 蕴含全部平台门（quaverMpris 桥 + win/mac UA + mediaSession API +
  // handler 注册成功），假音频模块免费复用这道门（详见 fake-audio.ts 头注释）。
  if (msPush) initFakeAudio();
  const push = (seeked = false) => {
    const s = snapshot(seeked);
    try {
      bridge.send(s);
    } catch (e) {
      console.warn("mpris push failed", e);
    }
    msPush?.(s);
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
