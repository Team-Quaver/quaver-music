// Quaver — 自建歌单数据层（右键菜单「加入歌单」/「从歌单删除」用）
//
// 读：GET /user/created-songlists（PlaylistBaseRead，一次全量）
// 写：POST /songlist/{dirid}/songs · DELETE /songlist/{dirid}/songs（PlaylistDetailWrite）
//
// 关键约定（实测得来，别想当然）：
//  1. **dirid ≠ disstid**。写操作要 dirid（自建歌单的「目录 ID」，从 created-songlists 或
//     歌单详情的 info.dirid 拿）；读详情用 disstid（= info.id）。两者混用会静默改错歌单。
//  2. song_type 一律发**读侧 Song.type 原值**：写侧枚举转换收口在 Go SDK
//     （modules.ToSonglistWriteType，上游 PR 306 的两阶段映射）。渲染层再做偏移
//     = 双重转换，上游 retCode=0 但歌单毫无变化（静默空操作）。
//  3. tid 传歌单的 tid（= 列表里的 id）；不知道就 0，上游多数情况容得下。
//  4. dirid=201 是「我喜欢」，与行内红心是同一份数据，故不列进「加入歌单」菜单。
import { api, postJson } from "./api";
import { getCachedSonglist, noteSonglistWrite } from "./songlist-detail";

export interface MyPlaylist {
  /** disstid / tid（歌单详情页路由与写接口的 tid 用它） */
  id: number;
  /** 目录 ID（写接口的 dirid 用它） */
  dirid: number;
  title: string;
  picurl?: string;
  songnum?: number;
}

interface CreatedPlaylistWire {
  id?: number | string;
  dirid?: number | string;
  title?: string;
  picurl?: string;
  bigpic_url?: string;
  songnum?: number | string;
}

const LOVED_DIRID = 201;

let items: MyPlaylist[] | null = null; // null = 尚未加载
let inflight: Promise<MyPlaylist[]> | null = null;

export const mySonglists = (): MyPlaylist[] => items ?? [];
export const isMySonglistsLoaded = () => items !== null;

/** 拉取自建歌单（默认吃缓存；force=true 回源）。失败抛错且不清空已有缓存。 */
export async function loadMySonglists(force = false): Promise<MyPlaylist[]> {
  if (items && !force) return items;

  if (inflight) return inflight;
  inflight = (async () => {
    const d: { playlists?: CreatedPlaylistWire[] } = await api("/user/created-songlists");

    return (d.playlists ?? [])
      .filter((p) => Number(p?.dirid) !== LOVED_DIRID && p?.dirid)
      .map((p) => ({
        id: Number(p.id),
        dirid: Number(p.dirid),
        title: String(p.title ?? "歌单"),
        picurl: p.picurl || p.bigpic_url || "",
        songnum: Number(p.songnum ?? 0),
      }));
  })();

  try {
    items = await inflight;

    return items;
  } finally {
    inflight = null;
  }
}

/** 写接口需要的歌曲引用；缺 song_id 就没法写（部分上下文不带数字 id） */
function songRef(song: any) {
  if (!song?.id) throw new Error("这首歌缺少 song_id，无法写入歌单");

  return { song_id: Number(song.id), song_type: Number(song.type ?? 1) };
}

/** 写接口的统一收口：SDK 把上游结果压成 bool（`retCode==0` → True；
 *  异常码 **80092** → False，即「确凿失败」：歌单不属于当前账号 / 歌曲状态不允许写入）。
 *  文档口径下 add/del 的 True 很宽容（歌已存在、歌本就不在，都算 True），
 *  所以**只有 False 要当失败抛出来** —— 否则「歌其实没进歌单」会静默显示成「已加入」，
 *  正是本仓库最怕的那类静默空操作。 */
function assertAccepted(r: { ok?: boolean } | null, what: string): void {
  if (r?.ok === true) return;
  throw new Error(`${what}未被上游接受（80092：歌单不属于当前账号，或歌曲状态不允许写入）`);
}

