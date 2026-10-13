// Quaver — 本地/NAS 音频文件的标签解析（刮削第一步：读文件自身携带的歌曲信息）。
//
// 姿态与全仓一致：**零依赖纯 Node**（只有 Buffer 运算，无 electron / 无 npm 包），
// 开发态（vite 进程里的 relay.ts）与打包态（native-server.ts）同构复用，
// 纯函数可被 scripts/verify-local.ts 用合成字节直接单测。
//
// 支持矩阵（读头尾窗口即可拿到的信息）：
//   MP3   ID3v2.2/2.3/2.4（文本/USLT 歌词/APIC 封面）→ ID3v1 兜底 → 文件名兜底；
//         时长走 Xing/Info（VBR）、VBRI，或按标称位率折算（CBR）。
//   FLAC  native：STREAMINFO（精确时长）+ VORBIS_COMMENT + PICTURE 块。
//   OGG   Vorbis/Opus 注释头（含 base64 的 METADATA_BLOCK_PICTURE）；时长缺省（精确值要扫尾页，不做）。
//   MP4   moov/mvhd（时长）+ ilst（©nam/©ART/aART/©alb/©day/trck/covr/©lyr…）；
//         moov 不在头部时由调用方喂尾部窗口重跑（未 faststart 的常见情况）。
//   WAV   fmt/data（时长/码率）+ LIST INFO（INAM/IART/INAL/ICRD/IGNR）+ 内嵌 ID3。
//   AIFF  NAME/AUTH/ANNO/YEAR + comm（时长）+ 内嵌 ID3。
// 其余容器（ape/wv/mpc/dsf…）只认格式名，信息交给文件名与在线刮削。
//
// 约定：本模块的 parse* 只吃**给定的窗口字节**，不做任何 IO；
// 何时扩窗重读由 library.ts 的读盘编排决定。

export type AudioFormat =
  | "mp3" | "flac" | "ogg" | "m4a" | "wav" | "aiff"
  | "ape" | "wv" | "mpc" | "dsf" | "dff" | "aac" | "unknown";

export type TagSource = "id3v2" | "id3v1" | "mp4" | "vorbis" | "flac" | "riff" | "aiff" | "filename" | "none";

export interface EmbeddedPicture { mime: string; data: Buffer }

export interface FileTags {
  format: AudioFormat;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  year: string;
  genre: string;
  trackNo: number;
  discNo: number;
  /** 内嵌歌词文本（ID3 USLT / Vorbis LYRICS / MP4 ©lyr / AIFF ANNO…），无则空串 */
  lyrics: string;
  picture: EmbeddedPicture | null;
  /** 秒；容器头里读不出来就 0（播放时引擎会给出真实时长，库里的 0 展示为「—」） */
  durationSec: number;
  /** kbps；0 = 未知 */
  bitrateKbps: number;
  tagSource: TagSource;
}

export function emptyTags(format: AudioFormat): FileTags {
  return {
    format, title: "", artist: "", albumArtist: "", album: "", year: "", genre: "",
    trackNo: 0, discNo: 0, lyrics: "", picture: null, durationSec: 0, bitrateKbps: 0, tagSource: "none",
  };
}

/** 把 id3v2 解析结果并进 FileTags（先到先得，已有值不覆盖）。 */
export function mergeId3(t: { title?: string; artist?: string; albumArtist?: string; album?: string; year?: string; genre?: string; trackNo?: number; discNo?: number; lyrics?: string; picture?: EmbeddedPicture | null }, out: FileTags): void {
  out.title ||= t.title ?? "";
  out.artist ||= t.artist ?? "";
  out.albumArtist ||= t.albumArtist ?? "";
  out.album ||= t.album ?? "";
  out.year ||= t.year ?? "";
  out.genre ||= t.genre ?? "";
  out.trackNo ||= t.trackNo ?? 0;
  out.discNo ||= t.discNo ?? 0;
  out.lyrics ||= t.lyrics ?? "";
  out.picture ||= t.picture ?? null;
}

export const AUDIO_EXT_SET: ReadonlySet<string> = new Set([
  "mp3", "flac", "ogg", "oga", "opus", "m4a", "m4b", "aac", "wav", "aif", "aiff",
  "ape", "wv", "mpc", "dsf", "dff", "mp2",
]);

