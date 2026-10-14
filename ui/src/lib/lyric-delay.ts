// Quaver — 按歌曲的「歌词延迟」（用户微调歌词同步）
//
// 这是**本地数据**不是设置：与红心收藏、会话存档同路走 localStorage，不进 quaver.conf ——
// 表里一项一歌、键集无界（在线曲 = mid，本地/NAS 曲 = "local:<trackId>"，两者都是稳定身份键），
// 塞进 INI 的「全局有限项」schema（见 lib/prefs.ts 与 electron/config.ts）是错的形状。
//
// 符号约定（宿主与 SDK 注释同口径）：**正数 = 歌词更晚出现**（滞后），负数 = 更早。
// 调的是「歌词渲染器看到的时钟」，不是播放本身：渲染方取 time() − delay 驱动动画，
// 「点击歌词行跳转」再把 delay 加回去（seek(行起始 + delay)），点哪行屏幕就停在哪行。
//
// 宿主不直接改写歌词时间轴，取值分三条路消费：
//   · 内置 AMLL / 插件注册的逐字提供器 —— 经 SparkleKaraokeRenderCtx.lyricDelay() 现读透传；
//   · 宿主行级兜底视图 —— NowPlaying 在 notify 里以同一约定扣减；
//   · 整页接管视图 —— np-view ctx 的 SparkleNpViewCtx.lyricDelay() 透传。
const LS_KEY = "quaver.lyricDelay.v1";

/** −/+ 一档 0.1s（歌词同步微调的常用粒度；长按连调留给以后） */
export const LYRIC_DELAY_STEP_MS = 100;
/** 值域 ±10s：再大基本是歌词源本身错了，不是同步问题 */
export const LYRIC_DELAY_MAX_MS = 10_000;

type DelayMap = Record<string, number>;
let cache: DelayMap | null = null;

function load(): DelayMap {
  if (cache) return cache;
  let out: DelayMap = {};
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= LYRIC_DELAY_MAX_MS) out[k] = Math.round(v);
      }
    }
  } catch { /* 坏档 / 隐私模式：从空表开始，不影响播放 */ }
  cache = out;
  return cache;
}

const songKey = (s: { mid?: string } | null | undefined): string => (s?.mid ? String(s.mid) : "");

/** 当前曲的歌词延迟（毫秒；正 = 歌词延后）。无 mid / 未调过 → 0 */
export function getLyricDelayMs(s: { mid?: string } | null | undefined): number {
  const k = songKey(s);
  if (!k) return 0;
  const v = load()[k];
  return typeof v === "number" ? v : 0;
}

/** 写入（钳到 ±值域并对齐 0.1s 粒度；0 = 删条目保持表干净）。
 *  落盘失败（配额/隐私模式）只在本次会话内生效 —— 与红心收藏同一约定。 */
export function setLyricDelayMs(s: { mid?: string } | null | undefined, ms: number): void {
  const k = songKey(s);
  if (!k) return;
  const map = load();
  const v = Math.round(Math.min(LYRIC_DELAY_MAX_MS, Math.max(-LYRIC_DELAY_MAX_MS, ms)) / LYRIC_DELAY_STEP_MS) * LYRIC_DELAY_STEP_MS;
  if (v === 0) delete map[k];
  else map[k] = v;
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch { /* 丢就丢，下次开机重调 */ }
}

/** 菜单读数："+1.5s" / "-0.5s" / "0.0s" */
export function fmtLyricDelay(ms: number): string {
  return `${ms > 0 ? "+" : ""}${(ms / 1000).toFixed(1)}s`;
}
