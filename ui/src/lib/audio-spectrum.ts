// Quaver — 正在播放页的真实音频频谱采集。
//
// 数据源分两条：
//   web    —— 直接给播放器自己的 <audio> 建 MediaElementAudioSourceNode，不复制流；
//   engine —— mpv 在独立进程里出声，渲染层拿不到它的 PCM。这里用同一个 streamUrl
//             建一个静音 <audio> 镜像，同样走 WebAudio AnalyserNode。镜像不接扬声器
//             （AnalyserNode → 0 增益 → destination），只用于取真实解码后的 FFT/波形；
//             位置/暂停/seek 跟随 player，换曲即换源。
//
// 为什么不用假波形：AnalyserNode 的 freq/time 数据来自真实音频样本；页面收起、暂停、
// 流不可解码时都会自然衰减为静默，不做周期性伪随机动画。
import { player } from "../player";
import type { SparkleSpectrumFrame, SparkleSpectrumStatus } from "@quaver/sparkle";

const FFT_SIZE = 2048;
const SMOOTHING = 0.76;
const MIRROR_SYNC_MS = 250;
const DIRECT_FRAME_KEEPALIVE_MS = 1500;
const MIN_DB = -100;
const MAX_DB = -18;

type FrameListener = (frame: SparkleSpectrumFrame) => void;

class AudioSpectrum {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private output: GainNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private sourceKind: "web" | "engine" | "" = "";
  private attachedElement: HTMLAudioElement | null = null;
  private mirror: HTMLAudioElement | null = null;
  private mirrorUrl = "";
  private mirrorTimer: number | null = null;
  private idleTimer: number | null = null;
  private raf = 0;
  private listeners = new Set<FrameListener>();
  private rawFreq = new Float32Array(0);
  private bins = new Float32Array(0);
  private wave = new Float32Array(0);
  private current: SparkleSpectrumFrame | null = null;
  private lastDirectFrameAt = 0;
  private state: SparkleSpectrumStatus = "idle";

  status(): SparkleSpectrumStatus { return this.state; }
  enabled(): boolean { return this.state === "live" || this.state === "starting"; }

  /** 逐帧订阅。首个订阅者会拉起分析器；返回的函数退订。 */
  onFrame(cb: FrameListener): () => void {
    this.listeners.add(cb);
    this.ensureCapture();
    this.loop();

    return () => {
      this.listeners.delete(cb);

      if (!this.listeners.size) this.scheduleIdleStop();
    };
  }

  /** 按需取一帧（插件自绘用），第一次调用可能返回 null（分析器异步就绪）。 */
  frame(): SparkleSpectrumFrame | null {
    this.lastDirectFrameAt = performance.now();
    this.ensureCapture();

    return this.sample();
  }

  private setState(s: SparkleSpectrumStatus) {
    if (this.state === s) return;
    this.state = s;
  }

  private ensureCapture() {
    const desired: "web" | "engine" = player.webAudioElement ? "web" : "engine";

    // 用户在设置页切换后端后，旧 MediaElement 源不能跨 AudioContext 复用：整张图重建。
    if (this.ctx && this.sourceKind && this.sourceKind !== desired) this.teardownGraph();

    if (this.ctx) {
      this.resume();
      this.syncMirror();

      return;
    }

    const AC = window.AudioContext;

    if (!AC) { this.setState("unavailable"); return; }

    try {
      this.setState("starting");
      const ctx = new AC({ latencyHint: "playback" });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      analyser.minDecibels = MIN_DB;
      analyser.maxDecibels = MAX_DB;
      const output = ctx.createGain();
      output.gain.value = desired === "engine" ? 0 : 1;
      analyser.connect(output);
      output.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.output = output;
      this.sourceKind = desired;

      const el = player.webAudioElement;

      if (el) {
        this.source = ctx.createMediaElementSource(el);
        this.attachedElement = el;
        this.source.connect(analyser);
        this.setState("live");
      } else {
        this.ensureMirror();
        this.syncMirror();
        this.setState(player.current ? "starting" : "idle");
      }

      this.resume();
      this.syncMirror();
      this.startTimers();
    } catch (e) {
      console.warn("[spectrum] 启动 WebAudio 分析失败", e);
      this.teardownGraph();
      this.setState("unavailable");
    }
  }

  private resume() {
    const ctx = this.ctx;

    if (!ctx || ctx.state !== "suspended") return;
    void ctx.resume().catch(() => { /* 等下一次用户手势/播放事件再试 */ });
  }

  private ensureMirror() {
    const ctx = this.ctx;
    const analyser = this.analyser;

    if (!ctx || !analyser) return;

    if (!this.mirror) {
      const m = new Audio();
      m.preload = "auto";
      m.autoplay = false;
      m.addEventListener("loadedmetadata", () => {
        this.alignMirror(true);

        if (!player.paused) void m.play().catch(() => {});
      });
      m.addEventListener("canplay", () => {
        if (player.current && !player.error) this.setState("live");
      });
      m.addEventListener("error", () => {
        if (!m.getAttribute("src")) return;
        this.setState("unavailable");
      });
      this.mirror = m;
    }

    if (this.attachedElement !== this.mirror) {
      try { this.source?.disconnect(); } catch { /* noop */ }

      this.source = ctx.createMediaElementSource(this.mirror);
      this.source.connect(analyser);
      this.attachedElement = this.mirror;
    }
  }