/** 扩展名（不带点，小写）→ 容器猜测；仅当头部字节读不出特征时兜底。 */
export function formatByExt(ext: string): AudioFormat {
  const e = String(ext ?? "").toLowerCase().replace(/^\./, "");
  if (e === "mp3" || e === "mp2") return "mp3";
  if (e === "flac") return "flac";
  if (e === "ogg" || e === "oga" || e === "opus") return "ogg";
  if (e === "m4a" || e === "m4b") return "m4a";
  if (e === "aac") return "aac";
  if (e === "wav") return "wav";
  if (e === "aif" || e === "aiff") return "aiff";
  if (e === "ape") return "ape";
  if (e === "wv") return "wv";
  if (e === "mpc") return "mpc";
  if (e === "dsf") return "dsf";
  if (e === "dff") return "dff";
  return "unknown";
}

export function isAudioFile(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i <= 0) return false;
  return AUDIO_EXT_SET.has(name.slice(i + 1).toLowerCase());
}

const str = (b: Buffer, i: number, n: number) => (b.length >= i + n ? b.toString("latin1", i, i + n) : "");

/** 用头部字节判容器；认不出回落 extHint。 */
export function sniffFormat(head: Buffer, extHint = ""): AudioFormat {
  if (str(head, 0, 3) === "ID3") return "mp3";
  if (str(head, 0, 4) === "fLaC") return "flac";
  if (str(head, 0, 4) === "OggS") return "ogg";
  if (str(head, 4, 4) === "ftyp") return "m4a";
  if (str(head, 0, 4) === "RIFF" && str(head, 8, 4) === "WAVE") return "wav";
  if ((str(head, 0, 4) === "FORM" || str(head, 0, 4) === "FREM") && (str(head, 8, 4) === "AIFF" || str(head, 8, 4) === "AIFC")) return "aiff";
  if (str(head, 0, 4) === "MAC ") return "ape";
  if (str(head, 0, 4) === "wvpk") return "wv";
  if (str(head, 0, 3) === "MP+") return "mpc";
  if (str(head, 0, 4) === "DSD ") return "dsf";
  if (str(head, 0, 4) === "FRM8") return "dff";
  // 裸 ADTS / 裸 MP3 帧
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return "aac";
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "mp3";
  return formatByExt(extHint);
}

// —— 读数小工具 ——
const u8 = (b: Buffer, i: number) => (i >= 0 && i < b.length ? b[i] : 0);
const u16be = (b: Buffer, i: number) => (u8(b, i) << 8) | u8(b, i + 1);
const u24be = (b: Buffer, i: number) => (u8(b, i) << 16) | (u8(b, i + 1) << 8) | u8(b, i + 2);
const u32be = (b: Buffer, i: number) => (((u16be(b, i) << 16) | u16be(b, i + 2)) >>> 0);
const u32le = (b: Buffer, i: number) => (u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16) | (u8(b, i + 3) << 24)) >>> 0;

/** ID3v2 的 syncsafe 整数（每字节 7 位有效）。 */
export function syncsafe(b: Buffer, i: number): number {
  return ((u8(b, i) & 0x7f) << 21) | ((u8(b, i + 1) & 0x7f) << 14) | ((u8(b, i + 2) & 0x7f) << 7) | (u8(b, i + 3) & 0x7f);
}

/** 80-bit IEEE 扩展精度（AIFF comm 的采样率）。 */
function readExtended80(b: Buffer, off: number): number {
  const sign = u8(b, off) & 0x80 ? -1 : 1;
  const exp = ((u8(b, off) & 0x7f) << 8) | u8(b, off + 1);
  if (exp === 0) return 0;
  let mant = 0;
  for (let i = 2; i < 10; i++) mant = mant * 256 + u8(b, off + i);
  return sign * mant * Math.pow(2, exp - 16383 - 63);
}

// —— ID3 文本编码 ——
function decodeBytes(b: Buffer, enc: number): string {
  if (!b.length) return "";
  if (enc === 0) return b.toString("latin1");
  if (enc === 1 || enc === 2) {
    const bom = b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
    const le = enc === 2 ? false : bom ? b[0] === 0xff : true;
    const units: number[] = [];
    for (let i = bom ? 2 : 0; i + 1 < b.length; i += 2) {
      units.push(le ? (b[i] | (b[i + 1] << 8)) : ((b[i] << 8) | b[i + 1]));
    }
    // 逐 16 位码单元拼接：UTF-16 代理对原样落在相邻单元上，String.fromCharCode 直接成立
    let s = "";
    for (let i = 0; i < units.length; i += 512) s += String.fromCharCode(...units.slice(i, i + 512));
    return s;
  }
  return b.toString("utf8");
}

