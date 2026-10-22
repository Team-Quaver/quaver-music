// Quaver — 歌词设置单测：[Lyrics] 四件套的行为与接线。
// 覆盖：TTML 地址模板判据与展开（src/lib/ttml.ts，纯函数直测）；在线库查询走本地 http 桩
// （200/404/非TTML/体积四路）+ 会话负缓存；本地歌词库候选名生成与 /api/local/ttml 路由
// （真目录真配置，含路径逃逸防线）；繁简转换真词典（vite 现打包 prefs+cjk-convert 注入 DOM 桩，
// 钉「档位→方向→词典」接线与短语级歧义）；渲染层与管线接线（源码正则，仓库既定套路）。
// 跑： node scripts/verify-lyrics.ts
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { defaults } from "../electron/config.ts";
import { handleLocalApi, ttmlLibraryCandidates } from "../electron/local/library.ts";
import {
  TTML_DB_DEFAULT_URL, TTML_PLATFORM_DIRS, expandTtmlUrl, isTtmlDatabaseUrl, looksLikeTtml,
  ttmlMissCached, ttmlMissRemember, fetchTtml,
} from "../src/lib/ttml.ts";
import { extractQrcPayload } from "../src/lyric.ts";
import { viewsSource } from "./views-source.ts";

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ROOT = mkdtempSync(join(tmpdir(), "quaver-lyrics-"));
process.env.QUAVER_CONFIG_DIR = join(ROOT, "cfg");
const UI = fileURLToPath(new URL("..", import.meta.url));

// ——— 模板判据与展开 ———
section("TTML 地址模板");
check("默认模板自校验通过", isTtmlDatabaseUrl(TTML_DB_DEFAULT_URL));
check("默认模板与 schema 同源", defaults()["Lyrics.TtmlDatabase"] === TTML_DB_DEFAULT_URL);
check("缺 %s 非法", !isTtmlDatabaseUrl("https://x.example/%p.ttml"));
check("非 http(s) 非法", !isTtmlDatabaseUrl("ftp://x.example/%s.ttml") && !isTtmlDatabaseUrl("javascript:fetch(%25s)"));
check("带空格/引号非法", !isTtmlDatabaseUrl("https://x.example/a b/%s.ttml") && !isTtmlDatabaseUrl('https://x.example/"%s'));
check("相对地址非法", !isTtmlDatabaseUrl("/just/a/path/%s.ttml"));
eq("展开：qq → qq-lyrics 目录", expandTtmlUrl(TTML_DB_DEFAULT_URL, "qq", "001A1BcC2dD33"), "https://amlldb.bikonoo.com/qq-lyrics/001A1BcC2dD33.ttml");
eq("展开：网易云目录", expandTtmlUrl(TTML_DB_DEFAULT_URL, "netease", "101126"), "https://amlldb.bikonoo.com/ncm-lyrics/101126.ttml");
eq("展开：平台未知但模板无 %p 照走", expandTtmlUrl("https://single.example/song/%s.ttml", "kugou", "42"), "https://single.example/song/42.ttml");
eq("展开：模板带 %p 而平台不认识 → null（不发请求）", expandTtmlUrl(TTML_DB_DEFAULT_URL, "kugou", "42"), null);
eq("展开：空 id → null", expandTtmlUrl(TTML_DB_DEFAULT_URL, "qq", ""), null);
eq("展开：坏模板 → null", expandTtmlUrl("not a url", "qq", "x"), null);
eq("展开：多次占位都替换", expandTtmlUrl("https://x.example/%s/%p/%s.ttml", "am", "i1"), "https://x.example/i1/am-lyrics/i1.ttml");
check("平台表含四大源", ["qq", "ncm", "am", "spotify"].every((p) => TTML_PLATFORM_DIRS[p]));

// ——— QRC 信封容错 ———
section("QRC XML 信封提取");
const STARBOY_QRC = '<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[0,3900]Produced by：Daft Punk/Martin "Doc" McKinney&#10;[15607,144]Ayy(15607,144)"/></LyricInfo></QrcInfos>';
const starboyBody = extractQrcPayload(STARBOY_QRC);
check("LyricContent 内未转义引号不会截断后续正文（Starboy 回归）",
  starboyBody.includes('Produced by：Daft Punk/Martin "Doc" McKinney') && starboyBody.includes("[15607,144]Ayy"),
  starboyBody);

