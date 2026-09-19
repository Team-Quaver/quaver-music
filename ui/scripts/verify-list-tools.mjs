// 歌曲列表工具条「本地搜索 + 排序」静态断言（歌单页 / 我喜欢 共用）
//
// 需求口径：排序 = 歌曲名正/倒、歌手正/倒、默认（歌单 = 加入时间 / 我喜欢 = 收藏顺序），
// **全部本地生效**（不回源），且**控件靠右**。
// 两条硬约束：
//   1. 原序不许就地 sort —— 「默认」必须原样返回，否则「加入时间 / 收藏顺序」这类信息永久丢失；
//   2. 过滤/排序路径里不许出现任何网络调用（`api(`）或路由跳转（`location.hash`）。
//
// 用法：node scripts/verify-list-tools.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const toolsSrc = read("src/components/ListTools.ts");
const views = read("src/views.ts");
const css = read("src/style.css");
const contrast = read("scripts/verify-highlight-contrast.mjs");

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
const code = noComments(toolsSrc);

const grab = (src, head) => src.match(new RegExp(head + "[\\s\\S]*?\\n\\}"))?.[0] ?? "";
const plView = grab(views, "async function playlistView");
const likedView = grab(views, "async function likedView");
ok("views: 抠到 playlistView / likedView", plView.length > 1200 && likedView.length > 600,
  `${plView.length} / ${likedView.length} 字符`);

// ============ 组件本体 ============
ok("tools: 独立组件 components/ListTools.ts，导出 songListTools",
  has(toolsSrc, "export function songListTools(") && has(toolsSrc, "export interface SongListTools"));
ok("tools: 原序用取值器 source()（删除后不必重新注册，引用不悬空）",
  has(toolsSrc, "source: () => any[]") && re(code, /const all = opts\.source\(\);/));
ok("tools: 对外给 el / visible / repaint / refreshCount",
  ["el,", "visible,", "repaint: paint", "refreshCount"].every((k) => has(toolsSrc, k)));

// ============ 全靠本地：组件里不该有任何网络/路由调用 ============
ok("本地: 组件里没有 api( 调用", !has(code, "api("));
ok("本地: 组件里没有 location.hash 跳转", !has(code, "location.hash"));
ok("本地: 组件不 import relay/api 的数据层（只借 songTitle/副标题格式化）",
  re(toolsSrc, /import \{ songSubtitle, songTitle \} from "\.\.\/lib\/api";/));

// ============ 排序 ============
ok("sort: 三个键 = default / name / singer",
  ["default", "name", "singer"].every((k) => toolsSrc.includes(`data-sort="${k}"`)));