/** 帧文本：去空终止尾巴；v2.4 多值（\0 分隔）合并为 " / "。 */
function frameText(b: Buffer, enc: number): string {
  return decodeBytes(b, enc).split("\u0000").map((x) => x.trim()).filter(Boolean).join(" / ");
}

const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Metal", "New Age", "Oldies",
  "Other", "Pop", "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal",
  "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Live",
  "Tribal", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "Alt. Rock", "Bass", "Soul",
  "Punk", "Space", "BGM", "Hard Rock", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll",
  "Easy Listening", "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychadelic", "Symphonic Rock",
  "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson", "Opera",
  "Chamber Music", "Sonata", "Symphony", "Booty Beat", "Primus", "Porn Groove", "Satire", "Slow Jam",
  "Club", "Tango", "House", "Dancehall", "Ragga", "Pavement", "Left Field", "Betal House", "Big Beat",
  "K-Pop", "Uk Rock", "Euro House",
];

function splitNumTotal(v: string): number {
  const m = /^\s*(\d+)/.exec(v);
  return m ? Number(m[1]) : 0;
}

function stripYear(v: string): string {
  const m = /(\d{4})/.exec(v);
  return m ? m[1] : "";
}

function guessImageMime(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && str(b, 1, 4) === "PNG\r") return "image/png";
  if (str(b, 0, 4) === "GIF8") return "image/gif";
  if (b.length >= 12 && str(b, 0, 4) === "RIFF" && str(b, 8, 4) === "WEBP") return "image/webp";
  return "image/jpeg";
}

interface Id3Frame { id: string; body: Buffer }

/** 去整体反同步：0x00 0xFF → 0xFF（v2.3 头部标志 / v2.4 帧标志）。 */
function desync(body: Buffer): Buffer {
  const out = Buffer.allocUnsafe(body.length);
  let w = 0;
  for (let r = 0; r < body.length; r++) {
    out[w++] = body[r];
    if (body[r] === 0x00 && r + 1 < body.length && body[r + 1] === 0xff) r++;
  }
  return out.subarray(0, w);
}

const ID3V22_MAP: Record<string, string> = {
  TT2: "TIT2", TP1: "TPE1", TP2: "TPE2", TAL: "TALB", TYE: "TYER", TRK: "TRCK",
  TCO: "TCON", ULT: "USLT", PIC: "APIC",
};

/** 找文本编码下的终止串末尾偏移：双字节编码找 \0\0，单字节找 \0。 */
function findTerm(buf: Buffer, from: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i + 2;
    return buf.length;
  }
  for (let i = from; i < buf.length; i++) if (buf[i] === 0) return i + 1;
  return buf.length;
}

function parseApic(body: Buffer): EmbeddedPicture | null {
  if (body.length < 5) return null;
  const enc = u8(body, 0);
  let p = body.indexOf(0x00, 1); // mime：永远 latin1 + \0（v2.4 的 UTF-8 mime 是其 ASCII 子集，同形）
  if (p < 0) return null;
  const mime = body.toString("latin1", 1, p);
  p += 2; // 跳过 \0 与 picture type（不挑类型，取第一张）
  p = findTerm(body, p, enc); // description
  if (p >= body.length) return null;
  return { mime: mime || guessImageMime(body.subarray(p, p + 12)), data: body.subarray(p) };
}

export interface Id3v2Result {
  title: string; artist: string; albumArtist: string; album: string;
  year: string; genre: string; trackNo: number; discNo: number; lyrics: string;
  picture: EmbeddedPicture | null;
  /** 标签总字节（10 头 + size + 可能的 footer） */
  tagSize: number;
  /** 帧区是否完整落在窗口内（false = 调用方应扩窗重读） */
  complete: boolean;
}

