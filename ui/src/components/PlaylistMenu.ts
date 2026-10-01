// Quaver — 侧栏（主菜单栏）歌单右键菜单 + 双击播放
//
//   自建歌单：立即播放 / 插队播放 / 删除歌单
//   收藏歌单：立即播放 / 插队播放 / 取消收藏
//   双击（两类同）：立即播放该歌单
//
// 面板机制复用 SongMenu（body 常驻层 / 视口钳制 / 关闭时机齐全），本文件只管
// 菜单内容与歌单动作本身。收藏歌单取消后侧栏由 favs 订阅自动重画；
// 自建歌单删除后侧栏条目由调用方经 onDeleted 摘除。
import { api } from "../lib/api";
import { player, type Song } from "../player";
import { deleteSonglist } from "../lib/playlists";
import { toggleFavSonglist } from "../lib/favs";
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

/** 立即播放：整队列替换、从第一首起播（侧栏双击与菜单「立即播放」共用一条路） */
export async function playPlaylistNow(pl: PlaylistMenuTarget) {
  const songs = await fetchPlaylistSongs(pl.id);
  if (!songs.length) { toast("歌单为空或不可见", "err"); return; }
  player.playList(songs, 0);
  toast(`正在播放歌单「${pl.title}」`);
}

/** 插队播放：整组按原序排到当前曲之后，不打断当前曲；队列空着没有「下一首」
 *  可言，enqueueNextMany 会退化成整列起播，文案跟着变。 */
export async function playPlaylistNext(pl: PlaylistMenuTarget) {
  const songs = await fetchPlaylistSongs(pl.id);
  if (!songs.length) { toast("歌单为空或不可见", "err"); return; }
  const wasEmpty = player.index < 0 || !player.queue.length;
  player.enqueueNextMany(songs);
  toast(wasEmpty ? `开始播放歌单「${pl.title}」` : `已插队：「${pl.title}」（${songs.length} 首排在当前曲之后）`);
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
  openMenuAt(x, y, items, anchor);
}
