// Quaver — 本地音乐 / NAS 曲库（扫描 · 标签刮削 · 音频与歌词服务）。
//
// 位置：这是「读盘侧」的真相，零 electron、纯 Node —— 开发态由 src/relay.ts 挂载，
// 打包态由 electron/native-server.ts 挂载（与 background/accent 同一套「两处同构、
// 共用一个模块」的既定模式）。渲染层永远只走同源 /api/local/*。
//
// 数据落点（都在配置目录里，QUAVER_CONFIG_DIR 可整体顶掉）：
//   local-library/library.json          —— 源 + 曲目索引（0600；含 WebDAV 口令，绝不回显给渲染层）
//   local-library/covers/<id>.(jpg|png|gif|webp) —— 内嵌封面抽出件 / QQ 专辑封面下载件
//   local-library/lyrics/<id>.txt       —— 内嵌歌词抽出件
//   local-library/lyrics/<id>.json      —— 在线刮削歌词 {lyric,trans,roma}
//
// 安全边界（与 /api/bg 同一条思路，三条一起才成立）：
//   ① 渲染层只能按 **曲目 id** 要流/封面/歌词——文件路径只存在于库索引里，请求参数不参与拼路径；
//   ② 源路径/URL 只在「添加源」时进来一次，扫描范围锁死在源目录之内；
//   ③ WebDAV 口令只进不出：任何 GET 响应把 source 里的 password 抹掉，日志不打印。
//
// NAS 说明：WebDAV 源直接吃网络共享（PROPFIND 扫描 + Range 流代理）；SMB/NFS 挂载成本机
// 路径后按 folder 源处理，同样是完整能力（流、封面、歌词、刮削一致）。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { configFile, configDir, readValues, type Env } from "../config.ts";
import {
  emptyTags, formatByExt, isAudioFile, mergeId3, mp3AudioStart, mp3Duration, parseAiff, parseFilename,
  parseFlac, parseId3v1, parseId3v2, parseMp4, parseOgg, parseWav, sniffFormat,
  type AudioFormat, type EmbeddedPicture, type FileTags, type TagSource,
} from "./tags.ts";
import { DavError, davAuthHeaders, davJoin, davReadRange, propfind, type DavAuth, type DavEntry } from "./webdav.ts";

// ———————————————————————————————————————————— 类型 ————————————————————————————————————————————

export type SourceKind = "folder" | "webdav";

export interface LocalSource {
  id: string;
  kind: SourceKind;
  name: string;
  /** folder：本机绝对路径（NAS 挂载路径同理） */
  path?: string;
  /** webdav：根 URL（含路径前缀） */
  url?: string;
  username?: string;
  /** 口令只在 Node 侧消费，序列化给渲染层前一律剔除 */
  password?: string;
  addedAt: number;
}

export interface LocalMatch {
  qqMid: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  singerMid: string;
  albumMid: string;
  albumPmid: string;
  /** QQ 专辑封面已下载到 covers/<id>.jpg */
  coverQq: boolean;
  /** 在线歌词已落 lyrics/<id>.json */
  lyricQq: boolean;
  scrapedAt: number;
}

export type LyricSourceKind = "" | "file" | "embed" | "qq" | "import";

export interface LocalTrack {
  id: string;
  sourceId: string;
  /** 相对源根的 POSIX 路径（展示与 WebDAV 拼接用） */
  relPath: string;
  file: string;
  format: AudioFormat;
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
  tagSource: TagSource;
  /** 封面文件（相对 local-library/ 的路径），空 = 无 */
  coverRel: string;
  /** 歌词来源标记；"file" 时 lyricRel 指 sidecar .lrc 的源相对路径。
   *  "import" = 用户手动导入的歌词（最高优先，扫描/重扫不许冲掉），
   *  原文落 lyrics/<id>.import，importFormat 记 lrc/qrc/ttml 供渲染层选解析路。 */
  lyricSource: LyricSourceKind;
  lyricRel: string;
  importFormat: string;
  /** 封面是用户手动导入的：重扫抽到内嵌图也不许覆盖 */
  coverManual: boolean;
  /** 曲名/歌手/专辑被用户手动校正过：在线刮削不再回填覆盖展示信息 */
  editedMeta: boolean;
  match: LocalMatch | null;
}

export interface ScanState {
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

export interface ScrapeState {
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

interface LibraryDb {
  version: number;
  sources: LocalSource[];
  tracks: Record<string, LocalTrack>;
}

interface StatsSummary {
  tracks: number;
  matched: number;
  withCover: number;
  withLyric: number;
}

// ———————————————————————————————————————————— 路径与存取 ————————————————————————————————————————————

export function libRoot(): string {
  return join(configDir(), "local-library");
}
function dbFile(): string {
  return join(libRoot(), "library.json");
}
function coversDir(): string {
  return join(libRoot(), "covers");
}
function lyricsDir(): string {
  return join(libRoot(), "lyrics");
}

/** 懒建目录：模块加载不碰磁盘（native-server 可独立跑、单测可 import 不副作用）。 */
function ensureLibDirs(): void {
  const root = libRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(coversDir())) mkdirSync(coversDir(), { mode: 0o700 });
  if (!existsSync(lyricsDir())) mkdirSync(lyricsDir(), { mode: 0o700 });
}

/** 写临时 + rename 原子替换，0600（库里有 WebDAV 口令）。 */
function writeFilePrivate(file: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
  try { chmodSync(file, mode); } catch { /* 权限尽力，不影响内容 */ }
}

let cache: LibraryDb | null = null;

function freshDb(): LibraryDb {
  return { version: 1, sources: [], tracks: {} };
}

function loadDb(): LibraryDb {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(dbFile(), "utf8"));
    if (raw && Array.isArray(raw.sources) && raw.tracks && typeof raw.tracks === "object") {
      cache = { version: 1, sources: raw.sources, tracks: raw.tracks };
      return cache;
    }
  } catch (e) {
    const err = e as { code?: string };
    if (err && err.code !== "ENOENT") {
      // 解析失败：留一份损坏副本再重建，别把用户配置无声删掉
      try { renameSync(dbFile(), dbFile() + `.corrupt-${Date.now()}`); } catch { /* 尽力 */ }
      console.warn("[local-library] library.json 解析失败，已备份并重建空库");
    }
  }
  cache = freshDb();
  return cache;
}

function saveDb(): void {
  const db = loadDb();
  ensureLibDirs();
  writeFilePrivate(dbFile(), JSON.stringify(db));
}

/** 渲染层可见的源视图：剔除口令。 */
function maskSource(s: LocalSource): LocalSource {
  const { password: _pw, ...rest } = s;
  void _pw;
  return rest;
}

// ———————————————————————————————————————————— 状态（内存态，重启即清） ————————————————————————————————————————————