// ——— 嗅探与在线查询（本地 http 桩） ———
section("在线库查询与负缓存");
const TTML_SAMPLE = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s">主歌</p></div></body></tt>';
check("looksLikeTtml 认 <tt", looksLikeTtml(TTML_SAMPLE));
check("looksLikeTtml 拒 LRC/QRC", !looksLikeTtml("[00:00.00]主歌") && !looksLikeTtml("<QrcInfos/>"));
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://h");
  if (u.pathname === "/ok.ttml") { res.setHeader("content-type", "application/octet-stream"); res.end(TTML_SAMPLE); return; }
  if (u.pathname === "/junk.ttml") { res.end("just some html"); return; }
  if (u.pathname === "/huge.ttml") { res.write(TTML_SAMPLE); res.write("x".repeat(600 * 1024)); res.end(); return; }
  res.statusCode = 404; res.end("nope");
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
eq("命中返回全文", await fetchTtml(`${base}/ok.ttml`), TTML_SAMPLE);
eq("404 → null", await fetchTtml(`${base}/missing.ttml`), null);
eq("非 TTML 内容 → null", await fetchTtml(`${base}/junk.ttml`), null);
eq("超体积上限 → null", await fetchTtml(`${base}/huge.ttml`), null);
eq("坏地址 → null（不抛）", await fetchTtml("http://127.0.0.1:1/%s"), null);
check("负缓存：未记时不命中", !ttmlMissCached(`${base}/m1`));
ttmlMissRemember(`${base}/m1`);
check("负缓存：记过后命中", ttmlMissCached(`${base}/m1`));
check("负缓存：别的地址不受影响", !ttmlMissCached(`${base}/m2`));
stub.close();

// ——— 本地 TTML 歌词库：候选名 + /api/local/ttml 路由（真目录真配置） ———
section("本地 TTML 歌词库");
const LIB = join(ROOT, "lib");
mkdirSync(join(LIB, "qq-lyrics"), { recursive: true });
writeFileSync(join(LIB, "qq-lyrics", "0000abcd.ttml"), TTML_SAMPLE);
writeFileSync(join(LIB, "夜空中最亮的星-逃跑计划.ttml"), TTML_SAMPLE);
writeFileSync(join(LIB, "起风了 - 买辣椒也用券.ttml"), TTML_SAMPLE);
writeFileSync(join(LIB, "孤勇者.ttml"), TTML_SAMPLE);
writeFileSync(join(LIB, "qq-lyrics", "notlyrics.txt"), "ignore me");
eq("候选：id 优先（仓库布局 → 平铺 → 名字组合）",
  ttmlLibraryCandidates({ qq: "0000abcd", name: "孤勇者", artist: "陈奕迅" }).slice(0, 2),
  ["qq-lyrics/0000abcd.ttml", "0000abcd.ttml"]);
eq("候选：两种连字符 + 两种顺序 + 裸名",
  ttmlLibraryCandidates({ name: "A", artist: "B" }),
  ["A-B.ttml", "B-A.ttml", "A - B.ttml", "B - A.ttml", "A.ttml"]);
eq("候选：多歌手逐个拆", ttmlLibraryCandidates({ name: "A", artist: "B,C" }).includes("A-C.ttml"), true);
eq("候选：分隔符与控制字符被消毒（路径逃逸拼不出来）",
  ttmlLibraryCandidates({ name: "../../etc/passwd", artist: "a/b\\c" }),
  [".. .. etc passwd-a b c.ttml", "a b c-.. .. etc passwd.ttml", ".. .. etc passwd - a b c.ttml", "a b c - .. .. etc passwd.ttml", ".. .. etc passwd.ttml"]);
eq("候选：非法 id 不产 id 候选", ttmlLibraryCandidates({ qq: "a/../b" }), []);

