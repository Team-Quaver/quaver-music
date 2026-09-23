// Quaver — 横向拖拽分隔条（侧栏右缘 / 停靠队列左缘共用）。
// 指针事件 + window 监听：分隔条是 10px 细条，指针一快就滑出去，
// setPointerCapture 之外再挂 window 兜底（与 QueuePanel 行排序同一套考量，
// 捕获偶发丢失时事件照样冒得到 window）。
//
// 本模块不做布局：move 回调拿「基准宽度 + 位移」的原始值，夹取与套用由调用方负责；
// 拖拽期间给 <body> 挂 .col-resizing（style.css 统一光标为 ew-resize 并压住选中）。

export interface HResizerHooks {
  /** 按下时取基准宽度（调用方自己持有真相，避免本模块依赖布局） */
  start: () => number;
  /** 新宽度 = 基准 ± 位移（未夹取）；调用方夹取后套用 */
  move: (width: number) => void;
  /** 松手/取消：落盘等收尾（宽度已经套上了，取消不回滚） */
  end?: () => void;
  /** 双击：恢复默认宽度 */
  dbl?: () => void;
  /** 把手贴在面板**左缘**时置 true：位移取反 ——「边界跟着指针走」，指针向左 = 面板变宽。
   *  默认 false = 右缘语义（指针向右 = 变宽，如侧栏右缘分隔条）。 */
  invert?: boolean;
}

const MOVE_THRESHOLD = 3; // 微动不算拖：双击的两次按下都不应触发拖拽/落盘

export function bindHResizer(handle: HTMLElement, hooks: HResizerHooks) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const pid = e.pointerId;
    const startX = e.clientX;
    const base = hooks.start();
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < MOVE_THRESHOLD) return;
        dragging = true;
        document.body.classList.add("col-resizing");
      }
      ev.preventDefault();
      hooks.move(base + (hooks.invert ? -dx : dx));
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (dragging) {
        document.body.classList.remove("col-resizing");
        hooks.end?.();
      }
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onCancel = (ev: PointerEvent) => finish(ev);

    try { handle.setPointerCapture(pid); } catch { /* 合成事件降级 */ }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
  if (hooks.dbl) handle.addEventListener("dblclick", () => hooks.dbl!());
}
