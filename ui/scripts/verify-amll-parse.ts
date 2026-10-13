// Quaver — 官方 AMLL 插件的**解析层**活体测试（真模块 + 真 lyric 解析器，跑在 dev server 里）。
// 跑：  node scripts/verify-amll-parse.ts   （需 dev server，QBASE 缺省 http://127.0.0.1:5173）
//
// 为什么单开一份（verify-np-gallery 只验渲染）：音译/翻译的「格式识别」全在 parse() 里 ——
// 上游 qrc=1 给的是 XML 信封、roma 字段可能是词级 QRC 也可能是普通 LRC、trans 一般是 LRC。
// 这些形状一旦认不出，症状是「音译档什么都没有」，渲染层测试看不见原因，只能在这里钉住。
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const CHROME = process.env.QUAVER_CHROME || "/usr/bin/google-chrome";
const UI = resolve(import.meta.dirname, "..");
// vite dev 用 /@fs<绝对路径> 交付项目根之外的模块（别名 @quaver/sparkle/* 走的也是这条），
// 这样浏览器里 import 到的就是**应用真正在用的那份插件**（含它自己的 CSS 与依赖解析）。
const PLUGIN = "/@fs" + resolve(UI, "..", "vendor", "Sparkle", "plugins", "amll", "index.ts");

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
/** 上游 qrc=1 的 XML 信封形状（属性内以 &#10; 分行、整段是实体编码过的） */
const envelope = (payload: string) =>
  '<?xml version="1.0" encoding="UTF-8"?><QrcInfos><LyricInfo><Lyric_1 Lyrics="'
  + payload.replace(/\n/g, "&#10;") + '"/></LyricInfo></QrcInfos>';

const run = await page.evaluate(async (spec: any) => {
  const mod = await import(spec.pluginUrl);
  const plugin = mod.default;
  let provider: any = null;
  plugin.setup({
    registerKaraokeProvider: (p: any) => { provider = p; },
    registerSettingsSection: () => {},
    storage: { get: () => null, set: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any);
  const shape = (lines: any[] | null) => (lines ?? []).map((l) => ({
    text: l.words.map((w: any) => w.word).join(""),
    trans: l.translatedLyric ?? "", roman: l.romanLyric ?? "",
    ruby: l.words.filter((w: any) => (w.ruby?.length ?? 0) > 0).length,
  }));
  return {
    // 逐字本体是纯文本 QRC，音译是词级 QRC，翻译是普通 LRC
    plainQrc: shape(provider.parse(spec.mainQrc, spec.transLrc, spec.romaQrc)),
    // 本体与音译都走 XML 信封（上游 qrc=1 的真实形状）
    xmlQrc: shape(provider.parse(spec.envelopeMain, spec.transLrc, spec.envelopeRoma)),
    // 音译只是普通 LRC（非 QRC 的老歌词）
    lrcRoma: shape(provider.parse(spec.mainQrc, spec.transLrc, spec.romaLrc)),
    // 只有音译、没有翻译
    romanOnly: shape(provider.parse(spec.mainQrc, "", spec.romaQrc)),
    // 两路都不给
    bare: shape(provider.parse(spec.mainQrc, "", "")),
    // 普通 LRC 本体（无词级时间轴）→ 行级行（单音节覆盖整行）也交给 AMLL 渲染
    plainLrc: shape(provider.parse("[00:00.00]第一行\n[00:03.00]第二行", spec.transLrc, spec.romaLrc)),
  };
}, {
  pluginUrl: PLUGIN,
  mainQrc: MAIN_QRC, romaQrc: ROMA_QRC, romaLrc: ROMA_LRC, transLrc: TRANS_LRC,
  envelopeMain: envelope(MAIN_QRC), envelopeRoma: envelope(ROMA_QRC),
});

console.log(JSON.stringify(run, null, 1));
section("音译与翻译都归一成「行级」辅助行（词上方不留 Ruby）");
const one = run.plainQrc[0] ?? {};
check("词级 QRC 音译 → 整行 romanLyric", String(one.roman).replace(/\s+/g, " ").trim() === "ni hao shi jie", JSON.stringify(one));
check("LRC 翻译 → 整行 translatedLyric", one.trans === "你好世界（译）", JSON.stringify(one));
check("不再往词上挂 Ruby（音译属翻译区域，不是振假名）", run.plainQrc.every((l: any) => l.ruby === 0));
check("第二行没有对应音译/翻译 → 两路都空（不瞎猜、不错位）",
  run.plainQrc[1]?.roman === "" && run.plainQrc[1]?.trans === "", JSON.stringify(run.plainQrc[1]));

section("XML 信封（上游 qrc=1 的真实形状）同样认得");
check("信封本体解析成逐字行（HTML 实体还原后仍是 QRC）", run.xmlQrc.length === 2 && run.xmlQrc[0].text === "你好世界", JSON.stringify(run.xmlQrc[0]));
check("信封音译 → 整行 romanLyric", String(run.xmlQrc[0].roman).replace(/\s+/g, " ").trim() === "ni hao shi jie", JSON.stringify(run.xmlQrc[0]));
check("信封路径也不挂 Ruby", run.xmlQrc.every((l: any) => l.ruby === 0));

section("音译是普通 LRC 时按时间就近配对");
check("行级音译挂到对应行", run.lrcRoma[0]?.roman === "ni hao shi jie" && run.lrcRoma[1]?.roman === "di er hang", JSON.stringify(run.lrcRoma));

section("两路都不给时留空（不造假数据）");
check("bare：翻译与音译都是空串", run.bare.every((l: any) => l.trans === "" && l.roman === ""), JSON.stringify(run.bare));

section("只给音译不给翻译（回落链的另一头）");
check("romanOnly：翻译空、音译有", run.romanOnly[0]?.trans === "" && String(run.romanOnly[0]?.roman).includes("ni"), JSON.stringify(run.romanOnly[0]));

section("普通 LRC 也交给 AMLL（行级渲染）");
check("LRC 本体 → 行级两行（单音节覆盖整行，不再回退宿主）",
  run.plainLrc.length === 2 && run.plainLrc[0].text === "第一行" && run.plainLrc[1].text === "第二行", JSON.stringify(run.plainLrc));
check("LRC 行级同样按时间就近挂辅助行（第 1 行翻译+音译）",
  run.plainLrc[0].trans === "你好世界（译）" && String(run.plainLrc[0].roman).replace(/\s+/g, " ").trim() === "ni hao shi jie",
  JSON.stringify(run.plainLrc[0]));
check("LRC 第 2 行只给音译 → 翻译空、音译有",
  run.plainLrc[1].trans === "" && run.plainLrc[1].roman === "di er hang", JSON.stringify(run.plainLrc[1]));
check("过程无页面异常", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-amll-parse: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
