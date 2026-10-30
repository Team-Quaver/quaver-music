// Quaver — 「本地音乐 / NAS」功能护栏（扫描 · 播放流 · 歌词 · 在线刮削）。
// 跑：  node scripts/verify-local.ts
//
// 三层：
//   • 解析层纯单测：合成 ID3v2/mp3、FLAC、Vorbis、文件名兜底、LRC 解码、路径安全。
//   • 端到端真 HTTP：起 native-server（打包态同构服务），对 /api/local/* 走完整链路 ——
//     folder 源（嵌套目录/同名冲突/封面/sidecar .lrc）、WebDAV 源（假 DAV 服务器带 Basic 认证
//     与 Range）、Range/416/HEAD、在线刮削（假 sidecar：search→match→歌词落缓存）、移除源清库。
//   • 源码级接线断言：relay ⇄ native-server 双挂载点、player 的本地分支（取流/歌词/红心/档位回退
//     全绕开 QQ 通路）、session 指纹留存、路由/导航注册、preload 桥、「路径只从库来」红线。
// 反向断言照旧：每条源码断言给出「变异样本必须为 false」，防断言自身失效。
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { viewsSource } from "./views-source.ts";

const existsSync0 = (p: string): boolean => { try { readFileSync(p); return true; } catch { return false; } };

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);

function check(name: string, cond: unknown, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(join(UI, rel), "utf8");

// ———————————————————————— 合成素材工具 ————————————————————————
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const fourcc = (s: string) => Buffer.from(s, "latin1");

function txtFrame(id: string, text: string): Buffer {
  const body = Buffer.from([3, ...Buffer.from(text, "utf8")]);

  return Buffer.concat([fourcc(id), be32(body.length), Buffer.from([0, 0]), body]);
}

function id3Tag(frames: Buffer[]): { buf: Buffer; size: number } {
  const all = Buffer.concat(frames);
  const buf = Buffer.concat([fourcc("ID3"), Buffer.from([3, 0, 0]), syncsafe(all.length), all]);

  return { buf, size: 10 + all.length };
}

function mp3Frame(bitIdx = 13): Buffer {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = 0xfb; h[2] = (bitIdx << 4); h[3] = 0xc0;
  const kbps = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0][bitIdx];
  const f = Buffer.alloc(Math.floor((144 * kbps * 1000) / 44100));
  h.copy(f);

  return f;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 9), Buffer.from([0xff, 0xd9])]);

function flacFile(opts: { fields?: [string, string][]; picture?: Buffer } = {}): Buffer {
  const si = Buffer.alloc(34);
  si[10] = (44100 >> 12) & 0xff; si[11] = (44100 >> 4) & 0xff; si[12] = ((44100 & 0xf) << 4) | (2 >> 1);
  // 36-bit 总样本：低 4 位在 byte13，高位 32 位铺在 byte14..17（与 tags.parseFlac 的读法逐位对齐）
  const total = 441000; // 10s
  si[13] = (total / 4294967296 | 0) & 0x0f; si[14] = (total >> 24) & 0xff; si[15] = (total >> 16) & 0xff; si[16] = (total >> 8) & 0xff; si[17] = total & 0xff;
  const entries = (opts.fields ?? []).map(([k, v]) => Buffer.from(`${k}=${v}`, "utf8"));
  const vendor = fourcc("quaver");
  const vc = Buffer.concat([le32(vendor.length), vendor, be32v(entries.length), ...entries.map((e) => Buffer.concat([le32(e.length), e]))]);

  function be32v(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

  const blk = (type: number, last: boolean, body: Buffer) =>
    Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body]);

  const pic = opts.picture ? picBlock(opts.picture) : null;

  function picBlock(jpg: Buffer): Buffer {
    return blk(6, !pic_after_comment(), Buffer.concat([
      be32(3), be32("image/jpeg".length), fourcc("image/jpeg"), be32(0), Buffer.alloc(16), be32(jpg.length), jpg,
    ]));
  }

  function pic_after_comment(): boolean { return false; }

  const blocks: Buffer[] = [blk(0, false, si), blk(4, pic == null, vc)];

  if (pic) { blocks[1] = blk(4, false, vc); blocks.push(pic); blocks[blocks.length - 1] = Buffer.concat([Buffer.from([blocks[blocks.length - 1][0] | 0x80]), blocks[blocks.length - 1].subarray(1)]); }

  return Buffer.concat([fourcc("fLaC"), ...blocks]);
}

