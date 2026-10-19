// Quaver — 桌面歌词覆盖层的**纯几何**（不 import DOM，裸 node 可载入）
//
// 拆出来的理由与 electron/desktop-lyrics-core.ts 同套路：这几条公式决定「看起来对不对」
// —— 条带是否居中、整块文字（主行 + 翻译/音译）是否落在视口中心、超长行到底该滚多远；
// DOM 那一侧只负责把量到的数字喂进来。纯函数让 verify-desktop-lyrics.ts 能直接对数字做
// 断言（含「块心 = 视口中心」「条带两侧对称」这类不变量），不必起浏览器。

/** 超长行横滚区间：文字盒 [left,right] 要在可用区 [aL,aR] 里完整露出来，位移从 from 走到
 *  to（px，正 = 右移）。装得下 → null（不滚）。翻译/音译各自调用，互不牵连。 */
export interface ScrollRange { from: number; to: number; dist: number }

export function scrollRange(aL: number, aR: number, left: number, right: number): ScrollRange | null {
  const from = aL - left; // 文字左缘贴可用区左缘
  const to = aR - right;  // 文字右缘贴可用区右缘
  if (!(from > to + 1)) return null; // 装得下（或 1px 内等价）就不滚
  return { from, to, dist: from - to };
}

/**
 * 锚位比例：AMLL 把行容器的**顶边**放在 `viewH × p` 处（alignAnchor = Top）。
 * 给定「文字块中心 − 行容器顶边」= centerRel，取 p 让块心正好落在视口中心。
 * 夹在 [min,max] 内：块心偏得太离谱时宁可牺牲精确居中，也不让容器把整块顶出视口。
 */
export function alignFor(viewH: number, centerRel: number, min = 0.08, max = 0.92): number {
  if (!(viewH >= 40)) return 0.5;
  return Math.min(max, Math.max(min, (viewH / 2 - centerRel) / viewH));
}

/** 条带最小高度：比这更矮的条带会把字切出豁口。 */
export const BAND_MIN_PX = 20;

/**
 * 条带（clip-path inset 开的可见窗口）：高 = 文字块高 + 上下各 pad，且**恒居中于视口**。
 * 因为块心钉在视口中心（alignFor），条带中心 = 视口中心 → 上下余量对称，块不会「挂」在下半。
 */
export function bandFor(viewH: number, blockH: number, pad: number): { top: number; h: number } {
  const h = Math.max(BAND_MIN_PX, Math.min(viewH, Math.round(blockH + pad * 2)));
  let top = Math.round((viewH - h) / 2);
  if (top + h > viewH) top = viewH - h;
  if (top < 0) top = 0;
  return { top, h };
}

/** 桌面歌词镜像里的时间线行（只取排程需要的字段；与 SparkleKaraokeLine 结构兼容）。 */
export interface TimedLyricWord {
  startTime: number;
  endTime: number;
}

export interface TimedLyricLine {
  startTime: number;
  endTime: number;
  isBG?: boolean;
  words?: TimedLyricWord[];
}

/**
 * 把「主行之间的重叠」在桌面歌词副本里收口成顺序时间线。
 *
 * QRC 常把同一句唱词拆成上下两行，并让上一行的行级 endTime 略微越过下一行起点
 * （例：Cries in a distance 18.986 结束，Can't stop the tremble 18.686 开始）。
 * AMLL 会把这类重叠当成一个高亮组，焦点停在组内第一行直到再下一行开始；正在播放页
 * 作为整组显示没问题，但桌面歌词的「当前句 / 当前句 + 下一句」会因此卡在第一行，
 * 第二行永远轮不到。
 *
 * 这里只改传给**桌面歌词渲染器**的副本：下一条非背景主行一开始，上一行就结束。
 * 背景人声（isBG）保留自己的时间轴，仍由 AMLL 按主行/和声组处理。主窗播放器与
 * 歌词缓存拿到的仍是原始时间，不受影响。返回新数组/新行/新词，绝不原地改输入。
 */
export function sequenceOverlappingLines<T extends TimedLyricLine>(lines: readonly T[]): T[] {
  const out = lines.map((line) => ({
    ...line,
    words: line.words?.map((word) => ({ ...word })),
  })) as T[];

  for (let i = 0; i < out.length; i++) {
    const line = out[i]!;
    if (line.isBG) continue;
    let next = i + 1;
    while (next < out.length && out[next]!.isBG) next++;
    if (next >= out.length) break;
    const boundary = out[next]!.startTime;
    // 同起点（或异常倒序）没有可推进的边界；行本身没越界也不动。
    if (!(boundary > line.startTime) || line.endTime <= boundary) continue;
    line.endTime = boundary;
    // AMLL 的 resetLineTimestamps 会用最后一个词的时间覆盖行时间：
    // 只前行 endTime 不够，最后一个跨过边界的词也必须一起收口。
    for (const word of line.words ?? []) {
      if (word.endTime > boundary) word.endTime = Math.max(word.startTime, boundary);
    }
  }
  return out;
}
