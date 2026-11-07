// Quaver — 「所有歌曲」的数据合流与分类索引。
//
// 三个来源：
//   • 本地音乐（local:<trackId>，可带刮削命中的 qqMid）
//   • 我喜欢（在线曲目 mid）
//   • 微云网盘（曲库匹配曲沿用 QQ mid；未匹配的原文件用 weiyun:<fileId>）
// 同一首歌同时出现在多个来源时按 mid 去重，优先级 本地 > 我喜欢 > 微云：
// 本地刮削命中的 qqMid 会挡住同 mid 的收藏与云端条目（保留本地版本，播放走本地文件）。
import { artistIdentity } from "./artist-key.ts";
import type { Song } from "../player";

export interface SongGroup {
  key: string;
  name: string;
  songs: Song[];
}

export interface ArtistGroup extends SongGroup {
  /** 歌手 mid：用于 T001 头像；同一繁简归并组取最先拿到的非空 mid。 */
  mid: string;
}

export interface AlbumGroup extends SongGroup {
  /** 专辑内出现的歌手署名（去重后用 " / " 连接） */
  artist: string;
  cover: string;
}

const GROUP_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
const UNKNOWN_ARTIST = "\u0000unknown-artist";
const UNKNOWN_ALBUM = "\u0000unknown-album";

const songKey = (song: Song) => String(song._key ?? song.mid ?? "");

/** 合并本地音乐、「我喜欢」与微云网盘；同一 mid 只留优先级最高的来源
 *  （本地 > 我喜欢 > 微云）。本地曲若已刮削到 qqMid，会挡住同 mid 的收藏与云端条目。 */
export function mergeAllSongs(localSongs: Song[], likedSongs: Song[], cloudSongs: Song[] = []): Song[] {
  const merged: Song[] = [];
  const seenLocal = new Set<string>();
  const localQqMids = new Set<string>();
  const seenLiked = new Set<string>();
  const seenCloud = new Set<string>();

  for (const song of localSongs) {
    const qqMid = String(song.local?.qqMid ?? "").trim();
    const localId = String(song.local?.id ?? "");
    const key = localId || songKey(song);

    // 本地库内即使两首歌匹配到同一个 QQ mid 也各自保留（可能是不同文件/版本）；
    // qqMid 只用于挡住「我喜欢」里的同一首，避免跨来源重复。
    if (seenLocal.has(key)) continue;
    seenLocal.add(key);
    merged.push(song);

    if (qqMid) localQqMids.add(qqMid);
  }

  for (const song of likedSongs) {
    if (!song?.mid) continue;

    if (localQqMids.has(song.mid) || seenLiked.has(song.mid)) continue;
    seenLiked.add(song.mid);
    merged.push(song);
  }

  // 微云排在最后：同 mid 的曲目若已在本地/收藏里，保留先出现的来源；
  // 未匹配曲库的原文件（weiyun:<fileId>）不与任何来源撞键，照常补进目录。
  for (const song of cloudSongs) {
    const mid = String(song?.mid ?? "").trim();

    if (!mid) continue;

    if (localQqMids.has(mid) || seenLiked.has(mid) || seenCloud.has(mid)) continue;
    seenCloud.add(mid);
    merged.push(song);
  }

  return merged;
}

/** 按歌手归组；每个合唱曲会进入每位歌手的分组。 */
export async function groupSongsByArtist(songs: Song[]): Promise<ArtistGroup[]> {
  const names = new Set<string>();

  for (const song of songs) {
    for (const singer of song.singer ?? []) {
      const name = String(singer?.name ?? "").trim();

      if (name) names.add(name);
    }
  }

  const identities = new Map(await Promise.all(
    [...names].map(async (name) => [name, await artistIdentity(name)] as const),
  ));

  const groups = new Map<string, ArtistGroup>();
  const groupSongKeys = new Map<string, Set<string>>();

  const push = (key: string, name: string, song: Song, mid: string) => {
    let group = groups.get(key);

    if (!group) {
      group = { key, name, mid, songs: [] };
      groups.set(key, group);
      groupSongKeys.set(key, new Set());
    } else if (!group.mid && mid) {
      group.mid = mid;
    }

    const keys = groupSongKeys.get(key)!;
    const id = songKey(song);

    if (keys.has(id)) return;
    keys.add(id);
    group.songs.push(song);
  };

  for (const song of songs) {
    const artists = (song.singer ?? [])
      .map((singer) => ({
        name: String(singer?.name ?? "").trim(),
        mid: String(singer?.mid ?? "").trim(),
      }))
      .filter((singer) => !!singer.name);

    if (!artists.length) {
      push(UNKNOWN_ARTIST, "未知歌手", song, "");
      continue;
    }

    for (const artist of artists) {
      const identity = identities.get(artist.name);

      push(
        identity?.key || artist.name.toLocaleLowerCase("zh-CN"),
        identity?.name || artist.name,
        song,
        artist.mid,
      );
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (a.key === UNKNOWN_ARTIST) return 1;

    if (b.key === UNKNOWN_ARTIST) return -1;

    return GROUP_COLLATOR.compare(a.name, b.name);
  });
}

/** 按专辑归组：专辑 mid 优先；缺失时用「专辑名 + 首位歌手」兜底，避免不同歌手的同名专辑误合并。 */
export function groupSongsByAlbum(songs: Song[], coverOf: (song: Song) => string = () => ""): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();
  const groupSongKeys = new Map<string, Set<string>>();
  const artists = new Map<string, string[]>();

  for (const song of songs) {
    const name = String(song.album?.name ?? "").trim() || "未知专辑";
    const mid = String(song.album?.mid ?? song.album?.pmid ?? "").split("_")[0].trim();
    const leadArtist = String(song.singer?.[0]?.name ?? "").trim().normalize("NFKC").toLocaleLowerCase("zh-CN");

    const key = mid
      ? `mid:${mid}`
      : name === "未知专辑"
        ? UNKNOWN_ALBUM
        : `name:${name.normalize("NFKC").toLocaleLowerCase("zh-CN")}|artist:${leadArtist}`;

    let group = groups.get(key);

    if (!group) {
      group = { key, name, artist: "", cover: coverOf(song), songs: [] };
      groups.set(key, group);
      groupSongKeys.set(key, new Set());
      artists.set(key, []);
    }

    const ids = groupSongKeys.get(key)!;
    const id = songKey(song);

    if (!ids.has(id)) {
      ids.add(id);
      group.songs.push(song);
    }

    if (!group.cover) group.cover = coverOf(song);

    const bucket = artists.get(key)!;

    for (const singer of song.singer ?? []) {
      const artist = String(singer?.name ?? "").trim();

      if (artist && !bucket.includes(artist)) bucket.push(artist);
    }
  }

  for (const group of groups.values()) group.artist = (artists.get(group.key) ?? []).join(" / ");

  return [...groups.values()].sort((a, b) => {
    if (a.key === UNKNOWN_ALBUM) return 1;

    if (b.key === UNKNOWN_ALBUM) return -1;

    return GROUP_COLLATOR.compare(a.name, b.name);
  });
}
