// 播放列表「拖拽排序」：纯逻辑跑真单测，接线/样式跑静态断言
//
// 修的是「拖不动」，两个根因都在这里钉死：
//  ① 监听挂在把手上 + setPointerCapture：换位要 insertBefore，元素被摘出来再插回去的那一瞬间
//     浏览器会丢掉捕获；捕获一丢，把手上的 pointermove 再也收不到（指针早不在把手上了）
//     → 拖到一半僵死。现在一律挂 window，事件怎么重定向都会冒上来。
//  ② 拿 getBoundingClientRect() 减 dy 反推文档流位置：.qp-item 自带 transform 过渡，
//     rect 是**动画中间值**，残差被下一帧再算一遍 → 行越拖越飘最后飞出指针。
//     现在量位置前先清 transform，且 .dragging 的 transition 不许带 transform。
//
// 用法：node scripts/verify-queue-drag.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let fails = 0;
let checks = 0;
const ok = (name, cond, note = "") => {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ===================== 真单测：拖拽的纯逻辑 =====================
// Node ≥22.18 默认开启类型剥离，零依赖的 .ts 可以直接 import —— 这段算术就该这么测，
// 对着源码写正则等于没测（下面那段静态断言只用来钉「接线不许被改坏」）。
const { dropSlot, edgeSpeed } = await import("../src/lib/reorder.ts");

const rows = (tops, h = 40) => tops.map((top) => ({ top, height: h })); // A@0 B@40 C@80
const three = rows([0, 40, 80]);

eq("落点：指针在全体之上 → 槽位 0（拖到队首）", dropSlot(three, 0, -10), 0);
eq("落点：指针还在自己那格 → 不动", dropSlot(three, 0, 20), 0);
eq("落点：压过 B 中线 → 槽位 1（越过一行）", dropSlot(three, 0, 60), 1);
eq("落点：压过 C 中线 → 槽位 2（拖到队尾）", dropSlot(three, 0, 100), 2);
eq("落点：指针远在列表之下 → 仍是队尾（不会越界）", dropSlot(three, 0, 9999), 2);
// self=-1：被拖行还不在 rows 里（从别处拖进来），三行全算数 → 指针压过 A、B 中线 = 槽位 2
eq("落点：self=-1（行不在 rows 里）时三行全算，压过 A/B 中线 → 槽位 2", dropSlot(three, -1, 60), 2);
eq("落点：单行列表恒为 0", dropSlot(rows([0]), 0, 500), 0);

// 抗抖动：越过一行之后重新量一次，结果必须和它现在的位置一致（否则会来回跳）
{
  const moved = rows([0, 40, 80]); // 换位后 DOM：B@0 A@40 C@80 —— 被拖的是 A（下标 1）
  eq("抗抖动：A 越过 B 后停在槽位 1，再量一次仍是 1（不抖）", dropSlot(moved, 1, 60), 1);
  const moved2 = rows([0, 40, 80]); // 再越一次：B@0 C@40 A@80 —— A 下标 2
  eq("抗抖动：A 越过 C 后停在槽位 2，再量一次仍是 2", dropSlot(moved2, 2, 100), 2);
}

eq("贴边滚动：指针在中间 → 不滚", edgeSpeed(50, 0, 100), 0);
eq("贴边滚动：贴上感应带 → 慢速上滚", edgeSpeed(10, 0, 100), -9);
eq("贴边滚动：越出上边界 → 封顶 -14", edgeSpeed(0, 0, 100), -14);
eq("贴边滚动：贴上感应带 → 慢速下滚", edgeSpeed(90, 0, 100), 9);
eq("贴边滚动：越出下边界越远也不超速（封顶 14）", edgeSpeed(500, 0, 100), 14);
eq("贴边滚动：感应带方向正确（上负下正）", Math.sign(edgeSpeed(5, 0, 100)) + Math.sign(edgeSpeed(95, 0, 100)), 0);
eq("贴边滚动：列表矮到放不下两条感应带 → 一律不滚", edgeSpeed(10, 0, 40), 0);

// ===================== 静态断言：接线不许被改回去 =====================
const qp = read("src/components/QueuePanel.ts");
const css = read("src/style.css");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const code = noComments(qp);

ok("纯逻辑抽到 lib/reorder.ts（零依赖、可脱离 DOM 单测）",
  /from "\.\.\/lib\/reorder"/.test(qp) && /export function dropSlot/.test(read("src/lib/reorder.ts")));

ok("拖拽监听挂 window（换位会丢捕获，挂把手会让拖拽半路僵死）",
  /window\.addEventListener\("pointermove"/.test(code) && /window\.addEventListener\("pointerup"/.test(code));
ok("捕获仍要设（指针滑出面板/窗口时事件回得来），但不再是唯一依赖",
  /setPointerCapture\(pid\)/.test(code) && /window\.addEventListener\("pointermove"/.test(code));
ok("量文档流位置前先清 transform（rect 是动画中间值，反推会把残差再算一遍）",
  /row\.style\.transform = "";\s*const flowTop = row\.getBoundingClientRect\(\)\.top;/.test(code));
ok("落点用 dropSlot（中线判据），不再自己遍历邻行猜位置",
  /const slot = dropSlot\(/.test(code) && !/swapUnder/.test(code));
ok("拖拽中绝不重建列表（整表重画会把正在拖的行连监听一起换掉）",
  /if \(dragRow\) \{ pendingRebuild = true; return; \}/.test(code));
ok("提交前先撤 dragRow（否则重建被自己挡住，队列顺序提交不进去）",
  /dragRow = null;[\s\S]{0,400}player\.moveInQueue\(fromIdx, to\)/.test(code));
ok("拖拽期间队列被改过 → 本次排序作废（DOM 下标已不对应，硬提交会挪错歌）",
  /to !== fromIdx && !pendingRebuild/.test(code));
ok("整行可拖（把手只是显式入口）：监听挂在 row 上",
  /row\.addEventListener\("pointerdown"/.test(code) && !/grip\.addEventListener\("pointerdown"/.test(code));
ok("删除钮不参与拖拽", /closest\("\.qi-del"\)\) return/.test(code));
ok("位移阈值：点了不走不算拖（否则单击切歌会被吃掉）", /Math\.abs\(ev\.clientY - startY\) < DRAG_THRESHOLD/.test(code));
ok("Esc 取消：先挪回原位再收尾", /ev\.key !== "Escape"\) return;[\s\S]{0,520}finish\(false\)/.test(code));
ok("pointercancel 走取消（手势被浏览器接管时不提交）", /const onCancel = \(ev[\s\S]{0,120}finish\(false\)/.test(code));

// —— 挤压动画（拖拽时其他内容被挤开）——
ok("邻行让位走 FLIP：换位前量一次、换位后量一次",
  /const before = others\.map\(\(el\) => el\.getBoundingClientRect\(\)\.top\);\s*mutate\(\);/.test(code));
ok("让位用 WAAPI（不写内联 transform，免得和拖拽位移打架）",
  /el\.animate\(\s*\[\s*\{ transform: `translateY\(\$\{d\}px\)` \}/.test(code));
ok("让位动画作用于**邻行**（不是被拖行自己）",
  /squeeze\(others, \(\) => list\.insertBefore\(row, others\[slot\] \?\? null\)\)/.test(code));
ok("上一帧还没滑完就被再次挤开：先 cancel 再接新目标（不叠加）",
  /shifts\.get\(el\)\?\.cancel\(\);/.test(code));
ok("松手落位有收尾动画（重建后的新行从松手位置滑回槽位）",
  /const settle = \(to: number, fromTop: number\)/.test(code) && /SETTLE_MS/.test(code));
ok("收尾用内容坐标做差（revealCurrent 可能改 scrollTop，视口坐标会漂）",
  /const contentY = \(viewportY: number\) => viewportY - list\.getBoundingClientRect\(\)\.top \+ list\.scrollTop;/.test(code));
ok("动画缓动与全站同一套", /const EASE = "cubic-bezier\(\.22,\.61,\.36,1\)"/.test(code));
ok("系统「减弱动效」时两段动画都短路", /if \(reduceMotion\(\)\) return;/.test(code));

// —— CSS ——
const draggingRule = css.match(/\.qp-item\.dragging \{([^}]*)\}/)?.[1] ?? "";
ok("css: .dragging 的 transition 不含 transform（含了就是「拖不动」的那个坑）",
  /transition:[^;}]*/.test(draggingRule) && !/transition:[^;}]*transform/.test(draggingRule),
  draggingRule.trim());
ok("css: 清 transform 量位置时不被 :active 的按压缩放污染",
  /\.qp-item\.dragging:active \{ transform: none; \}/.test(css));
ok("css: 重排中光标统一 grabbing，且 hover 高亮不跟着指针乱闪",
  /\.qp-list\.reordering, \.qp-list\.reordering \.qp-item \{ cursor: grabbing; \}/.test(css)
  && /\.qp-list\.reordering \.qp-item:not\(\.dragging\):not\(\.cur\):hover \{ background: transparent; \}/.test(css));
const itemRule = css.match(/\.qp-item \{([^}]*)\}/)?.[1] ?? "";
ok("css: 整行禁选中（否则纵向一拖就选中歌名）", /user-select:\s*none/.test(itemRule));
ok("css: 行是 touch-action:pan-y（触屏纵向仍归列表滚动），把手是 none（触屏走把手拖）",
  /touch-action:\s*pan-y/.test(itemRule) && /\.qi-grip \{[^}]*touch-action:\s*none/.test(css));
ok("css: 缩略图不触发浏览器原生图片拖拽", /draggable="false"/.test(read("src/components/QueuePanel.ts")));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
