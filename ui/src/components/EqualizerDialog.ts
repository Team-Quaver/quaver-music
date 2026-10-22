// Quaver — Quark EQ 浮窗（设置 → 播放 / 音量浮窗快捷入口）。
//
// 交互口径：
//   · 点空白 = 在指针位置新建节点；拖节点 = 同时改频率与增益；双击 / 右键 / Delete = 删除
//   · 滚轮停在节点上 = 改 Q；右侧检查器也能精确输入频率 / 增益 / Q / 滤波类型
//   · 所有改动先重画曲线，再以 ~40ms 节流下发 mpv af；听觉预览不等落盘
//   · 只有 MPV 后端可编辑；浏览器后端仍能打开看结构，但控件锁定并明确提示
import "./equalizer.css";
import { player } from "../player";
import { audioSpectrum } from "../lib/audio-spectrum";
import type { SparkleSpectrumFrame } from "@quaver/sparkle";
import {
  EQ_GAIN_LIMIT, EQ_MAX_BANDS, EQ_MAX_FREQ, EQ_MAX_Q,
  EQ_MIN_FREQ, EQ_MIN_Q, EQ_PREAMP_LIMIT, eqResponseDb,
  isEqBandType, isPassFilter, migrateLegacyFlat, normalizeEqState, parseApoPreset,
  type EqBand, type EqBandType, type EqImportMode, type EqState,
} from "../../electron/audio/eq-core.ts";
import { EQ_PRESETS, matchPreset, presetBands } from "../../electron/audio/eq-presets.ts";

const VIEW_W = 760;
const INITIAL_VIEW_H = 338;
let VIEW_H = INITIAL_VIEW_H;
const PLOT_L = 42;
const PLOT_R = 18;
const PLOT_T = 18;
const PLOT_B = 32;
const PLOT_W = VIEW_W - PLOT_L - PLOT_R;
let PLOT_H = INITIAL_VIEW_H - PLOT_T - PLOT_B;
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const GRID_DB = [-24, -18, -12, -6, 0, 6, 12, 18, 24];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const fmtFreq = (f: number) => f >= 1000
  ? `${(f / 1000).toFixed(f < 10000 ? 1 : 0).replace(/\.0$/, "")} kHz`
  : `${Math.round(f)} Hz`;

const fmtDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const esc = (s: string | number | null | undefined) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const eventElement = (e: Event): Element | null => e.target instanceof Element ? e.target : null;

const typeLabel = (t: EqBandType) => t === "lowShelf" ? "Low Shelf"
  : t === "highShelf" ? "High Shelf"
    : t === "lowPass" ? "Low-Pass"
      : t === "highPass" ? "High-Pass" : "Bell";

const xForFreq = (f: number) => PLOT_L + Math.log(f / EQ_MIN_FREQ) / Math.log(EQ_MAX_FREQ / EQ_MIN_FREQ) * PLOT_W;
const freqForX = (x: number) => EQ_MIN_FREQ * (EQ_MAX_FREQ / EQ_MIN_FREQ) ** clamp((x - PLOT_L) / PLOT_W, 0, 1);
const yForDb = (db: number) => PLOT_T + (EQ_GAIN_LIMIT - clamp(db, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT)) / (EQ_GAIN_LIMIT * 2) * PLOT_H;
const dbForY = (y: number) => EQ_GAIN_LIMIT - clamp((y - PLOT_T) / PLOT_H, 0, 1) * EQ_GAIN_LIMIT * 2;

let layer: HTMLElement | null = null;
let panel: HTMLElement | null = null;

/** 打开（或聚焦）唯一的 EQ 模态浮窗。调用方通过动态 import 加载本模块，避免曲线代码塞进首屏。 */
export function openEqualizer(): void {
  if (layer) {
    panel?.classList.remove("eq-attention");
    void panel?.offsetWidth;
    panel?.classList.add("eq-attention");
    window.setTimeout(() => panel?.classList.remove("eq-attention"), 320);

    return;
  }

  mount();
}