export const scanState: ScanState = { running: false, processed: 0, found: 0, kept: 0, removed: 0, errors: [], startedAt: 0, finishedAt: 0, lastError: "" };
export const scrapeState: ScrapeState = { running: false, total: 0, processed: 0, matched: 0, unmatched: 0, failed: 0, startedAt: 0, finishedAt: 0, lastError: "" };
let scanFlight: Promise<void> | null = null;
let scrapeFlight: Promise<void> | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 让出事件循环：扫描/刮削是长任务，别饿死同进程的 HTTP 服务。 */
async function yieldLoop(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

const idOf = (sourceId: string, relPath: string) => "t_" + createHash("sha1").update(`${sourceId}\u0000${relPath}`).digest("hex").slice(0, 12);

function normText(s: string): string {
  return String(s ?? "").normalize("NFKC").toLowerCase()
    .replace(/[\s\u3000·、,，.。\-_—–~!！?？()（）\[\]【】{}《》'"“”‘’/\\|:&;]/g, "");
}

// ———————————————————————————————————————————— 读窗口（folder / webdav 统一抽象） ————————————————————————————————————————————

export interface WindowReader {
  size: number;
  /** 读 [from, min(to, size))；不足量给短 Buffer（EOF 正常） */
  read(from: number, to: number): Promise<Buffer>;
}

async function openFolderReader(file: string, size: number): Promise<{ reader: WindowReader; close(): Promise<void> }> {
  const fsp = await import("node:fs/promises");
  const fh = await fsp.open(file, "r");
  return {
    reader: {
      size,
      async read(from, to) {
        const len = Math.max(0, Math.min(to, size) - from);
        if (len === 0) return Buffer.alloc(0);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, from);
        return buf.subarray(0, bytesRead);
      },
    },
    close: () => fh.close(),
  };
}

function webdavReader(url: string, auth: DavAuth | undefined, size: number): WindowReader {
  return {
    size,
    read: (from, to) => davReadRange(url, from, Math.min(to, size), auth),
  };
}

// ———————————————————————————————————————————— 标签提取（吃 WindowReader） ————————————————————————————————————————————

const TAG_WINDOW = 256 * 1024;      // 首选窗口
const TAG_WINDOW_BIG = 8 * 1024 * 1024; // 注释/封面截断时扩窗上限
const ID3_MAX = 20 * 1024 * 1024;   // ID3v2 尺寸疯涨的止损线

/** 解析一个音频文件的标签/时长/封面。dirHints：路径目录段（专辑名兜底用）。 */
export async function extractTags(reader: WindowReader, fileName: string, dirHints: string[] = []): Promise<FileTags> {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const head = await reader.read(0, TAG_WINDOW);
  const out = emptyTags(sniffFormat(head, ext));
  let tagHit: TagSource | null = null;

  const bump = (src: TagSource) => { if (!tagHit) tagHit = src; };

  if (out.format === "mp3") {
    let win = head;
    const id3 = parseId3v2(win);
    if (id3) {
      if (!id3.complete && id3.tagSize <= ID3_MAX) {
        win = await reader.read(0, Math.min(reader.size, id3.tagSize));
        const full = parseId3v2(win);
        if (full) {
          mergeId3(full, out);
          if (full.title || full.artist || full.lyrics || full.picture) bump("id3v2");
        }
      } else {
        mergeId3(id3, out);
        if (id3.title || id3.artist || id3.lyrics || id3.picture) bump("id3v2");
      }
    }
    const start = mp3AudioStart(win);
    const dur = mp3Duration(win, start, Math.max(0, reader.size - start));
    if (dur) { out.durationSec = dur.durationSec; out.bitrateKbps ||= dur.bitrateKbps; }
    if (!out.title && reader.size > 128) {
      const tail = await reader.read(reader.size - 128, reader.size);
      const v1 = parseId3v1(tail);
      if (v1 && v1.title) { mergeId3(v1, out); bump("id3v1"); }
    }
  } else if (out.format === "flac") {
    let r = parseFlac(head, out);
    if (r.needMore && reader.size > TAG_WINDOW) {
      const win = await reader.read(0, Math.min(reader.size, TAG_WINDOW_BIG));
      r = parseFlac(win, out);
    }
    if (out.title || out.artist || out.picture || out.lyrics) bump("flac");
  } else if (out.format === "ogg") {
    let r = parseOgg(head, out);
    if (r.needMore && reader.size > TAG_WINDOW) {
      const win = await reader.read(0, Math.min(reader.size, TAG_WINDOW_BIG));
      r = parseOgg(win, out);
    }
    if (out.title || out.artist || out.picture || out.lyrics) bump("vorbis");
  } else if (out.format === "m4a") {
    const sawMoov = parseMp4(head, out);
    if (!sawMoov && reader.size > TAG_WINDOW) {
      // 未 faststart：moov 在尾部。尾窗再试一次（mp4 盒从窗口任意处起，靠按魔数定位）
      const tailStart = Math.max(0, reader.size - TAG_WINDOW_BIG);
      const tail = await reader.read(tailStart, reader.size);
      const idx = tail.indexOf("moov", 0, "latin1");
      if (idx >= 8) {
        const sizeAt = ((tail[idx - 4] << 24) | (tail[idx - 3] << 16) | (tail[idx - 2] << 8) | tail[idx - 1]) >>> 0;
        const end = Math.min(tail.length, idx - 4 + sizeAt);
        if (sizeAt >= 8 && end > idx + 4) {
          // 造一枚完整 8 字节头的 moov，让 parseMp4 从窗口 0 处走它
          parseMp4(Buffer.concat([u32buf(8 + (end - idx - 4)), Buffer.from("moov", "latin1"), tail.subarray(idx + 4, end)]), out);
        }
      }
    }
    if (out.title || out.artist || out.durationSec || out.picture) bump("mp4");
  } else if (out.format === "wav") {
    parseWav(head, out, reader.size);
    if (!out.title && reader.size > TAG_WINDOW) {
      const tail = await reader.read(Math.max(0, reader.size - TAG_WINDOW), reader.size);
      const idx = tail.indexOf("LIST", 0, "latin1");
      if (idx >= 0 && idx + 8 <= tail.length) parseWavLikeInfo(tail, idx, out);
    }
    if (out.title || out.artist || out.durationSec) bump("riff");
  } else if (out.format === "aiff") {
    parseAiff(head, out);
    if (out.title || out.artist || out.durationSec) bump("aiff");
  }

  // 时长未知但容器字节在手 → 平均码率反推（有损/无损都够用）
  if (!out.bitrateKbps && out.durationSec > 0) out.bitrateKbps = Math.round((reader.size * 8) / out.durationSec / 1000);

  if (!out.title || !out.artist) {
    const fn = parseFilename(fileName);
    if (!out.title) out.title = fn.title;
    if (!out.artist) out.artist = fn.artist;
    if (!out.trackNo) out.trackNo = fn.trackNo;
    if (!tagHit) tagHit = "filename";
    if (!out.album && dirHints.length) {
      // 常见整理法 …/<专辑>/<曲>.ext：最里层目录当专辑（明显是根/年份目录的除外）
      const inner = dirHints[dirHints.length - 1];
      if (inner && inner.length > 1 && !/^(music|audio|flac|mp3|专辑|歌手|artists?|discs?|cd\d+|\d{4})$/i.test(inner)) out.album = inner;
    }
  }
  out.tagSource = tagHit ?? "none";
  return out;
}

function u32buf(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** WAV 尾窗里捡到 LIST/INFO 子块（parseWav 只在窗口从 RIFF 起时能扫到，这里补一次定点扫）。 */
function parseWavLikeInfo(buf: Buffer, listOff: number, out: FileTags): void {
  if (buf.toString("latin1", listOff + 8, listOff + 12) !== "INFO") return;
  const size = buf.readUInt32LE(listOff + 4);
  let q = listOff + 12;
  const end = Math.min(buf.length, listOff + 8 + size);
  while (q + 8 <= end) {
    const fid = buf.toString("latin1", q, q + 4);
    const fs = buf.readUInt32LE(q + 4);
    if (q + 8 + fs > buf.length) break;
    const v = buf.toString("utf8", q + 8, q + 8 + fs).replace(/\u0000+$/, "").trim();
    mergeId3(
      fid === "INAM" ? { title: v } : fid === "IART" ? { artist: v } : fid === "INAL" ? { album: v } : {},
      out,
    );
    q += 8 + fs + (fs % 2);
  }
}

// ———————————————————————————————————————————— 曲目入库 ————————————————————————————————————————————

function pictureExt(p: EmbeddedPicture): string {
  if (p.mime.includes("png")) return "png";
  if (p.mime.includes("gif")) return "gif";
  if (p.mime.includes("webp")) return "webp";
  return "jpg";
}

async function ensureTrackForFolder(src: LocalSource, absFile: string, relPath: string, st: { size: number; mtimeMs: number }, force: boolean): Promise<"new" | "updated" | "kept" | "error"> {
  const db = loadDb();
  const id = idOf(src.id, relPath);
  const prev = db.tracks[id];
  if (prev && !force && prev.size === st.size && Math.abs(prev.mtime - st.mtimeMs) < 1000) return "kept";

  let tags: FileTags;
  const opened = await openFolderReader(absFile, st.size);
  try {
    tags = await extractTags(opened.reader, relPath.split("/").pop() ?? absFile, relPath.split("/").slice(0, -1));
  } finally {
    await opened.close().catch(() => {});
  }
  const track = await materializeTrack({
    id, sourceId: src.id, relPath, file: absFile, tags,
    size: st.size, mtime: st.mtimeMs, prev,
    sidecarLrc: findSidecarLrc(dirname(absFile), relPath),
  });
  db.tracks[id] = track;
  return prev ? "updated" : "new";
}

/** 同目录找 .lrc/.lyric sidecar（同名优先；.txt 太杂，不进）。 */
function findSidecarLrc(dir: string, relPath: string): { rel: string; file: string } | null {
  const stem = relPath.replace(/\.[^.]+$/, "");
  for (const ext of [".lrc", ".lyric", ".LRC"]) {
    const f = join(dir, stem.slice(stem.lastIndexOf("/") + 1) + ext);
    if (existsSync(f)) return { rel: stem + ext.toLowerCase(), file: f };
  }
  return null;
}

/** WebDAV 目录列表里找同名 .lrc：按**文件名**匹配（e.path 是服务器绝对路径，不能拿相对路径比）。 */
function findSidecarLrcDav(entries: DavEntry[], relPath: string): DavEntry | null {
  const stem = relPath.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() ?? "";
  if (!stem) return null;
  return entries.find((e) => !e.isCollection && e.name.toLowerCase() === stem + ".lrc") ?? null;
}

async function materializeTrack(args: {
  id: string; sourceId: string; relPath: string; file: string;
  tags: FileTags; size: number; mtime: number; prev?: LocalTrack;
  sidecarLrc?: { rel: string; file: string } | null;
}): Promise<LocalTrack> {
  const { id, sourceId, relPath, file, tags, size, mtime, prev, sidecarLrc } = args;
  ensureLibDirs();
  // 旧内嵌封面/歌词文件先摘除（QQ 下载件由 match.coverQq 区分，见下）
  const coverRelOld = prev?.coverRel ?? "";
  const isQqCover = !!prev?.match?.coverQq;
  const embedLyricOld = prev?.lyricSource === "embed";

  let coverRel = "";
  if (prev?.coverManual && coverRelOld && existsSync(join(libRoot(), coverRelOld))) {
    // 手动导入的封面最高优先：重扫抽到内嵌图也不动它
    coverRel = coverRelOld;
  } else if (tags.picture && tags.picture.data.length >= 64 && tags.picture.data.length <= 20 * 1024 * 1024) {
    coverRel = `covers/${id}.${pictureExt(tags.picture)}`;
    writeFilePrivate(join(libRoot(), coverRel), tags.picture.data, 0o600);
  } else if (isQqCover && existsSync(join(coversDir(), `${id}.jpg`))) {
    // 这次没抽出内嵌图，但旧的 QQ 下载件还在 → 保留引用
    coverRel = `covers/${id}.jpg`;
  }
  if (coverRelOld && coverRelOld !== coverRel) {
    try { rmSync(join(libRoot(), coverRelOld)); } catch { /* 尽力 */ }
  }
  if (!isQqCover && !prev?.coverManual && coverRel !== `covers/${id}.jpg`) {
    try { rmSync(join(coversDir(), `${id}.jpg`)); } catch { /* QQ 件不再被引用：清掉防孤儿 */ }
  }

  const lyricFileRel = `lyrics/${id}.txt`;
  if (tags.lyrics.trim()) {
    writeFilePrivate(join(libRoot(), lyricFileRel), tags.lyrics, 0o600);
  } else {
    if (embedLyricOld) try { rmSync(join(libRoot(), lyricFileRel)); } catch { /* 尽力 */ }
  }

  const qqSidecar = `lyrics/${id}.json`;
  const match = prev?.match ?? null;
  const keepMatch = !!(match && prev && prev.sourceId === sourceId); // 重扫保留在线刮削结果（源没变才保）

  let lyricSource: LyricSourceKind = "";
  let lyricRel = "";
  let importFormat = prev?.importFormat ?? "";
  let coverManual = prev?.coverManual ?? false;
  const editedMeta = prev?.editedMeta ?? false;
  if (prev?.lyricSource === "import" && existsSync(join(lyricsDir(), `${id}.import`))) {
    // 手动导入的歌词赢过一切自动来源（重扫/换文件都不冲掉，是用户的显式意图）
    lyricSource = "import";
  } else if (sidecarLrc) { lyricSource = "file"; lyricRel = sidecarLrc.rel; }
  else if (tags.lyrics.trim()) { lyricSource = "embed"; lyricRel = lyricFileRel; }
  else if (keepMatch && match?.lyricQq && existsSync(join(libRoot(), qqSidecar))) { lyricSource = "qq"; }

  return {
    id, sourceId, relPath, file,
    format: tags.format, title: tags.title, artist: tags.artist, albumArtist: tags.albumArtist,
    album: tags.album, year: tags.year, genre: tags.genre, trackNo: tags.trackNo, discNo: tags.discNo,
    durationSec: Math.round(tags.durationSec * 10) / 10, bitrateKbps: tags.bitrateKbps,
    size, mtime, tagSource: tags.tagSource,
    coverRel, lyricSource, lyricRel, importFormat, coverManual, editedMeta,
    match: keepMatch && match ? match : null,
  };
}

// ———————————————————————————————————————————— 扫描 ————————————————————————————————————————————

export function startScan(): { started: boolean; busy?: true; error?: string } {
  if (scanFlight && scanState.running) return { started: false, busy: true };
  scanState.running = true;
  scanState.processed = scanState.found = scanState.kept = scanState.removed = 0;
  scanState.errors = [];
  scanState.startedAt = Date.now();
  scanState.finishedAt = 0;
  scanState.lastError = "";
  scanFlight = (async () => {
    try {
      const db = loadDb();
      const sources = db.sources.slice();
      const aliveIds = new Set<string>();
      for (const src of sources) {
        try {
          await scanSource(src, aliveIds);
        } catch (e) {
          pushError(scanState, `「${src.name}」扫描失败：${errText(e)}`);
        }
      }
      // 源已删除的曲目整体清出（顺带清它的封面/歌词缓存件）
      const srcIds = new Set(sources.map((s) => s.id));
      for (const [id, t] of Object.entries(loadDb().tracks)) {
        if (!srcIds.has(t.sourceId)) { dropTrackAssets(id, t); delete loadDb().tracks[id]; scanState.removed++; }
      }
      saveDb();
      // 扫描发现了新曲目 → 自动补一轮「未匹配刮削」（串行、限速、宁缺毋滥，见 startScrape）。
      // 这一步不只是补元数据：匹配到 QQ 曲库（match.qqMid）是本地曲目吃到**在线 QRC 逐字歌词**
      // 的前置条件 —— player.fetchLyric 对有 qqMid 的本地曲优先走 /song/<qqMid>/lyric?qrc=1，
      // 拿不到才落回本地通路（sidecar .lrc > 缓存 > 内嵌）。没有新歌就不自动跑，免得每次扫描都白打网络。
      if (scanState.found > 0 && Object.values(loadDb().tracks).some((t) => !t.match)) {
        console.log("[local-library] 扫描发现新曲目，自动刮削未匹配段");
        startScrape({});
      }
    } catch (e) {
      scanState.lastError = errText(e);
      pushError(scanState, errText(e));
    } finally {
      scanState.running = false;
      scanState.finishedAt = Date.now();
    }
  })();
  void scanFlight.finally(() => { scanFlight = null; });
  return { started: true };
}

async function scanSource(src: LocalSource, aliveIds: Set<string>): Promise<void> {
  const db = loadDb();
  const seen = new Set<string>();
  if (src.kind === "folder") {
    const root = resolve(src.path ?? "");
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`目录不存在：${root}`);
    const files: { abs: string; rel: string }[] = [];
    await walkFolder(root, root, 0, files);
    for (const f of files) {
      scanState.processed++;
      try {
        const st = statSync(f.abs);
        if (!st.isFile() || st.size === 0) continue;
        seen.add(idOf(src.id, f.rel));
        const r = await ensureTrackForFolder(src, f.abs, f.rel, { size: st.size, mtimeMs: Math.round(st.mtimeMs) }, false);
        if (r === "new") scanState.found++;
        else if (r === "updated") scanState.found++;
        else scanState.kept++;
      } catch (e) {
        pushError(scanState, `${f.rel}：${errText(e)}`);
      }
      if (scanState.processed % 16 === 0) await yieldLoop();
    }
  } else {
    const auth: DavAuth = { username: src.username, password: src.password };
    const rootHref = new URL(src.url ?? "").pathname;
    // BFS：队列元素 = 目录（服务器绝对路径 + 库内相对路径）
    const dirQ: { hrefPath: string; rel: string; depth: number }[] = [{ hrefPath: rootHref, rel: "", depth: 0 }];
    const origin = new URL(src.url ?? "").origin;
    while (dirQ.length) {
      const dir = dirQ.shift()!;
      const base = dir.hrefPath.replace(/\/+$/, "") + "/";
      const entries = await propfind(origin + encodePath(base), auth);
      for (const e of entries) {
        // 只吃「这个目录的直接子项」：href 必须以本目录为前缀（防 /Music 与 /Music2 同头误判）
        if (!e.path.startsWith(base)) continue;
        const rel = e.path.slice(base.length).replace(/\/+$/, "");
        if (!rel || rel.includes("/")) continue;
        if (e.isCollection) {
          if (dir.depth < 7) dirQ.push({ hrefPath: e.path.replace(/\/+$/, ""), rel, depth: dir.depth + 1 });
          continue;
        }
        if (!isAudioFile(e.name)) continue;
        scanState.processed++;
        try {
          seen.add(idOf(src.id, rel));
          const id = idOf(src.id, rel);
          const prev = db.tracks[id];
          if (!(prev && prev.size === e.size && Math.abs(prev.mtime - e.mtime) < 1000)) {
            const url = origin + encodePath(e.path);
            const lrc = findSidecarLrcDav(entries, rel);
            const reader = webdavReader(url, auth, e.size);
            const tags = await extractTags(reader, e.name, rel.split("/").slice(0, -1));
            const lrcRel = lrc ? rel.replace(/[^/]*$/, lrc.name) : "";
            db.tracks[id] = await materializeTrack({
              id, sourceId: src.id, relPath: rel, file: url, tags, size: e.size, mtime: e.mtime, prev,
              sidecarLrc: lrc && lrcRel ? { rel: lrcRel, file: lrc.path } : null,
            });
            scanState.found++;
          } else {
            seen.add(id);
            scanState.kept++;
          }
        } catch (e2) {
          pushError(scanState, `${rel}：${errText(e2)}`);
        }
        if (scanState.processed % 4 === 0) await yieldLoop();
      }
    }
  }
  // 本源清尾：上次在库、这次没再见到的条目删除（文件删了/移走了）
  for (const [id, t] of Object.entries(db.tracks)) {
    if (t.sourceId === src.id && !seen.has(id)) { dropTrackAssets(id, t); delete db.tracks[id]; scanState.removed++; }
  }
  for (const id of seen) aliveIds.add(id);
}

async function walkFolder(base: string, dir: string, depth: number, out: { abs: string; rel: string }[]): Promise<void> {
  if (depth > 8) return;
  const { readdir } = await import("node:fs/promises");
  const ents = await readdir(dir, { withFileTypes: true });
  for (const ent of ents) {
    if (ent.name.startsWith(".") || ent.name === "lost+found") continue;
    const abs = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue; // 不做软链跳转：环路与越界都从源头掐掉
    if (ent.isDirectory()) { await walkFolder(base, abs, depth + 1, out); continue; }
    if (!ent.isFile()) continue;
    if (!isAudioFile(ent.name)) continue;
    out.push({ abs, rel: toPosix(rel0(abs, base)) }); // rel 永远相对**源根**：id 由它派生，必须稳定唯一
  }
}

function rel0(abs: string, root: string): string {
  const r = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return r.replace(/^[/\\]+/, "");
}
const toPosix = (p: string) => p.split(sep).join("/");

function dropTrackAssets(id: string, t: LocalTrack): void {
  for (const rel of [t.coverRel, `lyrics/${id}.txt`, `lyrics/${id}.json`, `lyrics/${id}.import`]) {
    if (!rel) continue;
    try { rmSync(join(libRoot(), rel)); } catch { /* 尽力 */ }
  }
}

function pushError(state: { errors: string[] }, msg: string): void {
  if (state.errors.length < 50 && !state.errors.includes(msg)) state.errors.push(msg);
}

function errText(e: unknown): string {
  if (e instanceof DavError) return e.message;
  const err = e as { code?: string; message?: string };
  if (err?.code === "ENOENT") return "文件不存在";
  if (err?.code === "EACCES" || err?.code === "EPERM") return "无权限读取";
  return String(err?.message ?? e ?? "未知错误");
}

// ———————————————————————————————————————————— 在线刮削（QQ 侧：歌曲信息 + 歌词 + 封面） ————————————————————————————————————————————

function sidecarBase(): string {
  return String(process.env.QUAVER_API ?? "http://127.0.0.1:3200").replace(/\/+$/, "");
}

async function sidecarGet<T = any>(pathWithQuery: string, timeoutMs = 15000): Promise<T> {
  const r = await fetch(sidecarBase() + pathWithQuery, { signal: AbortSignal.timeout(timeoutMs) });
  let j: any = null;
  try { j = await r.json(); } catch { throw new Error(`sidecar HTTP ${r.status}（非 JSON）`); }
  if (!r.ok || (typeof j?.code === "number" && j.code !== 0)) throw new Error(String(j?.msg ?? `sidecar HTTP ${r.status}`));
  return j.data as T;
}

function searchKeyword(t: LocalTrack): string {
  const parts = [t.title, t.artist || t.albumArtist].filter((x) => String(x ?? "").trim());
  if (parts.length >= 2) return parts.join(" ");
  return parts[0] ?? "";
}

interface SearchSongLite {
  mid?: string; title?: string; name?: string; interval?: number;
  singer?: { name?: string; mid?: string }[];
  album?: { name?: string; mid?: string; pmid?: string };
}

/** 打分：歌名吻合是硬门槛，歌手/专辑加分。 */
function scoreMatch(t: LocalTrack, c: SearchSongLite): number {
  if (!c?.mid) return 0;
  const ct = normText(c.title || c.name || "");
  const want = normText(t.title);
  if (!ct || !want) return 0;
  let score = 0;
  if (ct === want) score += 3;
  else if (ct.includes(want) || want.includes(ct)) score += 2;
  else return 0; // 歌名都不沾：直接否（宁缺毋滥，绝不错配）
  const artist = normText(t.artist || t.albumArtist);
  const singers = (c.singer ?? []).map((s) => normText(s?.name ?? ""));
  if (artist) {
    if (singers.some((s) => s === artist)) score += 2;
    else if (singers.some((s) => s.includes(artist) || artist.includes(s))) score += 1;
  }
  const album = normText(t.album);
  if (album && c.album?.name && normText(c.album.name).includes(album)) score += 0.5;
  return score;
}

export function startScrape(opts: { ids?: string[]; all?: boolean; force?: boolean } = {}): { started: boolean; busy?: true; total: number } {
  if (scrapeFlight && scrapeState.running) return { started: false, busy: true, total: scrapeState.total };
  const db = loadDb();
  let targets: LocalTrack[];
  if (opts.ids?.length) targets = opts.ids.map((id) => db.tracks[id]).filter(Boolean);
  else targets = Object.values(db.tracks).filter((t) => opts.force || !t.match || (opts.all && !t.lyricSource));
  if (!targets.length) return { started: true, total: 0 };
  scrapeState.running = true;
  scrapeState.total = targets.length;
  scrapeState.processed = scrapeState.matched = scrapeState.unmatched = scrapeState.failed = 0;
  scrapeState.startedAt = Date.now();
  scrapeState.finishedAt = 0;
  scrapeState.lastError = "";
  const work = targets.map((t) => t.id);
  scrapeFlight = (async () => {
    let changed = false;
    try {
      for (const id of work) {
        const t = loadDb().tracks[id];
        if (!t) continue;
        try {
          const res = await scrapeTrack(t, !!opts.force);
          if (res === "matched") scrapeState.matched++;
          else if (res === "unmatched") scrapeState.unmatched++;
          else if (res === "skip") { /* 已有且未 force */ }
          if (res !== "error") changed = true;
          else scrapeState.failed++;
        } catch (e) {
          scrapeState.failed++;
          scrapeState.lastError = errText(e);
        }
        scrapeState.processed++;
        if (scrapeState.processed % 8 === 0) { saveDb(); }
        await yieldLoop();
        await sleep(250); // 上游限流：串行 + 间隔，宁慢勿封
      }
      if (changed) saveDb();
    } catch (e) {
      scrapeState.lastError = errText(e);
    } finally {
      scrapeState.running = false;
      scrapeState.finishedAt = Date.now();
    }
  })();
  void scrapeFlight.finally(() => { scrapeFlight = null; });
  return { started: true, total: targets.length };
}

export type ScrapeOutcome = "matched" | "unmatched" | "skip" | "error";

async function scrapeTrack(t: LocalTrack, force: boolean): Promise<ScrapeOutcome> {
  if (!force && t.match && t.match.lyricQq && t.match.coverQq) return "skip";
  const kw = searchKeyword(t);
  if (!kw) return "error";
  let data: { song?: SearchSongLite[] };
  try {
    data = await sidecarGet(`/search?keyword=${encodeURIComponent(kw)}&type=0&page=1&num=10`);
  } catch (e) {
    t.match = t.match ?? null;
    scrapeState.lastError = errText(e);
    return "error";
  }
  const cands = (data?.song ?? []).map((c) => ({ c, s: scoreMatch(t, c) })).filter((x) => x.s >= 3);
  if (!cands.length) return "unmatched";
  cands.sort((a, b) => b.s - a.s);
  const best = cands[0].c;
  const mid = String(best.mid);

  // 歌词（LRC 行级，顺带翻译/音译；别拉 QRC，格式留给 Sparkle 逐字管线之外）
  let lyricQq = t.match?.lyricQq ?? false;
  if (force || !lyricQq) {
    try {
      const l = await sidecarGet(`/song/${encodeURIComponent(mid)}/lyric?trans=1&roma=1`);
      const raw = String(l?.lyric ?? "");
      if (raw.trim()) {
        ensureLibDirs();
        writeFilePrivate(join(lyricsDir(), `${t.id}.json`), JSON.stringify({ lyric: raw, trans: String(l?.trans ?? ""), roma: String(l?.roma ?? "") }), 0o600);
        lyricQq = true;
      }
    } catch { /* 歌词失败不判整体失败 */ }
  }

  // 封面：无内嵌件时下载 QQ 专辑封面（500x500）
  let coverQq = t.match?.coverQq ?? false;
  const picBase = (best.album?.pmid ?? "").split("_")[0] || best.album?.mid || "";
  if (!t.coverRel && picBase && (force || !coverQq)) {
    try {
      const r = await fetch(`https://y.gtimg.cn/music/photo_new/T002R500x500M000${picBase}.jpg`, { signal: AbortSignal.timeout(15000) });
      const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
      if (buf.length >= 1024 && buf.length <= 8 * 1024 * 1024 && buf[0] === 0xff && buf[1] === 0xd8) {
        ensureLibDirs();
        writeFilePrivate(join(coversDir(), `${t.id}.jpg`), buf, 0o600);
        coverQq = true;
      }
    } catch { /* 网络图失败：继续 */ }
  }

  // 标签回填：文件本身没标签（filename 兜底）时，展示信息整体交给在线结果；
  // 但用户手动校正过（track/edit 置 editedMeta）的字段是权威 —— 只借匹配拿 id/封面/词，不改写展示。
  const tagWasGuess = (t.tagSource === "filename" || t.tagSource === "none") && !t.editedMeta;
  if (tagWasGuess) {
    t.title = best.title || best.name || t.title;
    t.artist = (best.singer ?? []).map((s) => s?.name).filter(Boolean).join(" / ") || t.artist;
    t.album = best.album?.name || t.album;
  }
  if (!t.durationSec && best.interval) t.durationSec = best.interval;
  t.coverRel = t.coverRel || (coverQq ? `covers/${t.id}.jpg` : "");
  if (!t.lyricSource && lyricQq) t.lyricSource = "qq";

  t.match = {
    qqMid: mid,
    title: best.title || best.name || t.title,
    artist: (best.singer ?? []).map((s) => s?.name).filter(Boolean).join(" / "),
    album: best.album?.name ?? "",
    year: t.year,
    singerMid: best.singer?.[0]?.mid ?? "",
    albumMid: best.album?.mid ?? "",
    albumPmid: best.album?.pmid ?? "",
    coverQq, lyricQq,
    scrapedAt: Date.now(),
  };
  return "matched";
}

// ———————————————————————————————————————————— 手动导入：base64 / 格式嗅探 ————————————————————————————————————————————

/** 解 base64 并卡体积；非法输入返回 null（渲染层 FileReader 产物就一条通路，宽容到能忍空白）。 */
function decodeBase64Cap(data: string, cap: number): Buffer | null {
  const raw = data.replace(/\s+/g, "").replace(/^data:[^,]*,/, "");
  if (!raw || raw.length > Math.ceil((cap * 4) / 3) + 8) return null;
  let buf: Buffer;
  try { buf = Buffer.from(raw, "base64"); } catch { return null; }
  if (!buf.length || buf.length > cap) return null;
  return buf;
}

/** 歌词格式判定：先看内容特征，文件名只当辅助证据。 */
export function sniffLyricFormat(text: string, name = ""): "lrc" | "qrc" | "ttml" {
  const c = text.slice(0, 4096);
  if (/<tt[\s>]|<ttml|xmlns="[^"]*ttml/i.test(c)) return "ttml";
  if (/<QrcInfos|<LyricInfo|<LyricContent|<\/?[wW]\b[^>]*>|^\[\d{1,3},\d+\]/m.test(c)) return "qrc";
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  if (ext === ".ttml" || ext === ".xml" && /ttml/i.test(text)) return "ttml";
  if (ext === ".qrc") return "qrc";
  return "lrc";
}


/** 本地 TTML 歌词库的候选文件（相对库根，纯函数供单测）。命名兼容三种习惯：
 *  ① AMLL TTML 数据库（amll-dev/amll-ttml-db）仓库克隆布局：qq-lyrics/<songmid>.ttml（或 id 平铺）；
 *  ② 「歌名-歌手.ttml」/「歌手-歌名.ttml」（连字符两侧空格两种写法都试；多歌手逐个拆）；
 *  ③ 「歌名.ttml」。
 *  候选名里会拼路径的字符（分隔符/控制字符）替换成空格 —— 这些名字**只**在库目录内做拼装，
 *  目录本身来自 quaver.conf，请求参数指不到库外（同 /api/bg 红线；消费侧还有一道 resolve 包含校验）。 */
export function ttmlLibraryCandidates(q: { qq?: string; name?: string; artist?: string }): string[] {
  const safe = (v: string) => String(v ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  const qq = safe(q.qq ?? "");
  if (/^[A-Za-z0-9._-]{1,80}$/.test(qq)) { out.push(join("qq-lyrics", `${qq}.ttml`), `${qq}.ttml`); }
  const name = safe(q.name ?? "");
  const artists = [...new Set(String(q.artist ?? "").split(",").map((a) => safe(a)).filter(Boolean))];
  if (!name) return out;
  for (const a of artists) {
    for (const dash of ["-", " - "]) {
      out.push(`${name}${dash}${a}.ttml`, `${a}${dash}${name}.ttml`);
    }
  }
  out.push(`${name}.ttml`);
  return out;
}

/** 在配置的库目录里找这份歌的 TTML：候选逐个试，只吃「库内 + 普通文件 + 嗅探是 TTML + ≤512KB」。
 *  目录真相恒取自 quaver.conf 的 [Lyrics] TtmlLibrary（请求参数不参与拼库路径）。 */
function findLocalTtml(q: { qq?: string; name?: string; artist?: string }, env: Env = process.env): { rel: string; text: string } | null {
  if (!existsSync(configFile(env))) return null; // 配置文件还没落地：只读 GET 不该顺手写模板（读值会触发）
  const dir = String(readValues(env).values["Lyrics.TtmlLibrary"] ?? "").trim();
  if (!dir) return null;
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  for (const rel of ttmlLibraryCandidates(q)) {
    const abs = resolve(root, rel);
    if (abs === root || !abs.startsWith(root + sep)) continue; // 拼装名万一指到库外：丢
    try {
      if (!statSync(abs).isFile() || statSync(abs).size > 512 * 1024) continue;
      const text = decodeLrc(readFileSync(abs));
      if (sniffLyricFormat(text, abs) !== "ttml") continue;
      return { rel, text };
    } catch { /* 不存在/读不动：下一个候选 */ }
  }
  return null;
}

/** 图片魔数判格式（只认四种，与内嵌封面通路同一套落盘名 covers/<id>.<ext>）。 */
export function imageFormat(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.length >= 4 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6))) return "gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return "";
}