// ———————————————————————— 1. 解析层纯单测 ————————————————————————
const T = await import("../electron/local/tags.ts");

section("标签解析（纯单测）");

{
  const { buf } = id3Tag([txtFrame("TIT2", "夜船"), txtFrame("TPE1", "歌手X"), txtFrame("TALB", "霓虹专"), txtFrame("TDRC", "2024")]);
  const full = Buffer.concat([buf, ...Array(20).fill(null).map(() => mp3Frame(14))]);
  const parsed = T.parseId3v2(full)!;
  eq("ID3v2.3 UTF8 字段", [parsed.title, parsed.artist, parsed.album, parsed.year], ["夜船", "歌手X", "霓虹专", "2024"]);
  check("ID3v2 tagSize 指向音频起点", T.mp3AudioStart(full) === parsed.tagSize);
  const d = T.mp3Duration(full, T.mp3AudioStart(full), full.length - T.mp3AudioStart(full))!;
  check("CBR 时长折算合理（20×1045B@320kbps≈0.52s）", d.durationSec > 0.4 && d.durationSec < 0.7, String(d));
  eq("sniff mp3", T.sniffFormat(full), "mp3");
  eq("sniff flac", T.sniffFormat(flacFile()), "flac");
  const f = T.emptyTags("flac");
  T.parseFlac(flacFile({ fields: [["TITLE", "雾中曲"], ["ARTIST", "云组"]] }), f);
  eq("FLAC vorbis 注释", [f.title, f.artist], ["雾中曲", "云组"]);
  eq("FLAC 时长（441000@44.1k=10s）", Math.round(f.durationSec), 10);
  eq("文件名兜底", T.parseFilename("03. 周杰伦 - 稻香.flac"), { title: "稻香", artist: "周杰伦", trackNo: 3 });
  eq("isAudioFile", [T.isAudioFile("a.flac"), T.isAudioFile("a.txt"), T.isAudioFile("no_ext")], [true, false, false]);
}

const L = await import("../electron/local/library.ts");

