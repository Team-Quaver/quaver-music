// Quaver — 「歌单详情」在线数据层：按歌单缓存 + 写后增量回源 + 变更广播
//
// 与 player.ts 的「我喜欢」同一套思路搬到这里（那边是全局红心态，这边是页面级歌单详情，
// 按歌单 tid 各管各的）：
//   读：GET /songlist/{tid}/detail（CgiGetDiss 族，分页拉全，整单缓存）
//   写：playlists.ts 的加入/删除落库后走 noteSonglistWrite —— 乐观改缓存 + 广播 + 排一次增量回源
//
// 实测（与「我喜欢」同族同坑）：读侧缓存**不保证单调** —— 不同分页参数各缓存各的，
// 写确认后旧快照能活 20s+；新加入的歌落在列表**头部**。所以：
//   - 增量窗口取首页（最近写入区）；
//   - 近期写入庇护期内所有读路径按本地校正，**只增不灭** —— 不能凭一次可能过期的拉取
//     把用户看得到的行删掉；他端删除的收敛交给整单回源（TTL 过期/进页）。
import { api } from "./api";

export interface SonglistDetail {
  info: any;
  /** 服务端原序（orderlist = 加入歌单的时间，新加入的在头部）；工具条只读它 */
  songs: any[];
  total: number;
}

const DETAIL_TTL = 60_000;   // 整单缓存新鲜期：期内进页直接吃缓存，过期才分页拉全
const SYNC_DELAY = 2_000;    // 写后增量回源的静默期（去抖合并连点）
const SYNC_PAGE = 100;       // 增量窗口：单请求取「最近写入」的头部段
// 写入庇护期：期内所有读路径都按已确认写入校正读数（读数反映也不提前出名单 ——
// 同一写入可能被更旧的快照再次冲掉）。实测过期快照能活 20s+，取 2 分钟。
const PENDING_TTL = 120_000;
const LS_WRITES_KEY = "quaver.songlist.writes.v1";

interface Entry { detail: SonglistDetail; at: number }
type WriteMark = { on: boolean; at: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SonglistDetail | null>>();
const listeners = new Map<string, Set<() => void>>();
const syncTimers = new Map<string, number>();
const syncFlights = new Map<string, Promise<void>>();
const syncTries = new Map<string, number>();
const syncCorrected = new Map<string, boolean>();
// 近期写入庇护名单（tid → mid → 期望态），localStorage 持久化跨重载存活（同「我喜欢」）
const recentWrites = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_WRITES_KEY) ?? "{}") as Record<string, Record<string, WriteMark>>;
    const now = Date.now();
    const map = new Map<string, Map<string, WriteMark>>();
    for (const [id, writes] of Object.entries(raw ?? {})) {
      const inner = new Map(Object.entries(writes ?? {}).filter(([, w]) => w && now - Number(w.at) <= PENDING_TTL));
      if (inner.size) map.set(id, inner);
    }
    return map;
  } catch { return new Map(); }
})();

const writesOf = (key: string): Map<string, WriteMark> => {
  let m = recentWrites.get(key);
  if (!m) { m = new Map(); recentWrites.set(key, m); }
  return m;
};

function persistWrites() {
  const now = Date.now();
  const out: Record<string, Record<string, WriteMark>> = {};
  for (const [id, writes] of recentWrites) {
    const inner: Record<string, WriteMark> = {};
    for (const [mid, w] of writes) if (now - w.at <= PENDING_TTL) inner[mid] = w;
    if (Object.keys(inner).length) out[id] = inner;
  }
  try { localStorage.setItem(LS_WRITES_KEY, JSON.stringify(out)); } catch { /* 配额满：庇护名单丢就丢，整单回源兜底 */ }
}

function emit(key: string) {
  for (const fn of [...(listeners.get(key) ?? [])]) { try { fn(); } catch (e) { console.warn(e); } }
}

/** 订阅某个歌单的内容变更（写确认 / 增量回源 / 整单回源后触发）。返回退订函数。 */
export const onSonglistChange = (id: string | number, fn: () => void): (() => void) => {
  const key = String(id);
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => {
    const s = listeners.get(key);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(key);
  };
};

