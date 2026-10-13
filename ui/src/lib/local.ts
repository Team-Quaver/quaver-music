// Quaver — 「本地音乐」渲染侧数据层（/api/local/* 客户端 + 库快照缓存）。
//
// 分工：读盘/扫描/刮削的真相全在 electron/local/library.ts（dev=relay、打包=native-server
// 两处同构挂载）；这里只管「拉快照 → 转成 Song → 动作触发 + 进度轮询」。
// Song 上的 local 指纹（{id, kind, hasCover, path}）随会话存档走，封面/取流都只认 id。
import { api } from "./api.ts";
// Song 的类型真相在 player.ts；这是**纯类型导入**（运行期被擦除），
// 因此 player ⇄ local 的运行时依赖保持单向（player 消费 local 的取流/判定函数）。
import type { Song } from "../player";

export interface LocalSourceView {
  id: string;
  kind: "folder" | "webdav";
  name: string;
  path?: string;
  url?: string;
  username?: string;
  trackCount: number;
}

export interface LocalMatchView {
  qqMid: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  singerMid: string;
  albumMid: string;
  albumPmid: string;
  coverQq: boolean;
  lyricQq: boolean;
  scrapedAt: number;
}

export interface LocalTrackView {
  id: string;
  sourceId: string;
  relPath: string;
  file: string;
  format: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  year: string;
  genre: string;
  trackNo: number;
  discNo: number;
  durationSec: number;
  bitrateKbps: number;
  size: number;
  mtime: number;
  tagSource: string;
  coverRel: string;
  lyricSource: "" | "file" | "embed" | "qq";
  lyricRel: string;
  match: LocalMatchView | null;
}

export interface ScanStateView {
  running: boolean;
  processed: number;
  found: number;
  kept: number;
  removed: number;
  errors: string[];
  startedAt: number;
  finishedAt: number;
  lastError: string;
}

export interface ScrapeStateView {
  running: boolean;
  total: number;
  processed: number;
  matched: number;
  unmatched: number;
  failed: number;
  startedAt: number;
  finishedAt: number;
  lastError: string;
}

export interface LibrarySnapshot {
  sources: LocalSourceView[];
  tracks: LocalTrackView[];
  stats: { tracks: number; matched: number; withCover: number; withLyric: number };
  scan: ScanStateView;
  scrape: ScrapeStateView;
}

let snapshot: LibrarySnapshot | null = null;
let inflight: Promise<LibrarySnapshot> | null = null;
let pollTimer: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of [...listeners]) {
    try { fn(); } catch (e) { console.warn(e); }
  }
}

/** 订阅库变化（快照更新 / 进度轮询落地）。返回退订函数。 */
export function onLocalLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const localSnapshot = () => snapshot;

/** 拉库快照；并发去重（多处同时首屏时只发一次）。 */
export async function loadLocalLibrary(force = false): Promise<LibrarySnapshot> {
  if (!force && snapshot) return snapshot;
  if (!inflight) {
    inflight = api<LibrarySnapshot>("/local/library").then((d) => {
      snapshot = d;
      if (d.scan.running || d.scrape.running) startPolling();
      emit();
      return d;
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

/** 有扫描/刮削在跑时轮询进度（每 900ms 一次）；都停了自动收线。 */
function startPolling() {
  if (pollTimer != null) return;
  pollTimer = window.setInterval(async () => {
    try {
      const d = await api<LibrarySnapshot>("/local/library");
      snapshot = d;
      emit();
      if (!d.scan.running && !d.scrape.running && pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch { /* 中继抖动：下一拍再看 */ }
  }, 900);
}

// —— 动作 ——

export async function addFolderSource(name: string, path: string) {
  const r = await api<{ source: LocalSourceView }>("/local/source/add", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "folder", name, path }),
  });
  await loadLocalLibrary(true);
  return r;
}

export async function addWebdavSource(payload: { name: string; url: string; username?: string; password?: string }) {
  const r = await api<{ source: LocalSourceView }>("/local/source/add", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, kind: "webdav" }),
  });
  await loadLocalLibrary(true);
  return r;
}

