// Quaver — 侧栏（主菜单栏）歌单右键菜单 + 双击播放
//
//   自建歌单：立即播放 / 插队播放 / 删除歌单
//   收藏歌单：立即播放 / 插队播放 / 取消收藏
//   系统虚拟歌单（每日 30 首 / 我喜欢，挂在导航区）：立即播放 / 插队播放
//   双击（以上同类）：立即播放该歌单
//
// 面板机制复用 SongMenu（body 常驻层 / 视口钳制 / 关闭时机齐全），本文件只管
// 菜单内容与歌单动作本身。收藏歌单取消后侧栏由 favs 订阅自动重画；
// 自建歌单删除后侧栏条目由调用方经 onDeleted 摘除。
import { api } from "../lib/api";
import { player, type Song } from "../player";
import { deleteSonglist } from "../lib/playlists";
import { toggleFavSonglist } from "../lib/favs";
import { sparklePlaylistMenuItems } from "../sparkle/registry";
import { openMenuAt, toast, type MenuItem } from "./SongMenu";

/** 侧栏歌单条目最小契约（自建列表是上游原样对象，收藏列表是 FavPlaylist） */
export interface PlaylistMenuTarget {
  /** 歌单 id（disstid/tid）——拉歌单详情用它，不是 dirid */
  id: number | string;
  title: string;
  /** 目录 ID（写接口语义，只有自建歌单有；删除歌单要用它） */
  dirid?: number;
  songnum?: number;
}

export interface PlaylistMenuOptions {
  /** created = 我创建的歌单（可删除）；fav = 收藏的歌单（可取消收藏） */
  kind: "created" | "fav";
  /** 删除成功后的回调（侧栏把条目摘掉并重画） */
  onDeleted?: (pl: PlaylistMenuTarget) => void;
}

/** 拉全歌单歌曲：与歌单页同一分页口径（页 100 首，页尽即止）。
 *  歌单可能超过一页，只拉首页会把大歌单截成「只播前 100 首」。失败抛给调用方。 */
async function fetchPlaylistSongs(id: number | string): Promise<Song[]> {
  const songs: Song[] = [];
  for (let page = 1; ; page++) {
    const d = await api<{ songs?: Song[]; hasmore?: boolean }>(`/songlist/${id}/detail?page=${page}&num=100`);
    songs.push(...(d?.songs ?? []));
    if (!d?.hasmore || !(d?.songs ?? []).length) break;
  }
  return songs;
}

/** 取歌失败不静默：双击路径没有菜单 run() 的 catch 兜底（SongMenu 才包 toast）。
 *  失败返回 null（这里已 toast），调用方据以区分「失败」与「空列表」两种提示。 */
async function fetchSongsOrComplain(fetchSongs: () => Promise<Song[]>): Promise<Song[] | null> {
  try {
    return await fetchSongs();
  } catch (e) {
    toast(`取歌失败：${e instanceof Error ? e.message : String(e)}`, "err");
    return null;
  }
}

/** 立即播放：整队列替换、从第一首起播（侧栏双击与菜单「立即播放」共用一条路）。
 *  普通歌单与系统虚拟歌单（每日 30 首 / 我喜欢）都落到这里，差别只在取歌函数。 */
export async function playSongsNow(title: string, fetchSongs: () => Promise<Song[]>) {
  const songs = await fetchSongsOrComplain(fetchSongs);
  if (!songs) return; // 取歌失败已 toast
  if (!songs.length) { toast("歌单为空或不可见", "err"); return; }
  player.playList(songs, 0);
  toast(`正在播放歌单「${title}」`);
}

/** 插队播放：整组按原序排到当前曲之后，不打断当前曲；队列空着没有「下一首」
 *  可言，enqueueNextMany 会退化成整列起播，文案跟着变。 */