const CFGDIR = join(ROOT, "cfg");
mkdirSync(CFGDIR, { recursive: true });
const confFile = join(CFGDIR, "quaver.conf");
writeFileSync(confFile, `[Lyrics]\nTtmlLibrary=${LIB}\n`);
const lapi = createServer((req, res) => {
  void handleLocalApi(req, res, new URL(req.url ?? "/", "http://h").pathname.replace(/^\/api\//, ""))
    .then((done) => { if (!done) { res.statusCode = 404; res.end(); } })
    .catch(() => { res.statusCode = 500; res.end("boom"); });
});
await new Promise<void>((r) => lapi.listen(0, "127.0.0.1", r));
const lbase = `http://127.0.0.1:${(lapi.address() as { port: number }).port}`;
// 与渲染层 api() 同构：信封 {code,msg,data} 要解包后再断言
const lget = async (qs: string): Promise<any> => {
  try { const j = await (await fetch(`${lbase}/api/local/ttml?${qs}`)).json(); return j?.data ?? j; } catch { return null; }
};
const byId = await lget("qq=0000abcd");
eq("路由：按 songmid 命中仓库布局", [byId?.found, byId?.rel], [true, "qq-lyrics/0000abcd.ttml"]);
check("路由：返回的是 TTML 原文", String(byId?.text ?? "").startsWith('<?xml'));
eq("路由：按「歌名-歌手」命中", (await lget("name=" + encodeURIComponent("夜空中最亮的星") + "&artist=" + encodeURIComponent("逃跑计划"))).found, true);
eq("路由：空格连字符变体命中", (await lget("name=" + encodeURIComponent("起风了") + "&artist=买辣椒也用券")).found, true);
eq("路由：裸歌名命中", (await lget("name=" + encodeURIComponent("孤勇者"))).found, true);
eq("路由：查无此歌 found:false", (await lget("qq=ffffffff&name=没有这首歌&artist=也没有")).found, false);
eq("路由：逃逸尝试不出库（found:false，未读到 /etc 内容）", (await lget("name=../../etc/passwd&artist=root")).found, false);
writeFileSync(confFile, `[Lyrics]\nTtmlLibrary=${join(ROOT, "does-not-exist")}\n`);
eq("路由：目录不存在 = 静默无命中", (await lget("qq=0000abcd")).found, false);
writeFileSync(confFile, `[Lyrics]\nTtmlLibrary=\n`);
eq("路由：未配置目录 = 不读盘", (await lget("qq=0000abcd")).found, false);
lapi.close();

// ——— 繁简转换：vite 现打包 prefs+cjk-convert，真词典真行为 ———
section("繁简转换（OpenCC 词典）");
writeFileSync(join(ROOT, "entry.ts"), `
export * from ${JSON.stringify(join(UI, "src/lib/cjk-convert.ts"))};
export { getChineseConvert, setChineseConvert } from ${JSON.stringify(join(UI, "src/lib/prefs.ts"))};
`);
const res = await viteBuild({
  configFile: false,
  logLevel: "error",
  root: UI,
  define: { "import.meta.env.DEV": "false" },
  build: {
    write: false, minify: false, target: "esnext",
    rollupOptions: { output: { codeSplitting: false } }, // 词典内联进测试 bundle，动态 import 才可在 node 里跑
    lib: { entry: join(ROOT, "entry.ts"), formats: ["es"], fileName: () => "b.mjs" },
  },
});
const chunk = res[0].output.find((o) => o.type === "chunk");
if (!chunk || chunk.type !== "chunk") { console.log("  ❌ 打包失败"); fail++; }
else {
  const bundleFile = join(ROOT, "b.mjs");
  writeFileSync(bundleFile, chunk.code);
  // 最小 DOM 桩（config.ts boot 的 localStorage 回落路径）
  const ls = new Map();
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => void ls.set(k, String(v)),
    removeItem: (k) => void ls.delete(k),
  };
  globalThis.document = { documentElement: { dataset: {}, classList: { toggle: () => {}, add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } }, body: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } }, addEventListener: () => {}, visibilityState: "visible" };
  globalThis.window = {
    addEventListener: () => {}, setTimeout, clearTimeout, localStorage: globalThis.localStorage,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  const C = await import(bundleFile);

  eq("off：原文不动", await C.cjkConvert("設計一個設計師"), "設計一個設計師");
  C.setChineseConvert("simplified"); C.resetCjkConverter();
  eq("转为简体", await C.cjkConvert("設計一個設計師在鐘錶"), "设计一个设计师在钟表");
  eq("简体二次幂等", await C.cjkConvert(await C.cjkConvert("設計")), "设计");
  C.setChineseConvert("traditional"); C.resetCjkConverter();
  eq("转为繁体", await C.cjkConvert("设计一个设计师"), "設計一個設計師");
  eq("短语级歧义：头发→頭髮（不是头發）", await C.cjkConvert("理发师在洗头发"), "理髮師在洗頭髮");
  eq("非汉字不动（英/日假名/数字/时间戳）", await C.cjkConvert("Hello 00:12.34 かな <w w=\"123\">"), "Hello 00:12.34 かな <w w=\"123\">");
  eq("XML 骨架穿透安全：标签与时间轴保持 ASCII", (await C.cjkConvert('<p begin="0.5s">這裡是歌詞</p>')).includes('begin="0.5s"'), true);
  check("无汉字短路透过（relevant 判据）", !C.cjkConvertRelevant("pure ascii かな"));
  check("relevant 认扩展汉字", C.cjkConvertRelevant("𠮷野家"));
  C.setChineseConvert("off"); C.resetCjkConverter();
  eq("关掉档位立即回原文", await C.cjkConvert("設計"), "設計");
}

