// 音频流信息浮窗（正在播放页 ⋮ 旁的音质胶囊）—— 解析器运行时测试 + 接线源码级断言
//
// 解析器（src/lib/streaminfo.ts）是零依赖纯 TS：Node ≥22.18 直接 strip-types 加载，
// 用合成的 FLAC/Ogg/MP3 文件头喂进去逐字段比对（真解析，不是正则）；
// 接线部分沿用本仓库「选择器 ↔ DOM ↔ JS 接线 ↔ CSS」四边自洽的静态断言。
//
// 用法：node scripts/verify-streaminfo.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = {
  si: read("src/lib/streaminfo.ts"),
  np: read("src/components/NowPlaying.ts"),
  player: read("src/player.ts"),
  api: read("src/lib/api.ts"),
  css: read("src/style.css"),
  relay: read("src/relay.ts"),
};

let fails = 0;
let checks = 0;
function ok(name, cond, note = "") {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
}
const has = (hay, needle) => hay.includes(needle);
const re = (hay, rx) => rx.test(hay);
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ============ 1. 解析器运行时测试（合成头逐字段比对） ============

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const put = (buf, at, bytes) => buf.set(bytes, at);
const putLe32 = (buf, at, v) => buf.set([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255], at);
/** FLAC STREAMINFO：spec=STREAMINFO 之外的参数（采样率/声道/位深/总样本数） */
function flacHead({ rate, ch, bps, samples }) {
  const b = new Uint8Array(64);
  put(b, 0, ascii("fLaC"));
  b[4] = 0; b[5] = 0; b[6] = 0; b[7] = 34; // 首块 = STREAMINFO（34 字节）
  b[18] = (rate >> 12) & 255; b[19] = (rate >> 4) & 255; // 20 位采样率按 12+8 打包（b<<12|b<<4|b>>4）
  b[20] = ((rate & 15) << 4) | ((ch - 1) << 1) | (((bps - 1) >> 4) & 1);
  b[21] = ((bps - 1) & 15) << 4;
  const hi = Math.floor(samples / 0x100000000), lo = samples >>> 0;
  b[21] |= hi & 15;
  b[22] = (lo >> 24) & 255; b[23] = (lo >> 16) & 255; b[24] = (lo >> 8) & 255; b[25] = lo & 255;
  return b;
}
function oggHead(payload) {
  const b = new Uint8Array(27 + 1 + payload.length + 8);
  put(b, 0, ascii("OggS"));
  b[26] = 1; // 单 segment
  b[27] = payload.length;
  b.set(payload, 28);
  return b;
}

let si;
try {
  si = await import(pathToFileURL(join(root, "src/lib/streaminfo.ts")).href);
} catch (e) {
  console.log("FAIL 解析器加载（Node ≥22.18 才能免 flag strip-types）:", e?.message ?? e);
  process.exit(1);
}