function mount(): void {
  const overlay = document.createElement("div");
  overlay.className = "eq-overlay";
  const host = document.createElement("div");
  host.className = "eq-float";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "EQ 图形均衡器");
  host.innerHTML = `
    <header class="eq-head" data-eq-drag>
      <span class="eq-logo" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="26" height="26" fill="none">
          <path d="M3 20h5l3-9 4 14 4-18 3 13h7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="eq-title"><b>EQ</b><small>GRAPHICS EQ · 10 BAND</small></span>
      <span class="eq-only">MPV ONLY</span>
      <span class="eq-head-space"></span>
      <button class="eq-power" id="eq-power" type="button" aria-pressed="true">
        <span class="eq-power-dot"></span><span class="eq-power-label">EQ ON</span>
      </button>
      <button class="eq-close" id="eq-close" type="button" aria-label="关闭 EQ 浮窗">×</button>
    </header>

    <div class="eq-unavailable" id="eq-unavailable" hidden>
      <b>当前不是 MPV 播放模式</b>
      <span>EQ 只作用于原生 MPV 引擎。请在「设置 → 播放 → 播放引擎」切到 MPV 后再调。</span>
    </div>

    <div class="eq-body" id="eq-body">
      <section class="eq-graph-wrap">
        <div class="eq-graph-head">
          <span class="eq-spectrum-legend"><b class="peak">PEAK</b><b class="loud">LOUDNESS</b><b class="eq">EQ</b><em>POST-FADER</em></span>
          <span id="eq-node-count">0 / 10 BANDS</span>
        </div>
        <div class="eq-graph-stage">
          <canvas class="eq-spectrum" id="eq-spectrum" aria-hidden="true"></canvas>
          <svg class="eq-graph" id="eq-graph" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="application"
            aria-label="均衡器曲线，点空白添加频段，拖动节点调整频率与增益"></svg>
        </div>
      </section>

      <aside class="eq-side">
        <div class="eq-block eq-preset-block">
          <div class="eq-block-title"><span>PRESET</span></div>
          <select class="eq-preset-select" id="eq-preset" aria-label="EQ 预设">
            <option value="">自定义</option>
            ${EQ_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("")}
          </select>
        </div>
        <div class="eq-block">
          <div class="eq-block-title"><span>PREAMP</span><output id="eq-preamp-out">0.0 dB</output></div>
          <input class="eq-preamp" id="eq-preamp" type="range" min="${-EQ_PREAMP_LIMIT}" max="${EQ_PREAMP_LIMIT}" step="0.5" value="0" aria-label="前级增益" />
          <div class="eq-inline-num"><span>增益</span><input id="eq-preamp-num" type="number" min="${-EQ_PREAMP_LIMIT}" max="${EQ_PREAMP_LIMIT}" step="0.1" value="0" aria-label="前级增益数值" /><em>dB</em></div>
        </div>

        <div class="eq-block eq-band-block">
          <div class="eq-block-title"><span>BAND</span><span id="eq-band-caption">点击节点</span></div>
          <div class="eq-band-empty" id="eq-band-empty">点击曲线上的节点进行编辑。</div>
          <div class="eq-band-controls" id="eq-band-controls" hidden>
            <div class="eq-band-row3">
              <label><span id="eq-freq-label">频率</span><span class="eq-value-line"><input id="eq-freq" type="number" min="${EQ_MIN_FREQ}" max="${EQ_MAX_FREQ}" step="1" /><em>Hz</em></span></label>
              <label><span id="eq-gain-label">增益</span><span class="eq-value-line"><input id="eq-gain" type="number" min="${-EQ_GAIN_LIMIT}" max="${EQ_GAIN_LIMIT}" step="0.1" /><em>dB</em></span></label>
              <label><span>Q</span><span class="eq-value-line"><input id="eq-q" type="number" min="${EQ_MIN_Q}" max="${EQ_MAX_Q}" step="0.01" /></span></label>
            </div>
            <label class="eq-type-row"><span>滤波类型</span><select id="eq-type">
              <option value="bell">Bell / Peaking</option>
              <option value="lowShelf">Low Shelf / 低频搁架</option>
              <option value="highShelf">High Shelf / 高频搁架</option>
              <option value="highPass">High-Pass / 高通滤波</option>
              <option value="lowPass">Low-Pass / 低通滤波</option>
            </select></label>
            <input class="eq-q-range" id="eq-q-range" type="range" min="${EQ_MIN_Q}" max="${EQ_MAX_Q}" step="0.01" aria-label="频段 Q 值" />
            <button class="eq-delete" id="eq-delete" type="button">删除此频段</button>
          </div>
        </div>

        <div class="eq-import">
          <button class="eq-btn" id="eq-import-apo" type="button">导入 APO</button>
          <button class="eq-btn" id="eq-import-graphic" type="button">导入 APO Graphic EQ</button>
        </div>
        <input id="eq-file" type="file" accept=".txt,.apo,.conf,text/plain" hidden />
      </aside>
    </div>

    <footer class="eq-foot">
      <button class="eq-flat" id="eq-flat" type="button">清空全部频段</button>
      <span class="eq-message" id="eq-message" role="status"></span>
      <span class="eq-powered">Powered By <b>Quark EQ</b></span>
    </footer>`;

  overlay.append(host);
  document.body.append(overlay);
  layer = overlay;
  panel = host;

  const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const svg = $<SVGSVGElement>("#eq-graph");

  // SVG 的宽度坐标固定为 760；高度按左栏实际可用空间扩展。viewBox 与元素同比例，
  // 所以圆点/文字不会被垂直拉伸，只有 dB 轴和频谱绘图区真正长高。
  const syncViewMetrics = (): void => {
    const r = svg.getBoundingClientRect();

    if (r.width < 2 || r.height < 2) return;
    VIEW_H = VIEW_W * r.height / r.width;
    PLOT_H = VIEW_H - PLOT_T - PLOT_B;
    svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
  };

  const spectrumCanvas = $<HTMLCanvasElement>("#eq-spectrum");
  const spectrumCtx = spectrumCanvas.getContext("2d");
  const unavailable = $("#eq-unavailable");
  const body = $("#eq-body");
  const power = $<HTMLButtonElement>("#eq-power");
  const powerLabel = $(".eq-power-label");
  const count = $("#eq-node-count");
  const message = $("#eq-message");
  const presetSelect = $<HTMLSelectElement>("#eq-preset");
  const preamp = $<HTMLInputElement>("#eq-preamp");
  const preampNum = $<HTMLInputElement>("#eq-preamp-num");
  const preampOut = $<HTMLOutputElement>("#eq-preamp-out");
  const empty = $("#eq-band-empty");
  const bandControls = $("#eq-band-controls");
  const bandCaption = $("#eq-band-caption");
  const freq = $<HTMLInputElement>("#eq-freq");
  const freqLabel = $("#eq-freq-label");
  const gain = $<HTMLInputElement>("#eq-gain");
  const gainLabel = $("#eq-gain-label");
  const q = $<HTMLInputElement>("#eq-q");
  const qRange = $<HTMLInputElement>("#eq-q-range");
  const type = $<HTMLSelectElement>("#eq-type");
  const fileInput = $<HTMLInputElement>("#eq-file");
  const importApo = $<HTMLButtonElement>("#eq-import-apo");
  const importGraphic = $<HTMLButtonElement>("#eq-import-graphic");

  let state: EqState = migrateLegacyFlat(normalizeEqState(player.getEqualizer()));
  let selectedId: string | null = state.bands[0]?.id ?? null;
  let drag: { id: string; moved: boolean } | null = null;
  let applyTimer = 0;
  let importMode: EqImportMode = "auto";
  let backendWasMpv = player.backend === "mpv";
  let destroyed = false;

  const isMpv = () => player.backend === "mpv";
  const selected = () => state.bands.find((b) => b.id === selectedId) ?? null;

  let sayTimer = 0;

  const say = (text: string, error = false) => {
    message.textContent = text;
    message.classList.toggle("err", error);
    window.clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => { if (!destroyed) message.textContent = ""; }, 4200);
  };

  const applyNow = (immediate = false) => {
    window.clearTimeout(applyTimer);
    applyTimer = 0;

    if (!isMpv()) return;

    const send = () => {
      if (destroyed || !isMpv()) return;
      void player.setEqualizer(state);
    };

    if (immediate) send();
    else applyTimer = window.setTimeout(send, 40);
  };

  const syncHead = () => {
    const active = isMpv() && state.enabled;
    power.classList.toggle("on", active);
    power.setAttribute("aria-pressed", active ? "true" : "false");
    powerLabel.textContent = !isMpv() ? "MPV ONLY" : state.enabled ? "EQ ON" : "BYPASS";
    count.textContent = `${state.bands.length} / ${EQ_MAX_BANDS} BANDS`;
    svg.classList.toggle("bypassed", !active);
  };

  const syncInspector = () => {
    const b = selected();
    empty.hidden = !!b;
    bandControls.hidden = !b;

    if (!b) empty.textContent = state.bands.length ? "点击曲线上的节点进行编辑。" : "点击曲线添加第一个频段。";
    bandCaption.textContent = b ? typeLabel(b.type) : "点击节点";
    preamp.value = String(state.preamp);
    preampNum.value = String(state.preamp);
    preampOut.textContent = fmtDb(state.preamp);

    if (!b) return;
    const pass = isPassFilter(b.type);
    freqLabel.textContent = pass ? "截止频率" : "频率";
    gainLabel.textContent = pass ? "增益 N/A" : "增益";
    freq.value = String(Math.round(b.freq * 100) / 100);
    gain.disabled = pass;
    gain.value = (pass ? 0 : b.gain).toFixed(1);
    q.value = b.q.toFixed(2);
    qRange.value = String(b.q);
    type.value = b.type;
  };

  const renderGraph = () => {
    syncViewMetrics();
    const grid: string[] = [];

    for (const f of GRID_FREQS) {
      const x = xForFreq(f);
      const major = f === 20 || f === 100 || f === 1000 || f === 10000 || f === 20000;
      grid.push(`<line class="eq-grid-line${major ? " major" : ""}" x1="${x.toFixed(2)}" y1="${PLOT_T}" x2="${x.toFixed(2)}" y2="${PLOT_T + PLOT_H}"/>`);
      grid.push(`<text class="eq-axis-text" x="${x.toFixed(2)}" y="${VIEW_H - 9}" text-anchor="middle">${f >= 1000 ? `${f / 1000}k` : f}</text>`);
    }

    for (const db of GRID_DB) {
      const y = yForDb(db);
      grid.push(`<line class="eq-grid-line${db === 0 ? " zero" : ""}" x1="${PLOT_L}" y1="${y.toFixed(2)}" x2="${PLOT_L + PLOT_W}" y2="${y.toFixed(2)}"/>`);

      if (db % 12 === 0 || db === 0) grid.push(`<text class="eq-axis-text" x="${PLOT_L - 8}" y="${(y + 3.5).toFixed(2)}" text-anchor="end">${db > 0 ? "+" : ""}${db}</text>`);
    }

    const pts: { x: number; y: number }[] = [];
    const samples = 280;

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const f = EQ_MIN_FREQ * (EQ_MAX_FREQ / EQ_MIN_FREQ) ** t;
      pts.push({ x: PLOT_L + t * PLOT_W, y: yForDb(eqResponseDb(state, f)) });
    }

    const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    const zeroY = yForDb(0).toFixed(2);
    const area = `M${PLOT_L},${zeroY} ${pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")} L${PLOT_L + PLOT_W},${zeroY} Z`;

    const nodes = state.bands.map((b) => {
      const x = xForFreq(b.freq), y = yForDb(b.gain);
      const sel = b.id === selectedId;
      const pass = isPassFilter(b.type);
      const metric = pass ? typeLabel(b.type) : fmtDb(b.gain);

      return `<g class="eq-node${sel ? " selected" : ""}${pass ? " pass" : ""}" data-band-id="${esc(b.id)}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})" tabindex="0" role="button" aria-label="${esc(fmtFreq(b.freq))}, ${esc(metric)}, Q ${b.q}, ${typeLabel(b.type)}">
        <title>${esc(fmtFreq(b.freq))} · ${esc(metric)} · Q ${b.q}</title>
        <circle class="eq-node-hit" r="15"/><circle class="eq-node-ring" r="${sel ? 8.5 : 6.5}"/><circle class="eq-node-core" r="${sel ? 3.7 : 2.8}"/>
      </g>`;
    }).join("");

    svg.innerHTML = `<defs>
      <linearGradient id="eq-area-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--cvg-accent, var(--cyan))" stop-opacity=".30"/>
        <stop offset="1" stop-color="var(--cvg-accent, var(--cyan))" stop-opacity=".015"/>
      </linearGradient>
      <filter id="eq-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>
    </defs>
    <rect class="eq-plot-bg" data-eq-bg x="${PLOT_L}" y="${PLOT_T}" width="${PLOT_W}" height="${PLOT_H}" rx="8"/>
    ${grid.join("")}
    <path class="eq-area" d="${area}"/>
    <path class="eq-glow-line" d="${line}"/>
    <path class="eq-line" d="${line}"/>
    ${nodes}`;
  };

  // —— 频谱：canvas 画 Peak + Loudness，SVG 只负责网格 / EQ 曲线 / 节点 ——
  // 复用 audio-spectrum 的 MPV 静音镜像（同一 streamUrl 的 WebAudio FFT），不伪造随机波形。
  const SPECTRUM_POINTS = 150;
  const SPECTRUM_MIN_DB = -100;
  const SPECTRUM_MAX_DB = -18;
  let spectrumOff: (() => void) | null = null;
  let spectrumLoud = new Float32Array(SPECTRUM_POINTS);
  let spectrumPeak = new Float32Array(SPECTRUM_POINTS);
  const spectrumEqDb = new Float32Array(SPECTRUM_POINTS);
  let spectrumLastAt = 0;
  let paletteAt = 0;
  let paletteAccent = "#19c2d8";
  let paletteInk = "#e6e8ec";

  const clearSpectrum = () => {
    if (!spectrumCtx) return;
    spectrumCtx.setTransform(1, 0, 0, 1, 0, 0);
    spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
    spectrumLoud.fill(0);
    spectrumPeak.fill(0);
    spectrumLastAt = 0;
  };

  const updateSpectrumEq = () => {
    for (let i = 0; i < SPECTRUM_POINTS; i++) {
      const freq = EQ_MIN_FREQ * (EQ_MAX_FREQ / EQ_MIN_FREQ) ** (i / (SPECTRUM_POINTS - 1));
      spectrumEqDb[i] = state.enabled ? eqResponseDb(state, freq) : 0;
    }
  };

  const refreshPalette = (now: number) => {
    if (now - paletteAt < 1000) return;
    paletteAt = now;
    const cs = getComputedStyle(document.documentElement);
    paletteAccent = cs.getPropertyValue("--cvg-accent").trim() || cs.getPropertyValue("--acc").trim() || "#19c2d8";
    paletteInk = cs.getPropertyValue("--ink").trim() || "#e6e8ec";
  };

  const drawSpectrum = (frame: SparkleSpectrumFrame) => {
    const c = spectrumCtx;

    if (!c) return;
    syncViewMetrics();
    const now = frame.timestamp || performance.now();
    refreshPalette(now);
    const r = spectrumCanvas.getBoundingClientRect();

    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(r.width * dpr));
    const ch = Math.max(1, Math.round(r.height * dpr));

    if (spectrumCanvas.width !== cw || spectrumCanvas.height !== ch) {
      spectrumCanvas.width = cw;
      spectrumCanvas.height = ch;
    }

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const dt = spectrumLastAt ? clamp((now - spectrumLastAt) / 1000, 0.001, 0.12) : 0.016;
    spectrumLastAt = now;
    const sx = r.width / VIEW_W;
    const sy = r.height / VIEW_H;
    const left = PLOT_L * sx;
    const right = (PLOT_L + PLOT_W) * sx;
    const top = PLOT_T * sy;
    const bottom = (PLOT_T + PLOT_H) * sy;
    const bins = frame.bins;

    if (!bins.length) { clearSpectrum(); return; }

    const binHz = frame.sampleRate / 2 / bins.length;
    const active = frame.active && !!player.current && !player.paused;
    const fader = player.muted ? 0 : player.volume;
    const faderDb = fader > 0 ? 20 * Math.log10(fader) : -Infinity;

    for (let i = 0; i < SPECTRUM_POINTS; i++) {
      const freq = EQ_MIN_FREQ * (EQ_MAX_FREQ / EQ_MIN_FREQ) ** (i / (SPECTRUM_POINTS - 1));

      if (!active || !(binHz > 0)) {
        spectrumLoud[i] *= Math.exp(-dt * 8);
        spectrumPeak[i] *= Math.exp(-dt * 1.8);
        continue;
      }

      const a = Math.max(0, Math.floor(freq * 0.92 / binHz));
      const b = Math.min(bins.length - 1, Math.ceil(freq * 1.08 / binHz));
      let amp = 0;

      for (let j = a; j <= b; j++) amp = Math.max(amp, bins[j] || 0);
      const sourceDb = SPECTRUM_MIN_DB + amp * (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB);
      const postDb = sourceDb + spectrumEqDb[i] + faderDb;
      const postNorm = clamp((postDb - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB), 0, 1);
      const target = Math.min(1, Math.pow(postNorm, 0.8) * (0.78 + frame.level * 1.5));
      const loudK = 1 - Math.exp(-dt * (target > spectrumLoud[i] ? 26 : 7));
      spectrumLoud[i] += (target - spectrumLoud[i]) * loudK;
      spectrumPeak[i] = Math.max(target, spectrumPeak[i] * Math.exp(-dt * 1.65));
    }

    const xAt = (i: number) => left + (i / (SPECTRUM_POINTS - 1)) * (right - left);
    const yAt = (v: number) => bottom - clamp(v, 0, 1) * (bottom - top) * 0.96;
    c.save();
    c.beginPath();
    c.moveTo(left, bottom);

    for (let i = 0; i < SPECTRUM_POINTS; i++) c.lineTo(xAt(i), yAt(spectrumLoud[i]));
    c.lineTo(right, bottom);
    c.closePath();
    const fill = c.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, paletteAccent);
    fill.addColorStop(1, "transparent");
    c.fillStyle = fill;
    c.globalAlpha = 0.2;
    c.fill();
    c.globalAlpha = 0.5;
    c.strokeStyle = paletteAccent;
    c.lineWidth = 0.9;
    c.beginPath();

    for (let i = 0; i < SPECTRUM_POINTS; i++) {
      const x = xAt(i), y = yAt(spectrumLoud[i]);

      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }

    c.stroke();
    c.globalAlpha = 0.52;
    c.strokeStyle = paletteInk;
    c.lineWidth = 0.85;
    c.shadowColor = paletteAccent;
    c.shadowBlur = 5;
    c.beginPath();

    for (let i = 0; i < SPECTRUM_POINTS; i++) {
      const x = xAt(i), y = yAt(spectrumPeak[i]);

      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }

    c.stroke();
    c.restore();
  };

  const startSpectrum = () => {
    if (spectrumOff || !isMpv()) return;
    spectrumOff = audioSpectrum.onFrame(drawSpectrum);
  };

  const stopSpectrum = () => {
    spectrumOff?.();
    spectrumOff = null;
    clearSpectrum();
  };

  const syncAvailability = () => {
    const ok = isMpv();
    unavailable.hidden = ok;
    body.classList.toggle("locked", !ok);
    power.disabled = !ok;
    presetSelect.disabled = !ok;
    preamp.disabled = !ok;
    preampNum.disabled = !ok;
    importApo.disabled = !ok;
    importGraphic.disabled = !ok;

    if (!ok) {
      drag = null;
      stopSpectrum();
      host.classList.add("is-unavailable");
    } else {
      host.classList.remove("is-unavailable");
      startSpectrum();

      if (!backendWasMpv) applyNow(true);
    }

    syncHead();
    backendWasMpv = ok;
  };

  const syncPreset = () => {
    presetSelect.value = matchPreset(state.bands)?.id ?? "";
  };

  const paintAll = () => {
    state = normalizeEqState(state);

    if (selectedId && !state.bands.some((b) => b.id === selectedId)) selectedId = state.bands[0]?.id ?? null;
    updateSpectrumEq();
    renderGraph();
    syncHead();
    syncInspector();
    syncPreset();
  };

  const mutate = (immediate = false) => {
    state = normalizeEqState(state);

    if (selectedId && !state.bands.some((b) => b.id === selectedId)) selectedId = state.bands[0]?.id ?? null;
    updateSpectrumEq();
    renderGraph();
    syncHead();
    syncInspector();
    syncPreset();
    applyNow(immediate);
  };

  const mutateBand = (id: string, patch: Partial<EqBand>, immediate = false, enable = true) => {
    const b = state.bands.find((x) => x.id === id);

    if (!b) return;
    Object.assign(b, patch);

    if (enable) state.enabled = true;
    mutate(immediate);
  };

  const removeBand = (id: string) => {
    if (!isMpv()) return;
    const b = state.bands.find((x) => x.id === id);

    if (!b) return;
    state.bands = state.bands.filter((x) => x.id !== id);
    selectedId = state.bands[0]?.id ?? null;
    mutate(true);
    say(`已删除 ${fmtFreq(b.freq)}`);
  };

  const plotPoint = (e: PointerEvent | WheelEvent) => {
    syncViewMetrics();
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * VIEW_W / Math.max(1, r.width);
    const y = (e.clientY - r.top) * VIEW_H / Math.max(1, r.height);

    return { x, y, freq: freqForX(x), gain: dbForY(y) };
  };

  svg.addEventListener("pointerdown", (e) => {
    if (!isMpv()) return;
    e.preventDefault();
    const node = eventElement(e)?.closest<SVGGElement>("[data-band-id]");

    if (node?.dataset.bandId) {
      selectedId = node.dataset.bandId;
      drag = { id: selectedId, moved: false };
      svg.setPointerCapture(e.pointerId);
      paintAll();

      return;
    }

    const p = plotPoint(e);

    if (p.x < PLOT_L || p.x > PLOT_L + PLOT_W || p.y < PLOT_T || p.y > PLOT_T + PLOT_H) return;

    if (state.bands.length >= EQ_MAX_BANDS) { say(`最多 ${EQ_MAX_BANDS} 个频段`, true); return; }

    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    state.bands.push({ id, freq: p.freq, gain: p.gain, q: 1.41, type: "bell" });
    state.enabled = true;
    selectedId = id;
    drag = { id, moved: false };
    svg.setPointerCapture(e.pointerId);
    mutate();
  });

  svg.addEventListener("pointermove", (e) => {
    if (!drag || !isMpv()) return;
    const p = plotPoint(e);
    drag.moved = true;
    state.enabled = true;
    const b = state.bands.find((x) => x.id === drag?.id);

    if (!b) return;
    b.freq = clamp(p.freq, EQ_MIN_FREQ, EQ_MAX_FREQ);
    // 高通/低通只沿频率轴移动；增益字段对它们没有意义，保持 0。
    b.gain = isPassFilter(b.type) ? 0 : clamp(p.gain, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT);
    mutate();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    applyNow(true);
  };

  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("lostpointercapture", endDrag);

  svg.addEventListener("dblclick", (e) => {
    const node = eventElement(e)?.closest<SVGGElement>("[data-band-id]");

    if (node?.dataset.bandId) { e.preventDefault(); removeBand(node.dataset.bandId); }
  });
  svg.addEventListener("contextmenu", (e) => {
    const node = eventElement(e)?.closest<SVGGElement>("[data-band-id]");

    if (!node?.dataset.bandId) return;
    e.preventDefault();
    removeBand(node.dataset.bandId);
  });
  svg.addEventListener("wheel", (e) => {
    if (!isMpv()) return;
    const node = eventElement(e)?.closest<SVGGElement>("[data-band-id]");
    const id = node?.dataset.bandId;

    if (!id) return;
    e.preventDefault();
    const b = state.bands.find((x) => x.id === id);

    if (!b) return;
    selectedId = id;
    b.q = clamp(b.q * (e.deltaY > 0 ? 0.92 : 1.08), EQ_MIN_Q, EQ_MAX_Q);
    state.enabled = true;
    mutate();
  }, { passive: false });

  presetSelect.onchange = () => {
    const preset = EQ_PRESETS.find((p) => p.id === presetSelect.value);

    if (!preset) { syncPreset(); return; }

    state = { enabled: true, preamp: state.preamp, bands: presetBands(preset) };
    selectedId = state.bands.find((b) => b.freq >= 1000)?.id ?? state.bands[0]?.id ?? null;
    mutate(true);
    say(`已应用预设：${preset.label}`);
  };

  power.onclick = () => {
    if (!isMpv()) return;
    state.enabled = !state.enabled;
    mutate(true);
  };

  preamp.addEventListener("input", () => {
    if (!isMpv()) return;
    state.preamp = Number(preamp.value);
    state.enabled = true;
    mutate();
  });
  preamp.addEventListener("dblclick", () => { state.preamp = 0; state.enabled = true; mutate(true); });
  // 数字框用 change（回车/失焦）而不是逐键 input：每敲一个字符就 normalize 回写会把
  // `12.5` 这类输入的中间态吞掉。滑杆仍走 input 实时预览。
  preampNum.addEventListener("change", () => {
    if (!isMpv() || preampNum.value.trim() === "") return;
    state.preamp = Number(preampNum.value);
    state.enabled = true;
    mutate(true);
  });

  const commitNumeric = (el: HTMLInputElement, fn: (n: number) => void) => {
    el.addEventListener("change", () => {
      if (!isMpv() || el.value.trim() === "") return;
      const n = Number(el.value);

      if (!Number.isFinite(n)) return;
      fn(n);
    });
  };

  commitNumeric(freq, (n) => { if (selectedId) mutateBand(selectedId, { freq: n }); });
  commitNumeric(gain, (n) => { if (selectedId) mutateBand(selectedId, { gain: n }); });
  commitNumeric(q, (n) => { if (selectedId) mutateBand(selectedId, { q: n }); });
  qRange.addEventListener("input", () => { if (selectedId) mutateBand(selectedId, { q: Number(qRange.value) }); });
  type.onchange = () => {
    if (!selectedId) return;
    const current = selected();
    const nextType = type.value;

    if (!isEqBandType(nextType)) return;
    const enteringPass = isPassFilter(nextType) && (!current || !isPassFilter(current.type));

    if (isPassFilter(nextType)) {
      const patch: Partial<EqBand> = { type: nextType, gain: 0 };

      if (enteringPass) patch.q = 0.707;

      mutateBand(selectedId, patch);
    } else {
      mutateBand(selectedId, { type: nextType });
    }
  };

  $("#eq-delete").addEventListener("click", () => { if (selectedId) removeBand(selectedId); });

  $("#eq-flat").addEventListener("click", () => {
    if (!isMpv()) return;
    state = { enabled: state.enabled, preamp: state.preamp, bands: [] };
    selectedId = null;
    mutate(true);
    say("已清空全部频段");
  });

  importApo.onclick = () => {
    if (!isMpv()) return;
    importMode = "apo";
    fileInput.value = "";
    fileInput.click();
  };

  importGraphic.onclick = () => {
    if (!isMpv()) return;
    importMode = "graphic";
    fileInput.value = "";
    fileInput.click();
  };

  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];

    if (!file) return;

    try {
      const text = await file.text();
      const result = parseApoPreset(text, importMode);
      state = normalizeEqState(result.state);
      selectedId = state.bands.find((b) => b.freq >= 1000)?.id ?? state.bands[0]?.id ?? null;
      mutate(true);
      const bits: string[] = [];

      if (result.graphicPoints) bits.push(`${result.graphicPoints} 个 GraphicEQ 频点`);

      if (result.filters) bits.push(`${result.filters} 个参数滤波`);

      if (result.preamp) bits.push(`Preamp ${fmtDb(result.preamp)}`);
      say(`已导入 ${bits.join(" · ") || file.name}${result.warnings.length ? `；${result.warnings[0]}` : ""}`, result.warnings.length > 0);
    } catch (e) {
      say(`导入失败：${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      fileInput.value = "";
    }
  };

  // —— 浮窗拖动：只在标题栏起手；按钮/开关不参与，避免点关闭时窗口先被拖走 ——
  const head = $<HTMLElement>("[data-eq-drag]");
  let winDrag: { dx: number; dy: number; pointerId: number } | null = null;

  const clampPosition = () => {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - r.width - 8);
    const maxY = Math.max(8, window.innerHeight - r.height - 8);
    panel.style.left = `${clamp(parseFloat(panel.style.left) || r.left, 8, maxX)}px`;
    panel.style.top = `${clamp(parseFloat(panel.style.top) || r.top, 8, maxY)}px`;
    panel.style.transform = "none";
  };

  head.addEventListener("pointerdown", (e) => {
    if (eventElement(e)?.closest("button, input, select")) return;
    const r = host.getBoundingClientRect();
    host.style.left = `${r.left}px`;
    host.style.top = `${r.top}px`;
    host.style.transform = "none";
    winDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, pointerId: e.pointerId };
    head.setPointerCapture(e.pointerId);
    host.classList.add("dragging");
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!winDrag || e.pointerId !== winDrag.pointerId) return;
    const r = host.getBoundingClientRect();
    host.style.left = `${clamp(e.clientX - winDrag.dx, 8, Math.max(8, window.innerWidth - r.width - 8))}px`;
    host.style.top = `${clamp(e.clientY - winDrag.dy, 8, Math.max(8, window.innerHeight - r.height - 8))}px`;
  });

  const stopWinDrag = (e?: PointerEvent) => {
    if (!winDrag) return;

    if (e && e.pointerId !== winDrag.pointerId) return;
    winDrag = null;
    host.classList.remove("dragging");
  };

  head.addEventListener("pointerup", stopWinDrag);
  head.addEventListener("pointercancel", stopWinDrag);
  head.addEventListener("lostpointercapture", () => stopWinDrag());

  const offPlayer = player.on(() => {
    const now = player.backend === "mpv";

    if (now !== backendWasMpv) syncAvailability();
    else host.classList.toggle("is-unavailable", !now);
  });

  const onResize = () => {
    clampPosition();
    syncViewMetrics();
    renderGraph();
  };

  window.addEventListener("resize", onResize);

  const close = () => {
    if (destroyed) return;
    destroyed = true;
    window.clearTimeout(applyTimer);
    window.clearTimeout(sayTimer);

    if (isMpv()) void player.setEqualizer(state);
    stopSpectrum();
    offPlayer();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey);
    layer = null;
    panel = null;
    const el = overlay;
    el.classList.add("leaving");
    // 只用定时收尾：子元素自己的进场动画 animationend 会冒泡，用它删层可能提前摘掉遮罩。
    window.setTimeout(() => el.remove(), 240);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }

    const t = eventElement(e);

    if ((e.key === "Delete" || e.key === "Backspace") && selectedId
      && !t?.closest("input, select, textarea, [contenteditable]")) {
      e.preventDefault();
      removeBand(selectedId);
    }
  };

  $<HTMLButtonElement>("#eq-close").onclick = close;
  // 真模态：点击遮罩空白处关闭，面板内部点击不冒泡成关闭。
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);

  paintAll();
  syncAvailability();
  // 初次打开统一回写一次：MPV 会立即套 af；Blink 只负责把旧开发版的 10 点默认迁成空曲线。
  void player.setEqualizer(state);
  $<HTMLButtonElement>("#eq-close").focus();
}
