// Quaver — 正在播放页内置频谱形态（宿主默认实现）。
// 三种形态共用同一份真实 FFT/波形帧；Sparkle 插件也可以注册同接口的自定义形态，
// 由 NowPlaying 统一挂载，所以内置和插件模式不需要两套渲染生命周期。
import type {
  SparkleNpSpectrumMode,
  SparkleNpSpectrumRenderCtx,
  SparkleSpectrumFrame,
} from "@quaver/sparkle";

type Ctx2D = CanvasRenderingContext2D;

function accentColor(): string {
  const root = getComputedStyle(document.documentElement);
  return root.getPropertyValue("--cvg-accent").trim() || root.getPropertyValue("--cyan").trim() || "#19c2d8";
}

/** Canvas 的 fillStyle 不保证认 color-mix()；内置渐变只处理 hex，其它形态退回原色。 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((x) => x + x).join("");
  const n = Number.parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function mountCanvas(
  host: HTMLElement,
  ctx: SparkleNpSpectrumRenderCtx,
  draw: (c: Ctx2D, w: number, h: number, frame: SparkleSpectrumFrame | null) => void,
): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "np-spectrum-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const c = canvas.getContext("2d");
  if (!c) return () => canvas.remove();
  let w = 1, h = 1;
  const size = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(host.clientWidth));
    h = Math.max(1, Math.round(host.clientHeight));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  const ro = new ResizeObserver(size);
  ro.observe(host);
  let last: SparkleSpectrumFrame | null = ctx.frame();
  const drawNow = (frame: SparkleSpectrumFrame) => {
    last = frame;
    c.clearRect(0, 0, w, h);
    draw(c, w, h, frame);
  };
  const unsub = ctx.onFrame(drawNow);
  if (last) drawNow(last);
  return () => {
    unsub();
    ro.disconnect();
    canvas.remove();
  };
}

/** 把 1024 个线性频点压成 count 个对数频带峰值（低频不挤成一根，高频不占半屏）。 */
function levelsFor(frame: SparkleSpectrumFrame | null, out: Float32Array): void {
  if (!frame?.bins.length) { out.fill(0); return; }
  const n = frame.bins.length;
  const lo = 1;
  const hi = Math.max(lo + 1, Math.floor(n * 0.74));
  for (let i = 0; i < out.length; i++) {
    const span = Math.max(1, out.length - 1);
    const a = Math.max(lo, Math.floor(lo * Math.pow(hi / lo, i / span)));
    const b = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, Math.min(1, (i + 1) / span))));
    let peak = 0;
    for (let j = a; j < Math.min(n, b); j++) peak = Math.max(peak, frame.bins[j] || 0);
    out[i] = Math.pow(peak, 0.82);
  }
}

const bars: SparkleNpSpectrumMode = {
  id: "bars",
  label: "柱状",
  render(host, ctx) {
    let levels = new Float32Array(96);
    let next = new Float32Array(96);
    return mountCanvas(host, ctx, (c, w, h, frame) => {
      const count = Math.max(20, Math.min(96, Math.round(w / 7.2)));
      if (levels.length !== count) {
        levels = new Float32Array(count);
        next = new Float32Array(count);
      }
      levelsFor(frame, next);
      const accent = accentColor();
      const gap = count > 70 ? 1.5 : 2.4;
      const bw = Math.max(1, (w - gap * (count - 1)) / count);
      const base = h - 3;
      const grad = c.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, withAlpha(accent, 0.32));
      grad.addColorStop(0.5, accent);
      grad.addColorStop(1, withAlpha(accent, 0.72));
      c.fillStyle = grad;
      c.shadowColor = accent;
      c.shadowBlur = 9;
      for (let i = 0; i < count; i++) {
        levels[i] = levels[i] * 0.68 + next[i] * 0.32;
        const bh = Math.max(1.5, levels[i] * (h - 9));
        const x = i * (bw + gap);
        c.globalAlpha = 0.45 + Math.min(0.55, levels[i]);
        c.beginPath();
        c.roundRect(x, base - bh, bw, bh, Math.min(bw / 2, 2.5));
        c.fill();
      }
      c.globalAlpha = 0.28;
      c.shadowBlur = 0;
      c.fillStyle = accent;
      c.fillRect(0, base + 1, w, 1);
      c.globalAlpha = 1;
    });
  },
};