// FLAC 16bit/44.1kHz 立体声，10,000,000 样本 ≈ 226.76s；总长 10,000,000 字节 → 平均码率 ≈ 353 kbps
{
  const info = si.parseStreamHead(flacHead({ rate: 44100, ch: 2, bps: 16, samples: 10_000_000 }), 10_000_000, 0);
  ok("flac: 识别 FLAC", info?.codec === "FLAC");
  ok("flac: 采样率 44100", info?.sampleRate === 44100);
  ok("flac: 位深 16", info?.bitDepth === 16);
  ok("flac: 声道 2", info?.channels === 2);
  ok("flac: 时长 = 总样本/采样率", Math.abs(info?.duration - 226.7574) < 0.01, String(info?.duration));
  ok("flac: 平均码率 ≈353（approx 标记）", info?.bitrateApprox === true && Math.abs(info.bitrate - 352.77) < 0.5, String(info?.bitrate));
}
// FLAC 24bit/96kHz：高位深不被当成 16
{
  const info = si.parseStreamHead(flacHead({ rate: 96000, ch: 2, bps: 24, samples: 9_600_000 }), 0, 0);
  ok("flac hi-res: 24bit/96kHz", info?.bitDepth === 24 && info?.sampleRate === 96000);
  ok("flac hi-res: 总长未知 → 不出码率", info?.bitrate === undefined);
}
// Ogg Vorbis：ID 头给 标称码率 224 kbps（精确值，不加 ≈）
{
  const p = new Uint8Array(30);
  p[0] = 1; put(p, 1, ascii("vorbis"));
  p[11] = 2; putLe32(p, 12, 44100); putLe32(p, 20, 224000);
  const info = si.parseStreamHead(oggHead(p), 9_000_000, 0);
  ok("vorbis: 识别 Vorbis/44100/2ch", info?.codec === "Vorbis" && info?.sampleRate === 44100 && info?.channels === 2);
  ok("vorbis: 标称码率 224（无 approx）", info?.bitrate === 224 && !info?.bitrateApprox);
}
// Ogg Opus：解码输出恒 48kHz；头内无码率 → 总长×时长估算
{
  const p = new Uint8Array(19);
  put(p, 0, ascii("OpusHead"));
  p[8] = 1; p[9] = 2; putLe32(p, 12, 44100);
  const info = si.parseStreamHead(oggHead(p), 7_938_000, 220.5);
  ok("opus: 识别 Opus/48000/2ch", info?.codec === "Opus" && info?.sampleRate === 48000 && info?.channels === 2);
  ok("opus: 平均码率 ≈288（approx 标记）", info?.bitrateApprox === true && Math.abs(info.bitrate - 288) < 0.5, String(info?.bitrate));
}
// Ogg Opus 多声道（回归：臻品全景声 7.1 = Q003，7.1.4 → 12ch）。
// OpusHead 的 Channel Count 字段规范是 1-255，早前按 >8 判废 → 只有 7.1 这一个档位
// 恒显「流信息不可用」（5.1 走 FLAC、其余档 ≤8ch 全正常，症状看着像随机失效）。
{
  const p = new Uint8Array(19);
  put(p, 0, ascii("OpusHead"));
  p[8] = 1; p[9] = 12; putLe32(p, 12, 48000);
  const info = si.parseStreamHead(oggHead(p), 40_000_000, 240);
  ok("opus 12ch: 不被声道上界判废（Q003 全景声 7.1）",
    info?.codec === "Opus" && info?.channels === 12 && info?.sampleRate === 48000, JSON.stringify(info));
  ok("opus 12ch: 展示为 7.1.4布局", si.fmtChannels(12) === "12（7.1.4）", si.fmtChannels(12));
}
// Ogg 但认不出编码（未知封装）：只报容器，别整个面板空掉
{
  const info = si.parseStreamHead(oggHead(new Uint8Array(16).fill(7)), 2_000_000, 100);
  ok("ogg 未知编码: 回落为 Ogg 而非 null", info?.codec === "Ogg" && info?.channels === undefined, JSON.stringify(info));
}
// MP3 裸帧头：FF FB 90 00 = MPEG1 LayerIII 128kbps/44100/立体声；帧头位率是精确值
ok("mp3: 128kbps/44100/立体声",
  (() => { const i = si.parseStreamHead(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), 0, 0);
    return i?.codec === "MP3" && i?.bitrate === 128 && i?.sampleRate === 44100 && i?.channels === 2 && !i?.bitrateApprox; })());
ok("mp3: 320kbps（FF FB E0 00）",
  si.parseStreamHead(Uint8Array.from([0xff, 0xfb, 0xe0, 0x00]), 0, 0)?.bitrate === 320);
ok("mp3: 单声道（mode=3 → 1ch）",
  si.parseStreamHead(Uint8Array.from([0xff, 0xfb, 0x90, 0xc0]), 0, 0)?.channels === 1);
// MP3 带 ID3v2：首块里只有标签 → 解析不出但给出帧偏移；第二段从帧头起可解
{
  const head = new Uint8Array(16);
  put(head, 0, ascii("ID3"));
  head[3] = 4; head[6] = 0; head[7] = 0; head[8] = 8; head[9] = 1; // syncsafe 1025 → 帧在 1035
  ok("id3: 首块解析不出（帧在标签后）", si.parseStreamHead(head, 0, 0) === null);
  ok("id3: 帧偏移 = 10 + 标签长", si.mp3FrameOffset(head) === 1035, String(si.mp3FrameOffset(head)));
  ok("id3: 帧头段可解", si.parseStreamHead(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), 0, 0)?.codec === "MP3");
}
// 坏输入一律 null（不留垃圾进浮窗）
ok("垃圾字节 → null", si.parseStreamHead(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]), 0, 0) === null);
ok("截断 FLAC → null", si.parseStreamHead(Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]), 0, 0) === null);
// 展示格式化
ok("fmt: 44100→44.1 kHz / 48000→48 kHz", si.fmtSampleRate(44100) === "44.1 kHz" && si.fmtSampleRate(48000) === "48 kHz");
ok("fmt: 位深/缺省", si.fmtBitDepth(16) === "16 bit" && si.fmtBitDepth(undefined) === "—");
ok("fmt: 码率精确/估算", si.fmtBitrate({ codec: "MP3", bitrate: 224 }) === "224 kbps"
  && si.fmtBitrate({ codec: "FLAC", bitrate: 352.77, bitrateApprox: true }) === "≈353 kbps"
  && si.fmtBitrate(null) === "—");
