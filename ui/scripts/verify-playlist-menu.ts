// 侧栏歌单右键菜单 + 双击播放 —— 源码级静态断言
//
// 与 verify-song-menu / verify-sidebar 同一思路：不起浏览器，检查
// **前端调用路径 ↔ sidecar 路由 ↔ 数据层** 三边对得上，以及几处
// 「界面上很难一眼看出来」的语义分叉（整批插队不打断当前曲、
// 删除歌单走 dirid 而不是 tid、拉歌单要分页拉全）。
// 删除歌单路由 Python（quaver-typhoeus）与 Go（typhoeus-go）两侧都要有，
// 打包态跑的是 Go 二进制 —— 缺一侧就是某一形态的 app 删不掉歌单。
//
// 用法：node scripts/verify-playlist-menu.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = {
  shell: read("src/shell.ts"),
  player: read("src/player.ts"),
  songMenu: read("src/components/SongMenu.ts"),
  plMenu: read("src/components/PlaylistMenu.ts"),
  playlists: read("src/lib/playlists.ts"),
  favs: read("src/lib/favs.ts"),
  app: readFileSync(join(root, "..", "vendor", "Typhoeus", "quaver_server", "app.py"), "utf8"),
  appGo: readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "handlers_content.go"), "utf8")
    + readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "app.go"), "utf8"),
  pkg: read("package.json"),
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

