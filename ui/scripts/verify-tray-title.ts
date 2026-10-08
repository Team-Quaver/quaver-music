// Quaver — 托盘菜单标题行（electron/tray-title.ts）单测与源码护栏。
// 跑：  node scripts/verify-tray-title.ts
//
// 背景：Windows 通知区菜单是 Win32 HMENU、macOS 是 NSMenu，两者**都不折行**，菜单宽度 = 最宽那
// 一项的宽度。托盘菜单第一项是当前曲目（「歌名 - 歌手」，歌名自带 Studio Live / (Half-acoustic
// Ver.) 这类版本后缀，歌手按 " / " 全连接）——一首中文长歌名 + 三位歌手就能把菜单撑成横贯屏幕
// 的一条。这里两头抓：
//   • 功能测试：列宽口径（汉字/全角/emoji 记 2）、截断边界（正好等于上限不截、超一列只切一列）、
//     幂等、不劈开代理对、悬空分隔符被吃掉。
//   • 源码护栏：主进程不再自己拼那行；上限别被人随手调大「修好」截断；新 verify 必须进总闸
//     verify:static。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRAY_ARTIST_SEP, TRAY_IDLE_LABEL, TRAY_TITLE_ELLIPSIS, TRAY_TITLE_MAX_COLS, TRAY_TRACK_SEP,
  charCols, clampCols, displayCols, trayTitleLine,
} from "../electron/tray-title.ts";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
/** 孤立代理对（劈开了 emoji/扩展汉字的半个字）——截断按码点走才不会有这个 */
const loneSurrogate = (s) => /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(s);
const UI = join(import.meta.dirname, "..");
const SONG = "名".repeat(19); // 38 列

// ——— 列宽口径 ———
section("显示列宽：汉字/全角/emoji 记 2，其余 1，控制字符 0");
eq("空串", displayCols(""), 0);
eq("空值不炸", displayCols(null), 0);
eq("纯拉丁", displayCols("abc"), 3);
eq("汉字", displayCols("夜曲"), 4);
eq("汉字 + 空格 + 拉丁（中英混排按各自宽度累加）", displayCols("周杰伦 Jay"), 10);
eq("全角标点（（）按 2 列）", displayCols("（Live）"), 8);
eq("假名", displayCols("あ"), 2);
eq("读音符号（长音符 ー 是 CJK 兼容区，2 列）", displayCols("コーヒー"), 8);
eq("谚文音节", displayCols("한"), 2);
eq("全角 ASCII", displayCols("ｆｕｌｌ"), 8);
eq("emoji 按 2 列", displayCols("🎵"), 2);
eq("省略号 1 列（所以用它而不是 ...，省两列）", displayCols(TRAY_TITLE_ELLIPSIS), 1);
eq("控制字符 0 列（兜底：oneLine 已清过）", displayCols("\u0007"), 0);
eq("charCols 对汉字返回 2", charCols("夜"), 2);
eq("charCols 对拉丁返回 1", charCols("A"), 1);
check("上限是个「一瞥即止」的量级（24–60 列）——别靠调大它来「修好」截断",
  TRAY_TITLE_MAX_COLS >= 24 && TRAY_TITLE_MAX_COLS <= 60, `=${TRAY_TITLE_MAX_COLS}`);

// ——— 截断 ———
section("截断：不超限原样返回，超限只切到预算");
eq("不超限不补省略号", clampCols("夜曲 - 周杰伦"), "夜曲 - 周杰伦");
check("不超限时内容逐字未变", !clampCols("夜曲 - 周杰伦").includes(TRAY_TITLE_ELLIPSIS));
eq("正好等于上限（拉丁 40 列）不截", clampCols("a".repeat(40)), "a".repeat(40));
eq("正好等于上限（汉字 20 列×2）不截", clampCols("夜".repeat(20)), "夜".repeat(20));
eq("超一列：正文砍到 39 列 + 省略号 = 40 列", clampCols("a".repeat(41)), "a".repeat(39) + TRAY_TITLE_ELLIPSIS);
eq("超一列（汉字口径）：19 个汉字 + 省略号", clampCols("夜".repeat(21)), "夜".repeat(19) + TRAY_TITLE_ELLIPSIS);
check("结果列宽恒 ≤ 上限（汉字串）", displayCols(clampCols("这是一首特别特别长的中文歌曲名字".repeat(3))) <= TRAY_TITLE_MAX_COLS,
  `得 ${displayCols(clampCols("这是一首特别特别长的中文歌曲名字".repeat(3)))}`);
check("结果列宽恒 ≤ 上限（拉丁串）", displayCols(clampCols("x".repeat(200))) <= TRAY_TITLE_MAX_COLS);
check("截断后必定以省略号收尾", clampCols("x".repeat(200)).endsWith(TRAY_TITLE_ELLIPSIS));
eq("幂等：再截一次不变", clampCols(clampCols("x".repeat(200))), clampCols("x".repeat(200)));
eq("空串截断仍是空串（不补省略号）", clampCols(""), "");
eq("上限 0 → 空串", clampCols("夜曲", 0), "");
eq("上限 1 → 只剩省略号", clampCols("夜曲", 1), TRAY_TITLE_ELLIPSIS);
eq("上限 2（放不下正文）→ 只剩省略号", clampCols("夜曲", 2), TRAY_TITLE_ELLIPSIS);