ok("sort: 「默认」原样返回，不排序", has(code, "if (sortKey === \"default\") return list;"));
ok("sort: 排序作用在副本上（list.sort，且 list 来自 all.slice/filter；绝不 all.sort）",
  re(code, /const list = q \? all\.filter\(\(s\) => hayOf\(s\)\.includes\(q\)\) : all\.slice\(\);/)
  && re(code, /const sorted = list\.sort\(/) && !re(code, /all\.sort\(/));
ok("sort: 同一个键再点 = 正/倒对调，方向写成 ↑/↓",
  re(code, /if \(key === sortKey\) \{ if \(key !== "default"\) desc = !desc; \}/)
  && re(code, /dir\.textContent = on && sortKey !== "default" \? \(desc \? "↓" : "↑"\) : ""/));
ok("sort: 中文按拼音 + 数字感知",
  re(code, /new Intl\.Collator\("zh-Hans-CN", \{ numeric: true, sensitivity: "base" \}\)/));
ok("sort: 主键相同用曲名兜底（顺序稳定）",
  re(code, /COLLATOR\.compare\(key\(a\), key\(b\)\) \|\| COLLATOR\.compare\(nameOf\(a\), nameOf\(b\)\)/));
ok("sort: 多歌手整串参与（合唱不失真）",
  re(code, /const singerOf = \(s: any\) => \(s\.singer \?\? \[\]\)\.map\(\(x: any\) => x\?\.name \?\? ""\)\.join\(" \/ "\)/));

// ============ 搜索 ============
ok("search: 匹配曲名(含版本后缀)/主名/副标题/歌手/专辑",
  re(code, /songTitle\(s\), s\.name, songSubtitle\(s\), singerOf\(s\), s\.album\?\.name \?\? ""/));
ok("search: 字段间用分隔符，避免跨字段假命中", has(code, 'join("\\u0001")'));
ok("search: 大小写不敏感", has(code, ".toLowerCase()"));
ok("search: 输入即筛选 + ✕ 清空 + Esc 清空",
  re(code, /kwEl\.addEventListener\("input"/) && re(code, /clrEl\.addEventListener\("click"/) && has(code, 'e.key !== "Escape"'));
ok("search: 计数读数 = 命中 / 总数（只在筛选时显示）",
  re(code, /countEl\.textContent = kw\.trim\(\) \? `\$\{visible\(\)\.length\} \/ \$\{opts\.source\(\)\.length\} 首` : "";/));
ok("perf: 逐字符输入按 120ms 合并，立即画的场合先吃掉排队那次",
  has(code, "INPUT_DEBOUNCE_MS = 120")
  && re(code, /timer = window\.setTimeout\(paint, INPUT_DEBOUNCE_MS\)/)
  && re(code, /function paint\(\) \{\s*window\.clearTimeout\(timer\);/));
ok("空态: 组件只负责给列表，空态文案由调用方兜（两页都写了）",
  (views.match(/没有匹配的歌曲/g) ?? []).length === 2);
ok("空态: 回调带上 filtering，调用方能区分「搜索没命中」与「本来就没收藏」",
  has(toolsSrc, "paint: (list: any[], state: { filtering: boolean }) => void")
  && has(toolsSrc, "opts.paint(visible(), { filtering: !!kw.trim() })")
  && re(noComments(likedView), /st\.filtering \? "没有匹配的歌曲" : "还没有收藏的歌曲"/));

// ============ 版式：控件靠右 ============
const ltBlock = css.match(/\.list-tools \{([^}]*)\}/)?.[1] ?? "";
ok("css: .list-tools 靠右（justify-content: flex-end）", /justify-content:\s*flex-end/.test(ltBlock));
ok("css: 计数在左、控件被推到右缘（.lt-count 用 margin-right: auto）",
  /\.lt-count \{[^}]*margin-right:\s*auto/.test(css));
ok("DOM: 顺序 = 计数 → 搜索 → 排序（靠 auto margin 分居两端）",
  toolsSrc.indexOf('class="lt-count"') < toolsSrc.indexOf('class="sb-field lt-search"')
  && toolsSrc.indexOf('class="sb-field lt-search"') < toolsSrc.indexOf('class="lt-sort"'));
ok("css: 搜索框宽度钳制（不会铺满整行）", /\.list-tools \.lt-search \{[^}]*width:\s*clamp\(/.test(css));
ok("css: 搜索框复用顶带胶囊 .sb-field（不另造输入框样式）", has(toolsSrc, 'class="sb-field lt-search"'));

// ============ 两页都在用 ============
ok("views: 歌单页用组件（source = 服务端原序 all）",
  re(noComments(plView), /const tools = songListTools\(\{\s*source: \(\) => all,\s*hint: "在歌单内搜索"/));
ok("views: 我喜欢页也用组件（source = 收藏顺序 items）",
  re(noComments(likedView), /const tools = songListTools\(\{\s*source: \(\) => items,\s*hint: "在我喜欢内搜索"/));
ok("views: 两页都把工具条插在列表之前（工具条在上、行在下）",
  has(plView, "root.append(tools.el, rows)") && has(likedView, "root.append(tools.el, box)"));
ok("views: 两页都在首帧主动画一次", (views.match(/tools\.(repaint|refreshCount)\(\)/g) ?? []).length >= 2);
ok("我喜欢: 拉不到数据（未登录）时把工具条摘掉，不摆死控件",
  re(noComments(likedView), /if \(!cached\) \{\s*tools\.el\.remove\(\);/));
ok("我喜欢: 取消收藏同步从原序 items 摘掉（否则重排会把它放回来）",
  re(noComments(likedView), /const at = items\.indexOf\(song\);\s*if \(at >= 0\) items\.splice\(at, 1\);/));
ok("我喜欢: 标题计数取「全部」而不是筛后的可见数",
  re(noComments(likedView), /setCount\(Math\.max\(items\.length, player\.likedTotal\)\)/));
ok("歌单页: 从歌单删除同步从原序 all 摘掉", re(noComments(plView), /const at = all\.indexOf\(song\);\s*if \(at >= 0\) all\.splice\(at, 1\);/));
ok("两页: 双击播的是当前可见的那一列",
  re(noComments(plView), /onPlay: \(_s, i, all2\) => player\.playList\(all2, i\)/)
  && re(noComments(likedView), /onPlay: \(_s, i, all\) => player\.playList\(all, i\)/));

// ============ 改名彻底：旧的 pl-tools/.sg 系列不许有残留 ============
for (const dead of [".pl-tools", ".pl-search", ".pl-clr", ".pl-count", "sg-row", '"sg"', ".sg "]) {
  ok(`残留: 旧类名 ${dead.trim()} 已清干净`, !has(views, dead) && !has(css, dead));
}

// ============ 选择器 ↔ CSS 三边自洽 ============
for (const sel of [".list-tools", ".lt-search", ".lt-clr", ".lt-count", ".lt-sort", ".lt-sg", ".lt-sg.on", ".lt-sg .dir"]) {
  ok(`css: ${sel} 有定义`, has(css, sel));
}
// .lt-kw 是**只给 JS 取值的查询钩子**（样式统一由 .sb-field input 提供，复用顶带胶囊），
// 所以它不进「每个类都要有 CSS」的名单 —— 但反过来必须证明它确实没在 CSS 里另起样式。
const QUERY_ONLY = new Set(["lt-kw"]);
const used = new Set([...toolsSrc.matchAll(/"(lt-[a-z-]+|list-tools)"/g)].map((m) => m[1]));
for (const c of used) {
  if (QUERY_ONLY.has(c)) continue;
  ok(`css: DOM 里出现的 .${c} 有定义`, has(css, `.${c}`), `共 ${used.size} 个类`);
}
ok("css: 输入框不自带样式，统一继承 .sb-field input（.lt-kw 只是查询钩子）",
  has(css, ".sb-field input") && !has(css, ".lt-kw"));

// ============ 高亮态走既有口径 + 已在对比度脚本里登记 ============
const sg = css.match(/\.lt-sg\.on \{([^}]*)\}/)?.[1] ?? "";
ok("css: .lt-sg.on = 软洗底 + accent 系前景 + accent 描边（不铺实心 accent）",
  /background:[^;]*color-mix\([^;]*transparent/.test(sg)
  && /border-color:[^;]*var\(--cvg-accent/.test(sg)
  && /(?<![-\w])color:[^;]*var\(--ink\)/.test(sg));
ok("contrast: .lt-sg.on 已登记进 verify-highlight-contrast（新加 accent 掺色的高亮态都要跑它）",
  has(contrast, '".lt-sg.on"'));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
