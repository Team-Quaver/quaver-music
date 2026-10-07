// 单曲音质档位存在性：纯逻辑跑真单测（实测夹具），接线跑静态断言
//
// 播放条音质选择器只列当前曲有源的档位（songMissingTiers）。判定真相在上游歌曲元数据
// file.size_* / file.size_new —— size_new 的位置语义上游无文档，是实测对账出来的
// （2026-10：全档位取链后 HEAD 实际字节数与数组逐位吻合，size==0 ⇔ 该档取链被上游拒绝）。
// 这里用当次实测的真实元数据当夹具钉死映射，映射一旦漂移（上游改数组布局）单测先红。
//
// 三份夹具都来自真机探测（quaver-server :3379 /song/urls + Content-Range 对账）：
//   ① 半梦 004XX53V27j2m9 —— 全档有源
//   ② 半梦 002kbvuj2unetj —— 臻品 2.0 / 全景声 5.1 / 7.1 无源（[1][2][6]=0）
//   ③ DEAD CENTER 003zmlC41qlUwM —— size_flac=0（明文 FLAC 无源）但母带/全景声齐备
//
// 用法：node scripts/verify-songtiers.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = {
  st: read("src/lib/songtiers.ts"),
  api: read("src/lib/api.ts"),
  bar: read("src/components/PlayerBar.ts"),
  session: read("src/lib/session.ts"),
};

let fails = 0;
let checks = 0;
function ok(name, cond, note = "") {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
}
const eqSet = (name, got, want) => {
  const a = [...(got ?? [])].sort(), b = [...want].sort();
  ok(name, a.length === b.length && a.every((x, i) => x === b[i]), `got [${a.join(",")}] want [${b.join(",")}]`);
};
const has = (hay, needle) => hay.includes(needle);

// ============ 1. 纯逻辑真单测（Node ≥22.18 strip-types 直接加载） ============

let mt;
try {
  mt = await import(pathToFileURL(join(root, "src/lib/songtiers.ts")).href);
} catch (e) {
  console.log("FAIL songtiers.ts 加载（Node ≥22.18 才能免 flag strip-types）:", e?.message ?? e);
  process.exit(1);
}
const Q = ["128", "320", "320ogg", "flac", "640ogg", "atmos2", "atmos51", "atmos71", "master"];

// —— 实测夹具（三首歌，见文件头注释）——
const HALF_DREAM_FULL = {
  media_mid: "003QHjC33I7gpx",
  size_128mp3: 3498108, size_320mp3: 8744959, size_flac: 46996286,
  size_new: [150277276, 24927864, 64283766, 8901422, 0, 19830823, 29193538, 2076335, 23947513, 6158010, 0, 0, 22725972, 0, 0, 0],
};
const HALF_DREAM_NO_ATMOS = {
  media_mid: "002kbvuj2unetj",
  size_128mp3: 3886420, size_320mp3: 9715230, size_flac: 52059932,
  size_new: [163778412, 0, 0, 9599066, 0, 20279783, 0, 2307420, 0, 0, 0, 0, 0, 0, 0, 0],
};
const DEAD_CENTER = {
  media_mid: "003zmlC41qlUwM",
  size_128mp3: 2831885, size_320mp3: 7079395, size_flac: 0,
  size_new: [139544324, 23729947, 61585808, 9103385, 0, 19496408, 25136828, 1681199, 40226410, 4984801, 0, 0, 18398535, 0, 0, 0],
};

eqSet("全档有源：无隐藏档", mt.missingTiersOf(Q, HALF_DREAM_FULL), []);
eqSet("臻品系无源：隐藏 atmos2/51/71，320ogg/640ogg/母带保留", mt.missingTiersOf(Q, HALF_DREAM_NO_ATMOS), ["atmos2", "atmos51", "atmos71"]);
eqSet("无明文 FLAC：隐藏 flac，母带/全景声照常", mt.missingTiersOf(Q, DEAD_CENTER), ["flac"]);

