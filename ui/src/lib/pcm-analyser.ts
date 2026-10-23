// Quaver — PCM 兼容模式的频谱分析节点桥。
//
// PcmSink 在最终 GainNode 后挂 AnalyserNode；这里仅保存引用，让按需加载的频谱模块
// 能复用扬声器同一份真实样本，不回退到另一个 <audio> 镜像去猜进度。
let current: AnalyserNode | null = null;
const listeners = new Set<(node: AnalyserNode | null) => void>();

export function setPcmSpectrumAnalyser(node: AnalyserNode | null): void {
  current = node;

  for (const cb of listeners) {
    try { cb(node); } catch { /* 频谱旁路失败不能影响音频 */ }
  }
}

export function pcmSpectrumAnalyser(): AnalyserNode | null {
  return current;
}

export function onPcmSpectrumAnalyser(cb: (node: AnalyserNode | null) => void): () => void {
  listeners.add(cb);

  return () => listeners.delete(cb);
}
