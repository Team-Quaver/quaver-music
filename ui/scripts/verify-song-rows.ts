// 回归护栏：歌曲行「容器级委托 + 分域高亮」的结构不变量。
//
// 背景（性能/内存优化的两条前提，破了就会静默出错而不是报错）：
//   ① 行上的交互监听改成挂在列表容器上（每容器一套）—— 前提是**行本身除 contextmenu 外不再挂监听**，
//      且 click/dblclick 仍由容器委托命中；右键菜单按 bindSongMenu 的契约继续挂在行上。
//   ② player.markActive 只在「已登记的容器」里找当前曲，清旧高亮靠记账的元素 —— 前提是
//      **全仓的 data-songkey 行都出自 renderSongRows（那里负责登记容器）**，且只有 markActive
//      会给 .row/.card 打 .playing。将来谁在别处自拼歌曲行，必须同样登记，否则那批行永远不高亮。
// 交互行为的真机验证见 scripts/probe-song-rows.ts（需 dev server）。
// 用法：node scripts/verify-song-rows.ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const songs = read("src/lib/songs.ts");
const player = read("src/player.ts");

let fails = 0;
let checks = 0;

const ok = (name, cond, note = "") => {
  checks++;

  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

ok("songs: 委托监听挂在容器上（click + dblclick）",
  /box\.addEventListener\("click"/.test(songs) && /box\.addEventListener\("dblclick"/.test(songs));

ok("songs: 行内不再逐行挂监听（只剩右键菜单 bindSongMenu）",
  !/row\.addEventListener\(/.test(songs), "每行 4~5 个监听闭包 × 整份 songs 引用是大列表的常驻开销");

ok("songs: 行→歌曲用 WeakMap（重复 mid 不串台，行删了可回收）",
  /new WeakMap<HTMLElement, any>\(\)/.test(songs) && /rowSong\.set\(row, s\)/.test(songs));

ok("songs: 每个容器只登记一次（重画不攒弱引用）",
  /if \(!state\.scoped\) \{/.test(songs) && /player\.registerRowScope\(box\)/.test(songs));

ok("player: markActive 走已登记容器，不再整篇扫",
  /mountedRowScopes\(\)/.test(player) && /private rowScopes = new Set<WeakRef<HTMLElement>>\(\)/.test(player));

ok("player: 清旧高亮只动记账元素，且记账用弱引用",
  /private activeEls = new Set<WeakRef<HTMLElement>>\(\)/.test(player)
  && /for \(const ref of this\.activeEls\) ref\.deref\(\)\?\.classList\.remove\("playing"\)/.test(player));

ok("player: 未登记容器时回落全篇扫（插件自绘视图不至于没高亮）",
  /document\.querySelectorAll\("\.card\.playing,\.row\.playing"\)/.test(player));

// —— 不变量：data-songkey 的行只可能由 renderSongRows 造，.playing 只可能由 markActive 打 ——
const srcFiles = [];

const walk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, name.name);

    if (name.isDirectory()) walk(p);
    else if (name.name.endsWith(".ts")) srcFiles.push(p);
  }
};

walk(join(root, "src"));

// 只认「造行」的写法：给 dataset 赋值、setAttribute，或在 HTML 串里写 <div class="row" ... data-songkey=。
// 各种 querySelector(".row[data-songkey=...]") 是读，不算造行，不能误报。
const createsRow = /dataset\.songkey\s*=(?!=)|setAttribute\(\s*"data-songkey"|<div class="row"[^>]*data-songkey=/;
const songkeyWriters = srcFiles.filter((f) => createsRow.test(readFileSync(f, "utf8")));

ok("全仓只有 songs.ts 造 data-songkey 行（分域高亮的前提）",
  songkeyWriters.length === 1 && songkeyWriters[0].endsWith("lib/songs.ts"),
  songkeyWriters.map((f) => f.replace(root + "/", "")).join(" "));

const playingAdders = srcFiles.filter((f) => {
  const t = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  return /classList\.add\("playing"\)/.test(t);
});

ok("全仓只有 player.markActive 给行/卡打 .playing（记账即全集的前提）",
  playingAdders.length === 1 && playingAdders[0].endsWith("player.ts"),
  playingAdders.map((f) => f.replace(root + "/", "")).join(" "));

// 高亮的两个触发口不能少：路由渲染完（shell 兜底）+ 列表重画后（带搜索/排序的那些页自己调）。
ok("shell: 每次路由渲染后补一次 markActive（进页面即点亮当前曲）",
  read("src/shell.ts").includes("player.markActive()"));

const repaintViews = readdirSync(join(root, "src/views"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => read(`src/views/${f}`));

ok("views: 用工具条重画列表的页面都跟着调 markActive",
  repaintViews.filter((v) => /songListTools\(/.test(v))
    .every((v) => v.includes("player.markActive()")),
  "搜索/排序重画后行换了位置，不补一次就会丢高亮");

console.log(fails ? `\n${checks - fails}/${checks} passed — ${fails} FAILED` : `\n${checks}/${checks} passed`);
process.exit(fails ? 1 : 0);
