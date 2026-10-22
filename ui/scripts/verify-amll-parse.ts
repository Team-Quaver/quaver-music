// Quaver — 内置歌词引擎（AMLL）的**解析层**活体测试（真模块 + 真 lyric 解析器，跑在 dev server 里）。
// 跑：  node scripts/verify-amll-parse.ts   （需 dev server，QBASE 缺省 http://127.0.0.1:5173）
//
// 为什么单开一份（verify-np-gallery 只验渲染）：格式识别全在 parse() 里 ——
// 上游 qrc=1 给的是 XML 信封、roma 字段可能是词级 QRC 也可能是普通 LRC、trans 一般是 LRC，
// 日文歌的振假名又是 QRC 里单独的 `[kana: ...]` 标签。这些形状一旦认不出，症状是
// 「音译档什么都没有 / 注音串位」，渲染层测试看不见原因，只能在这里钉住。
//
// AMLL 不再是 vendor/Sparkle 里的插件，而是宿主内置模块（src/lyrics/amll.ts）：
// 这里直接 import 应用真正在用的那份模块，取它导出的 builtinKaraokeProvider。
import puppeteer from "puppeteer-core";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const CHROME = process.env.QUAVER_CHROME || "/usr/bin/google-chrome";
const MODULE = "/src/lyrics/amll.ts";

let pass = 0, fail = 0;

const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const section = (t: string) => console.log(`\n=== ${t} ===`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
const pageErrors: string[] = [];

page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });

const MAIN_QRC = "[0,3000]你(0,750)好(750,750)世(1500,750)界(2250,750)\n[3000,3000]第(3000,1000)二(4000,1000)行(5000,1000)";
const ROMA_QRC = "[0,3000]ni(0,700) hao(700,800) shi(1500,700) jie(2250,700)";
const ROMA_LRC = "[00:00.00]ni hao shi jie\n[00:03.00]di er hang";
const TRANS_LRC = "[00:00.00]你好世界（译）";
const PLACEHOLDER_TRANS_LRC = "[00:00.00]//\n[00:03.00]第二行（译）";
const PLACEHOLDER_ROMA_LRC = "[00:00.00]ni hao shi jie\n[00:03.00]//";
const PLACEHOLDER_BOTH_LRC = "[00:00.00]//\n[00:03.00]//";

// 日文逐字 + 振假名（QQ《怪物》那种形状：正文只有一行 [st,dur]，词时间是**绝对毫秒**，
// 注音标签另起一行 [kana:...]，元数据行 [ti:]/[offset:] 混在里面）。
// 可注音字符只有汉字（貴 / 下 / 文 / 学）：「の」是平假名、不占配额。
const JP_QRC = "[ti:測試]\n[offset:0]\n[0,2250]貴(0,750)下(750,750)の(1500,750)\n[3000,2000]文(3000,1000)学(4000,1000)";
const JP_KANA = "[kana:2きさ2ぶんがく]";

/** QQ《怪物》真实样本（取自上游 lyric-kit 的 tests/kana.spec.ts，属性内直接换行）：
 *  元数据行 + [kana:] 注音标签 + 词时间为绝对毫秒的逐字正文。 */
const KANA_REAL_PAYLOAD = `[ti:怪物]
[ar:YOASOBI]
[offset:0]
[kana:1かい1ぶつ1す1ば1せ1か(2964,296)い(3260,240)2きょう]
[0,666]怪(0,121)物(121,121)
[2128,2725]素(2128,14)晴(2142,50)ら(2192,360)し(2552,239)き(2791,94)世(2885,79)界(2964,536)に(3500,143)今日(3643,439)
`;

/** Starboy 真实坑位：QQ 把制作名单里的 `Martin "Doc" McKinney` 原样留在 LyricContent 属性中，
 *  引号没有实体化成 &quot;。旧正则在这里截断，只解析出片头四行。 */
const QUOTED_ENVELOPE = '<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[0,3900]Lyrics(0,300) (300,300)by(600,300)：(900,300)Martin(1200,300) (1500,300)"(1800,300)Doc(2100,300)"(2400,300) (2700,300)McKinney(3000,900)&#10;[15607,144]Ayy(15607,144)"/></LyricInfo></QrcInfos>';