/** 加入歌单（成功即把该歌单计数 +1，供侧栏/菜单展示） */
export async function addSongToSonglist(target: MyPlaylist, song: any): Promise<void> {
  const ref = songRef(song);
  const r = await postJson<{ ok: boolean }>(`/songlist/${target.dirid}/songs`, { ...ref, tid: target.id || 0 });
  assertAccepted(r, "加入歌单");
  const hit = mySonglists().find((x) => x.dirid === target.dirid);

  if (hit) hit.songnum = Number(hit.songnum ?? 0) + 1;
  // 乐观跟进歌单详情缓存并排一次增量回源（打开中的该歌单页即时上屏；love-song-reload 同款）
  noteSonglistWrite(target.id, String(song.mid ?? ""), true, song);
}

/** 从歌单移除（dirid/tid 见文件头约定 1） */
export async function removeSongFromSonglist(
  target: { dirid: number; tid?: number },
  song: any,
): Promise<void> {
  const ref = songRef(song);

  const r = await api<{ ok: boolean }>(`/songlist/${target.dirid}/songs`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ref, tid: target.tid ?? 0 }),
  });

  assertAccepted(r, "从歌单删除");
  const hit = mySonglists().find((x) => x.dirid === target.dirid);

  if (hit && Number(hit.songnum ?? 0) > 0) hit.songnum = Number(hit.songnum) - 1;

  // 没拿不到 tid（个别调用方只带 dirid）就没法对上详情缓存，只跳过跟进，写本身已生效
  if (target.tid) noteSonglistWrite(target.tid, String(song.mid ?? ""), false, song);
}

// 开发/自动化测试钩子（生产构建里 vite define 会剔除，同 player.ts 的 __quaverPlayer）。
// 类型导出给 scripts/test-globals.d.ts 引用：scripts 工程经 verify 脚本间接 import 本模块，
// 全局 Window 合并要求两处声明逐字同型。
export interface QuaverSonglistsBridge {
  addSongToSonglist: typeof addSongToSonglist;
  removeSongFromSonglist: typeof removeSongFromSonglist;
  reorderSonglist: typeof reorderSonglist;
  mySonglists: typeof mySonglists;
  getCachedSonglist: typeof getCachedSonglist;
}

declare global { interface Window { __quaverSonglists?: QuaverSonglistsBridge } }

if (import.meta.env?.DEV) {
  window.__quaverSonglists = { addSongToSonglist, removeSongFromSonglist, reorderSonglist, mySonglists, getCachedSonglist };
}

/** 歌单全量重排序（POST /songlist/{dirid}/order → SeqSonglist）。
 *  ordered 必须是该歌单**全部**歌曲的新顺序（读侧对象数组，song_type 发原值）——
 *  上游对部分提交照样回成功但会打乱未提交歌曲的顺序，所以这里只收整单。
 *  成功后不做乐观缓存改写：整单顺序的读侧滞后与增删同族，由调用方
 *  （songlist-detail.noteSonglistOrder）负责乐观跟进 + 回源对账。 */
export async function reorderSonglist(
  target: { dirid: number; tid?: number },
  ordered: any[],
): Promise<void> {
  if (!Number(target?.dirid)) throw new Error("缺少歌单 dirid，无法重排");

  if (!ordered.length) throw new Error("重排列表为空：必须提交歌单全部歌曲");

  const songs = ordered.map((s) => {
    if (!s?.id) throw new Error("有歌曲缺少 song_id，无法重排");

    return { song_id: Number(s.id), song_type: Number(s.type ?? 1) };
  });

  const r = await postJson<{ ok: boolean }>(`/songlist/${target.dirid}/order`, { tid: target.tid ?? 0, songs });

  assertAccepted(r, "歌单重排");
}

/** 删除整个自建歌单（PlaylistBaseWrite DelPlaylist）。走的是 DELETE /songlist/{dirid}
 *  —— **没有** /songs 后缀，与上面的按歌移除是两条路由。dirid 缺失就无从下手，
 *  静默吞掉等于「看起来删了其实没删」。成功后把本地缓存里的该歌单摘掉
 *  （侧栏条目数据在 shell 侧另有一份，由调用方经回调自行摘除）。 */
export async function deleteSonglist(target: { dirid: number; title?: string }): Promise<void> {
  if (!Number(target?.dirid)) throw new Error("缺少歌单 dirid，无法删除");
  const r = await api<{ ok: boolean }>(`/songlist/${target.dirid}`, { method: "DELETE" });
  assertAccepted(r, "删除歌单");

  if (items) items = items.filter((x) => x.dirid !== Number(target.dirid));
}