export async function playSongsNext(title: string, fetchSongs: () => Promise<Song[]>) {
  const songs = await fetchSongsOrComplain(fetchSongs);
  if (!songs) return; // 取歌失败已 toast
  if (!songs.length) { toast("歌单为空或不可见", "err"); return; }
  const wasEmpty = player.index < 0 || !player.queue.length;
  player.enqueueNextMany(songs);
  toast(wasEmpty ? `开始播放歌单「${title}」` : `已插队：「${title}」（${songs.length} 首排在当前曲之后）`);
}

/** 立即播放（普通歌单入口）：按 disstid 翻页拉全歌后走 playSongsNow */
export async function playPlaylistNow(pl: PlaylistMenuTarget) {
  return playSongsNow(pl.title, () => fetchPlaylistSongs(pl.id));
}

/** 插队播放（普通歌单入口）：同上走 playSongsNext */
export async function playPlaylistNext(pl: PlaylistMenuTarget) {
  return playSongsNext(pl.title, () => fetchPlaylistSongs(pl.id));
}

/** 系统虚拟歌单（每日 30 首 / 我喜欢）的右键菜单：没有删除/取消收藏的尾巴，只有播放两兄弟。
 *  虚拟歌单没有固定的 disstid 可翻页拉详情，取歌由调用方给专用接口的 fetchSongs；
 *  id 是它的稳定标识（daily / liked），只给插件菜单项的 ctx 用。 */
export function openVirtualPlaylistMenu(
  x: number,
  y: number,
  title: string,
  fetchSongs: () => Promise<Song[]>,
  anchor?: HTMLElement,
  id = "virtual",
) {
  const items: MenuItem[] = [
    { label: "立即播放", note: "替换当前队列", run: () => playSongsNow(title, fetchSongs) },
    { label: "插队播放", note: "排到当前曲之后", run: () => playSongsNext(title, fetchSongs) },
  ];
  // Sparkle 插件追加项（SparkleMenuItem 与 MenuItem 同型；异常已在 registry 侧吞掉）
  items.push(...sparklePlaylistMenuItems({ id, title, kind: "virtual", songnum: 0 }));
  openMenuAt(x, y, items, anchor);
}

/** 在 (x, y) 打开歌单菜单（坐标一般是鼠标位置）。anchor = 右键的那个歌单条目 */
export function openPlaylistMenu(
  x: number,
  y: number,
  pl: PlaylistMenuTarget,
  opts: PlaylistMenuOptions,
  anchor?: HTMLElement,
) {
  const items: MenuItem[] = [
    { label: "立即播放", note: "替换当前队列", run: () => playPlaylistNow(pl) },
    { label: "插队播放", note: "排到当前曲之后", run: () => playPlaylistNext(pl) },
  ];
  if (opts.kind === "created") {
    items.push({
      label: "删除歌单",
      danger: true,
      // dirid 是删除写接口的唯一定位（dirid ≠ disstid）：列表条目异常缺 dirid 时
      // 禁用而不是点了报错
      disabled: !Number(pl.dirid),
      run: async () => {
        if (!confirm(`删除歌单「${pl.title}」？歌单内的歌曲不受影响，但本操作不可恢复。`)) return;
        await deleteSonglist({ dirid: pl.dirid!, title: pl.title });
        opts.onDeleted?.(pl);
        toast(`已删除歌单「${pl.title}」`);
      },
    });
  } else {
    // 取消收藏走 favs 数据层：乐观更新 + 失败回滚，侧栏由订阅同帧重画
    items.push({
      label: "取消收藏",
      run: async () => {
        await toggleFavSonglist({ id: pl.id, title: pl.title });
        toast(`已取消收藏「${pl.title}」`);
      },
    });
  }
  // Sparkle 插件追加项：ctx 按当时那个歌单现算（函数型条目据此区分「自建 / 收藏 / 虚拟」）
  items.push(...sparklePlaylistMenuItems({
    id: String(pl.id),
    title: pl.title,
    kind: opts.kind,
    songnum: Number(pl.songnum) || 0,
  }));
  openMenuAt(x, y, items, anchor);
}