// ———————————————————————————————————————————— 歌词解析（import > file > qq > embed） ————————————————————————————————————————————

/** 尽力解码 LRC：UTF-8/BOM → GBK → latin1。GBK 依赖 Node 的 full-icu TextDecoder。 */
export function decodeLrc(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* 非 UTF-8 */ }
  try { return new TextDecoder("gbk").decode(buf); } catch { /* 无 ICU */ }
  return buf.toString("latin1");
}

async function resolveLyric(t: LocalTrack, src: LocalSource): Promise<{ lyric: string; trans: string; roma: string; source: string; format: string }> {
  let qq: { lyric?: string; trans?: string; roma?: string } | null = null;
  try {
    const p = join(lyricsDir(), `${t.id}.json`);
    if (existsSync(p)) qq = JSON.parse(readFileSync(p, "utf8"));
  } catch { qq = null; }
  const main = { lyric: "", trans: qq?.trans ?? "", roma: qq?.roma ?? "", source: "", format: "lrc" };
  // ① 手动导入件恒胜（渲染层按 format 选解析路：lrc 直读；qrc/ttml 交逐字提供器或行级兜底转换）
  if (t.lyricSource === "import") {
    try {
      const p = join(lyricsDir(), `${t.id}.import`);
      if (existsSync(p) && statSync(p).size <= 512 * 1024) {
        main.lyric = readFileSync(p, "utf8");
        main.source = "import";
        main.format = t.importFormat || sniffLyricFormat(main.lyric);
        return main;
      }
    } catch { /* 文件被清：继续走自动链 */ }
  }
  if (t.lyricSource === "file" && t.lyricRel) {
    try {
      if (src.kind === "folder") {
        const p = join(src.path ?? "", t.lyricRel);
        if (existsSync(p) && statSync(p).size <= 512 * 1024) {
          main.lyric = decodeLrc(readFileSync(p));
          main.source = "file";
        }
      } else {
        const u = new URL(src.url ?? "");
        const base = u.origin + u.pathname.replace(/\/+$/, "");
        main.lyric = decodeLrc(await davReadRange(`${base}/${encodePath(t.lyricRel)}`, 0, 512 * 1024, { username: src.username, password: src.password }));
        main.source = "file";
      }
    } catch { /* 回落下一级 */ }
  }
  if (!main.lyric && qq?.lyric?.trim()) { main.lyric = qq.lyric; main.source = "qq"; }
  if (!main.lyric) {
    try {
      const p = join(lyricsDir(), `${t.id}.txt`);
      if (existsSync(p)) { main.lyric = decodeLrc(readFileSync(p)); main.source = "embed"; }
    } catch { /* 无 */ }
  }
  void t;
  return main;
}

