// Quaver — 窗口全屏能力收口（画廊模式消费）。
//
// Electron 壳层走 quaverCSD 的扩展桥（主进程 setFullScreen，原生窗口级全屏，CSD 按钮簇
// 仍在页面上）；浏览器 dev（无 preload）回落标准 Fullscreen API（document 级）。
// 两侧差异全部挡在本模块内，调用方只认 setFullscreen/isFullscreen/onFullscreenChange。
//
// 状态订阅做了去重：Electron 下主进程事件与 DOM fullscreenchange 万一都来（不同平台行为
// 不一），同值只回调一次；订阅时先对齐一次当前态，订阅者拿到的第一个值一定是确定的。

export function isFullscreen(): boolean {
  const bridge = (window as any).quaverCSD;
  if (bridge?.isFullscreen) return !!bridge.isFullscreen();
  return document.fullscreenElement != null;
}

export function setFullscreen(on: boolean): void {
  const bridge = (window as any).quaverCSD;
  if (bridge?.fullscreen) { bridge.fullscreen(on); return; }
  if (on) void document.documentElement.requestFullscreen?.().catch(() => { /* 拒绝全屏：保持现状 */ });
  else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => { /* noop */ });
}

export function onFullscreenChange(cb: (on: boolean) => void): () => void {
  let last: boolean | null = null;
  const fire = (v: boolean) => { if (v !== last) { last = v; cb(v); } };
  const bridge = (window as any).quaverCSD;
  const off = bridge?.onFullscreen?.((v: boolean) => fire(v));
  const dom = () => fire(document.fullscreenElement != null);
  document.addEventListener("fullscreenchange", dom);
  fire(isFullscreen()); // 订阅即对齐：让订阅者免于自己查初始态
  return () => {
    off?.();
    document.removeEventListener("fullscreenchange", dom);
  };
}
