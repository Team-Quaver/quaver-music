// 猜你喜欢（/recommend/guess）拿更多歌 —— 源码级静态断言
//
// 上游 `music.radioProxy.MbTrackRadioSvr/get_radio_track` 一次只给 5 首：
//   · num 加大被忽略（实测 5/10/20/50 都只回 5 首）；
//   · 回灌 song_ids 续拿直接报 22006；
//   · **并发只放行一个**，其余回 700000 —— 所以必须串行。
// 结论：想多拿只能「多调几轮 + 按 mid 去重」。这里把这几个实测约束钉死，
// 免得以后有人改成 asyncio.gather（会静默退化成 1 轮 5 首）。
//
// 用法：node scripts/verify-guess.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const views = read("src/views.ts");
const css = read("src/style.css");
const app = readFileSync(join(root, "..", "vendor", "Typhoeus", "quaver_server", "app.py"), "utf8");

let fails = 0;
let checks = 0;
function ok(name, cond, note = "") {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
}
const has = (hay, needle) => hay.includes(needle);
const re = (hay, rx) => rx.test(hay);
/** 去注释后再断言：否则「别再写回 XXX」这类注释会被当成违规代码 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const guess = (() => {
  const i = views.indexOf("async function guessView");
  return i < 0 ? "" : views.slice(i, views.indexOf("\n}", i));
})();
const guessCode = code(guess);
const route = (() => {
  const i = app.indexOf('@app.get("/recommend/guess")');
  return i < 0 ? "" : app.slice(i, app.indexOf("\n@app.", i + 10));
})();

// ============ 1. 后端：串行多轮（并发会被上游 700000 拒）============
ok("后端: /recommend/guess 路由存在", !!route);
ok("后端: **串行**取多轮（for 循环，不是 asyncio.gather —— 并发只放行一个，其余 700000）",
  re(route, /for i in range\(rounds\)/) && !has(route, "asyncio.gather"));
ok("后端: 轮数钳位在 1..8（别让人传个 999 把上游打爆）",
  re(route, /rounds = max\(1, min\(rounds, 8\)\)/));
ok("后端: 按 mid 去重（多轮内容随机，会撞歌）",
  re(route, /mid = getattr\(s, "mid", ""\)/) && re(route, /if not mid or mid in seen/));
ok("后端: 单轮失败只记 warning 并 continue（不拖垮整页）",
  re(route, /except Exception as exc/) && re(route, /logger\.warning\([\s\S]{0,80}continue/));
ok("后端: 全轮都失败才抛 502", re(route, /if not songs:[\s\S]{0,80}HTTPException\(502/));
ok("后端: 实测结论写进注释（num 被忽略 / 22006 / 700000）",
  has(route, "22006") && has(route, "700000") && has(route, "只给 5 首"));

// ============ 2. 前端：分两段取，别让用户干等 6 秒 ============
ok("前端: 首批 rounds=2 先出画面（单轮 ~950ms，一口气 6 轮是 6 秒白屏）",
  re(guessCode, /api<any>\("\/recommend\/guess\?rounds=2"\)/));
ok("前端: 第二批 rounds=4 补齐到 ~30 首", re(guessCode, /api<any>\("\/recommend\/guess\?rounds=4"\)/));
ok("前端: 首批拿到就画，不等第二批", re(guessCode, /if \(fresh\.length\) \{ songs = fresh; paint\(\); \}/));
ok("前端: 按 mid 去重（两批之间会撞歌）",
  has(guessCode, "const seen = new Set<string>();") && re(guessCode, /seen\.has\(k\)/));
ok("前端: 第二批失败不拖垮首批（catch 只在「一首都没有」时才报错）",
  re(guessCode, /catch \(e: any\) \{\s*if \(!songs\.length\)/));
ok("前端: 重画后重标当前曲", has(guessCode, "player.markActive()"));
ok("前端: 说明文案交代了为什么要等（一次只给 5 首）", has(guess, "一次只给 5 首"));
ok("前端: 空态有可读文案", has(guess, "暂无推荐，登录后可得"));

// ============ 3. 「换一批」============
ok("换一批: 按钮存在（页头下方、右侧对齐的次级按钮）",
  has(guessCode, '"guess-bar"') && has(guessCode, 'btn.textContent = "换一批"'));
ok("换一批: 走 .ghost-btn--quiet（透明底 + 发丝线的次级按钮，不抢标题）",
  has(guessCode, "ghost-btn ghost-btn--quiet"));
ok("换一批: 取歌中禁用按钮 + 改文案（单批 ~3-6s，没反馈会以为点了没反应）",
  re(guessCode, /btn\.disabled = true;\s*btn\.textContent = "取歌中…"/));
ok("换一批: 有 busy 闸门防重复触发（顺便挡键盘/程序触发）",
  has(guessCode, "let busy = false;") && re(guessCode, /if \(busy\) return;/));
ok("换一批: finally 里一定恢复按钮（异常也不把按钮卡死）",
  re(guessCode, /finally \{\s*busy = false;\s*btn\.disabled = false;\s*btn\.textContent = "换一批";/));
ok("换一批: **新批次先攒在临时数组**，成了才整体换上（失败时手上这批还在，不会一片空白）",
  re(guessCode, /const fresh: any\[\] = \[\];/) && re(guessCode, /songs = fresh; paint\(\)/)
  && !re(guessCode, /songs = \[\];/));
ok("换一批: 已有列表时失败只 toast，不整页报错",
  re(guessCode, /if \(!songs\.length\) box\.innerHTML[\s\S]{0,80}else toast\(/));
ok("换一批: 进页面即走同一条 load()（不重复实现一套取歌）",
  re(guessCode, /btn\.addEventListener\("click", \(\) => void load\(\)\);\s*await load\(\);/));
ok("css: .guess-bar 有定义且靠右（与列表工具条同一版式语言）",
  re(css, /\.guess-bar \{[^}]*justify-content: flex-end/));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