/** 与 folder 遍历共用：绝对路径的相对段要逐段 encodeURIComponent 再拼（保留 /）。 */
function encodePath(p: string): string {
  return p.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** WebDAV relPath 直接拼回 href 路径（relPath 各段已解码语义，需要再编码）。 */
function davStreamUrl(src: LocalSource, relPath: string): string {
  const u = new URL(src.url ?? "");
  const base = u.origin + u.pathname.replace(/\/+$/, "");
  return `${base}/${encodePath(relPath)}`;
}

// ———————————————————————————————————————————— HTTP：Range 音频 / 封面 / 歌词 ————————————————————————————————————————————

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries(JSON_HEADERS)) res.setHeader(k, v);
  res.end(JSON.stringify({ code: 0, msg: "ok", data }));
}

function jsonErr(res: ServerResponse, status: number, msg: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ code: -status, msg }));
}

function mimeByExt(file: string): string {
  const e = extname(file).toLowerCase();
  const MAP: Record<string, string> = {
    ".mp3": "audio/mpeg", ".mp2": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg",
    ".opus": "audio/ogg", ".m4a": "audio/mp4", ".m4b": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
    ".aif": "audio/aiff", ".aiff": "audio/aiff", ".ape": "audio/ape", ".wv": "audio/wavpack", ".mpc": "audio/musepack",
    ".dsf": "audio/x-dsf", ".dff": "audio/x-dff", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  return MAP[e] ?? "application/octet-stream";
}

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

interface ByteRange { start: number; end: number }

/** 单区间 Range（<audio>/mpv 都只发单区间；杂七杂八一律当无 Range，语义最稳）。 */
function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = RANGE_RE.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    const start = Math.max(0, size - Math.min(n, size));
    return { start, end: size - 1 };
  }
  const start = Number(m[1]);
  let end = m[2] === "" ? size - 1 : Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

