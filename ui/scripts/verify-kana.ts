// Quaver — QRCKana（QRC 振假名注音）的纯单测 + 源码接线断言。
// 跑：  node scripts/verify-kana.ts   （零依赖、零 DOM、不需要 dev server）
//
// 为什么值得单开一份：这套算法是从 SPlayer-Dev/lyric-kit（AGPL-3.0）移植过来的**逐字符对齐**
// 逻辑 —— 注音标签里的数字是「第几个可注音字符」的全局游标，跨行累计。写错一个 off-by-one 的
// 症状不是崩，而是「假名集体串位」（注音跟着错误的字走），肉眼在播放器里很难看出来。
// 所以这里用黄金样例钉死对齐结果，本地装了 lyric-kit 时再与上游做逐字节差分对照。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyKanaToLines, countRubyWords, extractKanaTag, lineHasRuby, parseKanaUnits, stripKanaTag,
  type KanaRubyLine,
} from "../src/lyrics/qrc-kana.ts";

const UI = dirname(import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url)));
const read = (p: string) => { try { return readFileSync(join(UI, p), "utf8"); } catch { return ""; } };

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** 注音挂载结果的紧凑可读形式：每行 = 各词的 ruby 串起来的文本 */
const rubyText = (lines: KanaRubyLine[]) =>
  lines.map((l) => l.words.map((w) => (w.ruby ?? []).map((r) => r.word).join("")).join("|")).join(" / ");
const rubyTime = (lines: KanaRubyLine[]) =>
  lines.map((l) => l.words.map((w) => (w.ruby ?? []).map((r) => `${r.word}@${r.startTime}-${r.endTime}`).join(",")).join(" | ")).join(" / ");

// —— ① 标签解析 ——
section("parseKanaUnits：数字=覆盖几个字，紧跟的假名=读音，(起始,时长)=假名自己的时间轴");
{
  const units = parseKanaUnits("[kana:2きさ2ぶんがく2しょうじょ]");
  check("按数字切成三段", units.length === 3, JSON.stringify(units));
  check("计数与文本配对正确",
    units.map((u) => `${u.kanjiCount}:${u.kanaText}`).join("|") === "2:きさ|2:ぶんがく|2:しょうじょ",
    JSON.stringify(units));
  check("没有 (start,dur) 时不带 spans", units.every((u) => u.spans === undefined), JSON.stringify(units));
}
{
  const units = parseKanaUnits("[kana:2か(0,300)ノ(300,300)1の]");
  check("括号被切成 spans 且不混进文本", units[0]?.kanaText === "かノ" && units[0]?.spans?.length === 2,
    JSON.stringify(units));
  check("span 的 word = 紧挨在括号前那个假名、时间 = start+duration",
    JSON.stringify(units[0]?.spans) === JSON.stringify([
      { word: "か", startTime: 0, endTime: 300 },
      { word: "ノ", startTime: 300, endTime: 600 },
    ]), JSON.stringify(units[0]?.spans));
  check("后一段照常解析", units[1]?.kanjiCount === 1 && units[1]?.kanaText === "の", JSON.stringify(units[1]));
}
check("非标签文本不产单元", parseKanaUnits("not a tag").length === 0);
check("空串安全", parseKanaUnits("").length === 0 && extractKanaTag("") === "");
// 单元计数只认 1-9 的单个字符；0 与假名一样进正文（上游就是这个形状，别自作聪明改）
check("多位数不会吞正文：0 落进文本、1-9 才开新单元",
  parseKanaUnits("[kana:1た3も001]").map((u) => `${u.kanjiCount}:${u.kanaText}`).join("|") === "1:た|3:も00|1:",
  JSON.stringify(parseKanaUnits("[kana:1た3も001]")));