/** 解析 ID3v2.2/2.3/2.4；buf[off..] 开头必须先看 10 字节头。 */
export function parseId3v2(buf: Buffer, off = 0): Id3v2Result | null {
  if (buf.length < off + 10) return null;
  if (buf.toString("latin1", off, off + 3) !== "ID3") return null;
  const major = u8(buf, off + 3);
  if (major < 2 || major > 4) return null;
  const flags = u8(buf, off + 5);
  const size = syncsafe(buf, off + 6);
  const footer = major >= 3 && (flags & 0x10) !== 0;
  const framesEnd = off + 10 + size;
  const end = framesEnd + (footer ? 10 : 0);
  const unsyncWhole = major === 3 && (flags & 0x80) !== 0;
  const out: Id3v2Result = {
    title: "", artist: "", albumArtist: "", album: "", year: "", genre: "",
    trackNo: 0, discNo: 0, lyrics: "", picture: null, tagSize: end, complete: buf.length >= end,
  };
  let p = off + 10;
  if (flags & 0x40) {
    // 扩展头：v2.3 是 u32be 长（不含自身）；v2.4 是 syncsafe 长（含自身）
    p += major === 4 ? syncsafe(buf, off + 10) : 4 + u32be(buf, off + 10);
  }
  const idLen = major === 2 ? 3 : 4;
  while (p + idLen + (major === 2 ? 3 : 6) <= Math.min(framesEnd, buf.length)) {
    const rawId = buf.toString("latin1", p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(rawId)) break; // padding（\0 起头）到此为止
    const id = ID3V22_MAP[rawId] ?? rawId;
    let fs: number;
    let fFlags = 0;
    if (major === 2) { fs = u24be(buf, p + 3); p += 6; }
    else if (major === 4) { fs = syncsafe(buf, p + 4); fFlags = u16be(buf, p + 8); p += 10; }
    else { fs = u32be(buf, p + 4); fFlags = u16be(buf, p + 8); p += 10; }
    if (fs <= 0 || p + fs > buf.length) break; // 窗口截断：以已读到的为准
    let body: Buffer = buf.subarray(p, p + fs);
    if (unsyncWhole || (major === 4 && (fFlags & 0x02) !== 0)) body = desync(body);
    p += fs;
    if (id.startsWith("T") && body.length >= 1) {
      const enc = u8(body, 0);
      const text = frameText(body.subarray(1), enc);
      if (!text) continue;
      if (id === "TIT2") out.title = text;
      else if (id === "TPE1") out.artist = text;
      else if (id === "TPE2") out.albumArtist = text;
      else if (id === "TALB") out.album = text;
      else if (id === "TYER" || id === "TDRC") out.year = stripYear(text);
      else if (id === "TRCK") out.trackNo = splitNumTotal(text);
      else if (id === "TPOS") out.discNo = splitNumTotal(text);
      else if (id === "TCON") out.genre = /^\(\d+\)$/.test(text) ? (ID3V1_GENRES[Number(text.slice(1, -1))] ?? "") : text;
    } else if (id === "USLT" && body.length > 4) {
      const enc = u8(body, 0);
      const textStart = findTerm(body, 4, enc); // 跳过 lang(3) 与 description
      const text = decodeBytes(body.subarray(Math.min(textStart, body.length)), enc).trim();
      if (text) out.lyrics = (out.lyrics ? out.lyrics + "\n" : "") + text;
    } else if (id === "APIC" && !out.picture) {
      const pic = parseApic(body);
      if (pic) out.picture = pic;
    }
  }
  return out;
}

/** 首帧音频起始偏移（= ID3v2 终点；没有 ID3 就 0）。 */
export function mp3AudioStart(head: Buffer): number {
  if (head.length < 10 || str(head, 0, 3) !== "ID3") return 0;
  return 10 + syncsafe(head, 6) + ((u8(head, 5) & 0x10) ? 10 : 0);
}

// —— MP3 帧头（只做 Layer III：时长与 VBR 判定只需要它）——
const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];

export interface Mp3Frame {
  /** 0=MPEG1 1=MPEG2 2=MPEG2.5 */
  version: 0 | 1 | 2;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  frameLen: number; // 字节
}

function mp3FrameAt(b: Buffer, i: number): Mp3Frame | null {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (b[i + 1] >> 3) & 0x03;
  if (verBits === 1) return null; // 保留位
  const version = (verBits === 3 ? 0 : verBits === 2 ? 1 : 2) as 0 | 1 | 2;
  if ((b[i + 1] & 0x06) !== 0x02) return null; // 只认 Layer III
  const brIdx = (b[i + 2] >> 4) & 0x0f;
  const srIdx = (b[i + 2] >> 2) & 0x03;
  if (srIdx === 3) return null;
  const padding = (b[i + 2] >> 1) & 0x01;
  const channels = ((b[i + 3] >> 6) & 0x03) === 3 ? 1 : 2;
  const bitrate = (version === 0 ? BITRATES_V1L3 : BITRATES_V2L3)[brIdx];
  if (!bitrate) return null;
  const sampleRate = SAMPLES[version][srIdx];
  const frameLen = Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
  return { version, bitrateKbps: bitrate, sampleRate, channels, frameLen };
}