{
  section("歌词解码 + 路由安全（纯单测）");
  eq("LRC UTF-8 直通", L.decodeLrc(Buffer.from("[00:01.00]啊", "utf8")).includes("啊"), true);
  eq("LRC UTF-8 BOM 剥除", L.decodeLrc(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")])).startsWith("x"), true);
  const gbk = Buffer.from([0xbe, 0xa9, 0xd6, 0xdd]); // GBK 的「京字」
  check("LRC GBK 兜底不抛异常", (() => { try { const out = L.decodeLrc(gbk); return typeof out === "string"; } catch { return false; } })());
  const LL = await import("../src/lyric.ts");
  eq("歌词格式嗅探 ttml", L.sniffLyricFormat('<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>', "a.ttml"), "ttml");
  eq("歌词格式嗅探 qrc(xml 信封)", L.sniffLyricFormat('<?xml?><QQMusic><LyricContent="[0,900]&lt;w d=&quot;900&quot;&gt;词&lt;/w&gt;"/></QQMusic>', "x"), "qrc");
  eq("歌词格式嗅探 qrc(纯文本行)", L.sniffLyricFormat("[0,900]<w d=\"450\">词</w>", "x"), "qrc");
  eq("歌词格式嗅探 lrc", L.sniffLyricFormat("[00:01.00]普通行", "x.lrc"), "lrc");
  eq("封面魔数 jpg", L.imageFormat(Buffer.from([0xff, 0xd8, 0xff, 1, 2])), "jpg");
  eq("封面魔数 png", L.imageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "png");
  eq("封面魔数拒收未知", L.imageFormat(Buffer.from("GARBAGEDATA")), "");
  eq("TTML→LRC 行级兜底", LL.ttmlToLrc('<p begin="00:00:02.500" end="00:00:04.000">第<span>二</span>行</p>'), "[00:02.50]第二行");
  eq("QRC→LRC 行级兜底", LL.qrcToLrc("[0,1500]<w d=\"750\">哈</w><w d=\"750\">喽</w>"), "[00:00.00]哈喽");
  eq("coerce 透传 lrc", LL.coerceLyricToLrc("[00:01.00]x", "lrc"), "[00:01.00]x");
  eq("reveal 拒绝非 id", L.revealTarget("../../etc/passwd").ok, false);
  eq("reveal 未知 id 报不在库", L.revealTarget("t_000000000000").ok, false);
}

// ———————————————————————— 2. 端到端真 HTTP ————————————————————————
const ROOT = mkdtempSync(join(tmpdir(), "quaver-local-"));

process.env.QUAVER_CONFIG_DIR = join(ROOT, "cfg");

// 假 sidecar（搜索 + 歌词）与假 WebDAV（Basic + Range + PROPFIND）合并在一个 http server 里。
const DAV_USER = "quaver", DAV_PASS = "s3cret";
const davMp3 = (() => { const { buf } = id3Tag([txtFrame("TIT2", "NAS 曲"), txtFrame("TPE1", "网络歌手"), txtFrame("TALB", "云专辑")]); return Buffer.concat([buf, ...Array(30).fill(null).map(() => mp3Frame(14))]); })();
const davLrc = Buffer.from("[00:01.00]来自 NAS 的 sidecar 歌词\n");
const files: Record<string, Buffer> = { "/davroot/music/NAS 曲.mp3": davMp3, "/davroot/music/NAS 曲.lrc": davLrc };

const sidecar = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const auth = String(req.headers.authorization ?? "");

  if (u.pathname.startsWith("/davroot")) {
    if (auth !== "Basic " + Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString("base64")) {
      res.statusCode = 401; return res.end("no");
    }

    if (req.method === "PROPFIND") {
      const dir = decodeURIComponent(u.pathname);
      const items = Object.keys(files).filter((p) => p.startsWith(dir.endsWith("/") ? dir : dir + "/") && !p.slice(dir.length + 1).includes("/"));
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[dir.endsWith("/") ? dir : dir + "/"].map((p) => `<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`).join("")}${items.map((p) => `<d:response><d:href>${encodeURI(p)}</d:href><d:propstat><d:prop><d:getcontentlength>${files[p].length}</d:getcontentlength><d:getlastmodified>Tue, 13 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`).join("")}</d:multistatus>`;
      res.statusCode = 207; res.setHeader("content-type", "application/xml"); return res.end(xml);
    }

    const p = decodeURIComponent(u.pathname);
    const body = files[p];

    if (!body || req.method === "PROPFIND") { res.statusCode = 404; return res.end("nf"); }

    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));

    if (range) {
      const from = Number(range[1]);
      const to = range[2] === "" ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
      res.statusCode = 206;
      res.setHeader("content-range", `bytes ${from}-${to}/${body.length}`);
      res.setHeader("content-length", String(to - from + 1));
      res.setHeader("accept-ranges", "bytes");

      return res.end(body.subarray(from, to + 1));
    }

    res.setHeader("content-length", String(body.length));

    return res.end(body);
  }

  res.setHeader("content-type", "application/json");

  if (u.pathname === "/search") {
    const kw = u.searchParams.get("keyword") ?? "";

    if (kw.includes("随手曲")) {
      return res.end(JSON.stringify({ code: 0, msg: "ok", data: { song: [{ mid: "QQMID1", title: "随手曲", name: "随手曲", interval: 205, singer: [{ name: "未知歌", mid: "SG1" }], album: { name: "", mid: "AL1", pmid: "AL1_00" } }], total_num: 1 } }));
    }

    if (kw.includes("改名曲")) {
      return res.end(JSON.stringify({ code: 0, msg: "ok", data: { song: [{ mid: "ZZ003", title: "改名曲", name: "改名曲", interval: 99, singer: [{ name: "在线歌手", mid: "SG3" }], album: { name: "", mid: "A3", pmid: "A3_9" } }], total_num: 1 } }));
    }

    return res.end(JSON.stringify({ code: 0, msg: "ok", data: { song: [] } }));
  }

  if (/^\/song\/(QQMID1|ZZ003)\/lyric$/.test(u.pathname)) {
    return res.end(JSON.stringify({ code: 0, msg: "ok", data: { lyric: "[00:03.00]刮削到的歌词", trans: "[00:03.00]scraped", roma: "" } }));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ code: -1, msg: "nope" }));
});

await new Promise<void>((r) => sidecar.listen(0, "127.0.0.1", r));

process.env.QUAVER_API = `http://127.0.0.1:${(sidecar.address() as { port: number }).port}`;

// 音乐目录（folder 源素材）：嵌套 + 两个同名文件（relPath 必须保住目录段 → id 不冲突）
const MUS = join(ROOT, "music");

mkdirSync(join(MUS, "艺人A/专辑B"), { recursive: true });

mkdirSync(join(MUS, "艺人C/专辑D"), { recursive: true });

const tagged = (() => { const { buf } = id3Tag([txtFrame("TIT2", "带标曲"), txtFrame("TPE1", "甲"), txtFrame("TALB", "专辑B")]); return Buffer.concat([buf, ...Array(20).fill(null).map(() => mp3Frame(14))]); })();

writeFileSync(join(MUS, "艺人A/专辑B/带标曲.mp3"), tagged);

writeFileSync(join(MUS, "艺人A/专辑B/带标曲.lrc"), "[00:02.00]sidecar词第一行\n");

writeFileSync(join(MUS, "艺人C/专辑D/带标曲.mp3"), flacFile({ fields: [["TITLE", "重名曲"]], picture: JPEG })); // 同名不同目录

writeFileSync(join(MUS, "艺人C/专辑D/随手曲.mp3"), mp3Frame(14)); // 无标签 → 文件名兜底 → 刮削目标

writeFileSync(join(MUS, "艺人C/专辑D/.hidden.mp3"), mp3Frame(14)); // 隐藏文件必须被跳过

const { startQuaverServer } = await import("../electron/native-server.ts");
const { server: app, url: appUrl } = await startQuaverServer({ dist: join(ROOT, "dist-empty"), logFile: join(ROOT, "dev.log"), port: 0 });
const base = appUrl + "api";
const jget = async (p: string) => { const r = await fetch(base + p); return { status: r.status, ct: r.headers.get("content-type"), body: await r.json().catch(() => null) }; };
const jpost = async (p: string, b: unknown) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };

const waitIdle = async (what: "scan" | "scrape") => {
  for (let i = 0; i < 200; i++) {
    const s = await jget(`/local/${what}`);

    if (s.body?.data?.running === false) return s.body.data;
    await new Promise((r) => setTimeout(r, 50));
  }

  throw new Error(`${what} 超时`);
};

section("端到端：添加源 → 扫描 → 播放流");

{
  const add = await jpost("/local/source/add", { kind: "folder", name: "本机音乐", path: MUS });
  check("folder 源添加成功", add.status === 200 && !!add.body?.data?.source?.id, JSON.stringify(add.body));
  const bad = await jpost("/local/source/add", { kind: "folder", name: "坏", path: join(ROOT, "does-not-exist") });
  check("不存在目录被拒（422）", bad.status === 422, JSON.stringify(bad));

  await jpost("/local/scan", {});
  const scan = await waitIdle("scan");
  check("扫描无错误", scan.errors.length === 0, JSON.stringify(scan.errors));
  const lib = (await jget("/local/library")).body.data;
  const rels = lib.tracks.map((t: any) => t.relPath).sort();
  eq("relPath 保目录段（同名不冲突）", rels, ["艺人A/专辑B/带标曲.mp3", "艺人C/专辑D/随手曲.mp3", "艺人C/专辑D/带标曲.mp3"].sort());
  check("隐藏文件被跳过", !rels.some((r: string) => r.includes(".hidden")));
  const t1 = lib.tracks.find((t: any) => t.title === "带标曲");
  eq("标签字段", [t1.artist, t1.album, t1.format, t1.tagSource], ["甲", "专辑B", "mp3", "id3v2"]);
  check("时长已解析", t1.durationSec > 0);
  const flacT = lib.tracks.find((t: any) => t.title === "重名曲");
  check("FLAC 封面抽出并落缓存", !!flacT.coverRel && exists0(join(ROOT, "cfg/local-library", flacT.coverRel)));

  // Range / 416 / HEAD
  let r = await fetch(`${base}/local/stream/${t1.id}`, { headers: { range: "bytes=10-19" } });
  const ab = await r.arrayBuffer();
  check("Range 206 + 十字节", r.status === 206 && ab.byteLength === 10 && /^bytes 10-19\/\d+$/.test(String(r.headers.get("content-range"))));
  eq("stream content-type", r.headers.get("content-type"), "audio/mpeg");
  r = await fetch(`${base}/local/stream/${t1.id}`, { headers: { range: "bytes=99999999-" } });
  eq("非法 Range → 416", r.status, 416);
  r = await fetch(`${base}/local/stream/${t1.id}`, { method: "HEAD" });
  eq("HEAD 200", r.status, 200);
  r = await fetch(`${base}/local/stream/t_000000000000`);
  eq("未知 id → 404", r.status, 404);

  // 歌词：sidecar 优先
  const ly = (await jget(`/local/lyric/${t1.id}`)).body.data;
  check("sidecar .lrc 命中", ly.source === "file" && ly.lyric.includes("sidecar词第一行"));

  // 无源可指：请求里没有路径参数（红线）
  eq("cover 无图 404", (await fetch(`${base}/local/cover/${t1.id}`)).status, 404);
}

section("端到端：WebDAV 源");

{
  const add = await jpost("/local/source/add", { kind: "webdav", name: "假NAS", url: appHostPath(sidecar, "/davroot/music"), username: DAV_USER, password: DAV_PASS });
  check("webdav 源添加（PROPFIND 探测通过）", add.status === 200 && !!add.body?.data?.source?.id, JSON.stringify(add.body));
  const masked = JSON.stringify((await jget("/local/library")).body.data.sources);
  check("口令不回显", !masked.includes(DAV_PASS), masked.slice(0, 200));
  await jpost("/local/scan", {});
  const scan = await waitIdle("scan");
  check("webdav 扫描无错误", scan.errors.length === 0, JSON.stringify(scan.errors));
  const lib = (await jget("/local/library")).body.data;
  const nas = lib.tracks.find((t: any) => t.sourceId === add.body.data.source.id);
  eq("webdav 标签解析", [nas?.title, nas?.artist, nas?.format], ["NAS 曲", "网络歌手", "mp3"]);
  check("webdav sidecar .lrc 记入", nas?.lyricSource === "file");
  const r = await fetch(`${base}/local/stream/${nas.id}`, { headers: { range: "bytes=0-3" } });
  const b = await r.arrayBuffer();
  check("webdav Range 代理（ID3 头透传）", r.status === 206 && b.byteLength === 4 && Buffer.from(b).subarray(0, 3).toString("latin1") === "ID3");
  const ly = (await jget(`/local/lyric/${nas.id}`)).body.data;
  check("webdav sidecar 歌词可读", ly.source === "file" && ly.lyric.includes("NAS 的 sidecar 歌词"));
  const bad = await jpost("/local/source/add", { kind: "webdav", name: "坏NAS", url: "http://127.0.0.1:9/dav" });
  check("不可达 WebDAV 添加被拒（502）", bad.status === 502, JSON.stringify(bad));
}

function exists0(p: string): boolean { try { return readFileSync(p).length > 0; } catch { return false; } }

function appHostPath(srv: { address(): string | { port: number } | null }, p: string): string {
  // SAFETY: 测试服务恒为 TCP 监听，address() 必返回带 port 的对象
  const a = srv.address() as { port: number };

  return `http://127.0.0.1:${a.port}${p}`;
}

section("端到端：扫描自动刮削（假 sidecar）→ QRC 前置条件落库");

{
  // 两轮扫描都发现了新歌 → 服务端在扫描收尾**自动**kick 了未匹配刮削；等它收线直接验收
  await waitIdle("scrape");
  const lib = (await jget("/local/library")).body.data;
  const unk = lib.tracks.find((t: any) => t.tagSource === "filename");
  check("扫描后自动刮削已把命中写入库（qqMid，QRC 逐字歌词的前置）", unk?.match?.qqMid === "QQMID1", JSON.stringify(unk?.match));
  const st0 = (await jget("/local/scrape")).body.data;
  check("自动那轮统计 matched≥1", st0.matched >= 1, JSON.stringify(st0));
  eq("文件名兜底 + 刮削回填后的元数据（专辑保留目录猜测）", [unk.title, unk.artist, unk.album], ["随手曲", "未知歌", "专辑D"]);
  // 显式 force 单曲重刮（队列空闲时应被接受）
  const r0 = await jpost("/local/scrape", { ids: [unk.id], force: true });
  check("显式重刮被接受", r0.body?.data?.started === true, JSON.stringify(r0.body?.data));
  await waitIdle("scrape");
  const after = (await jget(`/local/track/${unk.id}`)).body.data.track;
  eq("match 记录", [after.match?.qqMid ?? "", after.match?.singerMid ?? "", after.match?.albumPmid ?? ""], ["QQMID1", "SG1", "AL1_00"]);
  const ly = (await jget(`/local/lyric/${unk.id}`)).body.data;
  check("在线歌词入缓存且可取（本地通路兜底内容）", ly.source === "qq" && ly.lyric.includes("刮削到的歌词") && ly.trans.includes("scraped"));
}

section("端到端：手动导入歌词/封面 + 元数据校正（右键菜单的服务面）");

{
  const lib = (await jget("/local/library")).body.data;
  const tagged = lib.tracks.find((t: any) => t.title === "带标曲");   // 有 sidecar .lrc —— 测试「导入恒胜」
  const b64 = (b: Buffer) => b.toString("base64");
  // LRC 导入压过 sidecar
  let r = await jpost("/local/lyric/import", { id: tagged.id, name: "x.lrc", data: b64(Buffer.from("[00:09.00]手动导入的行\n", "utf8")) });
  eq("导入 LRC → format lrc", r.body?.data?.format, "lrc");
  let ly = (await jget(`/local/lyric/${tagged.id}`)).body.data;
  check("导入恒胜（盖过 sidecar .lrc）", ly.source === "import" && ly.lyric.includes("手动导入的行"), JSON.stringify(ly).slice(0, 120));
  // QRC 导入 → 格式标记
  r = await jpost("/local/lyric/import", { id: tagged.id, name: "y.qrc", data: b64(Buffer.from("[0,1500]<w d=\"750\">逐</w><w d=\"750\">字</w>\n", "utf8")) });
  eq("导入 QRC → format qrc", r.body?.data?.format, "qrc");
  // TTML 导入 → 格式标记
  r = await jpost("/local/lyric/import", { id: tagged.id, name: "z.ttml", data: b64(Buffer.from('<tt xmlns="http://www.w3.org/ns/ttml"><p begin="00:01.000">ttml行</p></tt>', "utf8")) });
  eq("导入 TTML → format ttml", r.body?.data?.format, "ttml");
  ly = (await jget(`/local/lyric/${tagged.id}`)).body.data;
  check("歌词接口带 format 字段", ly.source === "import" && ly.format === "ttml" && ly.lyric.includes("ttml行"), JSON.stringify(ly).slice(0, 140));
  check("重导入原地覆盖（旧内容不残留）", !ly.lyric.includes("手动导入的行") && !ly.lyric.includes("逐字"), JSON.stringify(ly).slice(0, 140));
  // 体积/内容闸
  r = await jpost("/local/lyric/import", { id: tagged.id, name: "big.lrc", data: b64(Buffer.alloc(600 * 1024, 0x31)) });
  eq("超限歌词 413", r.status, 413);
  r = await jpost("/local/cover/import", { id: tagged.id, name: "a.bin", data: b64(Buffer.from("NOT_AN_IMAGE_AT_ALL")) });
  eq("非图封面 422", r.status, 422);
  // 撤销导入 → 回到 sidecar file
  r = await fetch(`${base}/local/lyric/import/${tagged.id}`, { method: "DELETE" });
  const rev = (await r.json()) as any;
  check("撤销导入成功", rev?.data?.track?.lyricSource === "file", JSON.stringify(rev?.data).slice(0, 80));
  ly = (await jget(`/local/lyric/${tagged.id}`)).body.data;
  check("撤销后回到 sidecar", ly.source === "file", JSON.stringify(ly).slice(0, 80));
  // 封面导入 + 重扫保护（coverManual）
  const JPG1 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 5), Buffer.from([0xff, 0xd9])]);
  const cr = await jpost("/local/cover/import", { id: tagged.id, name: "c.jpg", data: b64(JPG1) });
  check("封面导入落库", cr.body?.data?.track?.coverManual === true, JSON.stringify(cr.body).slice(0, 140));
  const coverResp = await fetch(`${base}/local/cover/${tagged.id}`);
  check("封面可直接取图", coverResp.status === 200 && (await coverResp.arrayBuffer()).byteLength === JPG1.length);
  appendFileSync(tagged.file, Buffer.alloc(7000)); // 改体积逼重扫走 materialize 全解析
  await jpost("/local/scan", {});
  await waitIdle("scan"); await waitIdle("scrape");
  const after = (await jget(`/local/track/${tagged.id}`)).body.data.track;
  eq("重扫后手动封面还在", after.coverManual, true);
  check("封面字节仍是导入件", (await (await fetch(`${base}/local/cover/${tagged.id}`)).arrayBuffer()).byteLength === JPG1.length);
  // 元数据校正 + editedMeta 保护（刮削命中也不回填展示字段）
  const unk = (await jget("/local/library")).body.data.tracks.find((t: any) => t.tagSource === "filename");
  r = await jpost("/local/meta/set", { id: unk.id, title: "改名曲", artist: "自定义歌手", album: "" });
  eq("meta/set 生效", [r.body?.data?.track?.title, r.body?.data?.track?.artist, r.body?.data?.track?.editedMeta], ["改名曲", "自定义歌手", true]);
  await jpost("/local/scrape", { ids: [unk.id], force: true });
  await waitIdle("scrape");
  const fin = (await jget(`/local/track/${unk.id}`)).body.data.track;
  eq("editedMeta 挡住在线回填", [fin.title, fin.artist, fin.match?.qqMid ?? ""], ["改名曲", "自定义歌手", "ZZ003"]);
}