// —— ② 标签行提取 / 剥离 ——
section("extractKanaTag / stripKanaTag：注音是元数据行，不能混进歌词正文");
{
  const qrc = "[0,3000]貴(0,750)下(750,750)の(1500,750)\n[kana:2きさ]\n[3000,2000]文(0,1000)学(1000,1000)";
  check("抓到 [kana: ...] 行原文", extractKanaTag(qrc) === "[kana:2きさ]", extractKanaTag(qrc));
  check("剥离后只剩歌词行",
    stripKanaTag(qrc).split(/\r?\n/).length === 2 && !/\[kana:/.test(stripKanaTag(qrc)), stripKanaTag(qrc));
  check("大小写都认", extractKanaTag("[KANA:2き]\n[0,1]あ") === "[KANA:2き]", extractKanaTag("[KANA:2き]\n[0,1]あ"));
  check("多条时取最后一条（同上游 parseQRC 的覆盖语义）",
    extractKanaTag("[kana:1あ]\n[0,1]あ\n[kana:1い]") === "[kana:1い]");
  check("[ti:]/[offset:] 之类的别的元数据不当注音", extractKanaTag("[ti:曲名]\n[offset:0]") === "");
  check("无注音标签时 stripKanaTag 原样返回（不白跑一遍 split）", stripKanaTag("[0,1]あ") === "[0,1]あ");
}

// —— ③ 对齐（核心：跨行的字符游标） ——
section("applyKanaToLines：数字是「第几个可注音字符」的全局游标，跨行累计");
const mkLines = (): KanaRubyLine[] => ([
  { words: [{ word: "貴", startTime: 0, endTime: 300 }, { word: "下の", startTime: 300, endTime: 900 }] },
  { words: [{ word: "文学", startTime: 1000, endTime: 2000 }, { word: "少女", startTime: 2000, endTime: 3000 }] },
  { words: [{ word: "Hello 世界", startTime: 3000, endTime: 4000 }] },
]);
{
  const lines = mkLines();
  applyKanaToLines(lines, "[kana:2きさ2ぶんがく2しょうじょ]");
  // 可注音字符只有汉字（平/片假名自己不属于「被注音的基础字符」，拉丁与空格也不是）：
  // 整张表的字符流 = 貴 下 文 学 少 女 世 界，三个单元各吃 2 个，第三个之后正好耗尽。
  check("跨词的单元挂在第一个词上，时间跨 first.start…last.end",
    rubyTime(lines) === "きさ@0-900 |  / ぶんがく@1000-2000 | しょうじょ@2000-3000 / ", rubyTime(lines));
  check("「の」不占字符位（假名不是可注音字符）",
    rubyText(lines) === "きさ| / ぶんがく|しょうじょ / ", rubyText(lines));
  check("拉丁字母/空格不注音：第三行一个都没挂上",
    rubyText(lines).endsWith(" / "), rubyText(lines));
  check("lineHasRuby 命中两行、注音词共 3 个",
    lines.filter(lineHasRuby).length === 2 && countRubyWords(lines) === 3, String(countRubyWords(lines)));
}
{
  const lines = mkLines();
  applyKanaToLines(lines, "[kana:1た3も]");
  check("单字符单元落在单词上时贴着该词起止；跨词单元整体挂第一个词",
    rubyTime(lines) === "た@0-300 | も@300-2000 /  |  / ", rubyTime(lines));
}
{
  const lines = mkLines();
  applyKanaToLines(lines, "[kana:1あ21い]");
  // 单元 2 的读音是空串：它仍然吃掉两个字符位（那是「这几个字没有注音」，不是「这里无事发生」），
  // 少了这一步，后面所有注音会整体前移串位。
  check("空读音单元照样消费字符位",
    rubyText(lines) === "あ| / い| / ", rubyText(lines));
  check("单字符落进多字词 → 时间按字符数线性插值（「文学」的「学」= 后半段）",
    JSON.stringify(lines[1].words[0].ruby) === JSON.stringify([{ word: "い", startTime: 1500, endTime: 2000 }]),
    JSON.stringify(lines[1].words[0].ruby));
}
{
  const lines = mkLines();
  applyKanaToLines(lines, "[kana:2か(0,300)ノ(300,300)]");
  check("注音自带细分时间轴时原样挂到第一个被覆盖的词上",
    JSON.stringify(lines[0].words[0].ruby) === JSON.stringify([
      { word: "か", startTime: 0, endTime: 300 }, { word: "ノ", startTime: 300, endTime: 600 }]),
    JSON.stringify(lines[0].words[0].ruby));
}
{
  const lines = mkLines();
  applyKanaToLines(lines, "[kana:5おとめ9]");
  check("单元超出全部可注音字符时就此打住（不越界、不瞎补）",
    countRubyWords(lines) === 1 && (lines[0].words[0].ruby?.[0]?.word ?? "") === "おとめ",
    rubyTime(lines));
}
{
  const lines = mkLines();
  applyKanaToLines(lines, "not a tag");
  check("不含 [kana: 的串直接不动", lines.every((l) => l.words.every((w) => !w.ruby)));
  applyKanaToLines([], "[kana:2き]");
  check("空行表不炸", true);
}

// —— ③b 数字 token 的计数口径（上游 v0.6.1 的关键修正） ——
section("数字：连续数字串 = 一个基字符位（「22/7」是两个 token，不是三个字符）");
{
  // 上游 tests/kana.spec.ts 的「数字逐词计数」样例：紅組 / 22/ / 7 / 詞 / 秋元康
  const lines: KanaRubyLine[] = [
    { words: [{ word: "紅", startTime: 0, endTime: 50 }, { word: "組", startTime: 50, endTime: 100 }] },
    { words: [{ word: "22/", startTime: 100, endTime: 150 }, { word: "7", startTime: 150, endTime: 200 }] },
    { words: [{ word: "詞", startTime: 200, endTime: 250 }] },
    { words: [{ word: "秋", startTime: 300, endTime: 325 }, { word: "元", startTime: 325, endTime: 350 }, { word: "康", startTime: 350, endTime: 400 }] },
  ];
  applyKanaToLines(lines, "[kana:1あか1ぐみ111し1あき1もと1やす]");
  check("两个空读音单元吃掉「22」与「7」两处数字 token，注音不串位",
    rubyText(lines) === "あか|ぐみ / | / し / あき|もと|やす", rubyText(lines));
}
{
  const lines: KanaRubyLine[] = [{ words: [{ word: "A22B33", startTime: 0, endTime: 100 }] }];
  applyKanaToLines(lines, "[kana:1にじゅうに1さんさん]");
  check("同一个词里的两段数字各挂一条注音",
    (lines[0].words[0].ruby ?? []).map((r) => r.word).join("+") === "にじゅうに+さんさん",
    JSON.stringify(lines[0].words[0].ruby));
  check("数字串按 charLength 插值时间（不是整词时长）",
    JSON.stringify(lines[0].words[0].ruby?.map((r) => `${r.startTime}-${r.endTime}`)) === JSON.stringify(["17-50", "67-100"]),
    JSON.stringify(lines[0].words[0].ruby));
}
{
  const lines: KanaRubyLine[] = [{ words: [{ word: "1. アクマバライ", startTime: 0, endTime: 100 }] }];
  applyKanaToLines(lines, "[kana:1いち]");
  check("正文开头的数字 token 也消费注音单元",
    (lines[0].words[0].ruby ?? []).map((r) => r.word).join("") === "いち", JSON.stringify(lines[0].words[0].ruby));
}
{
  const lines: KanaRubyLine[] = [{ words: [
    { word: "生", startTime: 1000, endTime: 1500 }, { word: "日", startTime: 1500, endTime: 2000 },
    { word: "々", startTime: 2000, endTime: 2500 }, { word: "連", startTime: 2500, endTime: 3000 },
    { word: "続", startTime: 3000, endTime: 4000 }] }];
  applyKanaToLines(lines, "[kana:1い1ひ1び1れん1ぞく]");
  check("叠字符 々 算基字符（「生日々連接続」五字五注音，逐字对齐）",
    rubyText(lines) === "い|ひ|び|れん|ぞく", rubyText(lines));
}
{
  const lines: KanaRubyLine[] = [{ words: [
    { word: "世", startTime: 2885, endTime: 2964 }, { word: "界", startTime: 2964, endTime: 3500 }] }];
  applyKanaToLines(lines, "[kana:1せ1か(2964,296)い(3260,240)]");
  check("真实形状（QQ《怪物》）：假名细分时间轴按绝对毫秒原样挂上",
    JSON.stringify(lines[0].words[1].ruby) === JSON.stringify([
      { word: "か", startTime: 2964, endTime: 3260 }, { word: "い", startTime: 3260, endTime: 3500 }]),
    JSON.stringify(lines[0].words[1].ruby));
  // 深拷一份：{...w} 会把上一步写好的 ruby **数组引用**带过来，apply 是 push 语义
  const shifted: KanaRubyLine[] = [{
    words: lines[0].words.map((w) => ({ word: w.word, startTime: w.startTime, endTime: w.endTime })),
  }];
  applyKanaToLines(shifted, "[kana:1せ1か(2964,296)い(3260,240)]", 1000);
  check("timingOffset 只平移标签内的音节时间轴（外部注音那条路）",
    shifted[0].words[0].ruby?.[0].startTime === 2885
      && shifted[0].words[1].ruby?.[0].startTime === 3964, JSON.stringify(shifted[0].words.map((w) => w.ruby)));
}

// —— ④ 与上游 lyric-kit 的差分对照（本地装了就跑，没装就跳） ——
// 注意：本地装的 lyric-kit 是 npm 上的 0.6.0，比仓库 HEAD（0.6.1）旧一版，差别只在
// 「数字按 token 计数」那一处 —— 本组的行表正文里没有数字，两条实现应当逐字节一致；
// 0.6.1 新增的数字口径由上面那组黄金样例守（上游 tests/kana.spec.ts 同款）。
section("差分对照：与 SPlayer-Dev/lyric-kit 的实现逐字节一致（可选）");
{
  const kitEntry = resolve(UI, "node_modules", "lyric-kit", "dist", "index.mjs");
  if (!existsSync(kitEntry)) {
    console.log("  ⏭  本地未安装 lyric-kit（它不是声明依赖，只是移植时的参照），跳过差分对照");
  } else {
    const kit = await import(kitEntry);
    const tags = [
      "[kana:2きさ2ぶんがく2しょうじょ]", "[kana:1た3も001]", "[kana:2か(0,300)ノ(300,300)1の]",
      "[kana:2か3]", "[kana:9abcdefghijklmnopqrstuvwxyz]", "[kana:1あ2い3う]", "[kana:1あ21い]",
      "[kana:5おとめ9]", "[kana:2かん03しつ]", "",
    ];
    const dump = (ls: any[]) => JSON.stringify(ls.map((l) => l.words.map((w) => w.ruby ?? null)));
    let diff = 0;
    for (const tag of tags) {
      if (JSON.stringify(kit.parseKanaUnits(tag)) !== JSON.stringify(parseKanaUnits(tag))) { diff++; console.log("  units 不一致:", tag); }
      const a = mkLines(), b = mkLines();
      kit.applyKanaToLines(a as any, tag); applyKanaToLines(b, tag);
      if (dump(a) !== dump(b)) { diff++; console.log("  apply 不一致:", tag, dump(a), dump(b)); }
    }
    check(`与上游 ${tags.length} 组标签逐字节一致`, diff === 0, `${diff} 处不一致`);
  }
}

// —— ⑤ 源码接线：内置引擎真的在用这套算法 ——
section("接线：AMLL 内置引擎 = 解析器 + QRCKana + 渲染透传");
const amll = read("src/lyrics/amll.ts");
const registry = read("src/sparkle/registry.ts");
const loader = read("src/sparkle/loader.ts");
const init = read("src/sparkle/init.ts");
check("解析时先摘注音标签再喂 parseQrc（标签不是歌词）",
  amll.includes("extractKanaTag(c)") && amll.includes("tryParseQrc(stripKanaTag("));
check("XML 信封解出的正文同样抓注音", amll.includes("kanaTag: extractKanaTag(payload)"));
check("逐字行把 ruby 挂回词上", amll.includes("applyKanaToLines(word, kana)"));
check("core 渲染行透传 ruby（AMLL 原生画词上方注音）",
  /if \(w\.ruby\?\.length\) core\.ruby =/.test(amll), "toCoreLines 没透传 ruby");
check("辅助行档位规则复用宿主唯一那份 pickAux（不再有两份实现）",
  /import \{[^}]*\bpickAux\b[^}]*\} from "\.\.\/lyric"/.test(amll) && !amll.includes("const prefer ="));