/** 从 off 起找自洽帧头：下一帧起点也对齐才可信。 */
export function findMp3Frame(b: Buffer, off: number): Mp3Frame | null {
  for (let i = off; i + 4 <= b.length; i++) {
    const f = mp3FrameAt(b, i);
    if (!f) continue;
    const next = i + f.frameLen;
    if (next + 4 <= b.length && mp3FrameAt(b, next)) return f;
    if (next >= b.length - 8) return f; // 短样本/文件尾只剩一帧
  }
  return null;
}

/** MP3 时长/码率：Xing/Info（VBR）→ VBRI → CBR 折算。
 *  head 覆盖到音频头 + 帧内标签区即可。 */
export function mp3Duration(head: Buffer, audioStart: number, audioBytes: number): { durationSec: number; bitrateKbps: number } | null {
  const f = findMp3Frame(head, audioStart);
  if (!f) return null;
  // Xing/Info：帧头后 4B + side info（MPEG1 L3：立体 32/单声 17；MPEG2/2.5：17/9）
  const side = f.version === 0 ? (f.channels === 1 ? 17 : 32) : (f.channels === 1 ? 9 : 17);
  const xingOff = audioStart + 4 + side;
  const magic = str(head, xingOff, 4);
  if (magic === "Xing" || magic === "Info") {
    const flags = u32be(head, xingOff + 4);
    const frames = flags & 1 ? u32be(head, xingOff + 8) : 0;
    const bytes = flags & 2 ? u32be(head, xingOff + 12) : 0;
    // Xing 帧数 × 每帧样本数（Layer III = 1152；编码器通常已含编码器延迟，不再另加 522）
    const framesWithPad = frames > 0 ? frames : 0;
    if (frames > 0 && f.sampleRate) {
      const dur = (framesWithPad * 1152) / f.sampleRate;
      return { durationSec: dur, bitrateKbps: bytes > 0 && dur > 0 ? Math.round((bytes * 8) / dur / 1000) : f.bitrateKbps };
    }
  }
  // VBRI：恒在帧头后 36 字节；bytes 在 +12、frames 在 +16
  if (str(head, audioStart + 36, 4) === "VBRI") {
    const bytes = u32be(head, audioStart + 36 + 12);
    const frames = u32be(head, audioStart + 36 + 16);
    if (frames > 0 && f.sampleRate) {
      const dur = frames * 1152 / f.sampleRate;
      return { durationSec: dur, bitrateKbps: bytes > 0 && dur > 0 ? Math.round((bytes * 8) / dur / 1000) : f.bitrateKbps };
    }
  }
  if (audioBytes > 0) return { durationSec: (audioBytes * 8) / (f.bitrateKbps * 1000), bitrateKbps: f.bitrateKbps };
  return { durationSec: 0, bitrateKbps: f.bitrateKbps };
}

// —— Vorbis 注释（FLAC native 与 Ogg 共用）——
export interface VorbisResult { fields: Record<string, string[]>; complete: boolean }

export function parseVorbisComments(buf: Buffer, off: number): VorbisResult | null {
  const vendorLen = u32le(buf, off);
  let p = off + 4 + vendorLen;
  if (!isFinite(vendorLen) || p + 4 > buf.length) return null;
  const count = u32le(buf, p);
  p += 4;
  const fields: Record<string, string[]> = {};
  let complete = true;
  for (let i = 0; i < count; i++) {
    if (p + 4 > buf.length) { complete = false; break; }
    const len = u32le(buf, p);
    p += 4;
    if (p + len > buf.length) { complete = false; break; }
    const kv = buf.toString("utf8", p, p + len);
    p += len;
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    (fields[kv.slice(0, eq).toUpperCase()] ??= []).push(kv.slice(eq + 1));
  }
  return { fields, complete };
}

export function vorbisIntoTags(v: VorbisResult, out: FileTags): void {
  const first = (k: string) => (v.fields[k]?.[0] ?? "");
  mergeId3(
    {
      title: first("TITLE"), artist: first("ARTIST"),
      albumArtist: first("ALBUMARTIST") || first("BAND"), album: first("ALBUM"),
      year: stripYear(first("DATE") || first("YEAR") || first("ORIGINALDATE")), genre: first("GENRE"),
      trackNo: splitNumTotal(first("TRACKNUMBER") || first("TRACK")),
      discNo: splitNumTotal(first("DISCNUMBER") || first("DISC")),
      lyrics: first("LYRICS") || first("LYRIC") || first("UNSYNCEDLYRICS"),
    },
    out,
  );
  const pic = v.fields["METADATA_BLOCK_PICTURE"]?.[0];
  if (pic && !out.picture) {
    try {
      const p = parseFlacPicture(Buffer.from(pic, "base64"), 0);
      if (p) out.picture = p;
    } catch { /* 非法 base64：无图 */ }
  }
}

