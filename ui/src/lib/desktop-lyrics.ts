// Quaver — 桌面歌词桥（主窗口侧）
//
// 桌面歌词窗（desktop-lyrics.html，主进程托管的透明覆盖层）**不持有播放器**：它是主窗
// player 状态的一面镜子。本模块把镜像的两条数据流推到主进程（由 electron/desktop-lyrics.ts
// 转发进覆盖层窗）：
//   • track —— 曲目 + 歌词整包：换曲 / 歌词状态迁移 / 解析结果形状变化时重推（指纹判重）。
//     推的是 player 现成的**解析产物**（karaoke 逐字行 + lines 行级兜底），覆盖层不再拉网络、
//     不再重复解析管线 —— 繁简转换、TTML 库、QRC 振假名这些前处理天然与「正在播放页」一致。
//   • sync —— 播放钟快照（裸播放头毫秒，4Hz 随 notify）+ 当前曲歌词延迟 + 可用性位。
//     覆盖层用「快照位置 + 本地单调钟」外推逐帧时间，与主进程 MPRIS 的外推同构。
//
// 反向命令（覆盖层按钮 → 主窗执行）也收在本模块：player 是唯一事实源的口径不破 ——
// 播放、行点击 seek、歌词延迟 −/+ 全部在主窗执行（延迟仍落 localStorage 按歌曲表），
// 覆盖层只是遥控器。
//
// 契约（类型/常量/Window 声明）在 src/lib/desktop-lyrics-protocol.ts —— 覆盖层只 import 那份，
// 不碰本模块的 player 依赖链。
// 时间口径（对齐 NowPlaying 组 ctx 的两处 `+0.2` 字面量，三处必须同规）：
//   sync.posMs = player.time * 1000（裸播放头，不含补偿不含延迟）；
//   覆盖层 ctx.time() = posMs + 外推 + clockCompMs（兼容模式为 0，native/web 为 200）；
//   歌词时钟 = ctx.time() − lyricDelay()。
import { player } from "../player";
import { coverUrl } from "./api";
import { extractCoverColor, toUiColors } from "./color";
import { currentAccent, refreshAccent, watchAccent } from "./accent";
import { getLyricDelayMs, setLyricDelayMs, LYRIC_DELAY_MAX_MS, LYRIC_DELAY_STEP_MS } from "./lyric-delay";
import { getDesktopLyricsScale, setDesktopLyricsScale, DL_SCALE_MAX, DL_SCALE_MIN } from "./prefs";
import type { SparkleKaraokeLine } from "@quaver/sparkle";

// 契约在 ./desktop-lyrics-protocol.ts：本模块**用**它也**替两侧转发**它（老 import 路径不破）。
import {
  CLOCK_COMP_MS, type DlCmd, type DlLine, type DlStateSnapshot, type DlSyncPayload, type DlTrackPayload,
} from "./desktop-lyrics-protocol";
export { CLOCK_COMP_MS };
export type { DlCmd, DlLine, DlStateSnapshot, DlSyncPayload, DlTrackPayload };


let started = false;
let active = false;
let lastTrackFp = "";
/** 封面色异步补刀：换曲先置空回落白字，取色完成后按当前曲对号入座重推整包。 */
let coverAccent: string | null = null;
let coverJobKey = "";
let lastKey = "";
/** 系统强调色轮询句柄：只在覆盖层在线时订阅（离窗即停表，不养常驻定时器 —— 与 tint 同规矩） */
let accentStop: (() => void) | null = null;

const currentKey = (): string => {
  const c = player.current;
  return c ? String(c._key ?? c.mid) : "";
};

function trackPayload(): DlTrackPayload {
  const c = player.current;
  return {
    v: 1,
    key: currentKey(),
    mid: c ? String(c.mid ?? "") : "",
    lyricState: player.lyricState,
    lyricRevision: player.lyricRevision,
    durationSec: Math.round((c?.interval ?? player.duration) || 0),
    karaoke: player.karaoke,
    lines: player.lyrics.map((l) => ({ t: l.t, text: l.text, trans: l.trans, roma: l.roma })),
    accent: coverAccent,
    systemAccent: currentAccent()?.color ?? null,
  };
}

/** 封面染色取色（URL 级缓存在 lib/color.ts，与 tint 的 cover 档共用同一份 —— 不重复解码）。 */
function refreshCoverAccent(): void {
  const c = player.current;
  const key = currentKey();
  const next = c ? coverUrl(c, 300) : "";
  if (coverJobKey === key && (next || !c)) return; // 同一曲（或无曲）不重取
  coverJobKey = key;
  coverAccent = null; // 换曲先回落白字：拿上一首的颜色糊这一首是错的
  if (!next) return;
  void (async () => {
    const rgb = await extractCoverColor(next);
    if (coverJobKey !== currentKey()) return; // 期间又换了曲
    coverAccent = rgb ? toUiColors(rgb)?.accent ?? null : null;
    if (active) window.quaverDesktopLyrics?.sendTrack(trackPayload()); // 迟到补推（覆盖层按 payload 现取色，不重渲染）
  })();
}