/** 当前缓存的歌单详情（未拉取过时为 null；要保证拿到数据请先 await loadSonglistDetail） */
export const getCachedSonglist = (id: string | number): SonglistDetail | null =>
  cache.get(String(id))?.detail ?? null;

/** 整单回源（分页拉全，与旧版 playlistView 的循环同款断点）。TTL 内直接吃缓存；
 *  失败且有缓存时安静地返回缓存（ degraded ），无缓存才抛给视图显示错误。 */
export async function loadSonglistDetail(id: string | number): Promise<SonglistDetail | null> {
  const key = String(id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.detail;
  const flying = inflight.get(key);
  if (flying) return flying;
  let p!: Promise<SonglistDetail | null>;
  p = (async () => {
    try {
      let info: any = null;
      const songs: any[] = [];
      let total = 0;
      for (let page = 1; ; page++) {
        const d: any = await api(`/songlist/${key}/detail?page=${page}&num=100`);
        info ??= d?.info ?? null;
        const batch: any[] = d?.songs ?? [];
        if (page === 1) total = Number(d?.total ?? 0);
        songs.push(...batch);
        if (!d?.hasmore || !batch.length) break;
      }
      // 读侧滞后庇护：刚写确认的增删可能还没反映进读数（love-song-reload 的教训）
      const rec = reconcileWrites(key, songs, total);
      const old = cache.get(key)?.detail;
      for (const mid of [...rec.laggingOn].reverse()) {
        const row = old?.songs.find((x) => x?.mid === mid);
        if (row) songs.unshift(row); // 本地乐观行插回头部（新加入的歌在头部）
      }
      const detail: SonglistDetail = { info: info ?? old?.info ?? null, songs, total: rec.total };
      cache.set(key, { detail, at: Date.now() });
      emit(key);
      return detail;
    } catch (e) {
      const fallback = cache.get(key)?.detail;
      if (!fallback) throw e; // 无缓存可退：让视图显示错误
      console.warn("歌单详情整单回源失败（保留缓存）", e);
      return fallback;
    } finally {
      if (inflight.get(key) === p) inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 读侧滞后庇护（player.ts reconcilePending 的按歌单版）：把「已写确认但读数还没反映」
 *  的增删校正进拉取结果。名单在庇护期内不删除 —— 读数反映也不提前出名单（同一写入
 *  可能被更旧的快照再次冲掉），只按 PENDING_TTL 过期（persistWrites 落盘）。
 *  - 加入不可见 → mid 归入 laggingOn（行由调用方插回）+ 计数 +1；
 *  - 删除仍在读数 → 从结果剔除 + 计数 -1；
 *  - corrected = 本轮真的校正过（增量回源据此决定要不要重试追平）。 */
function reconcileWrites(key: string, songs: any[], total: number): {
  songs: any[]; total: number; laggingOn: string[]; corrected: boolean;
} {
  const writes = recentWrites.get(key);
  if (!writes?.size) return { songs, total, laggingOn: [], corrected: false };
  const now = Date.now();
  for (const [mid, w] of writes) if (now - w.at > PENDING_TTL) writes.delete(mid);
  const laggingOn: string[] = [];
  let t = total;
  for (const [mid, w] of writes) {
    const at = songs.findIndex((s) => s?.mid === mid);
    if (w.on && at < 0) { laggingOn.push(mid); t++; continue; }
    if (w.on) continue; // 已反映：无需校正，但更旧的快照仍可能缺它
    if (at >= 0) { songs.splice(at, 1); t--; continue; } // 删除滞后：从读数剔除
    // 删除已反映：无需校正
  }
  return { songs, total: t, laggingOn, corrected: laggingOn.length > 0 || t !== total };
}

/** 写确认后的乐观跟进 + 排一次增量回源（playlists.ts 的加入/删除成功后调用）。
 *  - on：把歌插进缓存列表头（新加入的歌在头部；没有歌对象就不插行，只计数）；
 *  - off：从缓存列表摘掉；total ±1；广播给打开中的该歌单页；2s 去抖后单请求窗口回源。
 *  没有缓存（该歌单没打开过）时只记庇护名单 —— 下次整单回源自然会校正。 */
export function noteSonglistWrite(id: string | number, mid: string, on: boolean, song?: any): void {
  const key = String(id);
  if (!mid) return;
  writesOf(key).set(mid, { on, at: Date.now() });
  persistWrites();
  syncTries.set(key, 0);
  const hit = cache.get(key);
  if (hit) {
    const d = hit.detail;
    if (on) {
      if (song && !d.songs.some((x) => x?.mid === mid)) d.songs.unshift(song);
      d.total++;
    } else {
      d.songs = d.songs.filter((x) => x?.mid !== mid);
      if (d.total > 0) d.total--;
    }
    emit(key);
  }
  syncSonglistSoon(key);
}

/** 安排一次写后增量回源（去抖：连点合并成最后一击后的一次）。 */
export function syncSonglistSoon(id: string | number): void {
  const key = String(id);
  const prev = syncTimers.get(key);
  if (prev !== undefined) window.clearTimeout(prev);
  syncTimers.set(key, window.setTimeout(() => {
    syncTimers.delete(key);
    void syncSonglist(key);
  }, SYNC_DELAY));
}

/** 写后增量回源：只拉「最近写入」的首页窗口与缓存对账，不做整单分页重载。
 *  与 player.ts 的「我喜欢」syncLoved 同规矩：**只增不灭** —— 窗口内以服务端顺序为准
 *  （滞后删除剔除、滞后加入的本地乐观行插回头部），窗口外/读数缺失一律保留；
 *  读侧缓存不保证单调，别让一次拉取把用户看得到的行删掉。他端删除的收敛交给整单回源。 */
async function syncSonglist(key: string): Promise<void> {
  if (!cache.has(key) || syncFlights.has(key)) return; // 无基线不凭空造列表；上一轮还在跑就等它
  const flight = (async () => {
    try {
      const r: any = await api(`/songlist/${key}/detail?page=1&num=${SYNC_PAGE}`);
      const fetched: any[] = ((r?.songs ?? []) as any[]).filter((s) => s?.mid);
      const rec = reconcileWrites(key, fetched, Number(r?.total ?? 0));
      syncCorrected.set(key, rec.corrected);
      const old = cache.get(key)!.detail;
      const prevAt = cache.get(key)!.at;
      const prevOrder = old.songs.slice();
      const prevTotal = old.total;
      // 窗口内以服务端顺序为准；滞后加入的本地乐观行插回头部（新加入的歌在头部）
      const head = [...rec.songs];
      const seen = new Set(head.map((s) => s.mid));
      for (const mid of [...rec.laggingOn].reverse()) {
        seen.add(mid);
        const row = old.songs.find((x) => x?.mid === mid);
        if (row) head.unshift(row);
      }
      const tail = old.songs.filter((s) => s?.mid && !seen.has(s.mid));
      const detail: SonglistDetail = { info: old.info, songs: [...head, ...tail], total: Math.max(rec.total, prevTotal) };
      cache.set(key, { detail, at: prevAt }); // 不刷新 TTL 时刻：窗口外没重拉，整单新鲜度不变
      if (!sameOrder(prevOrder, detail.songs) || prevTotal !== detail.total) emit(key);
    } catch (e) {
      console.warn("歌单增量回源失败（保留本地）", e);
    } finally {
      syncFlights.delete(key);
      const corrected = syncCorrected.get(key) ?? false;
      const tries = syncTries.get(key) ?? 0;
      if (corrected && tries < 3) {
        syncTries.set(key, tries + 1); // 读侧滞后没追平：稍后再对一轮（封顶，防上游真丢了无限打转）
        syncSonglistSoon(key);
      } else if (!corrected) {
        syncTries.set(key, 0);
      }
      syncCorrected.set(key, false);
    }
  })();
  syncFlights.set(key, flight);
  await flight;
}

/** 两个列表是否同一批曲（同序同 mid）：一样就不广播/不重画，避免打断滚动 */
function sameOrder(a: any[], b: any[]) {
  return a.length === b.length && a.every((x, i) => x?.mid === b[i]?.mid);
}
