// 猜你喜欢无限电台 —— 源码级静态断言
//
// 上游 `music.radioProxy.MbTrackRadioSvr/get_radio_track` 一次固定 5 首，所以电台每轮
// 只请求 rounds=1；播到轮末再取下一轮，不允许一次抓 20/30 首重新退回“歌单”语义。
//
// 用法：node scripts/verify-guess.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { viewSource } from "./views-source.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const css = read("src/style.css");
const playerSrc = read("src/player.ts");
const playerBar = read("src/components/PlayerBar.ts");
const nowPlaying = read("src/components/NowPlaying.ts");
const queuePanel = read("src/components/QueuePanel.ts");
const mpris = read("src/mpris.ts");
const guess = viewSource("guess");
const guessRoutes = readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "app.go"), "utf8");
const guessHandler = readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "handlers_discovery.go"), "utf8");
const recommendGo = readFileSync(join(root, "..", "vendor", "Typhoeus-go", "qqmusic", "modules", "recommend.go"), "utf8");

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
const guessCode = code(guess);
const playerCode = code(playerSrc);
const playerBarCode = code(playerBar);
const queuePanelCode = code(queuePanel);
const mprisCode = code(mpris);

// ============ 1. 后端（Go sidecar）：单轮固定 5 首的串行上游 ============
ok("后端: /recommend/guess 路由存在",
  re(guessRoutes, /"GET \/recommend\/guess"/) && re(guessHandler, /func \(a \*App\) handleRecommendGuess/));
ok("后端: **串行**取轮（并发只放行一个，其余 700000）",
  re(guessHandler, /for i := 0; i < rounds; i\+\+/) && !has(guessHandler, "errgroup"));
ok("后端: 轮数钳位在 1..8",
  re(guessHandler, /rounds > 8/) && re(guessHandler, /rounds = 8/));
ok("后端: 按 mid 去重",
  re(guessHandler, /seen\[t\.Mid\]/));