function syncPayload(): DlSyncPayload {
  const c = player.current;
  return {
    v: 1,
    posMs: Math.max(0, (player.time || 0) * 1000),
    clockCompMs: Math.round(player.lyricComp * 1000),
    playing: player.playing,
    delayMs: getLyricDelayMs(c),
    durationSec: Math.round((c?.interval ?? player.duration) || 0),
    canPrev: player.canPrev,
    canNext: player.queue.length > 0,
  };
}

/** 曲目指纹：换曲 / 歌词内容版本 / 状态迁移 / 解析结果形状变化才重推整包（歌词可达百 KB 级，别跟着 4Hz 走）。 */
function trackFp(t: DlTrackPayload): string {
  return `${t.key}|${t.lyricState}|${t.lyricRevision}|${t.karaoke.length}|${t.lines.length}`;
}

function pushAll(): void {
  const b = window.quaverDesktopLyrics;
  if (!b) return;
  const t = trackPayload();
  // 换曲先于歌词到达也先把「颜色期待」挂上：取色 job 与歌词管线并行，各自到货各自推
  if (t.key !== lastKey) {
    lastKey = t.key;
    refreshCoverAccent();
  }
  const fp = trackFp(t);
  if (fp !== lastTrackFp) {
    lastTrackFp = fp;
    b.sendTrack(t);
  }
  b.sendSync(syncPayload());
}

/** 系统强调色轮询：只在覆盖层在线时订阅（离窗停表，与 tint 的 syncAccentWatch 同规矩）。 */
function syncAccentWatch(on: boolean): void {
  if (on && !accentStop) {
    void refreshAccent().then(() => { if (active) window.quaverDesktopLyrics?.sendTrack(trackPayload()); });
    accentStop = watchAccent(() => {
      if (active) window.quaverDesktopLyrics?.sendTrack(trackPayload());
    });
  } else if (!on && accentStop) {
    accentStop();
    accentStop = null;
  }
}

/** 覆盖层命令的执行端（与 MPRIS / mediaSession 同一语义面：prev 走 prevPress 遵循 PrevReplay）。 */
function handleCmd(msg: unknown): void {
  const cmd = (msg ?? {}) as DlCmd & Record<string, unknown>;
  switch (cmd.cmd) {
    case "playpause":
      player.toggle();
      break;
    case "prev":
      player.prevPress();
      break;
    case "next":
      player.next();
      break;
    case "seek": {
      const ms = Number(cmd.ms);
      if (Number.isFinite(ms) && ms >= 0) player.seek(ms / 1000);
      break;
    }
    case "delay": {
      // 钳制/量化口径与 NowPlaying.applyLyricDelay 完全一致（±10s、0.1s 一档）；
      // notifyPublic 让行级视图与延迟读数即时挪动（暂停中没有 4Hz 广播，这一刀必须补）。
      const cur = getLyricDelayMs(player.current);
      const want = cmd.op === "zero" ? 0 : cur + (cmd.dir === -1 ? -1 : 1) * LYRIC_DELAY_STEP_MS;
      const v = Math.round(Math.min(LYRIC_DELAY_MAX_MS, Math.max(-LYRIC_DELAY_MAX_MS, want)) / LYRIC_DELAY_STEP_MS) * LYRIC_DELAY_STEP_MS;
      if (v !== cur) setLyricDelayMs(player.current, v);
      player.notifyPublic();
      break;
    }
    case "scale": {
      // 字号倍率与设置页滑条同一存储（quaver.conf 的 DesktopLyrics.Scale）：这里写 →
      // config 广播 → 覆盖层 loadConfig + applyStyle 即时生效；步长 0.1 与滑条 step=5(%) 同档
      const cur = getDesktopLyricsScale();
      const step = cmd.dir === -1 ? -0.1 : 0.1;
      const next = Math.min(DL_SCALE_MAX, Math.max(DL_SCALE_MIN, Math.round((cur + step) * 10) / 10));
      if (next !== cur) setDesktopLyricsScale(next);
      break;
    }
    default:
      break;
  }
}

/** 主窗启动调用（src/main.ts）：Electron 壳层外（浏览器 dev）桥不存在 → 直接 no-op。 */
export function startDesktopLyricsBridge(): void {
  const b = window.quaverDesktopLyrics;
  if (!b || started) return;
  started = true;

  let wasOpen = false;
  try {
    wasOpen = !!b.activeSync?.()?.open;
  } catch { /* 桥 handler 未就位：等事件 */ }
  active = wasOpen;

  b.onActive?.((s) => {
    const open = !!(s as DlStateSnapshot)?.open;
    if (open && !wasOpen) lastTrackFp = ""; // 覆盖层晚到：当前包必须重推一遍
    wasOpen = open;
    active = open;
    syncAccentWatch(open);
    if (open) pushAll();
  });

  // 4Hz notify 顺带同步镜像（仅覆盖层在线时发，别给不看的窗刷屏）
  // 4Hz notify 顺带同步镜像（仅覆盖层在线时发，别给不看的窗刷屏）
  player.on(() => {
    if (active) pushAll();
  });

  b.onCmd?.((msg) => handleCmd(msg));
}

/** 供设置页/其它模块查询（无桥时 null = 桌面端不可用）。 */
export function desktopLyricsStateSync(): DlStateSnapshot | null {
  try {
    return window.quaverDesktopLyrics?.activeSync?.() ?? null;
  } catch {
    return null;
  }
}