// 断在「名 - 歌手」的分隔符中间时不能留个「名 -…」的悬空连接符
const cutInSep = clampCols(SONG + " - 甲乙丙丁");
check("断在分隔符中间：悬空的分隔符/空白被吃掉", !cutInSep.includes("-") && cutInSep.endsWith(TRAY_TITLE_ELLIPSIS),
  JSON.stringify(cutInSep));
eq("断在分隔符中间：正文保留到歌名（不含尾随空格）", cutInSep, SONG + TRAY_TITLE_ELLIPSIS);
const cutInArtists = clampCols(SONG + " - 甲乙丙丁戊己庚辛");
check("多位歌手之间断开也吃干净分隔符", !/[\s\-/]…$/.test(cutInArtists), JSON.stringify(cutInArtists));
check("截断不劈开代理对（emoji 长串）", !loneSurrogate(clampCols("🎵".repeat(30))), JSON.stringify(clampCols("🎵".repeat(30))));
check("截断不劈开代理对（扩展汉字）", !loneSurrogate(clampCols("\u{20000}".repeat(30))));

// ——— 标题行 ———
section("标题行：成型（与界面同款）+ 截断");
eq("无曲目 → 占位", trayTitleLine(null), TRAY_IDLE_LABEL);
eq("undefined → 占位", trayTitleLine(undefined), TRAY_IDLE_LABEL);
eq("空对象 → 占位", trayTitleLine({}), TRAY_IDLE_LABEL);
eq("有 artists 没 name → 占位（不出现「 - 张三」这种半截行）", trayTitleLine({ artists: ["张三"] }), TRAY_IDLE_LABEL);
eq("单歌手：名 - 歌手", trayTitleLine({ name: "夜曲", artists: ["周杰伦"] }), `夜曲${TRAY_TRACK_SEP}周杰伦`);
eq("多歌手用「 / 」连接（与界面同款）",
  trayTitleLine({ name: "以父之名", artists: ["周杰伦", "费玉清"] }), `以父之名 - 周杰伦${TRAY_ARTIST_SEP}费玉清`);
eq("无歌手就只显示歌名", trayTitleLine({ name: "纯音乐" }), "纯音乐");
eq("空歌手名被丢掉", trayTitleLine({ name: "夜曲", artists: ["", "  ", "周杰伦"] }), "夜曲 - 周杰伦");
eq("artists 不是数组（脏数据）不炸，退回只有歌名", trayTitleLine({ name: "夜曲", artists: "周杰伦" }), "夜曲");
eq("换行/连续空白压成单空格（\\n 在 win/mac 上会真画成两行，菜单变高）",
  trayTitleLine({ name: "夜\n曲  ", artists: ["  周  杰伦 "] }), "夜 曲 - 周 杰伦");
eq("首尾空白被去掉", trayTitleLine({ name: "  夜曲  ", artists: [" 周杰伦 "] }), "夜曲 - 周杰伦");
const long = trayTitleLine({ name: "夜的第七章（Live at 台北小巨蛋 Concert Version）", artists: ["周杰伦", "温岚"] });
check("长中文歌名被截到上限", displayCols(long) <= TRAY_TITLE_MAX_COLS && long.endsWith(TRAY_TITLE_ELLIPSIS),
  `${displayCols(long)} 列 ${JSON.stringify(long)}`);
check("截断后仍能认出是哪首（保留开头）", long.startsWith("夜的第七章"), JSON.stringify(long));
const longLatin = trayTitleLine({ name: "Love Story (Taylor's Version) - 2021 Remastered", artists: ["Taylor Swift"] });
check("长拉丁歌名同样受管", displayCols(longLatin) <= TRAY_TITLE_MAX_COLS && longLatin.endsWith(TRAY_TITLE_ELLIPSIS),
  `${displayCols(longLatin)} 列 ${JSON.stringify(longLatin)}`);
eq("短标题不受影响（回归：别把正常歌名也截了）",
  trayTitleLine({ name: "晴天", artists: ["周杰伦"] }), "晴天 - 周杰伦");

// ——— 主进程接线 ———
section("main.ts 接线护栏");
const mainSrc = readFileSync(join(UI, "electron", "main.ts"), "utf8");
check("引了 tray-title.ts（成型与截断只有一份真相）",
  /import\s*\{\s*trayTitleLine\s*\}\s*from\s*"\.\/tray-title\.ts"/.test(mainSrc));
check("菜单第一项走 trayTitleLine（不再自己拼那行）", /const songLine = trayTitleLine\(t\);/.test(mainSrc));
check("主进程不再内联拼歌手串（旧的 .join(\" / \") 表达式已挪走）",
  !/\.artists\.join\(" \/ "\)/.test(mainSrc));
check("主进程不再自带「未在播放」文案（占位文案归模块，免得两处写岔）",
  !mainSrc.includes("未在播放"));
check("曲目行仍是纯展示项（不可点击）", /\{\s*label:\s*songLine,\s*enabled:\s*false\s*\}/.test(mainSrc));
check("托盘菜单仍是三平台同一份（没有为 win/mac 另开分支拼标题）",
  !/process\.platform[\s\S]{0,80}(songLine|trayTitleLine)/.test(mainSrc));

// ——— 总闸接线 ———
section("package.json：verify 脚本与总闸");
const pkg = JSON.parse(readFileSync(join(UI, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};
eq("verify:tray-title 脚本存在", scripts["verify:tray-title"], "node scripts/verify-tray-title.ts");
check("verify:static 收录了 verify-tray-title（新脚本必须进总闸，否则等于没测）",
  String(scripts["verify:static"] ?? "").includes("verify-tray-title.ts"));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-tray-title: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