ok("后端: 单轮失败只记 warning 并 continue",
  re(guessHandler, /logWarn\("猜你喜欢第 %d\/%d 轮失败/) && re(guessHandler, /continue/));
ok("后端: 全轮都失败才抛 502", re(guessHandler, /len\(songs\) == 0 \{[\s\S]{0,120}StatusBadGateway/));
ok("后端: 实测结论写进注释（num 被忽略 / 22006 / 700000）",
  has(guessHandler, "700000") && has(recommendGo, "22006") && has(recommendGo, "只给 5 首"));

// ============ 2. 入口：点击猜你喜欢即展开并开启电台 ============
ok("入口: 猜你喜欢视图调用 player.startRadio()", re(guessCode, /player\.startRadio\(\)/));
ok("入口: 进入视图就等首轮取歌，不再等用户双击歌曲行", re(guessCode, /await start\(\)/));
ok("入口: 电台已在跑时只展开当前会话，不打断重开", re(guessCode, /if \(player\.radioActive\) \{[\s\S]{0,80}player\.expanded = true;[\s\S]{0,80}\} else \{\s*await start\(\);/));
ok("电台: startRadio() 在取歌前同步 expanded=true（点击即展开，不等网络）",
  re(playerCode, /this\.expanded = true;[\s\S]{0,220}await this\.fetchRadioRound\(\)/));
ok("电台: 视图保留“回到正在播放”与“换一批”入口",
  has(guessCode, "guess-radio-open") && has(guessCode, "guess-radio-restart"));
ok("电台: 取歌失败有 toast 与可重开入口", has(guessCode, "toast(errText(e)") && has(guessCode, "重新开启电台"));
ok("css: 猜你喜欢使用电台落点 .guess-radio", re(css, /\.guess-radio \{[^}]*display: flex/));

// ============ 3. 一轮 5 首，播到第五首续下一轮 ============
ok("取歌: 每轮只请求 rounds=1", re(playerCode, /api(?:<[^>(]*>)?\("\/recommend\/guess\?rounds=1"\)/));
ok("取歌: 单轮结果硬截断为 5 首", has(playerCode, ".slice(0, 5)"));
ok("取歌: 不再出现旧 rounds=2 / rounds=4 两段式", !re(playerCode, /rounds=(?:2|4)/));
ok("续批: 有当前轮末下标 radioEnd", has(playerCode, "private radioEnd = -1"));
ok("续批: 播到本轮末首才续批（index < radioEnd 时不取）",
  re(playerCode, /this\.index < this\.radioEnd\) return;[\s\S]{0,80}void this\.extendRadio\(\)/));
ok("续批: jump 到第五首时触发 maybeExtendRadio", re(playerCode, /this\.index = i;\s*this\.maybeExtendRadio\(\);/));
ok("续批: 下一轮追加到队列尾部", has(playerCode, "this.queue.push(...songs)"));
ok("裁剪: 以当前曲为锚，删掉正在播放曲之前的全部历史",
  re(playerCode, /const anchor = this\.current;[\s\S]{0,160}const drop = Math\.max\(0, at\);[\s\S]{0,80}this\.queue\.splice\(0, drop\)/));
ok("续批: 裁剪后重算本轮末下标", re(playerCode, /this\.radioEnd = this\.queue\.length - 1;/));
ok("轮末: 下一轮未到时等待，不回绕旧歌", re(playerCode, /this\.radioWaitingNext = true;[\s\S]{0,100}return;/));

// ============ 4. 屏蔽上一曲，保留红心 ============
ok("上一曲: radioActive 时 canPrev=false", re(playerCode, /get canPrev\(\) \{ return this\.queue\.length > 0 && !this\.radioOn; \}/));
ok("上一曲: prev() 在电台里直接 return", re(playerCode, /if \(this\.radioOn\) return;[\s\S]{0,120}replay/));
ok("上一曲: 播放条按钮按 canPrev 禁用", has(playerBarCode, "prev.disabled = !canPrev;"));
ok("上一曲: 禁用原因写进 title/aria-label", has(playerBarCode, "无限电台只向前播放"));
ok("红心: 播放条红心仍调用 player.toggleLove(current)", has(playerBarCode, "player.toggleLove(player.current)"));
ok("红心: 正在播放页也保留红心入口（窄窗口藏播放条红心时仍可收藏）",
  has(nowPlaying, 'id="np-love"') && has(nowPlaying, "player.toggleLove(player.current)") && has(nowPlaying, "loveBtn.classList.toggle(\"on\", loved)"));
ok("红心: 电台队列仍是正常 Song 对象，收藏写接口无需特殊分支", !has(guessCode, "hideLove"));
// ============ 4.5 电台屏蔽播放列表与循环/随机 ============
ok("播放列表: 进入电台即关掉队列面板", has(playerCode, "this.queueOpen = false;"));
ok("播放列表: 播放条队列按钮隐藏且禁用", has(playerBarCode, "queueBtn.hidden = player.radioActive;") && has(playerBarCode, "queueBtn.disabled = player.radioActive;"));
ok("播放列表: 队列按钮点击在电台里直接返回", re(playerBarCode, /queueBtn\.onclick = \(\) => \{\s*if \(player\.radioActive\) return;/));
ok("播放列表: QueuePanel 自己也不允许在电台展开", has(queuePanelCode, "const open = player.queueOpen && !player.radioActive;"));
ok("循环: 播放条循环按钮在电台里禁用", has(playerBarCode, "loop.disabled = player.radioActive;"));
ok("循环: 进入电台关闭已打开的循环菜单", re(playerBarCode, /if \(player\.radioActive\) closeLPop\(\);/));
ok("循环: player.setMode 在电台里 no-op", re(playerCode, /setMode\(m: Mode\) \{\s*if \(this\.radioOn\) return;/));
ok("循环: player.toggleShuffle 在电台里 no-op", re(playerCode, /toggleShuffle\(\) \{\s*if \(this\.radioOn\) return;/));
ok("循环: MPRIS 电台态报告 None", has(mprisCode, 'loop: player.radioActive ? "None"'));


// ============ 5. 电台退出与队列语义 ============
ok("电台: 换整张队列/手动改队列会退出电台", re(playerCode, /playList\(songs: Song\[\], i = 0\) \{\s*this\.exitRadio\(\);/));
ok("电台: 只向前走（orderOf 在 radioOn 时走原序）",
  re(playerCode, /if \(this\.radioOn\) \{[\s\S]{0,180}return this\.identityOrder;/));
console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