async function serveFolderFile(res: ServerResponse, file: string, size: number, req: IncomingMessage, isHead: boolean): Promise<void> {
  const range = parseRange(req.headers.range, size);
  const type = mimeByExt(file);
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-type", type);
  if (range === "invalid") {
    res.statusCode = 416;
    res.setHeader("content-range", `bytes */${size}`);
    res.end();
    return;
  }
  if (!range) {
    res.statusCode = 200;
    res.setHeader("content-length", String(size));
    if (isHead) { res.end(); return; }
    await new Promise<void>((done) => {
      const s = createReadStream(file);
      const fin = () => { s.destroy(); done(); };
      s.on("error", () => done());
      res.on("close", fin);
      s.pipe(res);
    });
    return;
  }
  res.statusCode = 206;
  res.setHeader("content-range", `bytes ${range.start}-${range.end}/${size}`);
  res.setHeader("content-length", String(range.end - range.start + 1));
  if (isHead) { res.end(); return; }
  await new Promise<void>((done) => {
    const s = createReadStream(file, { start: range.start, end: range.end });
    const fin = () => { s.destroy(); done(); };
    s.on("error", () => done());
    res.on("close", fin);
    s.pipe(res);
  });
}

async function serveWebdavFile(res: ServerResponse, src: LocalSource, relPath: string, req: IncomingMessage, size: number, isHead: boolean): Promise<void> {
  const url = davStreamUrl(src, relPath);
  const range = parseRange(req.headers.range, size);
  if (range === "invalid") {
    res.statusCode = 416;
    res.setHeader("content-range", `bytes */${size}`);
    res.end();
    return;
  }
  const auth = { username: src.username, password: src.password };
  const headers: Record<string, string> = { ...davAuthHeaders(auth) };
  if (range) headers.range = `bytes=${range.start}-${range.end}`;
  let up: Response;
  try {
    up = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    jsonErr(res, 502, `NAS 上游连接失败：${errText(e)}`);
    return;
  }
  if (up.status === 404) { streamAbort(up); return jsonErr(res, 404, "文件不存在"); }
  if (up.status === 401 || up.status === 403) { streamAbort(up); return jsonErr(res, 403, "NAS 拒绝了访问（检查地址与口令）"); }
  if (!up.ok && up.status !== 206) { streamAbort(up); return jsonErr(res, 502, `NAS 上游 ${up.status}`); }
  const target = range ?? { start: 0, end: Math.max(0, size - 1) };
  const upRanged = up.status === 206;
  res.statusCode = range ? 206 : 200;
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-type", up.headers.get("content-type") || mimeByExt(relPath));
  if (range) {
    const cr = upRanged ? up.headers.get("content-range") : null;
    res.setHeader("content-range", cr && /^bytes \d+-\d+\/\d+$/.test(cr) ? cr : `bytes ${target.start}-${target.end}/${size}`);
  }
  res.setHeader("content-length", String(target.end - target.start + 1));
  if (isHead || !up.body) { res.end(); return; }
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.once("close", onClose);
  try {
    const node = Readable.fromWeb(up.body as never);
    // 上游理会了 Range 且区间一致 → 原样转管道；否则（无视 Range 回全量）本地掐头去尾，保住 Range 语义
    const passthrough = upRanged && (!range || (up.headers.get("content-range") ?? "").includes(`${target.start}-${target.end}/`));
    const srcIt = passthrough ? node : sliceBytes(node as AsyncIterable<Buffer>, target.start, target.end);
    await pipeline(srcIt as Readable, res, { signal: ac.signal });
  } catch (e) {
    if (!/AbortError|premature|destroyed|terminated/i.test(String(e))) console.warn(`[local-library] webdav stream aborted: ${e}`);
  } finally {
    res.off("close", onClose);
  }
}