// ============ 1. 菜单结构与标签 ============
for (const label of ["立即播放", "插队播放", "删除歌单", "取消收藏"]) {
  ok(`菜单项「${label}」存在`, has(src.plMenu, `label: "${label}"`));
}
ok("菜单: 删除/取消收藏按歌单归属分叉（自建可删、收藏可取消）",
  re(src.plMenu, /if \(opts\.kind === "created"\) \{[\s\S]{0,400}删除歌单[\s\S]{0,600}\} else \{[\s\S]{0,400}取消收藏/));
ok("菜单: 删除是危险项、取消收藏不是（后者可逆，重进歌单页可再收藏）",
  re(src.plMenu, /label: "删除歌单",\s*danger: true/) && !re(src.plMenu, /label: "取消收藏",\s*danger: true/));
ok("菜单: 复用 SongMenu 面板机制（不另起一层）",
  has(src.plMenu, "openMenuAt(") && has(src.songMenu, "export function openMenuAt"));
ok("SongMenu: 通用入口先关旧菜单再挂新面板（同屏只留一层）",
  re(src.songMenu, /export function openMenuAt\(x: number, y: number, items: MenuItem\[\], anchor\?: HTMLElement\) \{\s*closeMenu\(\);[\s\S]{0,200}openPanel\(items, 0, \{ x, y \}\);/));
ok("SongMenu: MenuItem 类型已导出（歌单菜单复用同一套项定义）", has(src.songMenu, "export interface MenuItem"));

// ============ 2. 右键挂载与双击播放（shell 侧） ============
ok("shell: 右键 preventDefault（不弹系统菜单）+ stopPropagation",
  re(src.shell, /addEventListener\("contextmenu"[\s\S]{0,120}preventDefault\(\)[\s\S]{0,120}stopPropagation\(\)/));
ok("shell: 右键把条目元素作为锚点传下去（滚动收起判据要用它）",
  re(src.shell, /openPlaylistMenu\(e\.clientX, e\.clientY, x, menu, a\)/));
ok("shell: 双击直接播放该歌单", re(src.shell, /addEventListener\("dblclick", \(\) => \{ void playPlaylistNow\(x\); \}\)/));
ok("shell: 菜单只挂自建/收藏两团（插件歌单组不挂）",
  re(src.shell, /group\("我创建的歌单", sidebarCreated, \(\) => "", \{[\s\S]{0,200}kind: "created"/)
  && re(src.shell, /group\("收藏的歌单", favs \?\? \[\], \(x\) => \(x\.nickname \? `\$\{x\.nickname\} 创建` : ""\), \{ kind: "fav" \}\)/));
ok("shell: 自建歌单删除后从侧栏数据摘除并重画",
  re(src.shell, /kind: "created",\s*onDeleted: \(x\) => \{[\s\S]{0,160}sidebarCreated\.splice\(at, 1\);[\s\S]{0,80}renderSidebarPlaylists\(box\);/));
ok("shell: 收藏歌单取消后不用回调（favs 订阅已负责重画）",
  !re(src.shell, /kind: "fav"[\s\S]{0,120}onDeleted/));

// ============ 3. 播放动作：立即播放 / 整批插队 ============
ok("plMenu: 立即播放 = 整队列替换从第一首起播",
  has(src.plMenu, "player.playList(songs, 0)") && has(src.plMenu, "export async function playPlaylistNow"));
ok("plMenu: 插队播放走 enqueueNextMany（整批排到当前曲之后）",
  has(src.plMenu, "player.enqueueNextMany(songs)") && has(src.plMenu, "export async function playPlaylistNext"));
ok("plMenu: 拉歌单按页拉全（页尽即止，大歌单不截断在 100 首）",
  re(src.plMenu, /for \(let page = 1; ; page\+\+\) \{[\s\S]{0,200}\/songlist\/\$\{id\}\/detail\?page=\$\{page\}&num=100[\s\S]{0,120}hasmore/));
ok("plMenu: 空歌单不静默（toast 提示，不把空列表灌进队列）",
  re(src.plMenu, /if \(!songs\.length\) \{ toast\("歌单为空或不可见", "err"\); return; \}/));
// 双击与菜单「立即播放」必须是同一条路：否则两处行为迟早分叉
ok("plMenu: 双击与菜单共用 playPlaylistNow",
  re(src.shell, /playPlaylistNow\(x\)/) && re(src.plMenu, /run: \(\) => playPlaylistNow\(pl\)/));

const enqBody = (src.player.match(/enqueueNextMany\(songs: Song\[\]\) \{([\s\S]*?)\n  \}/) ?? [])[1] ?? "";
ok("player: 整批插队排到当前曲之后（保序插入）",
  /this\.queue\.splice\(this\.index \+ 1, 0, \.\.\.list\);/.test(noComments(enqBody)));
ok("player: 整批插队不打断当前曲（不动指针、不起播）",
  !/this\.index \+=/.test(noComments(enqBody)) && !/startCurrent/.test(noComments(enqBody)));
ok("player: 队列空时整批插队退化成整列起播（与单曲插队同一分叉）",
  /if \(this\.index < 0 \|\| !this\.queue\.length\) \{ this\.playList\(list, 0\); return; \}/.test(noComments(enqBody)));
ok("player: 整批插队 bump queueVersion（QueuePanel 靠它去重重画）",
  /this\.queueVersion\+\+/.test(noComments(enqBody)));

// ============ 4. 删除歌单：dirid 语义 + 上游路由 ============
ok("plMenu: 删除前确认（不可恢复操作，与设置页 reset 同一交互）",
  re(src.plMenu, /if \(!confirm\(`删除歌单「\$\{pl\.title\}」/));
ok("playlists: deleteSonglist 走 DELETE /songlist/{dirid}（**没有** /songs 后缀，别和按歌移除混了）",
  re(src.playlists, /await api<\{ ok: boolean \}>\(`\/songlist\/\$\{target\.dirid\}`, \{ method: "DELETE" \}\)/));
ok("playlists: 删除走 dirid 不是 tid（dirid ≠ disstid，见 playlists 文件头约定 1）",
  re(src.playlists, /if \(!Number\(target\?\.dirid\)\) throw new Error\("缺少歌单 dirid/));
ok("playlists: 删除成功后摘掉本地缓存（侧栏另有一份，走 onDeleted 回调）",
  re(src.playlists, /assertAccepted\(r, "删除歌单"\);[\s\S]{0,120}items = items\.filter\(\(x\) => x\.dirid !== Number\(target\.dirid\)\);/));
ok("plMenu: 删除成功才回调 onDeleted（失败时侧栏条目不能消失）",
  re(src.plMenu, /await deleteSonglist\(\{ dirid: pl\.dirid!, title: pl\.title \}\);\s*opts\.onDeleted\?\.\(pl\);/));
ok("plMenu: 缺 dirid 时删除项禁用（写接口的唯一定位缺失，点了也是空手）",
  re(src.plMenu, /disabled: !Number\(pl\.dirid\)/));
ok("app.py: DELETE /songlist/{dirid} -> songlist.delete（PlaylistBaseWrite DelPlaylist）",
  re(src.app, /@app\.delete\("\/songlist\/\{dirid\}"\)[\s\S]{0,420}session\.client\.songlist\.delete\(dirid\)/));
ok("app.py: 删除歌单要求登录态", re(src.app, /songlist_delete[\s\S]{0,460}need_login=True/));

// ============ 4b. Go sidecar 同款路由（打包态跑 Go 二进制，两侧必须对齐） ============
ok("go: DELETE /songlist/{dirid} 已注册", re(src.appGo, /mux\.HandleFunc\("DELETE \/songlist\/\{dirid\}", a\.handleSonglistDelete\)/));
ok("go: handler 走 songlist.Delete（模块侧 PlaylistBaseWrite DelPlaylist）",
  re(src.appGo, /handleSonglistDelete[\s\S]{0,600}a\.songlist\.Delete\(dirid\)/));
ok("go: 删除要求登录态（call 的 needLogin 守卫）",
  re(src.appGo, /handleSonglistDelete[\s\S]{0,400}a\.call\(true, func\(\) \(json\.RawMessage, error\) \{ return a\.songlist\.Delete\(dirid\) \}\)/));
ok("go: retCode 兜底核验（业务码非零已在 ParseCGIData 报错，这里回 {ok} 信封）",
  re(src.appGo, /handleSonglistDelete[\s\S]{0,600}retCode[\s\S]{0,200}writeOK\(w, map\[string\]any\{"ok": resp\.RetCode == 0\}\)/));

// ============ 5. 取消收藏：走 favs 单一真相 ============
ok("plMenu: 取消收藏走 toggleFavSonglist（乐观更新 + 失败回滚，与歌单页红心同一写入口）",
  re(src.plMenu, /await toggleFavSonglist\(\{ id: pl\.id, title: pl\.title \}\)/));
ok("favs: 取消收藏按 id 匹配（收藏歌单的 id 是 disstid/pid，不是 dirid）",
  has(src.favs, "export async function toggleFavSonglist") && has(src.favs, `method: had ? "DELETE" : "POST"`));

// ============ 6. 歌单页同步渲染 ============
// 曾经只把订阅挂在按钮的点击期间：侧栏右键「取消收藏」后歌单页按钮停在「已收藏」，
// 下一次点击按旧态取反 = 做出与显示相反的动作。订阅必须挂按钮一生，退订交给视图 cleanup。
const views = read("src/views.ts");
ok("views: 收藏按钮一生期订阅 favs（别处的收藏变更同帧反映到按钮）",
  re(views, /const off = onFavSonglistsChange\(\(\) => \{ if \(!btn\.dataset\.fail\) paint\(\); \}\);\s*cleanups\.push\(off\);/));
ok("views: 点击期间不再临时订阅（旧写法 off() 在 finally 里，点完就瞎）",
  !re(noComments(views), /btn\.onclick = async \(\) => \{\s*const off = onFavSonglistsChange/));
ok("views: playlistView 把退订登记交给 renderRoute（路由切换/打断丢弃不留死监听）",
  re(views, /actions: await favSonglistButton\(\{[\s\S]{0,300}\}, cleanups\)\.catch\(\(\) => null\),/));
ok("views: 两个带订阅的出口都返回 cleanup（空歌单早退 + 正常结束）",
  (views.match(/return \(\) => cleanups\.forEach\(\(f\) => f\(\)\);/g) ?? []).length >= 2);
ok("shell: 删除时正开着该歌单详情页则立刻重渲染（不留「还在」的缓存假象）",
  re(src.shell, /onDeleted: \(x\) => \{[\s\S]{0,300}currentRoute\(\)[\s\S]{0,200}void renderRoute\(\)/));

// ============ 7. 接线：verify 脚本进 static 链 ============
ok("package.json: verify:playlist-menu 已接线",
  has(src.pkg, `"verify:playlist-menu": "node scripts/verify-playlist-menu.ts"`)
  && has(src.pkg, "&& node scripts/verify-playlist-menu.ts"));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
