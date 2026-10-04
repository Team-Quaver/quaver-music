// 音频流信息探测：对播放流（/api/stream/<token> 或插件源）发小 Range 请求取文件头，
// 解析容器头给出 编码格式 / 采样率 / 采样精度 / 码率 / 声道，供正在播放页的音质浮窗展示。
//
// 为什么在渲染层做：两种后端（Python sidecar / Go quaver-server）对 /api/stream/* 都是
// 纯透传中继（relay.ts 透传 Range，后端原样回 206），渲染层自己拿头字节即可解析，
// 不动后端、不占 resolve 协商的关键路径（打开浮窗才探测一次，结果按 URL 缓存）。
// 加密档位在后端中继侧已解密，渲染层看到的永远是明文容器 —— 三种容器覆盖全部档位：
// FLAC（STREAMINFO 首块必在文件头 42 字节内）、Ogg（Vorbis/Opus 的 ID 头必在首页）、
// MP3（帧头；带 ID3v2 时按头 10 字节里的标签大小跳过标签再取一段）。
// 各档位实际容器：atmos51 是 FLAC（6ch），atmos71 是 Ogg（7.1.4 = 12ch Opus）——
// 声道数按字段规范放行，别按「常见值」收口成 8（见 parseOgg 注释）。
//
// 本模块**零依赖**（不 import 任何东西）：解析函数是纯函数，Node 直接 strip-types
// 跑 scripts/verify-streaminfo.mjs 的合成头用例。

/** 一次探测的结果。有损格式没有采样精度（bitDepth 空缺）；头里带不出码率时由
 *  总长 ÷ 时长估算（bitrateApprox=true，展示层加 ≈ 号）。 */
export interface StreamInfo {
  codec: string; // 展示名：FLAC / Vorbis / Opus / MP3
  sampleRate?: number; // Hz
  bitDepth?: number; // 采样精度（bit），仅无损容器有
  bitrate?: number; // kbps
  bitrateApprox?: boolean; // true = 平均码率（总长÷时长），非头内标称值
  channels?: number;
  duration?: number; // 秒（FLAC 从 STREAMINFO 精确可得；其余空缺）
}

// —— 纯解析：head = 流头部字节；totalSize = 文件总长（Content-Range，0=未知）；
//    durationSec = 播放器已知的时长（0=未知，估算码率兜底用）。解析不出返回 null。——

export function parseStreamHead(head: Uint8Array, totalSize: number, durationSec: number): StreamInfo | null {
  if (head.length >= 4 && str(head, 0, 4) === "fLaC") return parseFlac(head, totalSize);
  if (head.length >= 4 && str(head, 0, 4) === "OggS") return parseOgg(head, totalSize, durationSec);
  // MP3：裸帧或带 ID3v2（首块里已能看到帧头就直接解）
  if (head.length >= 4 && str(head, 0, 3) === "ID3") {
    const off = mp3FrameOffset(head);
    if (off != null && off + 4 <= head.length) return parseMp3Frame(head, off, totalSize, durationSec);
    return null; // 帧头不在首块里：probeStreamInfo 会按标签终点再取一段
  }
  return parseMp3Frame(head, 0, totalSize, durationSec);
}

/** ID3v2 标签终点（= 音频帧应起始的偏移）；无 ID3 返回 null。
 *  尺寸是 syncsafe 整数（每字节 7 位），见 ID3v2.4 spec 6.1；带 footer（flag 0x10）再 +10。 */
export function mp3FrameOffset(head: Uint8Array): number | null {
  if (head.length < 10 || str(head, 0, 3) !== "ID3") return null;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const footer = !!(head[5] & 0x10);
  return 10 + size + (footer ? 10 : 0);
}

/** FLAC：STREAMINFO 永远是第一个元数据块（4 magic + 4 块头 + 34 字节块体，规格保证）。
 *  块体布局：0-9 = min/max block/frame size，10-12 = 采样率(20b,按 12+8 打包)+声道(3b)+位深(5b)，
 *  13-17 = 总样本数(36b)。s 指向采样率字段的绝对偏移（= 8 + 10）。 */