check("内置提供器不注册 enabled（没有「关掉歌词引擎」这一档）",
  /export const builtinKaraokeProvider: SparkleKaraokeProvider = \{/.test(amll)
    && !amll.includes("enabled?()") && !amll.includes("enabled:"));
check("注册表：插件提供器排在内置之前，内置是兜底",
  registry.includes("karaokeProviders[0]?.provider ?? builtinKaraoke") && registry.includes("export function setBuiltinKaraokeProvider"));
check("AMLL 不再是官方插件（meta/loader 表里都没有，只进撤除名单）",
  !loader.includes('"amll": () => import') && !loader.includes('name: "Apple Music-like Lyrics"')
    && loader.includes('export const RETIRED_OFFICIAL_IDS: readonly string[] = ["amll"]')
    && existsSync(resolve(UI, "..", "vendor", "Sparkle", "plugins", "die-for-you", "index.ts"))
    && !existsSync(resolve(UI, "..", "vendor", "Sparkle", "plugins", "amll")));
check("启动先清账再注册内置引擎", init.includes("pruneRetiredOfficial();") && init.includes("await registerBuiltinLyrics()"));
check("内置引擎零 ui 反向依赖（不 import player/shell，避免注册表成环）",
  existsSync(resolve(UI, "src", "lyrics", "amll.ts"))
    && !amll.includes('from "../player"') && !amll.includes('from "../shell"'));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-kana: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
