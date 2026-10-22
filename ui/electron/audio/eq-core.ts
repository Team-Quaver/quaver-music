// Quaver — Quark EQ 的重型纯逻辑：曲线响应 + APO / GraphicEQ 解析。
// 只被 EqualizerDialog 的懒加载块引用；共享模型/默认值在 eq-config.ts，首屏只拉那一份。
import {
  EQ_GAIN_LIMIT, EQ_MAX_BANDS, EQ_MAX_FREQ, EQ_MAX_Q, EQ_MIN_FREQ, EQ_MIN_Q,
  defaultEqState, isPassFilter,
  type EqBand, type EqBandType, type EqImportMode, type EqImportResult, type EqState,
} from "./eq-config.ts";

export * from "./eq-config.ts";

const EQ_SAMPLE_RATE = 48000;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: number, dflt = 0) => Number.isFinite(v) ? v : dflt;
const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
const freqNum = (v: number) => round(clamp(finite(v, 1000), EQ_MIN_FREQ, EQ_MAX_FREQ), 2);
const gainNum = (v: number) => round(clamp(finite(v, 0), -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT), 1);
const qNum = (v: number) => round(clamp(finite(v, 1), EQ_MIN_Q, EQ_MAX_Q), 2);

/** 旧开发版曾预铺 10 个平直点；在懒加载 EQ 浮窗里迁成空曲线，不把这段迁移塞进首屏模型。 */
export function migrateLegacyFlat(state: EqState): EqState {
  const legacy = !state.enabled && state.preamp === 0 && state.bands.length === 10
    && state.bands.every((b) => b.gain === 0 && b.q === 1.41 && b.type === "bell");
  return legacy ? { ...state, bands: [] } : state;
}

/** RBJ biquad 的幅频响应（dB）。视觉曲线与 FFmpeg 的 peaking/shelf 拓扑同源，差异只在
 *  shelf 的 Q 映射上；对调音预览足够，最终声音始终以 mpv 的滤镜为准。 */
function biquadDb(type: EqBandType, f0: number, gainDb: number, q: number, f: number, fs = EQ_SAMPLE_RATE): number {
  if (!(f > 0) || !(f0 > 0) || !(fs > 0)) return 0;
  const pass = isPassFilter(type);
  if (!pass && Math.abs(gainDb) < 0.001) return 0;
  const A = pass ? 1 : 10 ** (gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(EQ_MIN_Q, q));
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "lowPass") {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  } else if (type === "highPass") {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  } else if (type === "lowShelf") {
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cw + twoSqrtAAlpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - twoSqrtAAlpha);
    a0 = (A + 1) + (A - 1) * cw + twoSqrtAAlpha;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - twoSqrtAAlpha;
  } else if (type === "highShelf") {
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + twoSqrtAAlpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - twoSqrtAAlpha);
    a0 = (A + 1) - (A - 1) * cw + twoSqrtAAlpha;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - twoSqrtAAlpha;
  } else {
    b0 = 1 + alpha * A;
    b1 = -2 * cw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cw;
    a2 = 1 - alpha / A;
  }
  const w = 2 * Math.PI * f / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = b1 * s1 + b2 * s2;
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = a1 * s1 + a2 * s2;
  const num = nr * nr + ni * ni;
  const den = dr * dr + di * di;
  return den > 1e-30 ? 10 * Math.log10(Math.max(1e-30, num / den)) : 0;
}

/** 总响应 = preamp + 各节点响应之和。调用方画图时按显示范围夹紧，计算本身保持原值。 */
export function eqResponseDb(state: EqState, f: number): number {
  let db = finite(state.preamp, 0);
  for (const b of state.bands) db += biquadDb(b.type, b.freq, b.gain, b.q, f);
  return db;
}