/** 放弃上游响应体（不消费等于留着一条活连接慢慢烧流量） */
function streamAbort(up: Response): void {
  up.body?.cancel().catch(() => {});
}

async function* sliceBytes(it: AsyncIterable<Buffer>, start: number, end: number): AsyncGenerator<Buffer> {
  let off = 0;
  for await (const c of it) {
    const cEnd = off + c.length;
    if (cEnd > start) {
      const from = Math.max(0, start - off);
      const to = Math.min(c.length, end + 1 - off);
      if (to > from) yield c.subarray(from, to);
    }
    off = cEnd;
    if (off > end) return;
  }
}

// ———————————————————————————————————————————— 路由 ————————————————————————————————————————————

const TRACK_ID_RE = /^t_[0-9a-f]{12}$/;
const SRC_ID_RE = /^s_[0-9a-f]{8}$/;

function maskSourceForList(s: LocalSource, db: LibraryDb) {
  const { password: _pw, ...rest } = s;
  void _pw;
  return { ...rest, trackCount: Object.values(db.tracks).filter((t) => t.sourceId === s.id).length };
}

function statsOf(db: LibraryDb): StatsSummary {
  const tracks = Object.values(db.tracks);
  return {
    tracks: tracks.length,
    matched: tracks.filter((t) => !!t.match).length,
    withCover: tracks.filter((t) => !!t.coverRel).length,
    withLyric: tracks.filter((t) => !!t.lyricSource).length,
  };
}