function parseFlac(b: Uint8Array, totalSize: number): StreamInfo | null {
  if (b.length < 42 || b[4] >> 7 || (b[4] & 0x7f) !== 0) return null; // 首块必须是 STREAMINFO
  const s = 18;
  const sampleRate = (b[s] << 12) | (b[s + 1] << 4) | (b[s + 2] >> 4);
  const channels = ((b[s + 2] >> 1) & 0x7) + 1;
  const bitDepth = (((b[s + 2] & 1) << 4) | (b[s + 3] >> 4)) + 1;
  if (sampleRate < 8000 || sampleRate > 655350 || bitDepth < 4 || bitDepth > 32) return null;
  const totalSamples = (b[s + 3] & 0x0f) * 0x100000000
    + (b[s + 4] << 24 | b[s + 5] << 16 | b[s + 6] << 8 | b[s + 7]);
  const duration = sampleRate > 0 ? totalSamples / sampleRate : 0;
  const info: StreamInfo = { codec: "FLAC", sampleRate, bitDepth, channels };
  if (duration > 0) info.duration = duration;
  const bitrate = avgBitrate(totalSize, duration);
  if (bitrate) { info.bitrate = bitrate; info.bitrateApprox = true; }
  return info;
}

/** Ogg：ID 头（Vorbis 30B / Opus 19B）按规格必须在第一页，直接在首部字节里找 magic。
 *
 * 声道上界按**字段规范**放行到 255，不按 8 收口：OpusHead 的 Channel Count 字段
 * （RFC 7845 §4）是 1-255，8 只是绝大多数内容的实际取值。上游「臻品全景声 7.1」
 * （Q003，7.1.4 = 7 主 + LFE + 4 顶 = 12 声道）就落在区间里——早前按 `> 8` 判废，
 * 结果只有这一个档位的流信息恒为「不可用」，而6 声道/立体声的全景声、FLAC 各档全正常，
 * 症状看起来像「随机失效」实则是写死的上界。
 *
 * 首字节是 OggS 但认不出编码时也照样给一条 Ogg 记录：浮窗是只读展示，宁可少几行
 * 也不要掉进「流信息不可用」的死胡同（未知封装不该让整个面板变空）。 */
function parseOgg(b: Uint8Array, totalSize: number, durationSec: number): StreamInfo | null {
  const limit = Math.min(b.length - 8, 200);
  for (let i = 27; i < limit; i++) {
    if (str(b, i, 8) === "OpusHead") {
      // Opus 解码输出恒为 48 kHz（头里的 input samplerate 是原始录音率，不是播放采样率）
      const channels = b[i + 9];
      if (channels < 1) return null;
      const info: StreamInfo = { codec: "Opus", sampleRate: 48000, channels };
      const bitrate = avgBitrate(totalSize, durationSec);
      if (bitrate) { info.bitrate = bitrate; info.bitrateApprox = true; }
      return info;
    }
    if (b[i] === 1 && str(b, i + 1, 6) === "vorbis") {
      const channels = b[i + 11];
      const sampleRate = le32(b, i + 12);
      const nominal = le32(b, i + 20); // 标称码率（有符号，<=0 视为缺）
      if (channels < 1 || sampleRate < 8000 || sampleRate > 655350) return null;
      const info: StreamInfo = { codec: "Vorbis", sampleRate, channels };
      if (nominal > 0) info.bitrate = nominal / 1000;
      else {
        const bitrate = avgBitrate(totalSize, durationSec);
        if (bitrate) { info.bitrate = bitrate; info.bitrateApprox = true; }
      }
      return info;
    }
  }
  // 是 Ogg 但不是已知的 Vorbis/Opus（如腾讯自研封装）：只报容器，不猜编码
  const info: StreamInfo = { codec: "Ogg" };
  const bitrate = avgBitrate(totalSize, durationSec);
  if (bitrate) { info.bitrate = bitrate; info.bitrateApprox = true; }
  return info;
}

