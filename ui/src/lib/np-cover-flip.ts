// 默认正在播放页的封面中心翻转：方向纯逻辑 + 宿主请求通道。
//
// 方向口径（用户可见语义）：
//   prev = 上一首 → 左到右（旧面往右转出，新面从左侧转入）
//   next = 下一首 → 右到左（旧面往左转出，新面从右侧转入）
// 两面在 50% 处同时转到侧棱，随后新面转正、带一点过冲再回正 —— 中心翻转 + 惯性。
// 动画本体在 components/NowPlaying.ts（只服务默认布局）；插件经 player.flipCover()
// 调 requestNpCoverFlip()，接管视图不回放 —— 那时默认封面本来就不在屏上。
export type CoverFlipDirection = "prev" | "next";

export const COVER_FLIP_MS = 760;
const COVER_FLIP_PERSPECTIVE = 1100;
const COVER_FLIP_TURN = 90;
const COVER_FLIP_SHIFT = 18;
const COVER_FLIP_OVERSHOOT_DEG = 12;
const COVER_FLIP_OVERSHOOT_PX = 9;

let handler: ((dir: CoverFlipDirection) => void) | null = null;

/** NowPlaying 挂载时登记；返回退订函数（组件常驻，通常不需要调用）。 */
export function bindNpCoverFlip(fn: (dir: CoverFlipDirection) => void): () => void {
  handler = fn;

  return () => { if (handler === fn) handler = null; };
}

/** 插件/宿主请求回放一次默认正在播放页的封面中心翻转；页面不在默认布局时由接收方忽略。 */
export function requestNpCoverFlip(dir: CoverFlipDirection): void {
  handler?.(dir);
}

export interface CoverFlipFrames {
  incoming: Keyframe[];
  outgoing: Keyframe[];
}

/** 两面的关键帧（纯函数，供 verify 断言方向与数值）。
 *
 * 0–42%：旧面转出，新面停在侧棱；42–62%：新面转正；62–72% 惯性过冲；
 * 最后 28% 用长缓动缓慢回正，不再做反向回摆 —— 收尾更柔，不“啪”一下弹回。
 * 整段绕中心，布局位置不变。 */
export function coverFlipFrames(dir: CoverFlipDirection): CoverFlipFrames {
  const sign = dir === "prev" ? 1 : -1;

  const transform = (x: number, deg: number) =>
    `perspective(${COVER_FLIP_PERSPECTIVE}px) translateX(${x}px) rotateY(${deg}deg)`;

  const settle = { transform: transform(0, 0), opacity: 1 };

  const incomingStart = {
    transform: transform(-sign * COVER_FLIP_SHIFT, -sign * COVER_FLIP_TURN),
    opacity: 0,
  };

  const outgoingEnd = {
    transform: transform(sign * COVER_FLIP_SHIFT, sign * COVER_FLIP_TURN),
    opacity: 0,
  };

  const overshoot = {
    transform: transform(sign * COVER_FLIP_OVERSHOOT_PX, sign * COVER_FLIP_OVERSHOOT_DEG),
    opacity: 1,
  };

  return {
    incoming: [
      { ...incomingStart, offset: 0 },
      { ...incomingStart, offset: 0.42 },
      { ...settle, offset: 0.62, easing: "cubic-bezier(.2,.8,.3,1)" },
      { ...overshoot, offset: 0.72, easing: "cubic-bezier(.42,0,.58,1)" },
      { ...settle, offset: 1 },
    ],
    outgoing: [
      { ...settle, offset: 0 },
      { ...outgoingEnd, offset: 0.42 },
      { ...outgoingEnd, offset: 1 },
    ],
  };
}

