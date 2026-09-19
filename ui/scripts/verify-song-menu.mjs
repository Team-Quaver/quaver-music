// 歌曲名带副标题 / 右键菜单 / 搜索页插队 / 歌单写接口 / 会话存档 —— 源码级静态断言
//
// 为什么不起浏览器：本机跑 Chromium/Electron 会把宿主 OOM（见 AGENTS.md 与项目备注），
// 所以 UI 一律走「tsc --noEmit + vite build + 源码级静态断言」，检查
// **选择器 ↔ DOM 结构 ↔ JS 接线** 三边自洽，外加后端路由与前端调用路径对得上。
//
// 用法：node scripts/verify-song-menu.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = {
  api: read("src/lib/api.ts"),
  songs: read("src/lib/songs.ts"),
  menu: read("src/components/SongMenu.ts"),
  playlists: read("src/lib/playlists.ts"),
  session: read("src/lib/session.ts"),
  player: read("src/player.ts"),
  views: read("src/views.ts"),
  bar: read("src/components/PlayerBar.ts"),
  queue: read("src/components/QueuePanel.ts"),
  np: read("src/components/NowPlaying.ts"),
  mpris: read("src/mpris.ts"),
  css: read("src/style.css"),
  app: readFileSync(join(root, "..", "vendor", "Typhoeus", "quaver_server", "app.py"), "utf8"),
};

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
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ============ 1. 歌曲名带副标题（title 优先 + subtitle 追加） ============
ok("api: 导出 songTitle/songSubtitle/stripEm", /export function songTitle|export const songSubtitle/.test(src.api)
  && has(src.api, "export const stripEm"));