function graphicQ(freqs: number[], i: number): number {
  if (freqs.length < 2) return 1.41;
  const oct = (a: number, b: number) => Math.abs(Math.log2(a / b));
  const prev = i > 0 ? oct(freqs[i], freqs[i - 1]) : Infinity;
  const next = i < freqs.length - 1 ? oct(freqs[i], freqs[i + 1]) : Infinity;
  const bw = Math.min(prev, next) === Infinity ? 1 : Math.min(prev, next);
  // 1 倍频程 ≈ Q1.41；1/3 倍频程 ≈ Q4.32。限制下限，别让两三个孤点变成巨宽滤波。
  const q = 1 / (2 * Math.sinh(Math.LN2 / 2 * clamp(bw, 1 / 6, 2)));
  return qNum(q);
}

function bandsFromGraphic(points: { freq: number; gain: number }[], startId = 0, limit = EQ_MAX_BANDS): EqBand[] {
  const byFreq = new Map<number, number>();
  for (const p of points) byFreq.set(freqNum(p.freq), gainNum(p.gain));
  let sorted = [...byFreq.entries()].sort((a, b) => a[0] - b[0]);
  if (!sorted.length || limit <= 0) return [];
  // GraphicEQ 预设常见 31 段，但 Quark EQ 上限 10 点。超过上限时在对数频率轴上重采样，
  // 保留整条曲线的形状；绝不能只截前 10 个频点（那样只剩低频，高频全丢）。
  if (sorted.length > limit) {
    const first = sorted[0][0];
    const last = sorted[sorted.length - 1][0];
    const sampled: [number, number][] = [];
    for (let i = 0; i < limit; i++) {
      const freq = limit === 1 ? Math.sqrt(first * last) : first * (last / first) ** (i / (limit - 1));
      let j = 0;
      while (j < sorted.length - 1 && sorted[j + 1][0] < freq) j++;
      const [f0, g0] = sorted[j];
      const [f1, g1] = sorted[Math.min(sorted.length - 1, j + 1)];
      const t = f1 > f0 ? Math.log(freq / f0) / Math.log(f1 / f0) : 0;
      sampled.push([freq, g0 + (g1 - g0) * t]);
    }
    sorted = sampled;
  }
  const freqs = sorted.map(([f]) => f);
  return sorted.map(([freq, gain], i) => ({
    id: `g${startId + i + 1}`,
    freq,
    gain,
    q: graphicQ(freqs, i),
    type: "bell" as const,
  }));
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析 Equalizer APO / APO Graphic EQ 文本。
 * - 参数滤波：Filter N: ON PK/LS/HS/LP/HP Fc … Hz [Gain … dB] Q …
 * - 图形滤波：GraphicEQ: 20 -3; 25 -2.8; …
 * - 前级：Preamp: -6.0 dB
 * 未支持的滤波类型（Notch/AllPass…）不冒充支持，收进 warnings 让 UI 明说。
 */
export function parseApoPreset(text: string, mode: EqImportMode = "auto"): EqImportResult {
  const sourceText = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const warnings: string[] = [];
  let preamp = 0;
  let sawPreamp = false;
  const bands: EqBand[] = [];
  let filters = 0;
  let graphicPoints = 0;
  let sawGraphic = false;
  const pushBand = (b: EqBand) => {
    if (bands.length >= EQ_MAX_BANDS) return false;
    bands.push(b);
    return true;
  };

  for (const line of sourceText.split("\n")) {
    const m = /^\s*Preamp\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*dB?/i.exec(line);
    if (m) {
      preamp = gainNum(num(m[1]));
      sawPreamp = true;
    }
  }

  const filterLines: { line: string; index: number }[] = [];
  sourceText.split("\n").forEach((line, index) => {
    if (/^\s*Filter\s*\d*\s*:|^\s*GraphicEQ\s*:/i.test(line)) filterLines.push({ line, index });
  });

  for (const { line, index } of filterLines) {
    if (/^\s*GraphicEQ\s*:/i.test(line)) {
      sawGraphic = true;
      const payload = line.replace(/^\s*GraphicEQ\s*:/i, "");
      const pairRe = /([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
      const points: { freq: number; gain: number }[] = [];
      for (const pm of payload.matchAll(pairRe)) points.push({ freq: num(pm[1]), gain: num(pm[2]) });
      if (points.length) {
        graphicPoints += points.length;
        const remaining = EQ_MAX_BANDS - bands.length;
        if (remaining <= 0) {
          warnings.push(`参数滤波已占满 ${EQ_MAX_BANDS} 段，GraphicEQ 未导入`);
          continue;
        }
        if (points.length > remaining) {
          warnings.push(`GraphicEQ ${points.length} 点已在对数频率轴上压缩为 ${remaining} 段`);
        }
        const added = bandsFromGraphic(points, bands.length, remaining);
        for (const b of added) pushBand(b);
      } else {
        warnings.push(`第 ${index + 1} 行 GraphicEQ 没有可读的「频率 增益」对`);
      }
      continue;
    }
    const fm = /^\s*Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Za-z]+)\b(.*)$/i.exec(line);
    if (!fm) continue;
    const enabled = fm[1].toUpperCase() === "ON";
    const typeRaw = fm[2].toUpperCase();
    if (!enabled) continue;
    const body = fm[3];
    const attrs: { freq?: number; gain?: number; q?: number; bw?: number } = {};
    for (const am of body.matchAll(/\b(Fc|Frequency|Gain|Q|BW)\s*[:=]?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gi)) {
      const key = am[1].toLowerCase();
      const value = num(am[2]);
      if (key === "fc" || key === "frequency") attrs.freq = value;
      else if (key === "gain") attrs.gain = value;
      else if (key === "q") attrs.q = value;
      else if (key === "bw") attrs.bw = value;
    }
    if (attrs.freq === undefined) {
      warnings.push(`第 ${index + 1} 行缺少 Fc 频率，已跳过`);
      continue;
    }
    let type: EqBandType;
    if (typeRaw === "PK" || typeRaw === "PEAK") type = "bell";
    else if (typeRaw === "LS" || typeRaw === "LSC" || typeRaw === "LOWSHELF") type = "lowShelf";
    else if (typeRaw === "HS" || typeRaw === "HSC" || typeRaw === "HIGHSHELF") type = "highShelf";
    else if (typeRaw === "LP" || typeRaw === "LOWPASS") type = "lowPass";
    else if (typeRaw === "HP" || typeRaw === "HIGHPASS") type = "highPass";
    else {
      warnings.push(`第 ${index + 1} 行 ${typeRaw} 类型未支持，已跳过`);
      continue;
    }
    let q = attrs.q ?? (type === "bell" ? 1 : 0.707);
    if (attrs.bw !== undefined) {
      q = 1 / (2 * Math.sinh(Math.LN2 / 2 * clamp(attrs.bw, 1 / 12, 4)));
    }
    const added = pushBand({
      id: `p${filters + 1}`,
      freq: freqNum(attrs.freq),
      gain: isPassFilter(type) ? 0 : gainNum(attrs.gain ?? 0),
      q: qNum(q),
      type,
    });
    if (added) filters++;
    else warnings.push(`参数滤波超过 ${EQ_MAX_BANDS} 段，后续项已忽略`);
  }

  if (mode === "graphic" && !sawGraphic) throw new Error("未找到 GraphicEQ 行");
  if (mode === "apo" && !filters && !sawGraphic && !sawPreamp) throw new Error("未找到可识别的 APO 滤波或 Preamp");
  if (!bands.length && !sawPreamp) throw new Error("没有识别到可导入的 APO / GraphicEQ 内容");

  bands.sort((a, b) => a.freq - b.freq || a.id.localeCompare(b.id));
  const state: EqState = { enabled: true, preamp, bands: bands.length ? bands : defaultEqState().bands };
  return {
    state,
    preamp,
    filters,
    graphicPoints,
    warnings,
    source: sawGraphic ? "graphic" : "apo",
  };
}
