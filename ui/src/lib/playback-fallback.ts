// Quaver — QQ 曲目不可播时的本地/微云同曲兜底。
//
// 这是「歌单里明明有、网盘/本地也有，但点播进不了」的救济链。只做播放源选择，
// 不改动当前队列里的 QQ 曲目身份：当前曲、封面、歌词仍是歌单里那一行。
import type { Song } from "../player";
import { loadCloudLibrary, cloudItemToSong, type CloudItem } from "./cloud";
import { loadLocalLibrary, trackToSong } from "./local";
import { songMatchScore, type SongMatchWant } from "./song-match";

const MIN_SCORE = 4;

/** 上游 file.size_* 元数据是否至少声明了一个有源的音质档（含会员锁定档）。
 *  全为 0 表示曲库侧确实没有可播源；元数据缺失时保持原来的取链行为。 */
export function hasPlayableTier(song: Song): boolean {
  const f = song.file;

  if (!f) return true;

  const fields = [f.size_96ogg, f.size_128mp3, f.size_192ogg, f.size_320mp3, f.size_flac];
  const premium = f.size_new ?? [];

  // 未声明任何 size 字段时无法判断，保留取链尝试；声明了就必须至少一档 > 0。
  const declared = fields.some((v) => v !== undefined) || premium.length > 0;

  if (!declared) return true;

  return fields.some((v) => (v ?? 0) > 0) || premium.some((v) => v > 0);
}

function wantOf(song: Song): SongMatchWant {
  return {
    title: song.title || song.name || "",
    artists: (song.singer ?? []).map((x) => x.name).filter(Boolean),
    album: song.album?.name ?? "",
  };
}

let warmInflight: Promise<void> | null = null;

/** 进入歌单/点选歌曲时预热两份元数据；实际取流仍只在 QQ 取链失败后发生。 */
export function warmPlaybackFallbackSources(): Promise<void> {
  if (warmInflight) return warmInflight;

  // These are two independent caches; warm them in parallel. The real fallback
  // lookup still awaits both, but a slow empty Weiyun library must not delay
  // the local-library snapshot used by the "所有歌曲" page.
  warmInflight = Promise.allSettled([
    loadLocalLibrary(),
    loadCloudLibrary(),
  ]).then(() => {}).finally(() => {
    warmInflight = null;
  });

  return warmInflight;
}

/** 找到最可信的同曲文件。微云原文件优先；没有才查本地/NAS。
 *  返回 null 表示没有达到阈值，播放器应保持原来的 QQ 失败语义。 */
export async function findPlaybackFallback(song: Song): Promise<Song | null> {
  const want = wantOf(song);

  // Prefer the Weiyun original file for QQ-only tracks: cloud rows are already
  // a user-owned copy. Local library remains the second choice when no cloud
  // copy exists.
  try {
    const lib = await loadCloudLibrary();
    let best: { item: CloudItem; song: Song; score: number } | null = null;

    for (const item of lib.items) {
      if (!item.playable) continue;

      const score = [item.title, item.fileName]
        .map((title) => songMatchScore(want, { title, artist: item.artist, album: item.album }))
        .reduce((a, b) => Math.max(a, b), 0);

      if (score < MIN_SCORE) continue;

      const song = cloudItemToSong(item);

      if (song && (!best || score > best.score)) best = { item, song, score };
    }

    if (best) return best.song;
  } catch { /* 微云库不可用：继续查本地 */ }

  try {
    const lib = await loadLocalLibrary();
    let best: { song: Song; score: number } | null = null;

    for (const track of lib.tracks) {
      const score = songMatchScore(want, {
        title: track.title || track.relPath.split("/").pop() || track.relPath,
        artist: track.artist || track.albumArtist,
        album: track.album,
      });

      if (score >= MIN_SCORE && (!best || score > best.score)) {
        best = { song: trackToSong(track, lib.sources), score };
      }
    }

    if (best) return best.song;
  } catch {
    return null;
  }

  return null;
}