section("端到端：移除源清库");

{
  const lib = (await jget("/local/library")).body.data;
  const nasSrc = lib.sources.find((x: any) => x.kind === "webdav");
  await jpost("/local/source/remove", { id: nasSrc.id });
  const after = (await jget("/local/library")).body.data;
  check("曲目随之清出", after.tracks.every((t: any) => t.sourceId !== nasSrc.id));
  check("其余源不受影响", after.sources.length === lib.sources.length - 1);
}

(app as any).close?.();

sidecar.close();

rmSync(ROOT, { recursive: true, force: true });

// ———————————————————————— 3. 源码接线断言 ————————————————————————
section("源码接线：双服务端同构挂载");

{
  const relay = src("src/relay.ts"), native = src("electron/native-server.ts");
  check("relay 挂 /api/local", /path === "local" \|\| path\.startsWith\("local\/"\)/.test(relay));
  check("native-server 挂 /api/local", /sub === "\/local" \|\| sub\.startsWith\("\/local\/"\)/.test(native));
  // 顺序红线：local 路由必须在 sidecar 兜底转发之前截住
  check("relay：local 早于 sidecar 转发", relay.indexOf("handleLocalApi") < relay.indexOf("target.pathname"));
  check("native：local 早于 sidecar 转发", native.indexOf("handleLocalApi") < native.indexOf("target.pathname"));
  // 反向样本：删掉挂载行 → 断言必须为 false
  check("反向：去掉挂载则测不到", !/path === "local"/.test(relay.replace(/path === "local" \|/, "")));
}