export async function removeLocalSource(id: string) {
  await api("/local/source/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  await loadLocalLibrary(true);
}

export async function triggerLocalScan() {
  await api("/local/scan", { method: "POST", body: "{}" });
  await loadLocalLibrary(true);
  startPolling();
}

export async function triggerScrape(opts: { ids?: string[]; all?: boolean; force?: boolean } = {}) {
  const r = await api<{ started: boolean; busy?: boolean; total: number }>("/local/scrape", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opts),
  });
  await loadLocalLibrary(true);
  if (r.started || r.busy) startPolling();
  return r;
}

// —— Song 转换 ——

export interface LocalSongFingerprint {
  id: string;
  kind: "folder" | "webdav";
  hasCover: boolean;
  /** 展示用路径（folder=源相对路径；webdav=源名+相对路径） */
  path: string;
  sourceName: string;
  /** 刮削命中的 QQ 曲目 mid：非空 = 播放时**优先走在线 QRC 逐字歌词管线**
   *  （/song/<qqMid>/lyric?qrc=1，翻译/音译同取），拉不到内容再落回本地通路。 */
  qqMid: string;
}

/** 本地曲目的指纹挂在 Song.local 上：mid 只是稳定 key，取流/封面/歌词全认 id。 */
export type SongWithLocal = Song & { local?: LocalSongFingerprint };

export function isLocalSong(s: unknown): s is SongWithLocal & { local: LocalSongFingerprint } {
  const song = s as SongWithLocal | null | undefined;
  return !!song?.local?.id;
}

export function trackToSong(t: LocalTrackView, snapshotSources?: LocalSourceView[]): SongWithLocal {
  const src = (snapshotSources ?? snapshot?.sources ?? []).find((x) => x.id === t.sourceId);
  const kind: "folder" | "webdav" = src?.kind === "webdav" ? "webdav" : "folder";
  const artists = (t.artist || t.albumArtist || "").split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
  return {
    mid: "local:" + t.id,
    name: t.title || t.relPath.split("/").pop() || t.relPath,
    title: t.title,
    singer: artists.map((name) => ({ name, mid: t.match?.singerMid ?? "" })),
    album: { name: t.album, mid: t.match?.albumMid ?? "", pmid: t.match?.albumPmid ?? "" },
    interval: t.durationSec || 0,
    local: {
      id: t.id, kind,
      hasCover: !!t.coverRel,
      path: (kind === "webdav" ? (src?.name ?? "NAS") + " · " : "") + t.relPath,
      sourceName: src?.name ?? "",
      qqMid: t.match?.qqMid ?? "",
    },
  } as SongWithLocal;
}

/** 队列/会话恢复出来的 Song 只有 local 指纹；封面/取流都够用（hasCover 随存档走）。 */
export function localSongStreamUrl(song: SongWithLocal): { url: string; tier: string; label: string } {
  const kind = song.local?.kind ?? "folder";
  return {
    url: `/api/local/stream/${song.local!.id}`,
    tier: kind === "webdav" ? "nas" : "local",
    label: kind === "webdav" ? "NAS 流" : "本地文件",
  };
}

export const localCoverUrl = (id: string) => `/api/local/cover/${id}`;

/** 按 id 查当前快照里的曲目（播放器回填指纹/刷新封面标记用）；快照未加载返回 null。 */
export function trackById(id: string): LocalTrackView | null {
  return snapshot?.tracks.find((t) => t.id === id) ?? null;
}

export function fmtLocalDur(sec: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 曲目总数/进度的一行摘要（本地音乐页顶部状态条）。 */
export function scanSummary(s: ScanStateView): string {
  if (s.running) return `扫描中… 已处理 ${s.processed}，新增/更新 ${s.found}，移除 ${s.removed}`;
  if (!s.finishedAt) return "";
  const errs = s.errors.length ? `，${s.errors.length} 个错误` : "";
  return `扫描完成：新增/更新 ${s.found}，沿用 ${s.kept}${errs}`;
}
export function scrapeSummary(s: ScrapeStateView): string {
  if (s.running) return `刮削中… ${s.processed}/${s.total}（匹配 ${s.matched}）`;
  if (!s.finishedAt) return "";
  return `刮削完成：匹配 ${s.matched}，未匹配 ${s.unmatched}${s.failed ? `，失败 ${s.failed}` : ""}`;
}