/** MP3 帧头 4 字节：11 位帧同步 + 版本/层/位率/采样率/声道模式。 */
function parseMp3Frame(b: Uint8Array, off: number, totalSize: number, durationSec: number): StreamInfo | null {
  if (off + 4 > b.length || b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (b[off + 1] >> 3) & 3; // 3=MPEG1 2=MPEG2 0=MPEG2.5（1=保留）
  const layerBits = (b[off + 1] >> 1) & 3; // 1=Layer III 2=Layer II 3=Layer I（0=保留）
  const brIdx = (b[off + 2] >> 4) & 0x0f; // 0=free 15=坏
  const srIdx = (b[off + 2] >> 2) & 3; // 3=保留
  const mode = (b[off + 3] >> 6) & 3; // 3=单声道，其余按 2 声道算
  if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const mpeg = verBits === 3 ? 1 : verBits === 2 ? 2 : 25;
  const sampleRates: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };
  const sampleRate = sampleRates[mpeg][srIdx];
  const channels = mode === 3 ? 1 : 2;
  const codec = layerBits === 1 ? "MP3" : `MPEG${mpeg === 25 ? "2.5" : mpeg} L${4 - layerBits}`;
  const info: StreamInfo = { codec, sampleRate, channels };
  if (layerBits === 1) {
    // Layer III 位率表（kbps）：MPEG1 与 MPEG2/2.5 两张
    const kbps = (mpeg === 1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[brIdx];
    if (kbps) info.bitrate = kbps;
  }
  if (!info.bitrate) {
    const bitrate = avgBitrate(totalSize, durationSec);
    if (bitrate) { info.bitrate = bitrate; info.bitrateApprox = true; }
  }
  return info;
}

/** 平均码率（kbps）：总长与时长都已知才算（总长来自 Range 探测响应的 Content-Range）。 */
function avgBitrate(totalSize: number, durationSec: number): number | null {
  if (totalSize <= 0 || durationSec <= 0) return null;
  return (totalSize * 8) / durationSec / 1000;
}

// —— 探测（带缓存；并发共享同一 Promise，失败也缓存避免对死流反复打） ——

const cache = new Map<string, Promise<StreamInfo | null>>();
const CACHE_MAX = 32; // token 一次一换，够放下滚动换曲的余量；超了整体清（旧 token 后端也会 TTL 回收）

export function cachedStreamInfo(url: string): Promise<StreamInfo | null> | undefined {
  return cache.get(url);
}

export function probeStreamInfo(url: string, opts?: { duration?: number }): Promise<StreamInfo | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = doProbe(url, opts?.duration ?? 0).catch(() => null).then((info) => {
    if (cache.size > CACHE_MAX) cache.clear(); // 收尾换掉 Promise 本体，后续命中不再发请求
    cache.set(url, Promise.resolve(info));
    return info;
  });
  cache.set(url, p);
  return p;
}

async function doProbe(url: string, durationSec: number): Promise<StreamInfo | null> {
  const first = await fetchHead(url, 0, 4095);
  if (!first) return null;
  const info = parseStreamHead(first.bytes, first.total, durationSec);
  if (info) return info;
  // MP3 带 ID3v2：帧头藏在标签后（标签可到几百 KB，首页看不到）→ 按标签终点再取一小段
  const off = mp3FrameOffset(first.bytes);
  if (off == null || off <= 0 || off > 4_000_000) return null;
  const second = await fetchHead(url, off, off + 255);
  if (!second) return null;
  return parseStreamHead(second.bytes, second.total, durationSec);
}

/** 取 [start,end] 闭区间字节；total 从 Content-Range（回落 Content-Length）解析。 */
async function fetchHead(url: string, start: number, end: number): Promise<{ bytes: Uint8Array; total: number } | null> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const cr = /bytes\s+\d+-\d+\/(\d+)/.exec(r.headers.get("content-range") ?? "");
  const cl = /(\d+)/.exec(r.headers.get("content-length") ?? "");
  const total = cr ? Number(cr[1]) : cl ? Number(cl[1]) : 0;
  const reader = r.body?.getReader();
  if (!reader) return null;
  const cap = end - start + 1;
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
      if (got >= cap) { void reader.cancel().catch(() => {}); break; } // 只要头几个字节，后面立刻弃
    }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* 已关 */ }
  }
  const bytes = new Uint8Array(Math.min(got, cap));
  let at = 0;
  for (const c of chunks) {
    if (at >= bytes.length) break;
    bytes.set(c.subarray(0, bytes.length - at), at);
    at += c.length;
  }
  return { bytes, total };
}

// —— 展示格式化（浮窗直接用） ——

/** 声道布局名。只列frequently 出现的包围盒排布（数 = LFE + 主 + 高度/后置），
 *  表外直接落「N 声道」——宁可少个布局名，也不要把 12ch 硬套成 7.1。 */
const CH_LAYOUT: Record<number, string> = { 1: "单声道", 2: "立体声", 3: "3.0", 4: "4.0", 5: "5.0", 6: "5.1", 7: "6.1", 8: "7.1", 10: "5.1.4", 12: "7.1.4" };

export const fmtSampleRate = (hz?: number) =>
  hz && hz > 0 ? `${hz % 1000 ? (hz / 1000).toFixed(1) : hz / 1000} kHz` : "—";

export const fmtBitDepth = (bits?: number) => (bits && bits > 0 ? `${bits} bit` : "—");

export const fmtBitrate = (info: StreamInfo | null) =>
  info?.bitrate && info.bitrate > 0 ? `${info.bitrateApprox ? "≈" : ""}${Math.round(info.bitrate)} kbps` : "—";

export const fmtChannels = (ch?: number) =>
  ch && ch > 0 ? `${ch}${CH_LAYOUT[ch] ? `（${CH_LAYOUT[ch]}）` : " 声道"}` : "—";

// —— 小工具 ——

function str(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

function le32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}
