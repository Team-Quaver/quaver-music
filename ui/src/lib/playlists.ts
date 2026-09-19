// Quaver — 自建歌单数据层（右键菜单「加入歌单」/「从歌单删除」用）
//
// 读：GET /user/created-songlists（PlaylistBaseRead，一次全量）
// 写：POST /songlist/{dirid}/songs · DELETE /songlist/{dirid}/songs（PlaylistDetailWrite）
//
// 关键约定（实测得来，别想当然）：
//  1. **dirid ≠ disstid**。写操作要 dirid（自建歌单的「目录 ID」，从 created-songlists 或
//     歌单详情的 info.dirid 拿）；读详情用 disstid（= info.id）。两者混用会静默改错歌单。
//  2. songType 必须用**写侧**枚举（读侧 type - 1，见 api.ts:writeSongType）。发读侧原值
//     上游照样回 retCode=0，但歌单毫无变化（静默空操作）。
//  3. tid 传歌单的 tid（= 列表里的 id）；不知道就 0，上游多数情况容得下。
//  4. dirid=201 是「我喜欢」，与行内红心是同一份数据，故不列进「加入歌单」菜单。
import { api, postJson, writeSongType } from "./api";

export interface MyPlaylist {
  /** disstid / tid（歌单详情页路由与写接口的 tid 用它） */
  id: number;
  /** 目录 ID（写接口的 dirid 用它） */
  dirid: number;
  title: string;
  picurl?: string;
  songnum?: number;
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
    const d: any = await api("/user/created-songlists");
    return ((d?.playlists ?? []) as any[])
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
function songRef(song: any): { song_id: number; song_type: number } {
  if (!song?.id) throw new Error("这首歌缺少 song_id，无法写入歌单");
  return { song_id: Number(song.id), song_type: writeSongType(song.type) };
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
}