/** 上游 qrc=1 的 XML 信封形状（属性内以 &#10; 分行、整段是实体编码过的） */
const envelope = (payload: string) =>
  '<?xml version="1.0" encoding="UTF-8"?><QrcInfos><LyricInfo><Lyric_1 Lyrics="'
  + payload.replace(/\n/g, "&#10;") + '"/></LyricInfo></QrcInfos>';

const run = await page.evaluate(async (spec: any) => {
  const mod = await import(spec.moduleUrl);
  const provider = mod.builtinKaraokeProvider;

  const summarize = (lines: any[] | null) => (lines ?? []).map((l) => ({
    text: l.words.map((w: any) => w.word).join(""),
    trans: l.translatedLyric ?? "", roman: l.romanLyric ?? "",
    ruby: l.words.filter((w: any) => (w.ruby?.length ?? 0) > 0).length,
    // 注音明细：挂在第几个词上 / 文本 / 时间
    rubyAt: l.words.flatMap((w: any, i: number) => (w.ruby ?? []).map((r: any) =>
      `${i}:${r.word}@${r.startTime}-${r.endTime}`)),
  }));

  return {
    plainQrc: summarize(provider.parse(spec.mainQrc, spec.transLrc, spec.romaQrc)),
    xmlQrc: summarize(provider.parse(spec.envelopeMain, spec.transLrc, spec.envelopeRoma)),
    quotedEnvelope: summarize(provider.parse(spec.quotedEnvelope, "", "")),
    lrcRoma: summarize(provider.parse(spec.mainQrc, spec.transLrc, spec.romaLrc)),
    romanOnly: summarize(provider.parse(spec.mainQrc, "", spec.romaQrc)),
    bare: summarize(provider.parse(spec.mainQrc, "", "")),
    plainLrc: summarize(provider.parse("[00:00.00]第一行\n[00:03.00]第二行", spec.transLrc, spec.romaLrc)),
    placeholderAux: summarize(provider.parse(spec.mainQrc, spec.placeholderTransLrc, spec.placeholderRomaLrc)),
    placeholderBare: summarize(provider.parse(spec.mainQrc, spec.placeholderBothLrc, spec.placeholderBothLrc)),
    // —— QRCKana ——
    kanaHead: summarize(provider.parse(`${spec.jpKana}\n${spec.jpQrc}`, "", "")),
    kanaTail: summarize(provider.parse(`${spec.jpQrc}\n${spec.jpKana}`, "", "")),
    kanaEnvelope: summarize(provider.parse(spec.envelopeKana, spec.transLrc, "")),
    kanaWithRoma: summarize(provider.parse(`${spec.jpKana}\n${spec.jpQrc}`, spec.transLrc, "[00:00.00]きさ ぶんがく")),
    noKana: summarize(provider.parse(spec.jpQrc, "", "")),
    // 真实样本走「LyricContent="…" 直接换行」的信封形状（上游 spec 同款）
    kanaReal: summarize(provider.parse(
      '<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="'
      + spec.kanaRealPayload.replace(/\n/g, "&#10;") + '"/></LyricInfo></QrcInfos>', "", "")),
  };
}, {
  moduleUrl: MODULE,
  mainQrc: MAIN_QRC, romaQrc: ROMA_QRC, romaLrc: ROMA_LRC, transLrc: TRANS_LRC,
  placeholderTransLrc: PLACEHOLDER_TRANS_LRC, placeholderRomaLrc: PLACEHOLDER_ROMA_LRC,
  placeholderBothLrc: PLACEHOLDER_BOTH_LRC,
  envelopeMain: envelope(MAIN_QRC), envelopeRoma: envelope(ROMA_QRC),
  quotedEnvelope: QUOTED_ENVELOPE,
  jpQrc: JP_QRC, jpKana: JP_KANA, envelopeKana: envelope(`${JP_KANA}\n${JP_QRC}`),
  kanaRealPayload: KANA_REAL_PAYLOAD,
});

console.log(JSON.stringify(run, null, 1));

