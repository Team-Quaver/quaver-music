// 队列面板「拖拽排序」的纯逻辑（几何 + 序列）。
//
// 单独成文件只有一个理由：**零依赖**，scripts/verify-queue-drag.mjs 可以直接
// `await import("../src/lib/reorder.ts")` 跑真断言（Node ≥22.18 默认类型剥离），
// 不用为了测这段算术去起浏览器。位置信息只吃「顶边 + 高」两个数，调用方从
// getBoundingClientRect() 取来即可 —— 这里一行 DOM 都不碰。

/** 一行的竖向占位：顶边（视口坐标）与高度 */
export interface SlotRow {
  top: number;
  height: number;
}

/**
 * 指针位置 → 拖拽行的落点槽位。
 *
 * 槽位 = 落点前面还排着几行（**不含被拖的那行自己**，它占的格子不算落点），
 * 于是「槽位」可以直接当 insertBefore 的参照下标用。
 *
 * 判据是「指针压过某行中线就算越过它」，与遍历顺序无关，所以换位之后重新量一次就能收敛，
 * 不会来回抖：越过去的那行会把自己挪开，指针随即落在它中线之外。
 *
 * @param rows 含被拖行本身在内的所有行（顺序无所谓）
 * @param self 被拖行在 rows 里的下标；不在里面传 -1
 */
export function dropSlot(rows: SlotRow[], self: number, pointerY: number): number {
  let slot = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === self) continue;
    if (pointerY >= rows[i].top + rows[i].height / 2) slot++;
  }
  return slot;
}

/**
 * 贴边自动滚动速度（px/帧，负数往上滚）：0 = 该帧不滚。
 *
 * 指针进入上/下 edge 像素的感应带就开始滚，越贴边越快（线性斜率，封顶 max）。
 * 队列常常比可视区长，没有这条就只能「拖到边缘 → 松手 → 滚一屏 → 再拖」。
 *
 * 列表本身矮到放不下两条感应带时一律不滚：带子会把整块吃满，随便一动就狂滚。
 */
export function edgeSpeed(
  pointerY: number,
  top: number,
  bottom: number,
  zone = 28,
  max = 14,
): number {
  if (bottom - top < zone * 2) return 0;
  if (pointerY < top + zone) return -Math.min(max, (top + zone - pointerY) / 2);
  if (pointerY > bottom - zone) return Math.min(max, (pointerY - (bottom - zone)) / 2);
  return 0;
}
