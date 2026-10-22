// Quaver — 「收藏的歌单」在线数据层（侧栏与歌单页共用的单一真相）
//
// 读：GET /user/fav-songlists（上游 PlaylistFavRead.CgiGetPlaylistFavInfo，分页）
//     全量拉进内存缓存——侧栏要列出来、歌单页要判断收藏态，两处共用同一份，避免
//     「侧栏显示已收藏、歌单页红心却没亮」这类双源不一致。
// 写：POST /songlist/{id}/like · DELETE /songlist/{id}/like（PlaylistFavWrite）
//     与 player.toggleLove 同策略：先乐观改本地并广播，服务端失败再回滚。
//
// 注意：收藏歌单的 id 是上游 disstid/pid（不是自建歌单的 dirid）。
import { api } from "./api";

export interface FavPlaylist {
  /** 上游 disstid/pid —— 收藏/取消收藏与歌单页路由都用它 */
  id: number | string;
  title?: string;
  picurl?: string;
  songnum?: number;
  /** 歌单创建者（收藏别人的歌单时展示来源） */
  nickname?: string;
  uin?: number;
  dirid?: number;
  order_time?: number;
  [k: string]: any;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5; // 至多 500 条：侧栏列表用途，再多也不适合侧栏滚动

let items: FavPlaylist[] | null = null; // null = 尚未加载（区别于「已加载但为空」）
let inflight: Promise<FavPlaylist[]> | null = null; // 并发合流：多视图同时首屏只打一轮上游
const listeners = new Set<() => void>();

/** 订阅收藏歌单变更（增删后触发，侧栏/歌单页据此重绘）。返回退订函数。 */
export function onFavSonglistsChange(fn: () => void): () => void {
  listeners.add(fn);

  return () => { listeners.delete(fn); };
}

function emit() {
  for (const fn of [...listeners]) {
    try { fn(); } catch (e) { console.warn("favs listener failed", e); }
  }
}

/** 当前缓存的收藏歌单（未加载过时为空数组；要保证拿到数据请先 await loadFavSonglists） */
export const favSonglists = (): FavPlaylist[] => items ?? [];

export const isFavSonglist = (id: string | number): boolean =>
  favSonglists().some((x) => String(x.id) === String(id));

/** 拉取收藏的歌单（默认走缓存；force=true 强制回源）。失败抛错且不清空已有缓存。 */
export async function loadFavSonglists(force = false): Promise<FavPlaylist[]> {
  if (items && !force) return items;

  if (inflight) return inflight;
  inflight = (async () => {
    const all: FavPlaylist[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const d: any = await api(`/user/fav-songlists?page=${page}&num=${PAGE_SIZE}`);
      const batch: FavPlaylist[] = d?.playlists ?? [];
      all.push(...batch);

      if (!batch.length || !d?.hasmore) break;
    }

    return all;
  })();

  try {
    const next = await inflight;
    // 前台轮询会反复 force 回源：内容没变就别广播，否则侧栏/集合页会被每 30s 重画一次，
    // 右键菜单与被滚动的列表都会被打断。
    const prev = items;

    const changed = !prev || prev.length !== next.length || next.some((x, i) => {
      const y = prev[i];

      return !y
        || String(x.id) !== String(y.id)
        || x.title !== y.title
        || x.picurl !== y.picurl
        || Number(x.songnum ?? 0) !== Number(y.songnum ?? 0)
        || x.nickname !== y.nickname
        || Number(x.order_time ?? 0) !== Number(y.order_time ?? 0);
    });

    items = next;

    if (changed) emit();

    return items;
  } finally {
    inflight = null;
  }
}

/** 收藏/取消收藏一个歌单。返回操作后的收藏态；服务端失败会回滚并抛出。 */
export async function toggleFavSonglist(target: FavPlaylist): Promise<boolean> {
  const id = target.id;

  if (id === undefined || id === null || id === "") throw new Error("缺少歌单 id");

  // 首次调用前先建立基线：否则「已收藏」会被误判成「未收藏」而重复收藏
  if (items === null) await loadFavSonglists().catch(() => { items = items ?? []; });

  const had = isFavSonglist(id);
  const snapshot = items ?? [];
  items = had
    ? snapshot.filter((x) => String(x.id) !== String(id))
    : [target, ...snapshot];
  emit(); // 乐观更新：侧栏与歌单页按钮同一帧切换

  try {
    await api(`/songlist/${encodeURIComponent(String(id))}/like`, { method: had ? "DELETE" : "POST" });
    // 回源校准真实顺序/计数（侧栏按上游 order_time 排）；失败不打断当前交互
    void loadFavSonglists(true).catch(() => {});

    return !had;
  } catch (e) {
    items = snapshot;
    emit();
    throw e;
  }
}

// —— 自身音乐号：区分「我的歌单」（不提供收藏按钮）与「别人的歌单」 ——
let myMusicid: number | null = null;

export async function getMyMusicid(): Promise<number | null> {
  if (myMusicid !== null) return myMusicid;

  try {
    const st: any = await api("/login/status");
    myMusicid = st?.logged_in ? Number(st?.credential?.musicid ?? 0) || null : null;
  } catch {
    myMusicid = null;
  }

  return myMusicid;
}