// 曲目对象本身可以整体下发：file 只是路径/URL（口令不在此），且「在文件夹中显示」「复制路径」要用。

/**
 * 处理 /api/local/* 。pathIn 形如 "library" / "stream/t_xx"（不含前导 /api）。
 * 返回 false 表示没接住（调用方继续别的路由）。
 */
export async function handleLocalApi(req: IncomingMessage, res: ServerResponse, pathIn: string): Promise<boolean> {
  const path = String(pathIn ?? "").replace(/^\/+/, "").replace(/^local\/?/, "");
  const db = loadDb();
  const q = new URL(req.url ?? "/", "http://local").searchParams;

  // —— GET /api/local/library ——
  if (req.method === "GET" && path === "library") {
    json(res, {
      sources: db.sources.map((s) => maskSourceForList(s, db)),
      tracks: Object.values(db.tracks),
      stats: statsOf(db),
      scan: scanState,
      scrape: scrapeState,
    });
    return true;
  }
  // —— GET /api/local/track/<id> ——
  let m = /^track\/(t_[0-9a-f]{12})$/.exec(path);
  if (req.method === "GET" && m) {
    const t = db.tracks[m[1]];
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    json(res, { track: t });
    return true;
  }

  // —— POST /api/local/source/add {kind,name,path|url,username?,password?} ——
  if (req.method === "POST" && path === "source/add") {
    const body = await readJsonBody(req).catch(() => null);
    if (!body) { jsonErr(res, 400, "需要 JSON 请求体"); return true; }
    const kind = body.kind === "webdav" ? "webdav" : body.kind === "folder" ? "folder" : null;
    if (!kind) { jsonErr(res, 422, "kind 需为 folder 或 webdav"); return true; }
    const name = String(body.name ?? "").trim().slice(0, 40) || (kind === "folder" ? "本地文件夹" : "NAS (WebDAV)");
    const src: LocalSource = { id: "s_" + randomHex(8), kind, name, addedAt: Date.now() };
    if (kind === "folder") {
      const p = String(body.path ?? "").trim();
      if (!p || !resolve(p)) { jsonErr(res, 422, "缺少目录路径"); return true; }
      const abs = resolve(p);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) { jsonErr(res, 422, `目录不存在：${abs}`); return true; }
      src.path = abs;
    } else {
      const u = String(body.url ?? "").trim();
      let parsed: URL;
      try { parsed = new URL(u); } catch { jsonErr(res, 422, "WebDAV 地址不合法"); return true; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { jsonErr(res, 422, "仅支持 http/https 的 WebDAV"); return true; }
      src.url = parsed.origin + parsed.pathname.replace(/\/+$/, "") + (parsed.search || "");
      if (body.username) src.username = String(body.username).slice(0, 100);
      if (body.password) src.password = String(body.password).slice(0, 200);
      // 立即探一次根目录：连不通就别存坏源
      try { await propfind(src.url, { username: src.username, password: src.password }); }
      catch (e) { jsonErr(res, 502, `WebDAV 探测失败：${errText(e)}`); return true; }
    }
    loadDb().sources.push(src);
    saveDb();
    json(res, { source: maskSource(src) });
    return true;
  }

  // —— POST /api/local/source/remove {id} ——
  if (req.method === "POST" && path === "source/remove") {
    const body = await readJsonBody(req).catch(() => null);
    const id = String(body?.id ?? "");
    if (!SRC_ID_RE.test(id)) { jsonErr(res, 422, "缺少合法源 id"); return true; }
    const dbs = loadDb();
    const at = dbs.sources.findIndex((s) => s.id === id);
    if (at < 0) { jsonErr(res, 404, "源不存在"); return true; }
    dbs.sources.splice(at, 1);
    for (const [tid, t] of Object.entries(dbs.tracks)) {
      if (t.sourceId === id) { dropTrackAssets(tid, t); delete dbs.tracks[tid]; }
    }
    saveDb();
    json(res, { removed: id });
    return true;
  }

  // —— POST /api/local/source/rename {id,name} ——（NAS 换挂载点之类的场景很常用）
  if (req.method === "POST" && path === "source/rename") {
    const body = await readJsonBody(req).catch(() => null);
    const id = String(body?.id ?? "");
    const src = loadDb().sources.find((s) => s.id === id);
    if (!src || !SRC_ID_RE.test(id)) { jsonErr(res, 404, "源不存在"); return true; }
    src.name = String(body?.name ?? "").trim().slice(0, 40) || src.name;
    if (body?.path && src.kind === "folder") {
      const abs = resolve(String(body.path));
      if (!existsSync(abs) || !statSync(abs).isDirectory()) { jsonErr(res, 422, "目录不存在"); return true; }
      src.path = abs; // 同 id 换路径：曲目 id 由 sourceId+relPath 派生，relPath 不变即可无缝保留
    }
    saveDb();
    json(res, { source: maskSource(src) });
    return true;
  }

  // —— POST /api/local/scan ——
  if (req.method === "POST" && path === "scan") {
    const r = startScan();
    json(res, r);
    return true;
  }
  if (req.method === "GET" && path === "scan") { json(res, scanState); return true; }

  // —— POST /api/local/scrape {ids?,all?,force?} ——
  if (req.method === "POST" && path === "scrape") {
    const body = await readJsonBody(req).catch(() => () => ({}));
    const r = startScrape({ ids: Array.isArray(body?.ids) ? body!.ids.map(String) : undefined, all: !!body?.all, force: !!body?.force });
    json(res, r);
    return true;
  }
  if (req.method === "GET" && path === "scrape") { json(res, scrapeState); return true; }

  // —— POST /api/local/lyric/import {id, name, data(base64)} ——
  // 手动导入歌词（QRC / TTML / LRC）：用户的显式意图，压过一切自动来源（见 materializeTrack 的保序）。
  // 内容按字节嗅探格式，文本解码走 decodeLrc（UTF-8/BOM/GBK 一路兜底）。
  if (req.method === "POST" && path === "lyric/import") {
    const body = await readJsonBody(req).catch(() => null);
    const t = body && TRACK_ID_RE.test(String(body.id)) ? loadDb().tracks[String(body.id)] : null;
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    const buf = decodeBase64Cap(String(body!.data ?? ""), 512 * 1024);
    if (!buf) { jsonErr(res, 413, "歌词文件过大（上限 512KB）或非 base64"); return true; }
    const text = decodeLrc(buf).replace(/\r\n/g, "\n").trim();
    if (!text) { jsonErr(res, 422, "歌词文件是空的"); return true; }
    ensureLibDirs();
    const format = sniffLyricFormat(text, String(body!.name ?? ""));
    writeFilePrivate(join(lyricsDir(), `${t.id}.import`), text, 0o600);
    t.lyricSource = "import";
    t.importFormat = format;
    saveDb();
    json(res, { track: t, format, chars: text.length });
    return true;
  }

  // —— POST /api/local/cover/import {id, name, data(base64)} ——
  if (req.method === "POST" && path === "cover/import") {
    const body = await readJsonBody(req).catch(() => null);
    const t = body && TRACK_ID_RE.test(String(body.id)) ? loadDb().tracks[String(body.id)] : null;
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    const buf = decodeBase64Cap(String(body!.data ?? ""), 8 * 1024 * 1024);
    const ext = buf ? imageFormat(buf) : "";
    if (!buf || !ext) { jsonErr(res, 422, "封面图不合法（只认 jpg/png/gif/webp，上限 8MB）"); return true; }
    ensureLibDirs();
    const old = t.coverRel;
    t.coverRel = `covers/${t.id}.${ext}`;
    writeFilePrivate(join(libRoot(), t.coverRel), buf, 0o600);
    t.coverManual = true;
    if (old && old !== t.coverRel) { try { rmSync(join(libRoot(), old)); } catch { /* 尽力 */ } }
    saveDb();
    json(res, { track: t });
    return true;
  }

  // —— POST /api/local/meta/set {id, title?, artist?, album?} ——
  // 重新设置「刮削用的曲名/歌手/专辑」：展示与在线搜索都吃这份用户校正；
  // editedMeta 标记让 scrapeTrack 的回填不再覆盖（匹配仍借 search 拿 qqMid/词/封面）。
  if (req.method === "POST" && path === "meta/set") {
    const body = await readJsonBody(req).catch(() => null);
    const t = body && TRACK_ID_RE.test(String(body.id)) ? loadDb().tracks[String(body.id)] : null;
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    const clean = (v: unknown) => String(v ?? "").trim().slice(0, 200);
    const title = clean(body?.title); const artist = clean(body?.artist); const album = clean(body?.album);
    if (!title && !artist && !album) { jsonErr(res, 422, "至少填一项（曲名/歌手/专辑）"); return true; }
    if (title) t.title = title;
    if (artist) t.artist = artist;
    if (album) t.album = album;
    t.editedMeta = true;
    saveDb();
    json(res, { track: t });
    return true;
  }

  // —— DELETE /api/local/lyric/import/<id> ——（撤销导入：回到自动来源链）
  m = /^lyric\/import\/(t_[0-9a-f]{12})$/.exec(path);
  if (m && req.method === "DELETE") {
    const t = loadDb().tracks[m[1]];
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    try { rmSync(join(lyricsDir(), `${t.id}.import`)); } catch { /* 本就没有 */ }
    if (t.lyricSource === "import") {
      t.importFormat = "";
      // 撤销导入 = 交还给自动来源链（按现存资产逐档回退；webdav 的 .lrc 以扫描记录为准不再探活）
      const src = loadDb().sources.find((x) => x.id === t.sourceId);
      const lrcBack = !!t.lyricRel && !!src && (src.kind === "webdav" || existsSync(join(src.path ?? "", t.lyricRel)));
      if (lrcBack) t.lyricSource = "file";
      else if (existsSync(join(lyricsDir(), `${t.id}.json`))) t.lyricSource = "qq";
      else if (existsSync(join(lyricsDir(), `${t.id}.txt`))) t.lyricSource = "embed";
      else t.lyricSource = "";
    }
    saveDb();
    json(res, { track: t });
    return true;
  }

  // —— GET /api/local/stream/<id>（含 HEAD）——
  m = /^stream\/(t_[0-9a-f]{12})$/.exec(path);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const t = db.tracks[m[1]];
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    const src = db.sources.find((s) => s.id === t.sourceId);
    if (!src) { jsonErr(res, 404, "源已移除"); return true; }
    const isHead = req.method === "HEAD";
    if (src.kind === "folder") {
      let size = 0;
      try { size = statSync(t.file).size; } catch { jsonErr(res, 404, `文件不存在：${t.relPath}`); return true; }
      await serveFolderFile(res, t.file, size, req, isHead);
      return true;
    }
    try {
      const size = await davSize(src, t.relPath);
      await serveWebdavFile(res, src, t.relPath, req, size, isHead);
    } catch (e) {
      jsonErr(res, e instanceof DavError && e.status === 404 ? 404 : 502, errText(e));
    }
    return true;
  }

  // —— GET /api/local/cover/<id> ——
  m = /^cover\/(t_[0-9a-f]{12})$/.exec(path);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const t = db.tracks[m[1]];
    if (!t || !t.coverRel) { jsonErr(res, 404, "无封面"); return true; }
    const file = join(libRoot(), t.coverRel);
    if (!file.startsWith(libRoot()) || !existsSync(file)) { jsonErr(res, 404, "封面无副本"); return true; }
    res.statusCode = 200;
    res.setHeader("content-type", mimeByExt(t.coverRel));
    // no-store：重导入/重扫会原地换图但 URL 不变（id 恒定），max-age 会让界面挂旧图一小时
    res.setHeader("cache-control", "no-store");
    if (req.method === "HEAD") { res.end(); return true; }
    res.end(readFileSync(file));
    return true;
  }

  // —— GET /api/local/ttml?qq=&name=&artist= ——（本地 TTML 歌词库：目录只认 quaver.conf）
  if (req.method === "GET" && path === "ttml") {
    const hit = findLocalTtml({ qq: q.get("qq") ?? "", name: q.get("name") ?? "", artist: q.get("artist") ?? "" });
    json(res, hit ? { found: true, ...hit } : { found: false });
    return true;
  }

  // —— GET /api/local/lyric/<id> ——
  m = /^lyric\/(t_[0-9a-f]{12})$/.exec(path);
  if (m && req.method === "GET") {
    const t = db.tracks[m[1]];
    if (!t) { jsonErr(res, 404, "曲目不在库中"); return true; }
    const src = db.sources.find((s) => s.id === t.sourceId);
    if (!src) { jsonErr(res, 404, "源已移除"); return true; }
    json(res, await resolveLyric(t, src));
    return true;
  }

  // —— GET /api/local/status ——（壳层/设置页轻查询）
  if (req.method === "GET" && path === "status") {
    json(res, { configured: db.sources.length > 0, ...statsOf(db), scanning: scanState.running, scraping: scrapeState.running });
    return true;
  }

  jsonErr(res, 404, `local: unknown route ${path}`);
  return true;
}