// —— 边界：元数据缺失/结构认不出 → null（调用方回退全量列表）——
ok("无 song.file → null", mt.missingTiersOf(Q, undefined) === null);
ok("空 file → null", mt.missingTiersOf(Q, {}) === null);
ok("旧版会话存档（只留 media_mid）→ null", mt.missingTiersOf(Q, { media_mid: "003QHjC33I7gpx" }) === null);
ok("一个 size 字段都不认识（上游结构变了）→ null", mt.missingTiersOf(Q, { media_mid: "x", size_ogg_320: 5 }) === null);

// —— 边界：字段缺席 = 无从判定 = 不隐藏（resolve 自动回退兜底），只在 size==0 时隐藏 ——
eqSet("只有 128 一个字段：无隐藏（其余无从判定）", mt.missingTiersOf(Q, { size_128mp3: 100 }), []);
eqSet("size==0 命名档：隐藏该档", mt.missingTiersOf(Q, { size_128mp3: 100, size_flac: 0 }), ["flac"]);
eqSet("size_new 非数组：臻品系不误杀", mt.missingTiersOf(Q, { size_128mp3: 10, size_new: 5 }), []);
eqSet("size_new 截短：缺席档不误杀", mt.missingTiersOf(Q, { size_128mp3: 10, size_new: [163778412] }), []);
eqSet("全零：全部隐藏（选择器只剩自动）", mt.missingTiersOf(Q, { size_128mp3: 0, size_320mp3: 0, size_flac: 0, size_new: [0, 0, 0, 0, 0, 0, 0] }),
  Q);

// —— 档位全集来自调用方（api.ts 传 QUALITIES 的键）——
eqSet("qualities 子集：只判给定档位", mt.missingTiersOf(["flac"], { size_flac: 0, size_128mp3: 0 }), ["flac"]);

// —— 会话存档瘦身键清单与判定消费的字段一致（漂移即红）——
for (const k of ["size_128mp3", "size_320mp3", "size_flac", "size_new"])
  ok(`SONG_TIER_SIZE_KEYS 含 ${k}`, mt.SONG_TIER_SIZE_KEYS.includes(k));

// ============ 2. 接线静态断言 ============

// api.ts：档位全集对接（songMissingTiers 委托零依赖模块，键序与 QUALITIES 对齐）
ok("api: 引入 missingTiersOf", has(src.api, `import { missingTiersOf } from "./songtiers"`));
ok("api: songMissingTiers 用 QUALITIES 全集判定", /songMissingTiers\(song: any\)[\s\S]*?missingTiersOf\(Object\.keys\(QUALITIES\), song\?\.file\)/.test(src.api));

// PlayerBar：选择器过滤 + 换曲重建
ok("bar: 引入 songMissingTiers", has(src.bar, "songMissingTiers"));
ok("bar: 浮窗按无源档过滤（auto 恒在，锁定档不算无源）",
  has(src.bar, `item("auto", "自动", "最高可播")`)
  && /missing \? tierList\.filter\(\(x\) => !missing\.has\(x\.id as Quality\)\) : tierList/.test(src.bar));
ok("bar: 换曲即重建浮窗（挂在 lastMarkKey 换曲判定上）",
  /if \(s\?\.mid !== lastMarkKey\) \{ lastMarkKey = s\?\.mid; player\.markActive\(\); buildQPop\(\); \}/.test(src.bar));

// session.ts：存档瘦身保留判定消费的字段（旧存档没有 → 全量列表，新存档必须带上）
ok("session: 引入 SONG_TIER_SIZE_KEYS", has(src.session, `import { SONG_TIER_SIZE_KEYS } from "./songtiers"`));
ok("session: slim 按 SONG_TIER_SIZE_KEYS 保留 size 字段", has(src.session, "SONG_TIER_SIZE_KEYS.filter"));
ok("session: slim 保留 media_mid（高档取链依赖）", has(src.session, ".media_mid = mediaMid"));

console.log(`\n${fails ? `✗ ${fails} 项失败` : "✓ 全部通过"}（${checks} checks）`);
process.exit(fails ? 1 : 0);