// ——— 接线（源码正则，仓库既定护栏套路） ———
section("管线与设置页接线");
const player = readFileSync(join(UI, "src/player.ts"), "utf8");
check("fetchLyric：无逐字才进 TTML（两处调用都带 seq 守卫）",
  /!this\.karaoke\.length && \(await this\.pullTtml\(qqMid, seq, s\)\)/.test(player)
  && /pullTtml\("", seq, s\)/.test(player));
check("手动导入件不进 TTML（imported 分支被排除）", /local\.lyricImport \? "" :/.test(player));
check("在线查询走模板展开 + 负缓存", /expandTtmlUrl\(getTtmlDatabase\(\), "qq", mid\)/.test(player) && /ttmlMissCached\(url\)/.test(player) && /ttmlMissRemember\(url\)/.test(player));
check("本地库走主进程路由", /`\/local\/ttml\?\$\{qs/.test(player) && getTtmlLibGate());
function getTtmlLibGate() { return /if \(getTtmlLibrary\(\)\)/.test(player); }
check("QRC/LRC/TTML/本地合成四路都过 cjkConvert",
  (player.match(/cjkConvert\(/g) ?? []).length >= 6 && /applyLyricText\(text, "", "", "ttml"\)/.test(player));
check("音译不转换（roma 原文直传）", /roma = String\(d\?\.roma/g.test(player) || /roma = String\(d\?\.roma/g.test(player));
check("设置变更即重拉", /reloadLyric\(\): void \{/.test(player));
const views = viewsSource();
check("设置页有歌词 tab 与面板", views.includes('data-tab="lyrics"') && views.includes('data-panel="lyrics"'));
check("四项控件齐备", ["#cjk-cards", "#ttml-online-cards", "#ttml-db-url", "#ttml-lib-pick"].every((id) => views.includes(id)));
check("档位切换挂 resetCjkConverter + reloadLyric", /setChineseConvert\(v\); resetCjkConverter\(\); player\.reloadLyric\(\);/.test(views));
const cfgSrc = readFileSync(join(UI, "src/lib/config.ts"), "utf8");
check("渲染层 FALLBACK 与 schema 同步（改一处要改两处）",
  ["Lyrics.ChineseConvert", "Lyrics.OnlineTtml", "Lyrics.TtmlDatabase", "Lyrics.TtmlLibrary"].every((k) => cfgSrc.includes(`"${k}"`)));
check("正在播放页歌词列四档齐备且无说明行",
  ["默认", "全高", "已播放行隐藏", "全高已播放行隐藏"].every((label) => views.includes(`>${label}</button>`))
  && views.includes('id="np-lyric-layout-cards"') && defaults()["Style.LyricLayout"] === "default");
const nowPlayingSrc = readFileSync(join(UI, "src/components/NowPlaying.ts"), "utf8");
check("歌词列布局进渲染层 FALLBACK 与正在播放页接线",
  cfgSrc.includes('"Style.LyricLayout"') && nowPlayingSrc.includes("npLyricFullHeight")
  && nowPlayingSrc.includes("npLyricHidePlayed") && views.includes("setNpLyricLayout"));
const amll = readFileSync(join(UI, "src/lyrics/amll.ts"), "utf8");
check("TTML 解析早已在内置引擎（复用，不另开解析路）", /<tt\[\\s>\]/.test(amll) || amll.includes("parseTTML"));
check("逐字歌词接隐藏已播放行旋钮", amll.includes("setHidePassedLines"));
check("隐藏档当前行顶边对齐封面（行级与逐字同口径）",
  nowPlayingSrc.includes("lyricTopAnchor") && nowPlayingSrc.includes("cover.getBoundingClientRect().top")
  && amll.includes("LayoutAlignAnchor.Top") && amll.includes("lyricTopAnchor"));
const styleSrc = readFileSync(join(UI, "src/style.css"), "utf8");
check("正在播放页关闭 AMLL 平衡换行（避免右侧有空间却提前断行）",
  /\.np-kara-host \[class\*="lyricMainLine"\] > br \{ display: none; \}/.test(styleSrc));
check("歌词列比封面列更宽（1.4 : 1，宽屏优先利用中缝）",
  /grid-template-columns: minmax\(340px, 1\.4fr\) minmax\(0, 1fr\) minmax\(300px, 1fr\)/.test(styleSrc));
check("滚轮翻阅超时回正：AMLL resetScroll + 行级尾部留足一屏",
  amll.includes("player.resetScroll()") && amll.includes("BROWSE_RETURN_MS")
  && /\.np\.np-hide-played \.np-lyrics::after \{ height: 100%; \}/.test(styleSrc));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail ? "❌" : "✅"} verify-lyrics: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
