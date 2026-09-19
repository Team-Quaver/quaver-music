// 「每日30首」接入真接口的静态断言
//
// 背景：这页原先**是假的** —— 拿「我喜欢」按日期种子随机凑 30 首（官方接口未开放时的占位）。
// 实测真相：每日30首 = **系统虚拟歌单，dirid 固定 202**（与「我喜欢」201 同一族），
// 每天由服务端重生成 30 首，disstid 每天都变（本例 7083466040）；created-songlists 里不列它，
// 首页 feed 的卡片虽然带 id/dirid，但按 dirid 取才稳。读法与普通歌单详情一致（CgiGetDiss 传 disstid=dirid=202）。
//
// 用法：node scripts/verify-daily.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const views = read("src/views.ts");
const appPy = readFileSync(join(root, "..", "vendor", "Typhoeus", "quaver_server", "app.py"), "utf8");

let fails = 0;
let checks = 0;
const ok = (name, cond, note = "") => {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};
const has = (h, n) => h.includes(n);
const re = (h, rx) => rx.test(h);
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const view = views.match(/async function dailyView[\s\S]*?\n\}/)?.[0] ?? "";
const code = noComments(view);
ok("views: 抠到 dailyView 源码", view.length > 300, `${view.length} 字符`);

// ============ 后端：dirid 202 的虚拟歌单 ============
ok("app.py: 有 GET /recommend/daily", re(appPy, /@app\.get\("\/recommend\/daily"\)/));
ok("app.py: 用 DAILY_DIRID = 202（与「我喜欢」201 同族的系统 dirid）",
  re(appPy, /DAILY_DIRID = 202/) && re(appPy, /get_detail\(\s*DAILY_DIRID, dirid=DAILY_DIRID/));
ok("app.py: 注释写清「disstid 每天变、按 dirid 取才稳」（免得后人又去追那个 id）",
  has(appPy, "每天") && has(appPy, "dirid"));

// ============ 前端：接真接口，且假实现彻底删干净 ============
ok("views: 走 /recommend/daily（路径与后端一致，写错就是 404）",
  re(code, /api\("\/recommend\/daily\?page=1&num=100"\)/) && has(appPy, '"/recommend/daily"'));
ok("views: 30 首一把拿全（num=100，不翻页）", re(code, /num=100/));
ok("假实现已删干净：不再用「我喜欢」凑数 / 不再有日期种子随机",
  !has(code, "loadLiked") && !has(code, "mulberry32") && !has(code, "2654435761")
  && !has(noComments(views), "接口未开放"));
ok("输出: 行渲染带专辑列 + 双击播整列（与歌单页同一套语义）",
  re(code, /renderSongRows\(box, songs, \{ showAlbum: true, onPlay: \(s, i, all\) => player\.playList\(all, i\) \}\)/));
ok("说明文案: 服务端那句编辑语（info.desc）覆盖占位说明",
  re(code, /if \(note && d\?\.info\?\.desc\) note\.textContent = d\.info\.desc;/)
  && has(view, "listPage(root"));
ok("空态: 列表为空给可读提示（没生成 / 未登录），不是白屏",
  re(code, /if \(!songs\.length\) \{[\s\S]{0,160}今天的 30 首还没生成/));
ok("失败态: 报错文案带「需要先登录」引导", has(code, "需要先登录"));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