section("音译与翻译都归一成「行级」辅助行（词上方只留给 QRCKana 的振假名）");

{
  const one = run.plainQrc[0] ?? {};
  check("词级 QRC 音译 → 整行 romanLyric", String(one.roman).replace(/\s+/g, " ").trim() === "ni hao shi jie", JSON.stringify(one));
  check("LRC 翻译 → 整行 translatedLyric", one.trans === "你好世界（译）", JSON.stringify(one));
  check("没有注音标签时绝不往词上挂 Ruby", run.plainQrc.every((l: any) => l.ruby === 0), JSON.stringify(run.plainQrc.map((l: any) => l.rubyAt)));
  check("第二行没有对应音译/翻译 → 两路都空（不瞎猜、不错位）",
    run.plainQrc[1]?.roman === "" && run.plainQrc[1]?.trans === "", JSON.stringify(run.plainQrc[1]));
}

section("XML 信封（上游 qrc=1 的真实形状）同样认得");

check("信封本体解析成逐字行（HTML 实体还原后仍是 QRC）", run.xmlQrc.length === 2 && run.xmlQrc[0].text === "你好世界", JSON.stringify(run.xmlQrc[0]));

check("信封音译 → 整行 romanLyric", String(run.xmlQrc[0].roman).replace(/\s+/g, " ").trim() === "ni hao shi jie", JSON.stringify(run.xmlQrc[0]));

check("信封路径也不挂 Ruby", run.xmlQrc.every((l: any) => l.ruby === 0));

check("LyricContent 内含未转义引号：引号后的正文仍完整解析（Starboy 回归）",
  run.quotedEnvelope.length === 2
    && run.quotedEnvelope[0]?.text.includes('Martin "Doc" McKinney')
    && run.quotedEnvelope[1]?.text === "Ayy", JSON.stringify(run.quotedEnvelope));

section("音译是普通 LRC 时按时间就近配对");

check("行级音译挂到对应行", run.lrcRoma[0]?.roman === "ni hao shi jie" && run.lrcRoma[1]?.roman === "di er hang", JSON.stringify(run.lrcRoma));

section("两路都不给时留空（不造假数据）");

check("bare：翻译与音译都是空串", run.bare.every((l: any) => l.trans === "" && l.roman === ""), JSON.stringify(run.bare));

check("只给音译不给翻译（回落链的另一头）",
  run.romanOnly[0]?.trans === "" && String(run.romanOnly[0]?.roman).includes("ni"), JSON.stringify(run.romanOnly[0]));

section("普通 LRC 也交给 AMLL（行级渲染）");

check("LRC 本体 → 行级两行（单音节覆盖整行，不再回退宿主）",
  run.plainLrc.length === 2 && run.plainLrc[0].text === "第一行" && run.plainLrc[1].text === "第二行", JSON.stringify(run.plainLrc));

check("LRC 行级同样按时间就近挂辅助行（第 1 行翻译+音译）",
  run.plainLrc[0].trans === "你好世界（译）" && String(run.plainLrc[0].roman).replace(/\s+/g, " ").trim() === "ni hao shi jie",
  JSON.stringify(run.plainLrc[0]));

check("LRC 第 2 行只给音译 → 翻译空、音译有",
  run.plainLrc[1].trans === "" && run.plainLrc[1].roman === "di er hang", JSON.stringify(run.plainLrc[1]));

section("辅助源里的 // 是占位，不挂到歌词行上");

check("第 1 行翻译为 // → 翻译空、音译保留",
  run.placeholderAux[0]?.trans === "" && String(run.placeholderAux[0]?.roman).replace(/\s+/g, " ").trim() === "ni hao shi jie",
  JSON.stringify(run.placeholderAux[0]));

check("第 2 行音译为 // → 音译空、翻译保留",
  run.placeholderAux[1]?.roman === "" && run.placeholderAux[1]?.trans === "第二行（译）",
  JSON.stringify(run.placeholderAux[1]));

check("两路都是 // → 两行辅助文本全空（渲染层整行收起）",
  run.placeholderBare.every((l: any) => l.trans === "" && l.roman === ""), JSON.stringify(run.placeholderBare));