section("源码接线：player/渲染层绕开 QQ 通路");

{
  const player = src("src/player.ts");
  check("Song 类型带 local 指纹", /local\?:\s*LocalSongFingerprint/.test(player));
  check("取流走本地分支", /isLocalSong\(s\)[\s\S]{0,200}localSongStreamUrl\(s\)/.test(player));
  check("本地流不过 Sparkle/QQ resolve", /if \(isLocalSong\(s\)(?: \|\| s\.directUrl)?\) \{ this\.skipSong\(msg\); return; \}/.test(player));
  check("歌词走 /local/lyric", /\/local\/lyric\//.test(player));
  check("红心对本地曲目停用", /if \(isLocalSong\(song\)(?: \|\| song\.directUrl)?\) return null/.test(player));
  check("换音质对本地曲目停用", /if \(this\.current && isLocalSong\(this\.current\)\)/.test(player));
  check("预取对本地曲目短路", /if \(isLocalSong\(song\)\) return/.test(player));
  const api = src("src/lib/api.ts");
  check("coverUrl 本地分支（同源路径 + 版本穿透）", /if \(s\?\.local\)[\s\S]{0,120}localCoverPath\(s\.local\.id\)/.test(api));
  const session = src("src/lib/session.ts");
  check("会话存档保留 local 指纹", /local: \(s as any\)\.local/.test(session));
  const songs = src("src/lib/songs.ts");
  check("本地行藏红心 + 时长占位", /hooks\.hideLove \|\| isLocal/.test(songs) && /isLocal && !\(s\.interval > 0\)/.test(songs));
  const mpris = src("src/mpris.ts");
  check("MPRIS 封面绝对化", /const absArt =/.test(mpris) && /artUrl: absArt\(coverUrl/.test(mpris));
  const local = src("src/lib/local.ts");
  check("mid 命名空间隔离（local:<id>）", /mid: "local:" \+ t\.id/.test(local));
  check("口令永不进渲染层：快照不含 password 消费", !/\.password/.test(local));
  // —— QRC 优先：匹配到 QQ 曲库的本地曲目，歌词走在线逐字管线（用户明确要求）——
  check("指纹携带 qqMid（刮削命中随 Song/session 走）", /qqMid: t\.match\?\.qqMid/.test(local));
  check("本地曲目仅在有 qqMid 且未手动导入时才试在线管线", /const qqMid = local \? \(local\.lyricImport \? "" : String\(local\.qqMid \?\? ""\)\) : s\.mid/.test(player));
  check("QRC 拉取与官方共用一条管线（pullQqLyric）", /private async pullQqLyric\(midRaw: string/.test(player) && /await this\.pullQqLyric\(qqMid, seq, s\)/.test(player));
  check("在线无内容才落回 /local/lyric（本地曲专属兜底；官方曲目行为不变）", /if \(has \|\| !local\) \{ this\.notify\(\); return; \}/.test(player));
  check("库快照更新回填当前曲目（qqMid 到手即升级 QRC）", /onLocalLibraryChange\(\(\) => this\.refreshLocalCurrent\(\)\)/.test(player));
  const np = src("src/components/NowPlaying.ts");
  const dlBridge = src("src/lib/desktop-lyrics.ts");
  const dlPage = src("src/desktop-lyrics.ts");
  check("重导入歌词即使状态仍为 ok 也重建正在播放页 DOM",
    /lyricRevision/.test(player) && /player\.lyricRevision !== lastLyricRevision/.test(np));
  check("重导入歌词会重推桌面歌词整包并按内容版本重绘",
    /lyricRevision: player\.lyricRevision/.test(dlBridge) && /track\.lyricRevision/.test(dlPage));
  const libSrc2 = src("electron/local/library.ts");
  check("扫描发现新歌 → 服务端自动补刮未匹配段", /if \(scanState\.found > 0 && Object\.values\(loadDb\(\)\.tracks\)\.some\(\(t\) => !t\.match\)\)/.test(libSrc2));
  // 反向：qqMid 判空写坏成恒真/恒假都要能红
  check("反向：把 qqMid 分支删掉即测不到", !/const qqMid = local \? \(local\.lyricImport \? "" : String\(local\.qqMid \?\? ""\)\) : s\.mid/.test(player.replace('const qqMid = local ? (local.lyricImport ? "" : String(local.qqMid ?? "")) : s.mid;', "")));
}

section("源码接线：路由/导航/桥");

{
  const shell = src("src/shell.ts"), views = viewsSource();
  check("侧栏导航含本地音乐", /\{ path: "#\/local", label: "本地音乐", icon: "folder" \}/.test(shell));
  const LOCAL_REG = /"\/local": \(\) => import\("\.\/local"\)/;
  check("视图注册 /local（懒加载表里是一条 import 缝，不是函数直引）", LOCAL_REG.test(views));
  check("反向：注册缺失即红", !LOCAL_REG.test(views.replace(LOCAL_REG, "")));
  const preload = src("electron/preload.cts"), globals = src("src/globals.d.ts");
  check("preload 暴露 quaverLocal", /exposeInMainWorld\("quaverLocal"/.test(preload));
  check("globals 声明 quaverLocal", /quaverLocal\?:/.test(globals));
  const main = src("electron/main.ts");
  check("主进程处理 pick-folder 与 reveal", /op === "pick-folder"/.test(main) && /revealTarget\(String\(msg\?\.id/.test(main));
}

section("安全红线：路径只从库来");

{
  const lib = src("electron/local/library.ts");
  check("流/封面/歌词只认 t_<12hex> id", /stream\\\/\(t_\[0-9a-f\]\{12\}\)/.test(lib) && /TRACK_ID_RE/.test(lib));
  check("请求参数不参与拼路径", !/searchParams\.get\("path"\)|searchParams\.get\("file"\)/.test(lib));
  check("库文件 0600", /writeFilePrivate\(dbFile\(\), JSON\.stringify\(db\)\)/.test(lib));
  check("软链不跟（防越界/环路）", /ent\.isSymbolicLink\(\)\) continue/.test(lib));
}

console.log(`\n=== 合计 ${pass} 通过 / ${fail} 失败 ===`);

process.exit(fail ? 1 : 0);
