// Quaver — 歌手头像解析（「所有歌曲」歌手分类用）。
//
// 歌曲行通常带 singer.mid，直接拼 T001 CDN；本地未刮削到 mid 的曲目只有歌手名，
// 这时按名字查一次搜索接口，取「归一化后完全相同」的歌手，避免把同名前缀的别人认进来。
// 结果按繁简归并键缓存：同一歌手在卡片/详情两处请求只发一次。
import { api, stripEm, upPic } from "./api";
import { artistIdentity } from "./artist-key";

export interface ArtistAvatar {
  url: string;
  mid: string;
}

interface SingerSearchHit {
  mid?: string;
  name?: string;
  pic?: string;
}

interface SingerSearchResp {
  singer?: SingerSearchHit[];
}

const EMPTY: ArtistAvatar = { url: "", mid: "" };
const cache = new Map<string, Promise<ArtistAvatar>>();

/** T001 是 QQ 音乐歌手头像的标准 300px 档；mid 为空时不造死链。 */
export function singerAvatarUrl(mid: string): string {
  return mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : "";
}

async function findExactSinger(name: string): Promise<ArtistAvatar> {
  const target = await artistIdentity(name);
  const hit = cache.get(target.key);

  if (hit) return hit;

  let pending!: Promise<ArtistAvatar>;

  const dropMiss = () => {
    if (cache.get(target.key) === pending) cache.delete(target.key);
  };

  pending = (async (): Promise<ArtistAvatar> => {
    try {
      const d = await api<SingerSearchResp>(
        `/search?keyword=${encodeURIComponent(name)}&type=1&page=1&num=10`,
      );

      const candidates = await Promise.all((d?.singer ?? []).map(async (singer) => ({
        singer,
        identity: await artistIdentity(stripEm(singer?.name)),
      })));

      const exact = candidates.find(({ identity }) => identity.key === target.key)?.singer;
      const mid = String(exact?.mid ?? "").trim();
      const pic = upPic(stripEm(exact?.pic));

      const result = {
        url: pic || singerAvatarUrl(mid),
        mid,
      };

      // 未命中不缓存：sidecar 恢复/登录后允许再试一次，避免首屏失败永久粘住。
      if (!result.url) dropMiss();

      return result;
    } catch {
      // 未登录/离线/上游抖动都只是「暂时没有头像」，分类页继续用首字母占位。
      dropMiss();

      return EMPTY;
    }
  })();

  cache.set(target.key, pending);

  return pending;
}

/** 优先使用歌曲携带的歌手 mid；缺 mid 时按名字精确搜索并缓存。 */
export function resolveArtistAvatar(name: string, mid = ""): Promise<ArtistAvatar> {
  const known = String(mid ?? "").trim();

  if (known) return Promise.resolve({ url: singerAvatarUrl(known), mid: known });

  return findExactSinger(name);
}