const mirror: SparkleNpSpectrumMode = {
  id: "mirror",
  label: "镜像",
  render(host, ctx) {
    let levels = new Float32Array(96);
    let next = new Float32Array(96);
    return mountCanvas(host, ctx, (c, w, h, frame) => {
      const count = Math.max(18, Math.min(80, Math.round(w / 8)));
      if (levels.length !== count) {
        levels = new Float32Array(count);
        next = new Float32Array(count);
      }
      levelsFor(frame, next);
      const accent = accentColor();
      const gap = 2;
      const bw = Math.max(1, (w - gap * (count - 1)) / count);
      const mid = h * 0.5;
      c.fillStyle = accent;
      c.shadowColor = accent;
      c.shadowBlur = 10;
      for (let i = 0; i < count; i++) {
        levels[i] = levels[i] * 0.68 + next[i] * 0.32;
        const bh = Math.max(1.5, levels[i] * (h * 0.43));
        const x = i * (bw + gap);
        c.globalAlpha = 0.32 + levels[i] * 0.68;
        c.beginPath();
        c.roundRect(x, mid - bh, bw, bh, Math.min(bw / 2, 2));
        c.fill();
        c.beginPath();
        c.roundRect(x, mid, bw, bh, Math.min(bw / 2, 2));
        c.fill();
      }
      c.globalAlpha = 0.5;
      c.shadowBlur = 0;
      c.fillRect(0, mid, w, 1);
      c.globalAlpha = 1;
    });
  },
};

const wave: SparkleNpSpectrumMode = {
  id: "wave",
  label: "波形",
  render(host, ctx) {
    return mountCanvas(host, ctx, (c, w, h, frame) => {
      const accent = accentColor();
      const mid = h * 0.5;
      const n = frame?.wave.length ?? 0;
      const samples = Math.max(2, Math.min(Math.round(w), n || 2));
      const yAt = (x: number) => {
        if (!n) return mid;
        const i = Math.min(n - 1, Math.floor((x / samples) * (n - 1)));
        return mid + Math.max(-1, Math.min(1, frame!.wave[i] * 1.8)) * (h * 0.4);
      };
      const trace = () => {
        c.beginPath();
        for (let x = 0; x <= samples; x++) {
          const px = (x / samples) * w;
          if (x === 0) c.moveTo(px, yAt(x)); else c.lineTo(px, yAt(x));
        }
      };
      c.strokeStyle = accent;
      c.lineWidth = 1.4;
      c.shadowColor = accent;
      c.shadowBlur = 9;
      trace();
      c.stroke();

      c.shadowBlur = 0;
      c.globalAlpha = 0.18;
      trace();
      c.lineTo(w, mid);
      c.lineTo(0, mid);
      c.closePath();
      const grad = c.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, withAlpha(accent, 0.55));
      grad.addColorStop(0.5, withAlpha(accent, 0.02));
      grad.addColorStop(1, withAlpha(accent, 0.55));
      c.fillStyle = grad;
      c.fill();

      c.globalAlpha = 0.42;
      c.fillStyle = accent;
      c.fillRect(0, mid, w, 1);
      c.globalAlpha = 1;
    });
  },
};

export const builtinSpectrumModes: readonly SparkleNpSpectrumMode[] = [bars, mirror, wave];
export const builtinSpectrumLabels: Readonly<Record<string, string>> = { bars: "柱状", mirror: "镜像", wave: "波形" };
