// Quaver — Quark EQ 的轻量共享模型（首屏会加载这一份）。
//
// 只放 schema / 默认值 / clamp / normalize / mpv af 生成。APO 解析与曲线计算在
// eq-core.ts（随 EQ 浮窗懒加载），别把重型代码重新挪回来，否则主窗包体会超预算。

export type EqBandType = "bell" | "lowShelf" | "highShelf" | "lowPass" | "highPass";

export interface EqBand {
  /** 稳定 id：拖拽/选中/删除只认它，不依赖数组下标。 */
  id: string;
  freq: number;
  gain: number;
  q: number;
  type: EqBandType;
}

export interface EqState {
  enabled: boolean;
  preamp: number;
  bands: EqBand[];
}

export interface EqImportResult {
  state: EqState;
  preamp: number;
  filters: number;
  graphicPoints: number;
  warnings: string[];
  source: "apo" | "graphic";
}

export type EqImportMode = "auto" | "apo" | "graphic";

export const EQ_MIN_FREQ = 20;
export const EQ_MAX_FREQ = 20000;
export const EQ_GAIN_LIMIT = 24;
export const EQ_PREAMP_LIMIT = 24;
export const EQ_MIN_Q = 0.1;
export const EQ_MAX_Q = 18;

/** 图形 EQ 的硬上限：最多 10 个节点；默认一个都没有，点击曲线才添加。 */
export const EQ_MAX_BANDS = 10;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const round = (v: number, digits: number) => {
  const k = 10 ** digits;

  return Math.round(v * k) / k;
};

const freqNum = (v: number) => round(clamp(Number.isFinite(v) ? v : 1000, EQ_MIN_FREQ, EQ_MAX_FREQ), 2);
const gainNum = (v: number) => round(clamp(Number.isFinite(v) ? v : 0, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT), 1);
const qNum = (v: number) => round(clamp(Number.isFinite(v) ? v : 1, EQ_MIN_Q, EQ_MAX_Q), 2);
const isRecord = (v: unknown): v is { [key: string]: JsonValue } => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number";
const isString = (v: unknown): v is string => typeof v === "string";

export function isEqBandType(v: unknown): v is EqBandType {
  return v === "bell" || v === "lowShelf" || v === "highShelf" || v === "lowPass" || v === "highPass";
}

/** 出厂为空曲线：最多 10 个节点，但默认一个点都没有。默认 bypass，不偷偷改用户听感。 */
export function defaultEqState(enabled = false): EqState {
  return { enabled, preamp: 0, bands: [] };
}

export function isPassFilter(type: EqBandType): boolean {
  return type === "lowPass" || type === "highPass";
}

/** IPC / 配置文件 / 手改 JSON 的统一入口：坏字段就地兜底，永不把 NaN 或超长数组带进 mpv。 */
export function normalizeEqState(input: unknown): EqState {
  const raw = isRecord(input) ? input : {};
  const bandValue = raw.bands;
  const hasBands = Array.isArray(bandValue);
  const rawBands: readonly unknown[] = hasBands ? bandValue : [];
  const ids = new Set<string>();
  const bands: EqBand[] = [];

  for (let i = 0; i < rawBands.length && bands.length < EQ_MAX_BANDS; i++) {
    const b = rawBands[i];

    if (!isRecord(b)) continue;
    const freq = freqNum(isNumber(b.freq) ? b.freq : 1000);
    let id = isString(b.id) && /^[A-Za-z0-9_-]{1,48}$/.test(b.id) ? b.id : `b${i + 1}`;

    if (ids.has(id)) id = `b${i + 1}`;

    if (ids.has(id)) id = `x${i + 1}`;
    ids.add(id);
    const type: EqBandType = isEqBandType(b.type) ? b.type : "bell";
    const defaultQ = isPassFilter(type) ? 0.707 : 1;
    bands.push({
      id,
      freq,
      gain: isPassFilter(type) ? 0 : gainNum(isNumber(b.gain) ? b.gain : 0),
      q: qNum(isNumber(b.q) ? b.q : defaultQ),
      type,
    });
  }

  bands.sort((a, b) => a.freq - b.freq || a.id.localeCompare(b.id));

  const enabled = raw.enabled === true || raw.enabled === 1 || raw.enabled === "true"
    || raw.enabled === "yes";

  const preamp = isNumber(raw.preamp) ? raw.preamp : 0;

  return {
    enabled,
    preamp: round(clamp(preamp, -EQ_PREAMP_LIMIT, EQ_PREAMP_LIMIT), 1),
    // 显式空数组 = 用户把最后一段也删了；缺字段/坏输入同样落到出厂空曲线。
    bands: hasBands ? bands : [],
  };
}

const fmt = (v: number) => String(round(v, 2));

/** 生成 mpv `af` 属性值。普通 band 增益为 0 时省略；LP/HP 没有增益，按截止频率常驻。 */
export function eqFilterString(input: EqState): string {
  const s = normalizeEqState(input);

  if (!s.enabled) return "";
  const chain: string[] = [];

  if (Math.abs(s.preamp) >= 0.05) chain.push(`volume=${fmt(s.preamp)}dB`);

  for (const b of s.bands) {
    const width = `f=${fmt(b.freq)}:width_type=q:width=${fmt(b.q)}`;

    if (b.type === "lowPass") { chain.push(`lowpass=${width}`); continue; }

    if (b.type === "highPass") { chain.push(`highpass=${width}`); continue; }

    if (Math.abs(b.gain) < 0.05) continue;
    const common = `${width}:g=${fmt(b.gain)}`;

    if (b.type === "lowShelf") chain.push(`bass=${common}`);
    else if (b.type === "highShelf") chain.push(`treble=${common}`);
    else chain.push(`equalizer=${common}`);
  }

  return chain.length ? `lavfi=[${chain.join(",")}]` : "";
}

