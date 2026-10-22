// Quaver — Quark EQ 内置 10 Band 预设。只被 EQ 浮窗懒加载块引用。
// 频点与用户给出的曲线一一对应；应用时替换节点，不偷偷改 preamp（前级是独立的全局增益）。
import type { EqBand } from "./eq-config.ts";

export interface EqPreset {
  id: string;
  label: string;
  gains: readonly number[];
}

export const EQ_PRESET_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_PRESET_Q = 1.41;

export const EQ_PRESETS = [
  { id: "pop", label: "流行", gains: [1, 2, 3, 4, 3, 1, -1, 1, 2, 3] },
  { id: "rock", label: "摇滚", gains: [4, 3, 1, 0, -1, 0, 1, 2, 3, 4] },
  { id: "classical", label: "古典", gains: [3, 2, 1, 1, 0, 0, 0, 1, 2, 3] },
  { id: "jazz", label: "爵士", gains: [2, 1, 0, 1, -1, -1, 0, 1, 2, 2] },
  { id: "electronic", label: "电子", gains: [5, 4, 2, 0, -2, -1, 0, 1, 3, 4] },
  { id: "country", label: "乡村", gains: [2, 1, 0, 1, 2, 1, 0, 1, 2, 2] },
  { id: "headphone", label: "耳机补偿", gains: [3, 2, 0, -1, -2, -1, 0, 2, 4, 5] },
  { id: "treble-boost", label: "高音增强", gains: [0, -1, -2, -2, -1, 0, 1, 3, 5, 6] },
  { id: "bass-boost", label: "低音增强", gains: [6, 5, 4, 2, 0, -1, -2, -2, -1, 0] },
  { id: "vocal", label: "中音/人声增强", gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { id: "bass-cut", label: "低音减弱", gains: [-4, -3, -2, -1, 0, 0, 0, 0, 0, 0] },
  { id: "treble-cut", label: "高音减弱", gains: [0, 0, 0, 0, 0, 0, -1, -2, -3, -4] },
  { id: "smile", label: "微笑曲线", gains: [4, 3, 1, -1, -2, -2, -1, 1, 3, 4] },
] as const satisfies readonly EqPreset[];

/** 预设 → 10 个 bell 节点。id 带预设前缀，切换预设时选中态/删除操作不会串到别的曲线上。 */
export function presetBands(preset: EqPreset): EqBand[] {
  return EQ_PRESET_FREQS.map((freq, i) => ({
    id: `pre-${preset.id}-${i}`,
    freq,
    gain: preset.gains[i],
    q: EQ_PRESET_Q,
    type: "bell" as const,
  }));
}

/** 当前曲线是否正好等于某个内置预设（UI 用它把下拉回写成对应名称，否则显示「自定义」）。 */
export function matchPreset(bands: readonly EqBand[]): EqPreset | null {
  if (bands.length !== EQ_PRESET_FREQS.length) return null;
  for (const preset of EQ_PRESETS) {
    if (preset.gains.every((gain, i) => {
      const b = bands[i];
      return b.freq === EQ_PRESET_FREQS[i] && b.gain === gain && b.q === EQ_PRESET_Q && b.type === "bell";
    })) return preset;
  }
  return null;
}