section("QRCKana：[kana: ...] 标签 → 词上方振假名（ruby），且标签本身不进歌词");

check("正文仍是两行逐字（注音行与 [ti:]/[offset:] 都没被当成一句歌词）",
  run.kanaHead.length === 2 && run.kanaHead[0].text === "貴下の" && run.kanaHead[1].text === "文学",
  JSON.stringify(run.kanaHead));

check("「2きさ」覆盖 貴+下 → 挂在第一个词、时间跨两词",
  JSON.stringify(run.kanaHead[0]?.rubyAt) === JSON.stringify(["0:きさ@0-1500"]), JSON.stringify(run.kanaHead[0]?.rubyAt));

// 注音的时间永远取自「它所挂载的那个词」，与词同一套坐标：QRC 正文的词时间是绝对毫秒，
// 标签里的 (start,dur) 音节时间轴也是绝对毫秒，两边原样透传、不做换算。
check("「2ぶんがく」跨行继续数汉字 → 挂在第二行的「文」上，时间跟词走（绝对毫秒）",
  JSON.stringify(run.kanaHead[1]?.rubyAt) === JSON.stringify(["0:ぶんがく@3000-5000"]), JSON.stringify(run.kanaHead[1]?.rubyAt));

check("注音标签在文末同样生效（顺序无关）",
  JSON.stringify(run.kanaTail[0]?.rubyAt) === JSON.stringify(["0:きさ@0-1500"]), JSON.stringify(run.kanaTail));

check("XML 信封里的注音标签（实体解码后再摘）也生效",
  JSON.stringify(run.kanaEnvelope[0]?.rubyAt) === JSON.stringify(["0:きさ@0-1500"])
    && run.kanaEnvelope.length === 2, JSON.stringify(run.kanaEnvelope[0]));

check("注音与音译各行其道：ruby 来自标签、romanLyric 来自档位数据源",
  JSON.stringify(run.kanaWithRoma[0]?.rubyAt) === JSON.stringify(["0:きさ@0-1500"])
    && run.kanaWithRoma[0]?.roman === "きさ ぶんがく", JSON.stringify(run.kanaWithRoma[0]));

check("没有标签就不挂 ruby（不误伤非日文歌词）",
  run.noKana.every((l: any) => l.ruby === 0), JSON.stringify(run.noKana));

section("真实样本：QQ《怪物》信封 QRC（上游 lyric-kit 的 spec 夹具，逐字对齐口径一致）");

{
  const l1 = run.kanaReal[0] ?? {};
  const l2 = run.kanaReal[1] ?? {};
  check("正文两行、逐字切分与注音标签互不干扰",
    run.kanaReal.length === 2 && l1.text === "怪物" && l2.text === "素晴らしき世界に今日", JSON.stringify(run.kanaReal.map((x: any) => x.text)));
  check("怪=かい(0-121)、物=ぶつ(121-242)：单词单字贴着词起止",
    JSON.stringify(l1.rubyAt) === JSON.stringify(["0:かい@0-121", "1:ぶつ@121-242"]), JSON.stringify(l1.rubyAt));
  check("素=す、晴=ば（第二行按绝对毫秒继续对齐）",
    JSON.stringify(l2.rubyAt?.slice(0, 2)) === JSON.stringify(["0:す@2128-2142", "1:ば@2142-2192"]), JSON.stringify(l2.rubyAt));
  check("平假名 ら/し/き 不占注音配额（所以世/界落在后面两个单元）",
    JSON.stringify(l2.rubyAt?.slice(2)) === JSON.stringify(["5:せ@2885-2964", "6:か@2964-3260", "6:い@3260-3500", "8:きょう@3643-4082"]),
    JSON.stringify(l2.rubyAt));
  check("汉字叠字「今日」= 一个单元跨两字（きょう 3643-4082）",
    (l2.rubyAt ?? []).includes("8:きょう@3643-4082"), JSON.stringify(l2.rubyAt));
}

check("过程无页面异常", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-amll-parse: ${pass} 通过 / ${fail} 失败`);

process.exit(fail === 0 ? 0 : 1);
