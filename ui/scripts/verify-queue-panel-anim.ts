// 队列面板（播放列表）展开动画的静态断言
//
// 修的是一个具体缺陷：**首次展开没有动画**。根因 —— 早期实现「打开时才按宽度定形态」，
// 于是首次展开在同一帧里既换父节点（body → .content-body）又加 .open，
// 浏览器把「插入新节点 + 类变更」合并成一次样式重算 → transition 根本不启动。
// 之后的展开因为不再换父节点，就正常了 —— 典型的「第一次不对，第二次对」。
//
// 修法：形态（dock/float）与开合（.open）解耦 —— 形态只看宽度、**关闭时也定好**；
// 万一真的换了父节点，.open 推到下一帧再加（新节点需要一帧「关闭态」垫底，过渡才有可比）。
//
// 用法：node scripts/verify-queue-panel-anim.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const qp = read("src/components/QueuePanel.ts");
const css = read("src/style.css");

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
const code = noComments(qp);

// ============ JS 接线 ============
ok("形态与开合解耦：applyLayout() 只管 dock/float，applyOpen() 只管 .open",
  re(code, /function applyLayout\(\): boolean \{/) && re(code, /function applyOpen\(\) \{/));
ok("applyLayout 返回「是否换了父节点」（换过才需要推迟 .open）",
  re(code, /want\.append\((?:qpResizer, )?el\);[\s\S]{0,60}return true;/) && re(code, /return false;/));
ok("换过父节点：先摘掉 .open，再 requestAnimationFrame 补上",
  re(code, /if \(applyLayout\(\)\) \{\s*el\.classList\.remove\("open"\);\s*requestAnimationFrame\(applyOpen\);/));
ok("启动时就定形态（首展不再换父节点 = 这次修的核心）",
  re(code, /const ro = new ResizeObserver\(syncMount\);[\s\S]{0,200}syncMount\(\);/));
ok("构造时节点还没进 DOM（壳层随后才 append）：等一帧再补一次定形态",
  re(code, /syncMount\(\);\s*\/{0,2}[^\n]*\n\s*requestAnimationFrame\(syncMount\);/)
  || re(code, /syncMount\(\);\s*requestAnimationFrame\(syncMount\);/));
ok("ResizeObserver 无条件同步：**关闭时也跟宽度走**（否则尺寸变过后的首次展开又会边搬边开）",
  re(code, /new ResizeObserver\(syncMount\)/) && !re(code, /ResizeObserver\(\(\) => \{ if \(player\.queueOpen\)/));
ok("正在播放全屏页仍强制浮窗（那条实测结论不许被解耦改掉）",
  re(code, /const dock = !\(npEl\(\) && player\.expanded\) && dockable\(\);/));
ok("开合仍由播放条队列按钮驱动（.open 只跟 player.queueOpen）",
  re(code, /const open = player\.queueOpen;\s*el\.classList\.toggle\("open", open\)/));
ok("关闭态 inert：常驻 DOM 但不能被 Tab 聚焦（聚焦会把它滚进视野 → 祖先被程序化滚动）",
  re(code, /el\.toggleAttribute\("inert", !open\)/));

// ============ CSS：关闭态必须是「可过渡的隐藏」，不能用 display:none ============
// 规则块一律**从行首**取：`.queue-panel.float {` 在文件里还有一条带前缀的兄弟规则
// （body[data-control-bar="floating"] .queue-panel.float，管浮窗底距），不锚行首会先命中它。
const blockOf = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel} \\{([^}]*)\\}`))?.[1] ?? "";
const floatBlock = blockOf("\\.queue-panel\\.float");
const floatOpen = blockOf("\\.queue-panel\\.float\\.open");
const dockBlock = blockOf("\\.queue-panel\\.dock");
const dockClosed = blockOf("\\.queue-panel\\.dock:not\\(\\.open\\)");
ok("css: 浮窗态有 transition（opacity + transform）",
  /transition:[^;]*opacity/.test(floatBlock) && /transition:[^;]*transform/.test(floatBlock));
ok("css: 浮窗关闭态 = 透明 + 缩放位移（起始帧可过渡）",
  /opacity:\s*0/.test(floatBlock) && /transform:\s*scale\(\.9\)/.test(floatBlock));
ok("css: 浮窗打开态落在终态（opacity 1 / transform none）",
  /opacity:\s*1/.test(floatOpen) && /transform:\s*none/.test(floatOpen));
ok("css: 停靠态 transition 覆盖 flex-basis/width/opacity/transform（展开是卷出而不是闪现）",
  ["flex-basis", "width", "opacity", "transform"].every((k) => new RegExp(`transition:[^;]*${k}`).test(dockBlock)));
ok("css: 停靠关闭态收成 0 宽 + 淡出（收/展都可过渡）",
  /flex-basis:\s*0/.test(dockClosed) && /width:\s*0/.test(dockClosed) && /opacity:\s*0/.test(dockClosed));
ok("css: 队列面板任何一态都不用 display:none（用了就没有过渡）",
  !/\.queue-panel[^{]*\{[^}]*display:\s*none/.test(css));
ok("css: 停靠关闭态不占位（启动即停靠也不会挤到 route）",
  /flex-basis:\s*0/.test(dockClosed) && /width:\s*0/.test(dockClosed) && /min-width:\s*300px/.test(css));

// ============ 停靠态与吸顶底（.content::before）的边界 ============
// 底片是铺满整个内容卡的渐变（盖住 route 里滚到顶带底下的内容）。面板停靠时与 route
// **并排常驻**、自己不滚，全宽底片就把它当头两行一起压掉：暗色下吸顶后标题直接消失
// （实测面板头矩形内亮像素归零），亮色下整体泛白。修法 = 停靠且展开时用 clip-path 把
// 底片右缘收到面板左缘 —— 但**只收顶带以下**：顶带不滚、也没有自己的底色
// （verify-layout-responsive 钉死「顶带无底」），连续性全靠这层，右缘收进去会在
// CSD 按钮簇/搜索框那行切出一条竖向色阶缝。收边量取面板自身宽度 --qp-w。
const veilBase = blockOf("\\.content::before");
const veilClip = css.match(/\.content:has\(> \.content-body > \.queue-panel\.dock\.open\)::before \{([^}]*)\}/)?.[1] ?? "";
ok("js: --qp-w 写在 .content（面板与吸顶底读同一份），不再写在面板自己身上",
  re(code, /contentEl\(\)\?\.style\.setProperty\("--qp-w"/) && !re(code, /el\.style\.setProperty\("--qp-w"/));
ok("css: 顶带高度是单一事实源 --top-band-h（.content-top 与吸顶底收口共用）",
  /--top-band-h:\s*42px/.test(css) && /min-height:\s*var\(--top-band-h\)/.test(css));
ok("css: 停靠展开时吸顶底右缘收到面板左缘（内缩量 = --qp-w，折点在顶带下缘）",
  /clip-path:\s*polygon\([\s\S]*?calc\(100% - var\(--qp-w, 300px\)\) var\(--top-band-h, 42px\)/.test(veilClip));
ok("css: 顶带段保持全宽（第三顶点仍是 100%，收口从顶带下缘才开始）",
  /clip-path:\s*polygon\(\s*0 0,\s*100% 0,\s*100% var\(--top-band-h, 42px\)/.test(veilClip));
ok("css: 基础态是零宽凹口（与展开态同 6 顶点，收起/浮窗时底片照旧铺满）",
  /clip-path:\s*polygon\(\s*0 0,\s*100% 0,\s*100% var\(--top-band-h, 42px\),\s*100% var\(--top-band-h, 42px\),\s*100% 100%,\s*0 100%\)/.test(veilBase));
ok("css: clip-path 在 ::before 的基础 transition 里（收起方向也要跟着面板卷回）",
  /transition:[^;]*clip-path[^;]*;/.test(veilBase));
ok("css: 拖面板宽度时停掉底片过渡（否则边缘拖在指针后面）",
  /\.content:has\(> \.content-body > \.queue-panel\.resizing\)::before \{\s*transition:\s*none/.test(css));

// ============ 吸顶变色同步：面板列自己补画底片段 ============
// 底片被 clip 收走的那段若没人补，吸顶实底一亮起来就只有 route 列变色、面板列原地不动。
// 面板列用**同一组变量**（--veil-gentle / --stuck-cover / --stuck-h）与同一定位把这段画回来，
// 两列逐像素同色；面板头文字画在自己背景之上，不会被实底洗掉。
ok("css: 顶带渐变是单一事实源 --veil-gentle（底片与面板列共用）",
  /--veil-gentle:\s*linear-gradient/.test(css)
  && /background:\s*var\(--veil-gentle\)/.test(blockOf("\\.content::before"))
  && /background-image:\s*var\(--veil-gentle\)/.test(dockBlock));
const dockBlockFull = dockBlock;
ok("css: 面板列底片段定位/尺寸与底片一致（上移一个顶带、高 = max(112, 46+--stuck-h)）",
  /background-position:\s*0 calc\(-1 \* var\(--top-band-h, 42px\)\)/.test(dockBlockFull)
  && /background-size:\s*100% max\(112px, calc\(46px \+ var\(--stuck-h, 0px\)\)\)/.test(dockBlockFull));
ok("css: 吸顶实底同步到面板列（三层 --stuck-cover，与 .content.has-stuck::before 同构）",
  /\.content\.has-stuck \.queue-panel\.dock \{\s*background-image:\s*var\(--stuck-cover\), var\(--stuck-cover\), var\(--stuck-cover\);/.test(css));

// ============ 祖先滚动卫生：绝不用 scrollIntoView ============
// 它会把**所有**可滚祖先的 scrollport 一起滚，而 `overflow:hidden` 的盒子程序化照样能滚
// （.content 是 position:relative + overflow:hidden，正是 .route 的祖先）——
// 面板停靠后行落在内容区右缘之外，scrollIntoView 就会给 .content 设上 scrollLeft，
// 于是切一次歌整个路由视图横移 = 「ContentView 错位」。
import { readdirSync, statSync } from "node:fs";
const srcFiles = (() => {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
    }
  };
  walk(join(root, "src"));
  return out;
})();
const offenders = srcFiles.filter((f) => noComments(readFileSync(f, "utf8")).includes("scrollIntoView"));
ok("祖先滚动卫生: 全 src/ 不出现 scrollIntoView（它会连锁滚动祖先 scrollport）",
  offenders.length === 0, offenders.map((f) => f.replace(root + "/", "")).join(", ") || `扫了 ${srcFiles.length} 个文件`);
ok("当前曲定位：revealCurrent() 只改 .qp-list 自己的 scrollTop",
  re(code, /function revealCurrent\(\) \{[\s\S]{0,500}list\.scrollTop/) && !re(code, /scrollIntoView/));
ok("重建列表后调用 revealCurrent（不再依赖祖先滚动）",
  re(code, /player\.queue\.forEach\(\(q, i\) => list\.append\(rowOf\(q, i\)\)\);\s*revealCurrent\(\);/));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