/** FLAC PICTURE 块结构（native 块体与 ogg base64 解码后同形）。 */
export function parseFlacPicture(b: Buffer, off: number): EmbeddedPicture | null {
  if (b.length < off + 32) return null;
  let p = off + 4; // picture type
  const mimeLen = u32be(b, p);
  p += 4;
  if (p + mimeLen > b.length) return null;
  const mime = b.toString("latin1", p, p + mimeLen);
  p += mimeLen;
  const descLen = u32be(b, p);
  p += 4 + descLen + 16; // 描述与 w/h/depth/colors 一律忽略
  const dataLen = u32be(b, p);
  p += 4;
  if (!isFinite(dataLen) || dataLen <= 0 || p + dataLen > b.length) return null;
  return { mime: mime || guessImageMime(b.subarray(p, p + 12)), data: b.subarray(p, p + dataLen) };
}

/** FLAC native：fLaC + 元数据块链表。head 必须从 0 起。 */
export function parseFlac(head: Buffer, out: FileTags): { needMore: boolean } {
  let p = 4;
  let sawComment = false;
  let needMore = false;
  while (p + 4 <= head.length) {
    const last = (head[p] & 0x80) !== 0;
    const type = head[p] & 0x7f;
    const len = u24be(head, p + 1);
    const body = p + 4;
    if (body + len > head.length) {
      if (type === 4 || type === 6) needMore = true; // 注释/封面还没进窗口
      break;
    }
    if (type === 0 && len >= 18) {
      const s = body + 10;
      const sampleRate = (u8(head, s) << 12) | (u8(head, s + 1) << 4) | (u8(head, s + 2) >> 4);
      // 总样本数 36 bit = b[s+3] 低 4 位（高 4 位）+ b[s+4..s+7] 完整 32 位
      const total = (u8(head, s + 3) & 0x0f) * 4294967296 + u32be(head, s + 4);
      if (sampleRate > 0 && total > 0) out.durationSec = total / sampleRate;
    } else if (type === 4 && !sawComment) {
      sawComment = true;
      const v = parseVorbisComments(head, body);
      if (v) vorbisIntoTags(v, out);
      else needMore = true;
    } else if (type === 6 && !out.picture) {
      const pic = parseFlacPicture(head, body);
      if (pic) out.picture = pic;
    }
    p = body + len;
    if (last) break;
  }
  return { needMore };
}

/** Ogg：走页找 identification（vorbis/Opus/flac-in-ogg）与其后的注释头。
 *  只解析注释与封面；时长留给播放引擎（精确值要扫尾页，不做）。 */
export function parseOgg(head: Buffer, out: FileTags): { needMore: boolean } {
  let p = 0;
  let commentParsed = false;
  let sawId = false;
  while (p + 27 <= head.length) {
    if (str(head, p, 4) !== "OggS") break;
    const segCount = u8(head, p + 26);
    if (p + 27 + segCount > head.length) break;
    let total = 0;
    for (let i = 0; i < segCount; i++) total += u8(head, p + 27 + i);
    const payload = head.subarray(p + 27 + segCount, Math.min(p + 27 + segCount + total, head.length));
    if (!sawId) {
      if (payload.length >= 7 && payload[0] === 0x01 && str(payload, 1, 6) === "vorbis") sawId = true;
      else if (str(payload, 0, 7) === "OpusHea") sawId = true;
      else if (payload.length >= 7 && payload[0] === 0x7f && str(payload, 1, 6) === "FLAC") sawId = true;
    } else if (!commentParsed) {
      let cOff = 0;
      if (payload.length >= 7 && payload[0] === 0x03 && str(payload, 1, 6) === "vorbis") cOff = 7;
      else if (str(payload, 0, 8) === "OpusTags") cOff = 8;
      if (cOff) {
        const v = parseVorbisComments(payload, cOff);
        if (v) { vorbisIntoTags(v, out); commentParsed = true; }
      }
    } else break;
    p += 27 + segCount + total;
  }
  return { needMore: sawId && !commentParsed };
}

// —— MP4 / QuickTime ——
interface Mp4Atom { type: string; payload: Buffer }