async function davSize(src: LocalSource, relPath: string): Promise<number> {
  // 探一次文件本体大小（HEAD 不是所有 WebDAV 服务器都答得稳，退 PROPFIND 单资源）
  const url = davStreamUrl(src, relPath);
  try {
    const r = await fetch(url, { method: "HEAD", headers: davAuthHeaders({ username: src.username, password: src.password }), signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const n = Number(r.headers.get("content-length") ?? "0");
      if (n > 0) return n;
    }
  } catch { /* 退 PROPFIND */ }
  const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const entries = await propfind(davStreamUrl(src, parent) || (src.url ?? ""), { username: src.username, password: src.password });
  const want = decodeURIComponent(new URL(url).pathname);
  const hit = entries.find((e) => e.path.replace(/\/+$/, "") === want.replace(/\/+$/, ""));
  if (!hit) throw new DavError("文件不存在", 404);
  return hit.size;
}

function randomHex(n: number): string {
  return createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, n);
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try { res(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { rej(e); }
    });
    req.on("error", rej);
  });
}

/** 主进程 IPC（quaver:local reveal）用：按 id 现读磁盘上的库，回绝对路径。
 *  渲染层只报 id；路径只从库文件来 —— 与 /api/bg 同一条「请求参数不参与拼路径」的红线。 */
export function revealTarget(id: string): { ok: boolean; path?: string; error?: string } {
  if (!TRACK_ID_RE.test(String(id ?? ""))) return { ok: false, error: "bad id" };
  try {
    const raw = JSON.parse(readFileSync(dbFile(), "utf8"));
    const t = raw?.tracks?.[id] as LocalTrack | undefined;
    if (!t) return { ok: false, error: "曲目不在库中" };
    const src = (raw.sources as LocalSource[]).find((s) => s.id === t.sourceId);
    if (!src) return { ok: false, error: "源已移除" };
    if (src.kind !== "folder") return { ok: false, error: "网络存储的曲目没有本地文件可显示" };
    if (!existsSync(t.file)) return { ok: false, error: "文件已不存在" };
    return { ok: true, path: t.file };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// 让 TS 知道 formatByExt/isAudioFile 等再导出是有意的公共面（library 消费者少而固定）
export { formatByExt, isAudioFile };
