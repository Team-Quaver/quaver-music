// 「每日随机播放」的纯逻辑：本地日期 → 种子 → 确定性洗牌。
//
// 为什么按日期而不是每次 Math.random()：**同一天内顺序必须稳定**。
// 反复开关随机、拖动进度、退出重进，播放顺序都该是同一套 —— 否则「随机」变成
// 「每次跳一下都换一批歌」，用户刚记住的听感全被打散。想要换一套就等第二天，
// 或者直接关掉随机回到顺序播。跨零点的「今天」按**本地时区**算（用户感知的日界），
// 不是 UTC —— 否则晚上 8 点前后的用户会觉得换序来得莫名其妙。
//
// 零依赖单文件：scripts/verify-shuffle.ts 直接 `await import` 跑真断言
// （Node ≥22.18 默认开启类型剥离），不用为这段算术起浏览器。

/** 本地日期键 `YYYY-MM-DD`（本地时区，理由见文件头） */
export function dayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期键 → 32 位无符号种子（FNV-1a；同键必得同种子，跨键不易撞） */
export function daySeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：同种子必得同序列。取 0..1 浮点，供 Fisher–Yates 取下标 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates：把下标 0..n-1 洗成一个确定性排列（n≤0 → 空数组） */
export function shuffleOrder(n: number, seed: number): number[] {
  const a = Array.from({ length: Math.max(0, n | 0) }, (_, i) => i);
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * 在当日顺序里走一步。
 *
 * @param order 当日洗牌后的下标排列
 * @param cur   当前所在下标（-1 = 还没在播）
 * @param dir   +1 下一首 / -1 上一首
 * @param wrap  末位之后是否回绕（手动跳与列表循环为 true；顺序播放的自然结束为 false → 返回 -1 收尾）
 * @returns 目标下标；-1 = 播放序列到此为止
 */
export function step(order: number[], cur: number, dir: 1 | -1, wrap: boolean): number {
  if (!order.length) return -1;
  const p = order.indexOf(cur);
  if (p < 0) {
    // cur 不在当日顺序里：队列换了内容、或用户从列表直接点了一首不在序的歌。
    // 沿 dir 方向取第一个仍在序里的元素；取不到（已在序列另一端外侧）才按 wrap 决定回绕。
    const hit = dir > 0 ? order.find((i) => i > cur) : order.slice().reverse().find((i) => i < cur);
    if (hit !== undefined) return hit;
    if (!wrap) return -1;
    return dir > 0 ? order[0] : order[order.length - 1];
  }
  const q = p + dir;
  if (q >= 0 && q < order.length) return order[q];
  if (!wrap) return -1;
  return dir > 0 ? order[0] : order[order.length - 1];
}

/**
 * 沿 `order` 从 `from` 出发连走 `steps` 步，返回落点下标；-1 = 中途越界（wrap=false 时）。
 *
 * **每一步都从上一步的落点继续** —— 这是多步前进唯一正确的走法。
 * 反例（曾经的宿主实现）：循环调用「从当前曲走一步」的 stepInOrder，而它每次都以
 * this.index 为起点 → 循环 N 次仍然只走一步，`songAtOffset(-2)` 取回的是 -1 那首，
 * 封面流两侧于是各出现一对重复封面（`jumpToOffset(±2)` 也只跳一首）。
 */
export function walk(order: number[], from: number, steps: number, dir: 1 | -1, wrap: boolean): number {
  const n = order.length;
  if (!n) return -1;
  // 步数先夹紧：**这不是优化，是防呆** —— 调用方可能传个天文数字（插件里 offset 来自
  // 用户/路由），线性空转会把主线程转死。语义上夹紧是等价的：
  //   · wrap=true  走满一圈回到原处 → 取模；
  //   · wrap=false 从任意点出发最多 n 步必然越界返回 -1。
  const left0 = wrap ? ((steps % n) + n) % n : Math.min(steps, n);
  let left = left0;
  let cur = from;
  while (left-- > 0) {
    cur = step(order, cur, dir, wrap);
    if (cur < 0) return -1;
  }
  return cur;
}
