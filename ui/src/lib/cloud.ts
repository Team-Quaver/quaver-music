// Quaver — 微云音乐条目的本地化元数据操作（刮削信息 / 封面 / 歌词）。
//
// key 是 sidecar 按账号 + file_id 生成的稳定哈希；这里只操作该条目的展示元数据，
// 不暴露微云目录、上传、删除等通用文件管理能力。
import { api, bumpCloudCover } from "./api";
import { fileToBase64, pickFile } from "./local";
import type { Song } from "../player";

export interface CloudSongFingerprint {
  key: string;
  hasCover: boolean;
  lyricImport: boolean;
  importFormat: string;
}

export interface CloudMetaEdit {
  title: string;
  artist: string;
  album: string;
}

export interface CloudItem {
  key: string;
  fileId: string;
  fileName: string;
  matched: number;
  playable: boolean;
  title: string;
  artist: string;
  album: string;
  editedMeta: boolean;
  coverManual: boolean;
  lyricImport: boolean;
  importFormat: string;
  scrapedAt: number;
  hasCover: boolean;
  hasLyric: boolean;
  playbackError: string;
  song?: Song;
}

export interface CloudLibrary {
  items: CloudItem[];
  count: number;
  stats: { total: number; playable: number; withCover: number; withLyric: number };
  scrape: {
    running: boolean;
    total: number;
    processed: number;
    matched: number;
    unmatched: number;
    failed: number;
    lastError: string;
  };
}

// 播放兜底要的是「用户点歌时已经有一份可用的同曲索引」。微云页的刮削/元数据
// 变更会主动失效这份快照，所以不需要靠 30s 短 TTL 追新；反过来，短 TTL 会让
// 用户在歌单里停留一会儿后，每首失败曲都重新等一次 /cloud/library。
const CLOUD_LIBRARY_TTL = 5 * 60_000;
let cloudLibraryCache: { at: number; data: CloudLibrary } | null = null;
let cloudLibraryInflight: Promise<CloudLibrary> | null = null;
let cloudLibraryGen = 0;

/** 最近一次成功快照（即使已过 TTL 也返回）：微云页先用它出首帧，再后台换新。
 *  播放器兜底仍走 loadCloudLibrary 的 TTL 语义，不能拿过期快照冒充新匹配结果。 */
export function peekCloudLibrary(): CloudLibrary | null {
  return cloudLibraryCache?.data ?? null;
}

/** 微云库整单快照（歌单兜底匹配与微云页共用）。TTL 内只吃内存；
 *  库内容变更事件会立刻作废旧快照。失败不清空上次成功快照。 */
export async function loadCloudLibrary(force = false): Promise<CloudLibrary> {
  if (!force && cloudLibraryCache && Date.now() - cloudLibraryCache.at < CLOUD_LIBRARY_TTL) {
    return cloudLibraryCache.data;
  }

  if (cloudLibraryInflight && !force) return cloudLibraryInflight;

  const gen = cloudLibraryGen;

  const req = api<CloudLibrary>("/cloud/library").then((data) => {
    // 刮削/元数据变更会让旧请求结果过期；晚到的旧响应不能重新盖回缓存。
    if (gen === cloudLibraryGen) cloudLibraryCache = { at: Date.now(), data };

    return data;
  }).finally(() => {
    if (cloudLibraryInflight === req) cloudLibraryInflight = null;
  });

  cloudLibraryInflight = req;

  return req;
}

export function invalidateCloudLibrary(): void {
  cloudLibraryCache = null;
  cloudLibraryGen++;
}

/** 微云条目 → 播放器 Song（歌单兜底与微云页共用同一份转换）。 */
export function cloudItemToSong(item: CloudItem): Song | null {
  if (!item.playable || !item.fileId) return null;

  const song = item.song;
  const title = item.title || item.fileName;
  const matchedSong = item.matched === 1 ? song : undefined;
  const directUrl = `/api/weiyun/music/${encodeURIComponent(item.fileId)}?name=${encodeURIComponent(item.fileName)}`;

  return {
    ...song,
    mid: matchedSong?.mid || `weiyun:${item.fileId}`,
    name: title,
    title,
    singer: item.artist ? [{ name: item.artist }] : song?.singer,
    album: {
      ...song?.album,
      name: item.album || song?.album?.name || "",
    },
    directUrl,
    cloud: {
      key: item.key,
      hasCover: item.hasCover,
      lyricImport: item.lyricImport,
      importFormat: item.importFormat,
    },
  };
}

const notifyCloudChanged = (key: string) => {
  invalidateCloudLibrary();
  window.dispatchEvent(new CustomEvent("quaver:cloud-changed", { detail: { key } }));
};

export async function importCloudLyric(key: string, file: File): Promise<{ format: string; chars: number }> {
  const r = await api<{ format: string; chars: number }>("/cloud/lyric/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, name: file.name, data: await fileToBase64(file) }),
  });

  notifyCloudChanged(key);

  return r;
}

export async function revertCloudLyric(key: string): Promise<void> {
  await api(`/cloud/lyric/import/${encodeURIComponent(key)}`, { method: "DELETE" });
  notifyCloudChanged(key);
}

export async function importCloudCover(key: string, file: File): Promise<void> {
  await api("/cloud/cover/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, name: file.name, data: await fileToBase64(file) }),
  });
  bumpCloudCover(key);
  notifyCloudChanged(key);
}

export async function setCloudMeta(key: string, meta: CloudMetaEdit): Promise<void> {
  await api("/cloud/meta/set", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ...meta }),
  });
  notifyCloudChanged(key);
}

export async function triggerCloudScrape(opts: { keys?: string[]; all?: boolean; force?: boolean } = {}) {
  const r = await api<{ started: boolean; busy?: boolean; total: number }>("/cloud/scrape", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });

  notifyCloudChanged(opts.keys?.[0] ?? "");

  return r;
}

export const chooseCloudLyricFile = () => pickFile(".lrc,.qrc,.ttml,.xml,.txt");
export const chooseCloudCoverFile = () => pickFile(".jpg,.jpeg,.png,.gif,.webp");