  private syncMirror() {
    if (this.sourceKind !== "engine") return;

    if (!this.mirror) this.ensureMirror();
    const m = this.mirror;

    if (!m) return;
    const url = player.streamUrl;

    if (!url) {
      if (this.mirrorUrl) {
        this.mirrorUrl = "";

        try { m.pause(); } catch { /* noop */ }

        m.removeAttribute("src");

        try { m.load(); } catch { /* noop */ }
      }

      this.setState(player.current ? "starting" : "idle");

      return;
    }

    if (url !== this.mirrorUrl) {
      this.mirrorUrl = url;
      m.src = url;

      try { m.load(); } catch { /* noop */ }

      this.setState("starting");
    }

    this.alignMirror(false);

    if (player.paused) {
      if (!m.paused) m.pause();

      return;
    }

    if (m.paused) void m.play().catch(() => { this.setState("unavailable"); });
  }

  private alignMirror(force: boolean) {
    const m = this.mirror;

    if (!m || m.readyState < 1) return;
    const target = Math.max(0, player.time);

    if (force || Math.abs(m.currentTime - target) > 0.55) {
      try { m.currentTime = target; } catch { /* metadata 尚未就绪 */ }
    }
  }

  private startTimers() {
    if (this.mirrorTimer === null) {
      this.mirrorTimer = window.setInterval(() => this.syncMirror(), MIRROR_SYNC_MS);
    }

    if (this.idleTimer === null) {
      this.idleTimer = window.setInterval(() => {
        const idle = !this.listeners.size && performance.now() - this.lastDirectFrameAt > DIRECT_FRAME_KEEPALIVE_MS;

        if (idle && this.sourceKind === "engine") this.stopMirror();
      }, 1000);
    }
  }

  private scheduleIdleStop() {
    // 不立刻停：模式切换/视图重挂常有“先 cleanup 再 subscribe”的一拍空窗。
    window.setTimeout(() => {
      if (this.listeners.size) return;

      if (performance.now() - this.lastDirectFrameAt > DIRECT_FRAME_KEEPALIVE_MS && this.sourceKind === "engine") {
        this.stopMirror();
      }
    }, DIRECT_FRAME_KEEPALIVE_MS + 50);
  }

  private stopMirror() {
    const m = this.mirror;
    this.mirrorUrl = "";

    if (m) {
      try { m.pause(); } catch { /* noop */ }

      m.removeAttribute("src");

      try { m.load(); } catch { /* noop */ }
    }

    if (!player.webAudioElement) this.setState("idle");
  }

  private loop = () => {
    this.raf = 0;

    if (!this.listeners.size) return;
    const frame = this.sample();

    if (frame) {
      for (const cb of [...this.listeners]) {
        try { cb(frame); } catch (e) { console.warn("[spectrum] frame listener failed", e); }
      }
    }

    this.raf = window.requestAnimationFrame(this.loop);
  };

  private sample(): SparkleSpectrumFrame | null {
    // 设置页切后端时，MediaElementSource 不能迁移：检测到源类型变了就整图重建。
    const desired: "web" | "engine" = player.webAudioElement ? "web" : "engine";

    if (this.ctx && this.sourceKind && this.sourceKind !== desired) this.ensureCapture();

    if (!player.paused) this.resume();
    const analyser = this.analyser;

    if (!analyser || !this.ctx) return null;

    if (this.rawFreq.length !== analyser.frequencyBinCount) {
      this.rawFreq = new Float32Array(analyser.frequencyBinCount);
      this.bins = new Float32Array(analyser.frequencyBinCount);
      this.wave = new Float32Array(analyser.fftSize);
    }

    try {
      analyser.getFloatFrequencyData(this.rawFreq);
      analyser.getFloatTimeDomainData(this.wave);
    } catch {
      this.teardownGraph();
      this.setState("unavailable");

      return null;
    }

    let sum = 0;

    for (let i = 0; i < this.bins.length; i++) {
      const db = this.rawFreq[i];
      const n = Number.isFinite(db) ? Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB))) : 0;
      this.bins[i] = n;
    }

    for (let i = 0; i < this.wave.length; i++) {
      const x = this.wave[i];
      sum += x * x;
    }

    const level = Math.min(1, Math.sqrt(sum / Math.max(1, this.wave.length)));
    const active = !!player.current && !player.paused && this.state !== "unavailable";

    if (!this.current) {
      this.current = {
        bins: this.bins,
        wave: this.wave,
        level,
        sampleRate: this.ctx.sampleRate,
        timestamp: performance.now(),
        active,
      };
    } else {
      this.current.bins = this.bins;
      this.current.wave = this.wave;
      this.current.level = level;
      this.current.sampleRate = this.ctx.sampleRate;
      this.current.timestamp = performance.now();
      this.current.active = active;
    }

    return this.current;
  }

  private teardownGraph() {
    if (this.raf) { window.cancelAnimationFrame(this.raf); this.raf = 0; }

    if (this.mirrorTimer !== null) { window.clearInterval(this.mirrorTimer); this.mirrorTimer = null; }

    if (this.idleTimer !== null) { window.clearInterval(this.idleTimer); this.idleTimer = null; }

    try { this.source?.disconnect(); } catch { /* noop */ }

    try { this.analyser?.disconnect(); } catch { /* noop */ }

    try { this.output?.disconnect(); } catch { /* noop */ }

    try { if (this.mirror) { this.mirror.pause(); this.mirror.removeAttribute("src"); this.mirror.load(); } } catch { /* noop */ }

    const ctx = this.ctx;
    this.ctx = null;
    this.analyser = null;
    this.output = null;
    this.source = null;
    this.attachedElement = null;
    this.sourceKind = "";
    this.mirror = null;
    this.mirrorUrl = "";
    this.current = null;
    this.rawFreq = new Float32Array(0);
    this.bins = new Float32Array(0);
    this.wave = new Float32Array(0);

    if (ctx) void ctx.close().catch(() => { /* noop */ });
  }
}

export const audioSpectrum = new AudioSpectrum();