function readAtom(buf: Buffer, off: number): { atom: Mp4Atom | null; next: number } {
  if (off + 8 > buf.length) return { atom: null, next: buf.length };
  let size = u32be(buf, off);
  const type = str(buf, off + 4, 4);
  let header = 8;
  if (size === 1) {
    size = u32be(buf, off + 8) * 4294967296 + u32be(buf, off + 12);
    header = 16;
  } else if (size === 0) {
    size = buf.length - off;
  }
  if (!isFinite(size) || size < header || off + size > buf.length) return { atom: null, next: buf.length };
  return { atom: { type, payload: buf.subarray(off + header, off + size) }, next: off + size };
}

function childAtoms(buf: Buffer, isMeta = false): Mp4Atom[] {
  const out: Mp4Atom[] = [];
  let p = isMeta ? 4 : 0; // meta 盒在头后跟 4 字节 version+flags
  while (p < buf.length) {
    const { atom, next } = readAtom(buf, p);
    if (!atom) break;
    out.push(atom);
    p = next;
  }
  return out;
}

/** ilst → 规范名（"©nam"/"trck"…）→ data 载荷（flags 低 24 位 = 内容类型）。 */
function ilstItems(ilst: Mp4Atom): Map<string, { flags: number; payload: Buffer }[]> {
  const map = new Map<string, { flags: number; payload: Buffer }[]>();
  for (const item of childAtoms(ilst.payload)) {
    const datas: { flags: number; payload: Buffer }[] = [];
    for (const d of childAtoms(item.payload)) {
      if (d.type !== "data") continue;
      datas.push({ flags: u32be(d.payload, 0) & 0xffffff, payload: d.payload.subarray(8) });
    }
    if (datas.length) map.set(item.type, datas);
  }
  return map;
}

/** MP4：从窗口字节里找 moov→mvhd（时长）+ moov→udta→meta→ilst（标签）。返回是否见到 moov。 */
export function parseMp4(head: Buffer, out: FileTags): boolean {
  let p = 0;
  while (p < head.length) {
    const { atom, next } = readAtom(head, p);
    p = next;
    if (!atom) break;
    if (atom.type !== "moov") continue;
    for (const inner of childAtoms(atom.payload)) {
      if (inner.type === "mvhd") {
        const ver = u8(inner.payload, 0);
        if (ver === 0) {
          const timescale = u32be(inner.payload, 12);
          const dur = u32be(inner.payload, 16);
          if (timescale > 0) out.durationSec = dur / timescale;
        } else {
          const timescale = u32be(inner.payload, 20);
          const dur = u32be(inner.payload, 24) * 4294967296 + u32be(inner.payload, 28);
          if (timescale > 0) out.durationSec = dur / timescale;
        }
      }
      if (inner.type === "udta") {
        const meta = childAtoms(inner.payload).find((x) => x.type === "meta");
        if (!meta) continue;
        const ilst = childAtoms(meta.payload, true).find((x) => x.type === "ilst");
        if (!ilst) continue;
        const items = ilstItems(ilst);
        const text = (k: string) => (items.get(k)?.[0]?.payload.toString("utf8") ?? "").trim();
        mergeId3(
          {
            title: text("\u00a9nam"), artist: text("\u00a9ART"), albumArtist: text("aART"),
            album: text("\u00a9alb"), year: stripYear(text("\u00a9day")), genre: text("\u00a9gen"),
            lyrics: text("\u00a9lyr") || text("lyr "),
          },
          out,
        );
        const gnre = items.get("gnre")?.[0]?.payload;
        if (gnre && gnre.length >= 2 && !out.genre) out.genre = ID3V1_GENRES[u16be(gnre, 0) - 1] ?? "";
        const trck = items.get("trck")?.[0]?.payload;
        if (trck && trck.length >= 4) out.trackNo ||= u16be(trck, 2);
        if (trck && trck.length >= 8) out.discNo ||= u16be(trck, 6);
        const covr = items.get("covr")?.[0];
        if (covr && !out.picture && covr.payload.length >= 8) {
          out.picture = { mime: covr.flags === 14 ? "image/png" : covr.flags === 13 ? "image/jpeg" : guessImageMime(covr.payload), data: covr.payload };
        }
      }
    }
    break; // 时长/标签只看第一枚 moov
  }
  return p > 0;
}