ok("api: songTitle 优先 title 再退 name", /const title = stripEm\(s\?\.title\)\.trim\(\);\s*return title \|\| name;/.test(src.api));
ok("api: 分享链接走 QQ 音乐网页版", has(src.api, "https://y.qq.com/n/ryqq/songDetail/"));
ok("api: copyText 带 execCommand 回落", has(src.api, "execCommand(\"copy\")"));
ok("songs: 行标题用 songTitle + 追加 subtitle", re(src.songs, /esc\(songTitle\(s\)\)/) && re(src.songs, /class="rt-sub"/));
ok("songs: 不再直出 s.name 当标题", !re(src.songs, /class="rt"[^>]*>\$\{esc\(s\.name/));
ok("css: .row .rt-sub 有样式", has(src.css, ".row .rt-sub"));
for (const [name, file] of [["播放条", src.bar], ["队列面板", src.queue], ["正在播放页", src.np], ["MPRIS", src.mpris]]) {
  ok(`${name}: 展示名走 songTitle`, has(file, "songTitle("), "避免不同版本同名不可分辨");
}

// ============ 2. 右键菜单（含搜索页） ============
const MENU_LABELS = ["插队播放", "加入歌单", "从歌单删除", "跳转至", "歌手", "专辑", "同名搜索",
  "更多操作", "复制歌曲链接", "复制歌曲名称"];
for (const label of MENU_LABELS) ok(`菜单项「${label}」存在`, has(src.menu, `label: "${label}"`));

ok("菜单: 歌曲行统一挂载（搜索结果同一组件同一行渲染）",
  has(src.songs, "bindSongMenu(row,") && has(src.menu, "export function bindSongMenu"));
ok("菜单: 右键 preventDefault（不弹系统菜单）", re(src.menu, /addEventListener\("contextmenu"[\s\S]{0,120}preventDefault\(\)/));
ok("菜单: 子菜单悬停展开 + 宽限收回", has(src.menu, "SUB_GRACE_MS") && has(src.menu, "pointerenter"));
ok("菜单: 关闭时机齐全（外部点击 / Esc / 滚动 / 尺寸·失焦·路由）",
  ["pointerdown", "keydown", "scroll", "resize", "blur", "hashchange"].every((k) => has(src.menu, `"${k}"`)));
ok("菜单: .ctx-menu 自己可滚（歌单多时不越出视口）—— 内部滚动不该被当成页面滚动",
  re(src.css, /\.ctx-menu \{[\s\S]{0,320}overflow-y: auto/));
ok("菜单: 位置钳制在视口内", has(src.menu, "VIEW_PAD") && re(src.menu, /clamp\(left, VIEW_PAD/));
ok("菜单: 歌单子菜单异步内容有竞态丢弃", has(src.menu, "subSeq") && has(src.menu, "seq !== subSeq"));
// 回归（实测踩到）：曾经用 `panels.length !== depth + 1 → return` 丢过期异步结果，
// 结果第一个子菜单一开，同层其它项就再也打不开 —— 换成「先收深层再挂自己」。
const menuCode = noComments(src.menu);
ok("菜单: 同层换项先收深层再展开", re(menuCode, /const cur = panels\[depth \+ 1\];[\s\S]{0,200}dropPanels\(depth \+ 1\);[\s\S]{0,80}const seq = \+\+subSeq;/)
  && !has(menuCode, "panels.length !== depth + 1"), "早期写法会锁死第二个子菜单");
ok("菜单: 同项重复悬停不重建（面板记住挂它的项）",
  has(src.menu, "cur.dataset.owner === btn.dataset.itemId") && has(src.menu, 'panel.dataset.owner = anchor?.dataset.itemId ?? "root"'));
ok("菜单: 指针移进子菜单不作废在飞请求（「载入中…」要能落成真实列表）",
  !/pointerleave"[\s\S]{0,240}invalidateSubs\(\)/.test(noComments(src.menu.split("if (it.sub) {")[1]?.split("} else {")[0] ?? "")));
ok("菜单: 加入歌单/从歌单删除走 playlists 数据层",
  has(src.menu, "addSongToSonglist") && has(src.menu, "removeSongFromSonglist"));
ok("菜单: 复制走 clipboard 封装", has(src.menu, "copyText("));

// 选择器 ↔ DOM：SongMenu 里出现的每个 ctx-/ct- 类名都要在 style.css 有定义
const menuClasses = new Set([...src.menu.matchAll(/"(ctx-[a-z-]+|ct-[a-z-]+)"/g)].map((m) => m[1]));
for (const c of menuClasses) ok(`css: .${c} 有定义`, has(src.css, `.${c}`), [...menuClasses].join(" "));
ok("css: 面板是 fixed 层（不受 .route transform/overflow 影响）",
  /\.ctx-layer \{[^}]*position: fixed[^}]*pointer-events: none/.test(src.css)
  && /\.ctx-menu \{[^}]*position: fixed/.test(src.css));

// 层级：菜单(80) 必须盖住队列面板(70)与正在播放页(50)，但不压过窗口按钮簇(90)
const zOf = (sel) => {
  const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*z-index:\\s*(\\d+)`).exec(src.css);
  return m ? Number(m[1]) : NaN;
};
const zMenu = zOf(".ctx-layer"), zQp = zOf(".queue-panel.float"), zNp = zOf(".np"), zWin = zOf(".winbtns");
ok("层级: 菜单 > 队列浮窗 > 正在播放页", zMenu > zQp && zQp > zNp, `menu=${zMenu} qp=${zQp} np=${zNp}`);
ok("层级: 菜单不盖窗口按钮簇", zMenu < zWin, `menu=${zMenu} winbtns=${zWin}`);
ok("css: 提示条 .toast / .toast.show 有样式", has(src.css, ".toast {") && has(src.css, ".toast.show"));

// ============ 3. 搜索页双击 = 插队（不清空队列） ============
// 插队 = 排到当前曲之后**等着播**（不打断、不跳转）。早期实现写成「插进去 + 立刻跳过去」，
// 与用户要的语义不符 —— 这里把「不许动指针、不许切歌」写成断言。
const enqueueBody = (src.player.match(/enqueueNext\(song: Song\) \{([\s\S]*?)\n  \}/) ?? [])[1] ?? "";
ok("player: 插队插到当前曲之后（排在下一首）",
  /this\.queue\.splice\(this\.index \+ 1, 0, song\);\s*this\.notify\(\);/.test(noComments(enqueueBody)));
ok("player: 插队不动指针、不切歌（队列空时才退化成起播）",
  !/this\.index \+=/.test(noComments(enqueueBody))
  && !/startCurrent/.test(noComments(enqueueBody))
  && /if \(this\.index < 0 \|\| !this\.queue\.length\) \{ this\.playList\(\[song\], 0\); return; \}/.test(noComments(enqueueBody)));
ok("player: 已删掉「插队即跳转」的 playNext", !has(noComments(src.player), "playNext("));
ok("views: 搜索页双击走插队（不是 playList，也不是已废的 playNext）",
  /renderSongRows\(box, list, \{ showAlbum: true, onPlay: \(s\) => enqueueNextWithToast\(s\) \}\)/.test(src.views));
ok("菜单: 插队播放与搜索页共用同一处语义 + 回执",
  has(src.menu, "export function enqueueNextWithToast") && has(src.menu, "player.enqueueNext(song)")
  && has(src.menu, "run: () => enqueueNextWithToast(song)"));

// ============ 4. 歌单写入（加入歌单 / 从歌单删除） ============
ok("playlists: 自建歌单缓存 + 排除「我喜欢」(dirid=201)",
  has(src.playlists, "loadMySonglists") && has(src.playlists, "LOVED_DIRID = 201") && has(src.playlists, "Number(p?.dirid) !== LOVED_DIRID"));
ok("playlists: 写接口用 dirid 路径 + 带 tid + writeSongType 转换",
  re(src.playlists, /postJson<\{ ok: boolean \}>\(`\/songlist\/\$\{target\.dirid\}\/songs`, \{ \.\.\.ref, tid: target\.id \|\| 0 \}\)/)
  && re(src.playlists, /song_type: writeSongType\(song\.type\)/));
ok("playlists: 缺 song_id 时不静默失败", has(src.playlists, "缺少 song_id"));
// 文档（SonglistApi）口径：add/del 的 True 很宽容（歌已存在 / 歌本就不在，都算 True），
// 只有 80092 被压成 False = 确凿失败。把 false 当成功 = 「其实没写进去」却显示「已加入」。
ok("playlists: ok=false 必须抛错（80092 不当成功）",
  has(src.playlists, "function assertAccepted")
  && /assertAccepted\(r, "加入歌单"\)/.test(src.playlists)
  && /assertAccepted\(r, "从歌单删除"\)/.test(src.playlists));
ok("app.py: POST /songlist/{dirid}/songs -> add_songs",
  re(src.app, /@app\.post\("\/songlist\/\{dirid\}\/songs"\)[\s\S]{0,320}add_songs\(dirid, \[\(body\.song_id, body\.song_type\)\], tid=body\.tid\)/));
ok("app.py: DELETE /songlist/{dirid}/songs -> del_songs",
  re(src.app, /@app\.delete\("\/songlist\/\{dirid\}\/songs"\)[\s\S]{0,360}del_songs\(dirid, \[\(body\.song_id, body\.song_type\)\], tid=body\.tid\)/));
ok("app.py: 写接口要求登录态", re(src.app, /songlist_add_song[\s\S]{0,300}need_login=True/));

// 视图接线：歌单页提供 dirid/tid/removable，删除后计数 -1 且行淡出
ok("views: 歌单页把 dirid/tid/removable 交给行", re(src.views, /playlist: \{\s*dirid: Number\(info\?\.dirid \?\? 0\),\s*tid: Number\(info\?\.id \?\? 0\)/) && has(src.views, "removable: own"));
ok("views: 只有自有歌单才 removable", re(src.views, /Number\(info\?\.creator\?\.musicid\) === myId/));
ok("views: 删除后计数 -1（并从原序里摘掉，见 verify-playlist-tools）",
  re(src.views, /onRemoved: \(song\) => \{[\s\S]{0,240}if \(songCount > 0\) songCount--;/));
ok("songs: 删除成功后行淡出移除", re(src.songs, /onRemoved: \(\) => \{[\s\S]{0,160}classList\.add\("leaving"\)/));

// ============ 5. 退出保留队列与进度 ============
ok("session: 独立存档键 + 队列上限",
  re(src.session, /const KEY = "quaver\.session\.v1"/) && has(src.session, "MAX_QUEUE = 500"));
const slimBody = src.session.split("function slim")[1]?.split("export function saveSession")[0] ?? "";
ok("session: 瘦身掉不必要的大字段（vs/vi/vf/pay 不进存档）",
  !/\bvs:|\bvi:|\bvf:|\bpay:/.test(slimBody));
ok("session: 但 file.media_mid 必须留（高档位取链用它，常与 mid 不同）",
  /file: mediaMid \? \{ media_mid: mediaMid \} : undefined/.test(slimBody));
ok("session: 读档做结构校验（脏数据不炸启动）",
  re(src.session, /export function loadSession[\s\S]{0,500}JSON\.parse\(raw\)/) && has(src.session, "typeof s.mid === \"string\""));
ok("player: 启动还原在 backendInit 之后", re(src.player, /this\.backendInit\.then\(\(\) => this\.restoreSession\(\)\)/));
ok("player: 还原是「挂流不自动播」", re(src.player, /await this\.startCurrent\(snap\.position, false\)/));
ok("player: 用户先动手就放弃还原（用户意图优先）",
  re(src.player, /if \(!snap \|\| this\.queue\.length \|\| this\.index >= 0\) \{ this\.sessionReady = true; return; \}/));
ok("player: 存档闸门 — 还原完成前不写盘（防空队列覆盖存档）",
  re(src.player, /scheduleSessionSave\(\) \{\s*if \(!this\.sessionReady\) return;/));
ok("player: notify 触发节流存档", /private notify\(\) \{[^}]*\}[\s\S]{0,200}this\.scheduleSessionSave\(\);/.test(src.player)
  || /private notify\(\) \{[^\n]*\n[^\n]*\n\s*this\.scheduleSessionSave\(\);/.test(src.player));
ok("player: 关窗/切后台立刻补落一次",
  re(src.player, /addEventListener\("pagehide", \(\) => this\.saveSessionNow\(\)\)/)
  && re(src.player, /visibilityState === "hidden"\) this\.saveSessionNow\(\)/));
ok("player: 流未就绪时保住还原点（不被 0 覆盖）", re(src.player, /posForSave\(\)[\s\S]{0,200}return this\.savedPos \|\| p;/));

// ============ 6. 回归：行的既有交互不能被菜单改动带走 ============
ok("回归: 双击播放仍走 hooks.onPlay", re(src.songs, /"dblclick"[\s\S]{0,180}hooks\.onPlay\?\.\(s, i, songs\)/));
ok("回归: 红心按钮仍先乐观改态再写接口", re(src.songs, /player\.toggleLove\(s\)[\s\S]{0,120}paintLove\(btn/));
ok("回归: 单击仍选中 + 预加载", re(src.songs, /player\.prefetchSong\(s\);/) && has(src.songs, "classList.add(\"sel\")"));
ok("回归: 歌手/专辑行内链仍在", re(src.songs, /dataset\.link!;[\s\S]{0,400}location\.hash = `#\/\$\{kind\}/));

// ============ 7. 滚动收起：只认「会把菜单甩脱位置」的那一种 ============
// 曾经写成「凡是滚动就收」→ 菜单刚开就闪没（.np 常驻布局，歌词每换一行 smooth 滚动连发 scroll）。
ok("菜单: 锚点被记下来（滚动判据要用它）",
  has(src.menu, "let anchorEl: HTMLElement | null = null;") && has(src.menu, "anchorEl = anchor ?? null;"));
ok("菜单: bindSongMenu 把行作为锚点传给 openSongMenu",
  re(src.menu, /openSongMenu\(me\.clientX, me\.clientY, get\(\), row\)/));
ok("菜单: 关闭时清锚点", re(src.menu, /anchorEl = null;\s*bindGlobal\(false\)/));
ok("菜单: 文档/窗口滚动才收（target = document / html / body）",
  re(src.menu, /t === document \|\| t === document\.documentElement \|\| t === document\.body\)\s*\{\s*closeMenu\(\);/));
ok("菜单: 锚点所在的可滚祖先滚了才收（.route 这条）",
  re(src.menu, /anchorEl && t instanceof Element && \(t === anchorEl \|\| t\.contains\(anchorEl\)\)\) closeMenu\(\)/));
ok("菜单: 不相干的容器自己滚**不收**（旧写法是 layer.contains → 一律收，就是 bug 本体）",
  !has(src.menu, "if (layer && e.target instanceof Node && layer.contains(e.target)) return;"));
ok("菜单: 这条踩坑经过写进了注释（后人别改回去）",
  has(src.menu, "smooth") && has(src.menu, "np") && has(src.menu, "revealCurrent"));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
