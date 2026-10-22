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
const session = read("src/lib/session.ts");
const songMenu = read("src/components/SongMenu.ts");
const playlistMenu = read("src/components/PlaylistMenu.ts");
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
const sessionCode = code(session);
const songMenuCode = code(songMenu);
const playlistMenuCode = code(playlistMenu);

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

// ============ 2. 入口：Content View 电台主舞台 ============
ok("入口: 猜你喜欢视图调用 player.startRadio()", re(guessCode, /player\.startRadio\(\)/));

ok("入口: 进入视图就等首轮取歌，不再等用户双击歌曲行", re(guessCode, /await start\(\)/));

ok("入口: 电台已在跑时只恢复主舞台，不打断重开", re(guessCode, /if \(!player\.radioActive\) await start\(\);/));

ok("入口: 进入电台不自动展开正在播放覆盖层", has(guessCode, "player.expanded = false;") && !re(playerCode, /this\.expanded = true;[\s\S]{0,220}await this\.fetchRadioRound\(\)/));

ok("舞台: 当前曲目在 Content View 居中", has(guessCode, 'root.classList.add("guess-radio-page")') && re(css, /\.route > \.entering\.guess-radio-page \{[^}]*align-items: center;[^}]*justify-content: center;/));

ok("舞台: 控制条在封面上方，含暂停/下一首/红心", has(guessCode, 'id="radio-play"') && has(guessCode, 'id="radio-next"') && has(guessCode, 'id="radio-love"'));

ok("舞台: 手动换一批入口保留", has(guessCode, 'id="radio-restart"') && has(guessCode, "restart.addEventListener(\"click\""));

ok("封面: 使用与正在播放页相同的 300 档封面地址", has(guessCode, "coverUrl(s, 300)") && !has(guessCode, "coverUrl(s, 600)"));

ok("封面: 图片加载失败回落 ∞ 占位", has(guessCode, "img.onerror"));

ok("舞台: 取歌失败有 toast 与可重试入口", has(guessCode, "toast(errText(e)") && has(guessCode, "换一批"));

ok("css: 电台主舞台 .radio-stage 有定义", re(css, /\.radio-stage \{[^}]*flex-direction: column/));

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

ok("红心: 电台舞台红心调用 player.toggleLove(current)", has(guessCode, "player.toggleLove(player.current)"));

ok("红心: 正在播放页不再有红心按钮", !has(nowPlaying, 'id="np-love"') && !has(nowPlaying, "toggleLove(player.current)"));

ok("红心: 空心/实心只换 SVG 形状，不染色", has(guessCode, "loved ? icons.heartFill : icons.heart") && has(css, ".pb-ghost#pb-love.on { color: var(--ink3); }") && !re(css, /\.radio-control\.on[^}]*color/));

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

// ============ 4.6 电台状态跨重启 + 插队边界 ============
ok("存档: 写入 radio/radioEnd", has(sessionCode, "radio,") && has(sessionCode, "radioEnd,"));

ok("存档: 空队列也保留已开启的电台", re(sessionCode, /if \(!queue\.length && !radio\) return null;/));

ok("存档: 读回 radio/radioEnd", has(sessionCode, "radio,") && re(sessionCode, /radioEnd,[\s\S]{0,120}quality:/));

ok("恢复: 电台开关与轮末边界一起还原", re(playerCode, /this\.radioOn = !!snap\.radio;[\s\S]{0,320}this\.radioEnd = this\.radioOn && this\.queue\.length/));

ok("恢复: 空电台取回首轮但不自动出声", re(playerCode, /if \(this\.radioOn && !this\.current\) \{\s*void this\.startRadio\(false\)/));

ok("存档: 节流落盘也带上电台态", re(playerCode, /radio: this\.radioOn, radioEnd: this\.radioEnd,/));

ok("插队: 单曲插队在电台里 no-op 且不退出电台", re(playerCode, /enqueueNext\(song: Song\): boolean \{\s*if \(!song\?\.mid \|\| this\.radioOn\) return false;/));

ok("插队: 整批插队在电台里 no-op", re(playerCode, /enqueueNextMany\(songs: Song\[\]\): boolean \{\s*if \(this\.radioOn\) return false;/));

ok("立即播放: 搜索双击先退出电台再切歌", re(playerCode, /playNextNow\(song: Song\): boolean \{[\s\S]{0,260}?this\.exitRadio\(\);[\s\S]{0,160}?this\.startCurrent\(\);/));

ok("立即播放: 搜索双击入口不把电台态当成插队锁", !re(songMenuCode, /playNowWithToast\(song: any\) \{[\s\S]{0,140}?player\.radioActive/));

ok("插队: 单曲菜单在电台里仍明确拒绝", has(songMenuCode, "无限电台播放中，不能插队播放其他歌曲"));

ok("插队: 歌曲菜单禁用插队项", re(songMenuCode, /label: "插队播放",[\s\S]{0,100}disabled: player\.radioActive/));

ok("插队: 歌单菜单禁用电台期间的插队项", re(playlistMenuCode, /label: "插队播放",[\s\S]{0,120}disabled: player\.radioActive/));

ok("插队: 歌单插队先拦电台再取歌", re(playlistMenuCode, /playSongsNext[\s\S]{0,180}if \(player\.radioActive\)[\s\S]{0,100}return;[\s\S]{0,100}fetchSongsOrComplain/));


// ============ 5. 电台退出与队列语义 ============
ok("电台: 换整张队列/手动改队列会退出电台", re(playerCode, /playList\(songs: Song\[\], i = 0\) \{\s*this\.exitRadio\(\);/));

ok("电台: 只向前走（orderOf 在 radioOn 时走原序）",
  re(playerCode, /if \(this\.radioOn\) \{[\s\S]{0,180}return this\.identityOrder;/));

ok("电台: 封面流邻曲不回绕（左侧 -1，轮末 next 也为 -1）",
  re(playerCode, /if \(this\.radioOn\) \{\s*const next = this\.index >= 0 && this\.index \+ 1 < this\.queue\.length \? this\.index \+ 1 : -1;\s*return \{ prev: -1, next \};/));

ok("电台: songAtOffset 负偏移为空、正向不越过队列末尾",
  re(playerCode, /if \(this\.radioOn\) \{\s*if \(offset < 0\) return undefined;\s*const i = this\.index \+ offset;\s*return i >= 0 && i < this\.queue\.length \? this\.queue\[i\] : undefined;/));

ok("电台: jumpToOffset 负偏移与越界都是 no-op，绝不倒带/回绕",
  re(playerCode, /jumpToOffset[\s\S]{0,500}?if \(this\.radioOn\) \{\s*const i = this\.index \+ offset;\s*if \(i < 0 \|\| i >= this\.queue\.length\) return;\s*this\.jump\(i\);/));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);

process.exit(fails ? 1 : 0);