// —— WAV ——
export function parseWav(head: Buffer, out: FileTags, fileSize: number): void {
  let p = 12; // RIFF size WAVE
  let byteRate = 0;
  let dataBytes = 0;
  let dataOffset = 0;
  while (p + 8 <= head.length) {
    const id = str(head, p, 4);
    const size = u32le(head, p + 4);
    const body = p + 8;
    if (!isFinite(size) || size < 0) break;
    if (id === "fmt " && body + 16 <= head.length) {
      byteRate = u32le(head, body + 8);
      out.bitrateKbps = byteRate ? Math.round((byteRate * 8) / 1000) : 0;
    } else if (id === "data") {
      dataBytes = size;
      dataOffset = body;
    } else if (id === "LIST" && str(head, body, 4) === "INFO") {
      let q = body + 4;
      const listEnd = Math.min(body + size, head.length);
      while (q + 8 <= listEnd) {
        const fid = str(head, q, 4);
        const fs = u32le(head, q + 4);
        if (q + 8 + fs > head.length) break;
        const v = head.toString("utf8", q + 8, q + 8 + fs).replace(/\u0000+$/, "").trim();
        mergeId3(
          fid === "INAM" ? { title: v } : fid === "IART" ? { artist: v } : fid === "INAL" ? { album: v }
            : fid === "ICRD" ? { year: stripYear(v) } : fid === "IGNR" ? { genre: v }
              : fid === "ITRK" ? { trackNo: splitNumTotal(v) } : {},
          out,
        );
        q += 8 + fs + (fs % 2);
      }
    } else if (id === "id3 " || id === "ID3 ") {
      const t = parseId3v2(head.subarray(body, body + size), 0);
      if (t) mergeId3(t, out);
    }
    if (size > fileSize) break;
    p = body + size + (size % 2);
  }
  if (byteRate > 0) {
    const bytes = dataBytes || Math.max(0, fileSize - dataOffset);
    out.durationSec ||= bytes / byteRate;
  }
}

// —— AIFF ——
export function parseAiff(head: Buffer, out: FileTags): void {
  let p = 12; // FORM size AIFF/AIFC
  while (p + 8 <= head.length) {
    const id = str(head, p, 4);
    const size = u32be(head, p + 4);
    const body = p + 8;
    if (!isFinite(size) || size < 0 || body + 2 > head.length) break;
    if (id === "COMM" && body + 18 <= head.length) {
      const frames = u32be(head, body + 2);
      const rate = readExtended80(head, body + 8);
      if (rate > 0 && frames > 0) out.durationSec = frames / rate;
    } else if (id === "NAME" || id === "AUTH" || id === "YEAR" || id === "ANNO") {
      const v = head.toString("utf8", body, Math.min(body + size, head.length)).trim();
      mergeId3(id === "NAME" ? { title: v } : id === "AUTH" ? { artist: v } : id === "YEAR" ? { year: stripYear(v) } : { lyrics: v }, out);
    } else if (id === "id3 " || id === "ID3 ") {
      const t = parseId3v2(head.subarray(body, body + size), 0);
      if (t) mergeId3(t, out);
    }
    p = body + size + (size % 2);
  }
}

/** ID3v1：文件尾 128B 窗口。 */
export function parseId3v1(tail: Buffer): { title: string; artist: string; album: string; year: string; genre: string; trackNo: number } | null {
  if (tail.length < 128) return null;
  const off = tail.length - 128;
  if (tail.toString("latin1", off, off + 3) !== "TAG") return null;
  const s = (a: number, len: number) => tail.toString("latin1", off + a, off + a + len).replace(/\u0000+$/, "").trim();
  return {
    title: s(4, 30), artist: s(34, 30), album: s(64, 30), year: s(94, 4),
    trackNo: u8(tail, off + 125) === 0 && u8(tail, off + 126) !== 0 ? u8(tail, off + 126) : 0,
    genre: ID3V1_GENRES[u8(tail, off + 127)] ?? "",
  };
}

/** 文件名兜底："01. Artist - Title" / "Artist - Title" 之类。 */
export function parseFilename(file: string): { title: string; artist: string; trackNo: number } {
  let base = String(file ?? "");
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  let trackNo = 0;
  let s = base.trim();
  const m = /^(\d{1,3})\s*(?:[.\-_]\s*)?(.+)$/.exec(s);
  if (m && Number(m[1]) <= 999) {
    trackNo = Number(m[1]);
    s = m[2].trim();
  }
  let artist = "";
  let title = s;
  const dash = s.indexOf(" - ");
  if (dash > 0) { artist = s.slice(0, dash).trim(); title = s.slice(dash + 3).trim(); }
  else {
    const fw = s.indexOf("－");
    if (fw > 0) { artist = s.slice(0, fw).trim(); title = s.slice(fw + 1).trim(); }
  }
  return { title, artist, trackNo };
}
