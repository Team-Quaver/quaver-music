// 封面主色提取：CDN 无 CORS，经同源中继 /api/img 代理加载进 canvas（不会被 taint）。
// 24x24 量化取主色（4bit/通道分桶，票数为主、饱和度破平），再调成适合浅色 UI 的柔和填充。
export type RGB = { r: number; g: number; b: number };

// LRU 上限：条目本身极小（URL → RGB），但封面 URL 无限多，长期驻留没必要
const CACHE_MAX = 256;
const cache = new Map<string, RGB | null>();

function cacheSet(key: string, v: RGB | null) {
  cache.delete(key);          // 重插到队尾 = MRU
  cache.set(key, v);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

const proxied = (url: string) => "/api/img?u=" + encodeURIComponent(url);

function sat(c: { r: number; g: number; b: number }): number {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}

async function loadPixelColor(src: string): Promise<RGB | null> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("cover load fail"));
    img.src = src;
  });
  const N = 24;
  const cv = document.createElement("canvas");
  cv.width = N; cv.height = N;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);
  const { data } = ctx.getImageData(0, 0, N, N); // 同源：不会 taint
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  let best: RGB | null = null;
  let bestScore = -1;
  for (const e of buckets.values()) {
    const avg = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
    const score = e.n * 64 + sat(avg); // 票数主权重；同票取更鲜艳（避开黑白边条）
    if (score > bestScore) { bestScore = score; best = avg; }
  }
  return best ? { r: Math.round(best.r), g: Math.round(best.g), b: Math.round(best.b) } : null;
}

// 供播放条使用的一对颜色：soft = 已播区背景染色；line = 边缘进度线/圆点。
// 关键：把封面主色拉进"可读区间"——色相保留，饱和度提浓（灰封面除外），亮度锚定在中亮，
// 保证深色文字压在上面仍有高对比，同时与玻璃底色拉开明显色差。
function rgb2hsl(c: RGB): { h: number; s: number; l: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s, l };
}

function hsl2rgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((((h / 60) % 2) - 1)));
  const m = l - c / 2;
  const seg = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((seg[0] + m) * 255), g: Math.round((seg[1] + m) * 255), b: Math.round((seg[2] + m) * 255) };
}

export function toBarColors(c: RGB | null) {
  if (!c) return { soft: "rgba(25,194,216,.75)", line: "rgb(19,150,168)" };
  const hsl = rgb2hsl(c);
  // 饱和度：低彩度(<0.12)视为灰封面——保留灰调但压深做对比；否则拉到明显有色
  const s = hsl.s < 0.12 ? Math.min(0.18, hsl.s * 1.5) : Math.max(hsl.s, 0.5);
  const fill = hsl2rgb(hsl.h, s, 0.6); // 中亮度：深色文字压在上面仍有 ~6:1 对比
  const line = hsl2rgb(hsl.h, Math.min(1, s * 1.15), 0.4);
  return {
    soft: `rgba(${fill.r},${fill.g},${fill.b},.9)`,
    line: `rgb(${line.r},${line.g},${line.b})`,
  };
}

// 供 UI 高亮 / 条目背景染色的颜色对（与 toBarColors 同源提取，亮度用途不同）：
//   accent = 强调色（选中文字 / 激活态前景 / 左侧条 / 描边），亮度 0.5 适合作前景强调，
//            深/浅主题下都能与背景拉开对比；
//   glow   = 柔和背景基色（亮 0.62），CSS 用 color-mix 叠低 alpha 混进条目背景，
//            避免大块色块抢眼。灰封面同样压低饱和保留灰调，不强行上色。
// 输出纯 rgb() 字符串（不带 alpha），透明度交给 CSS（明暗主题可不同混合比例）。
export function toUiColors(c: RGB | null) {
  if (!c) return null;
  const hsl = rgb2hsl(c);
  const s = hsl.s < 0.12 ? Math.min(0.18, hsl.s * 1.5) : Math.max(hsl.s, 0.5);
  const accent = hsl2rgb(hsl.h, s, 0.5);
  const glow = hsl2rgb(hsl.h, Math.min(1, s * 1.05), 0.62);
  return {
    accent: `rgb(${accent.r},${accent.g},${accent.b})`,
    glow: `rgb(${glow.r},${glow.g},${glow.b})`,
  };
}

export async function extractCoverColor(url: string): Promise<RGB | null> {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url)!;
  let out: RGB | null = null;
  try {
    out = await loadPixelColor(proxied(url));
  } catch {
    out = null; // 中继不可用（如壳层 file:// 直开）：退回默认青色
  }
  cacheSet(url, out);
  return out;
}