ok("fmt: 声道布局", si.fmtChannels(2) === "2（立体声）" && si.fmtChannels(6) === "6（5.1）" && si.fmtChannels(1) === "1（单声道）");

// ============ 2. 接线静态断言（正在播放页 ⋮ 旁胶囊 + 锚定浮窗） ============

ok("np: 胶囊与浮窗都在 ⋮ 容器内（morewrap）",
  re(src.np, /np-morewrap[^>]*>\s*<button class="np-qpill"/));
ok("np: 浮窗节点 id=np-qinfo（role=dialog）", has(src.np, 'id="np-qinfo"') && has(src.np, 'role="dialog"'));
ok("np: 胶囊文案 = 当前音质设置（QUALITY_SHORT[effectiveQuality()]）",
  has(src.np, "QUALITY_SHORT[effectiveQuality()]"));
ok("np: 浮窗数据源 = lib/streaminfo（探测 + 格式化）",
  has(src.np, "probeStreamInfo") && has(src.np, "cachedStreamInfo")
  && has(src.np, "fmtSampleRate") && has(src.np, "fmtBitDepth") && has(src.np, "fmtBitrate") && has(src.np, "fmtChannels"));
ok("np: 浮窗行齐全（编码/采样率/采样精度/码率/声道）",
  has(src.np, '"编码格式"') && has(src.np, '"采样率"') && has(src.np, '"采样精度"')
  && has(src.np, '"码率"') && has(src.np, '"声道"'));
ok("np: 探测回来自动落行（开着 + 还是同一条流才画）",
  re(src.np, /qinfoOpen\(\) && player\.streamUrl === url\)? fillQInfo\(url, info\)/));
ok("np: 点胶囊开浮窗先收 ⋮ 菜单（同锚区互斥）",
  re(src.np, /closeMoreMenu\(\);[\s\S]{0,80}qInfo\.classList\.add\("open"\)/));
ok("np: 收起正在播放页顺路关浮窗（连带摘文档监听）",
  re(src.np, /setFullscreen\(false\);\s*\}\s*closeQInfo\(\);/));
ok("np: 浮窗内容签名守卫（4Hz notify 不重建 DOM）", has(src.np, "qFillSig"));

ok("player: 挂流时记录 streamUrl", has(src.player, "this.streamUrl = r.url;"));
ok("player: 打断即清 streamUrl（旧流失效）",
  re(src.player, /private interrupt\(\) \{[\s\S]*?this\.streamUrl = "";[\s\S]*?this\.transport\.stop\(\)/));
ok("player: 窗口重建接管路径补 streamUrl（engine adopt）", has(src.player, "this.streamUrl = es.url;"));

ok("css: 胶囊与浮窗有样式", has(src.css, ".np-qpill") && has(src.css, ".np-qinfo") && has(src.css, ".qi-row"));
ok("css: 浮窗锚在胶囊上方（bottom 100%+8px，同 .np-menu 口径）", re(src.css, /\.np-qinfo\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\)/));
ok("css: morewrap 成行排布（胶囊 + ⋮ 同排）", re(src.css, /\.np-morewrap\s*\{[^}]*display:\s*flex/));

ok("si: 零依赖（Node strip-types 可直接加载，别加 import）", !/\bimport\b/.test(noComments(src.si)));
ok("si: 解析器导出齐备",
  has(src.si, "export function parseStreamHead") && has(src.si, "export function mp3FrameOffset")
  && has(src.si, "export function probeStreamInfo") && has(src.si, "export function cachedStreamInfo"));
ok("relay: Range 透传仍在（探测走的是播放流同一条中继）",
  has(src.relay, 'headers.set("range", range)'));
ok("api: 音质档位短表在场（胶囊文案依赖）", has(src.api, "export const QUALITY_SHORT"));
ok("np: 胶囊显示实际已应用档位（lastStream 优先，未播放回落设置）",
  has(src.np, "player.current && ls") && re(src.np, /ls\.degraded \? "↓" : ""/));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
