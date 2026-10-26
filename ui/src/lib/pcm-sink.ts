// Quaver — 原生兼容模式的 renderer PCM 播放器。
//
// MPV 在兼容模式下只写 48kHz / stereo / float32 的裸 PCM；主线程把 PCM 塞进单个
// AudioWorklet 的 ring buffer，最终由 AudioContext 打开本机音频设备。媒体会话因此
// 归属 renderer，Oopz/Discord/OBS 的窗口音频捕获能看到它。
//
// 不再使用 AudioBufferSourceNode：实时音频不需要每秒新建几十个节点，也不会因主线程
// 调度抖动在相邻 source 之间制造微小断点。
//
// 本模块（含 PcmController 与 PcmEngineTransport）只被 pcm 兼容模式动态 import，
// 不进首屏闭包（verify-bundle 的首屏预算守着这条线）。
import { getEqualizerState, getFadeMs } from "./prefs";
import { EngineTransport, type EngineBridge } from "./transport";
import { pcmSpectrumAnalyser, setPcmSpectrumAnalyser } from "./pcm-analyser";
import type { EqBandType, EqState } from "../../electron/audio/eq-config.ts";

const PCM_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_FRAME_BYTES = PCM_CHANNELS * 4;
const WORKLET_URL = "/pcm-worklet.js";

function filterType(type: EqBandType): BiquadFilterType {
  if (type === "lowShelf") return "lowshelf";

  if (type === "highShelf") return "highshelf";

  if (type === "lowPass") return "lowpass";

  if (type === "highPass") return "highpass";

  return "peaking";
}

type WorkletStatus = {
  playedFrames?: number;
  availableFrames?: number;
  underrun?: boolean;
};

export interface PcmSinkOpts {
  /** 最后一块 PCM 播完（且收到 pcm-eof）时回调。 */
  onEnded: () => void;
  /** 收到 EOF、但队列里还有声音时先回调一次，给跨曲淡出留出重叠窗口。 */
  onEnding?: () => void;
}

export class PcmSink {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private preamp: GainNode | null = null;
  private gain: GainNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** AnalyserNode 必须有一条通往 destination 的静音下游，音频图才会持续拉取 FFT。 */
  private analyserOutput: GainNode | null = null;
  private pending: Float32Array[] = [];
  private pendingFrames = 0;
  private eq: EqState = { enabled: false, preamp: 0, bands: [] };
  private gainValue = 1;
  private basePos = 0;
  private playedFrames = 0;
  private availableFrames = 0;
  private lastStatusAt = 0;
  private underrun = false;
  private started = false;
  private eof = false;
  private ending = false;
  private ended = false;
  private suspended = false;
  private disposed = false;
  private opts: PcmSinkOpts;
  /** 频谱分析旁路不能影响 PCM 播放：分析节点异常时仍继续出力。 */
  private analyserHint = false;

  constructor(opts: PcmSinkOpts) {
    this.opts = opts;
  }

  private ensureCtx(): AudioContext | null {
    if (this.disposed) return null;

    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});

      return this.ctx;
    }

    const AC = window.AudioContext;

    if (!AC) return null;

    let ctx: AudioContext;

    try {
      ctx = new AC({ latencyHint: "playback", sampleRate: PCM_RATE });
    } catch {
      ctx = new AC({ latencyHint: "playback" });
    }

    const input = ctx.createGain();
    const preamp = ctx.createGain();
    const gain = ctx.createGain();
    this.ctx = ctx;
    this.input = input;
    this.preamp = preamp;
    this.gain = gain;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.76;
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -18;
    this.analyserOutput = ctx.createGain();
    this.analyserOutput.gain.value = 0;
    this.analyser.connect(this.analyserOutput);
    this.analyserOutput.connect(ctx.destination);
    setPcmSpectrumAnalyser(this.analyser);
    this.rebuildFilters();
    void this.initWorklet(ctx);

    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    return ctx;
  }

  private async initWorklet(ctx: AudioContext): Promise<void> {
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);

      if (this.disposed) return;

      const node = new AudioWorkletNode(ctx, "quaver-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [PCM_CHANNELS],
      });

      node.port.onmessage = (event) => this.onWorkletStatus(event.data);

      if (this.suspended) node.port.postMessage({ type: "pause" });

      node.connect(this.input!);
      this.worklet = node;
      this.flushPending();
    } catch (e) {
      console.warn("[pcm-sink] AudioWorklet init failed:", String(e));
    }
  }

  private flushPending() {
    const node = this.worklet;

    if (!node || this.disposed) return;

    for (const chunk of this.pending) {
      node.port.postMessage({ type: "pcm", data: chunk.buffer }, [chunk.buffer]);
    }

    this.pending = [];
    this.pendingFrames = 0;
  }

  private onWorkletStatus(raw: WorkletStatus) {
    if (!raw) return;

    const played = Number(raw.playedFrames);
    const available = Number(raw.availableFrames);

    if (!Number.isFinite(played) || !Number.isFinite(available)) return;
    this.playedFrames = Math.max(0, played);
    this.availableFrames = Math.max(0, available);
    this.lastStatusAt = performance.now();
    this.started = this.started || this.playedFrames > 0 || this.availableFrames > 0;
    this.underrun = !!raw.underrun;

    if (this.eof && this.availableFrames === 0 && this.pendingFrames === 0) this.maybeEnded();
  }

  /** 用户音量/静音/淡入淡出包络：AudioParam 改值立即生效，不等 mpv 预写缓冲区。 */
  setGain(value: number) {
    this.gainValue = Math.max(0, Math.min(1, Number(value) || 0));

    if (this.gain) this.gain.gain.value = this.gainValue;
  }

  /** 跨曲/停止用：旧 sink 独立跑一条 GainNode 下降曲线，不跟新 sink 的 pcm-gain 混在一起。 */
  fadeOut(ms: number) {
    const ctx = this.ctx;
    const gain = this.gain;

    if (!ctx || !gain) {
      this.setGain(0);

      return;
    }

    const now = ctx.currentTime;
    const end = now + Math.max(0, ms) / 1000;

    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, end);
  }

  /** 兼容模式的 EQ 在 renderer 处理，避免 mpv af 慢一个预写缓冲。 */
  setEq(state: EqState) {
    this.eq = state;

    if (this.ctx) this.rebuildFilters();
  }

  /** 新流 / seek / 窗口接管：清掉旧声音，把时间轴钉到 pos。 */
  reset(pos = 0) {
    this.pending = [];
    this.pendingFrames = 0;
    this.basePos = Math.max(0, Number(pos) || 0);
    this.playedFrames = 0;
    this.availableFrames = 0;
    this.lastStatusAt = 0;
    this.underrun = false;
    this.started = false;
    this.eof = false;
    this.ending = false;
    this.ended = false;
    this.worklet?.port.postMessage({ type: "reset" });
  }

  pause() {
    // 不 suspend AudioContext：Windows WASAPI 重新激活可能吞掉几百毫秒甚至数秒。
    // worklet 在暂停时输出静音但不消费环形队列，恢复时从原帧继续。
    this.suspended = true;
    this.worklet?.port.postMessage({ type: "pause" });
  }

  eofPending(): boolean {
    return this.eof && !this.ended && (this.availableFrames > 0 || this.pendingFrames > 0);
  }

  resume() {
    this.suspended = false;
    void this.ctx?.resume().catch(() => {});
    this.worklet?.port.postMessage({ type: "resume" });
  }

  stop() {
    this.reset(0);
  }

  markEof() {
    this.eof = true;

    if (!this.ending) {
      this.ending = true;
      this.opts.onEnding?.();
    }

    this.maybeEnded();
  }

  position(): number {
    if (!this.started) return this.basePos;

    let frames = this.playedFrames;

    // status 约 20ms 一次；在队列未 underrun 时做很短的本地外推，歌词不必等 IPC。
    if (!this.suspended && !this.underrun && this.lastStatusAt > 0) {
      const elapsed = Math.min(0.05, Math.max(0, (performance.now() - this.lastStatusAt) / 1000));
      frames += elapsed * PCM_RATE;
    }

    return this.basePos + frames / PCM_RATE;
  }

  /** 已进 worklet 但还没播到的时长；主进程用这个值做管道背压。 */
  queued(): number {
    return (this.availableFrames + this.pendingFrames) / PCM_RATE;
  }

  push(data: Uint8Array) {
    if (this.disposed) return;
    const ctx = this.ensureCtx();

    if (!ctx) return;

    const bytes = Math.floor(data.byteLength / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;

    if (bytes <= 0) return;

    const f32 = new Float32Array(bytes / 4);
    new Uint8Array(f32.buffer).set(new Uint8Array(data.buffer, data.byteOffset, bytes));
    this.ended = false;
    this.started = true;

    if (this.worklet) {
      this.worklet.port.postMessage({ type: "pcm", data: f32.buffer }, [f32.buffer]);

      return;
    }

    this.pending.push(f32);
    this.pendingFrames += f32.length / PCM_CHANNELS;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];

    try { this.worklet?.port.close(); } catch {}

    try { this.worklet?.disconnect(); } catch {}

    this.worklet = null;

    this.input?.disconnect();
    this.preamp?.disconnect();

    for (const f of this.filters) f.disconnect();

    this.filters = [];
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.analyserOutput?.disconnect();

    // 快速切歌时旧 sink 会晚于新 sink 销毁；只能撤掉自己的引用，
    // 不能把新 sink 已发布的 AnalyserNode 一并清空。
    if (this.analyser && pcmSpectrumAnalyser() === this.analyser) setPcmSpectrumAnalyser(null);

    this.analyser = null;
    this.analyserOutput = null;
    this.analyserHint = false;
    this.input = null;
    this.preamp = null;
    this.gain = null;

    if (this.ctx) void Promise.resolve(this.ctx.close()).catch(() => {});
    this.ctx = null;
  }

  private rebuildFilters() {
    const ctx = this.ctx;
    const input = this.input;
    const preamp = this.preamp;
    const gain = this.gain;

    if (!ctx || !input || !preamp || !gain) return;

    input.disconnect();
    preamp.disconnect();

    for (const f of this.filters) f.disconnect();

    this.filters = [];
    gain.disconnect();
    // 这条输出链的节点连接被整段拆掉，分析旁路的旧连线也一起失效。
    // 不把 hint 复位，下一次 connectAnalyser 会被误判为「已连接」而跳过，
    // 兼容模式频谱就会在首次调 EQ / 切预置后永久断掉。
    this.analyserHint = false;

    const eq = this.eq;
    preamp.gain.value = eq.enabled ? 10 ** (eq.preamp / 20) : 1;
    input.connect(preamp);

    let tail: AudioNode = preamp;

    if (eq.enabled) {
      for (const band of eq.bands) {
        const f = ctx.createBiquadFilter();
        f.type = filterType(band.type);
        f.frequency.value = Math.min(Math.max(10, band.freq), ctx.sampleRate / 2 - 1);
        f.Q.value = band.q;
        f.gain.value = band.gain;
        tail.connect(f);
        tail = f;
        this.filters.push(f);
      }
    }

    tail.connect(gain);
    this.connectAnalyser(gain);
    gain.gain.value = this.gainValue;
    gain.connect(ctx.destination);
  }

  private connectAnalyser(gain: GainNode): void {
    if (!this.analyser || this.analyserHint) return;

    try {
      gain.connect(this.analyser);
      this.analyserHint = true;
    } catch {
      this.analyserHint = false;
    }
  }

  private maybeEnded() {
    if (this.ended || !this.eof || this.availableFrames > 0 || this.pendingFrames > 0) return;
    this.ended = true;
    this.opts.onEnded();
  }
}

// —— PcmController：pcm 兼容模式的传输层状态机 ——————————————————————————
// 从 transport.ts 拆出来并随 sink 一起动态加载：native 模式的首屏闭包
// 不为兼容模式付一分钱。世代（epoch）校验也在这里做：旧 MPV 会话在途的尾巴一律丢弃。

export interface PcmControllerOpts {
  invoke: (cmd: Record<string, unknown>) => Promise<any>;
  /** 当前 PCM 世代（transport 的 pcmEpoch；窗口重建/热切时会跟主进程对齐） */
  epoch(): number;
  /** 引擎侧已挂流且在播时为 true（驱动 10Hz 进度上报）。 */
  progressDue: () => boolean;
  /** 收到 EOF、但队列里还有声音时先回调一次，给跨曲淡出留出重叠窗口。 */
  onEnding: () => void;
  /** 最后一块 PCM 播完（且收到 pcm-eof）时回调。 */
  onEnded: () => void;
}

export class PcmController {
  private sink: PcmSink;
  private gainValue = 1;
  private eqValue = getEqualizerState();
  private progressTimer: number | null = null;
  private pauseTimer: number | null = null;
  private stopTimer: number | null = null;
  private paused = true;
  private fadingPcms = new Map<PcmSink, number>();
  private opts: PcmControllerOpts;

  constructor(opts: PcmControllerOpts) {
    this.opts = opts;
    this.sink = this.makeSink(opts.epoch());

    this.progressTimer = window.setInterval(() => {
      if (!opts.progressDue()) return;
      void opts.invoke({ cmd: "pcm-progress", pos: this.sink.position(), queued: this.sink.queued() }).catch(() => {});
    }, 100);
  }

  private makeSink(epoch: number): PcmSink {
    const sink = new PcmSink({
      onEnding: () => {
        if (this.sink !== sink || epoch !== this.opts.epoch()) return;

        if (getFadeMs().outMs <= 0) return;

        this.opts.onEnding();
      },
      onEnded: () => {
        if (this.sink !== sink || epoch !== this.opts.epoch()) return; // 旧曲淡出队列的迟到 ended
        // 先让主进程把 PCM 状态收口，再通知 player 切下一首；否则 ended 触发的
        // load 可能和迟到的 pcm-ended 抢状态。
        void this.opts.invoke({ cmd: "pcm-ended", epoch, pos: sink.position() })
          .catch(() => {})
          .then(() => this.opts.onEnded());
      },
    });

    sink.setGain(this.gainValue);
    sink.setEq(this.eqValue);

    return sink;
  }

  position() { return this.sink.position(); }

  /** 引擎 state 广播的暂停态翻转：淡出走完再挂起渲染，恢复时立刻 resume。 */
  onPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;

    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    if (paused) {
      // 等主进程的 GainNode 淡出走完、FIFO 背压停住后再冻结 worklet。
      // 立刻 pause 会切断淡出，也会让恢复时的首块 PCM 听起来卡一下。
      if (!this.sink.eofPending()) {
        this.pauseTimer = window.setTimeout(() => {
          this.pauseTimer = null;

          if (this.paused) this.sink.pause();
        }, getFadeMs().outMs);
      }
    } else {
      this.sink.resume();
    }
  }

  /** 引擎推来的 PCM 事件（pcm / pcm-gain / pcm-eq / pcm-eof），按世代丢弃旧会话尾巴。 */
  feed(ev: any) {
    switch (ev.t) {
      case "pcm": {
        if (Number(ev.epoch) !== this.opts.epoch()) return; // 旧 MPV 会话在途的尾巴
        const d = ev.data;

        if (d instanceof Uint8Array) this.sink.push(d);
        else if (d instanceof ArrayBuffer) this.sink.push(new Uint8Array(d));
        else if (d?.data && Array.isArray(d.data)) this.sink.push(Uint8Array.from(d.data));

        return;
      }

      case "pcm-gain":
        // 音量/EQ 是跨世代的全局播放状态；只有 PCM 样本和 EOF 需要按 epoch 丢弃。
        // 切歌时若把新主进程包络误判成旧世代，新 sink 会永久停在 0 增益。
        this.gainValue = Number(ev.value) || 0;
        this.sink.setGain(this.gainValue);

        return;
      case "pcm-eq":
        this.eqValue = ev.state;
        this.sink.setEq(this.eqValue);

        return;
      case "pcm-eof":
        if (Number(ev.epoch) !== this.opts.epoch()) return;
        this.sink.markEof();

        return;
    }
  }

  /** 新流：上一轮 stop 的延迟清理不能碰新歌；建新一代 sink，旧曲独立淡出（交叉淡化）。 */
  load(epoch: number, startAt: number, paused: boolean) {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    const old = this.sink;
    const next = this.makeSink(epoch);

    this.sink = next;

    if (old) this.retirePcm(old);
    next.reset(startAt);
    this.paused = paused;

    if (paused) next.pause();
    else next.resume();
  }

  /** 跨曲：旧 sink 保留已排好的 PCM，独立淡出；新 sink 立即接管主进程的新 PCM。 */
  private retirePcm(sink: PcmSink) {
    const fade = getFadeMs();
    // 旧曲降幅与新曲升幅取同一时长，才是交叉淡化；outMs 单用会比淡入短一截。
    const ms = Math.max(fade.inMs, fade.outMs);

    // 快速连切只允许一层交叉；再切就把上一条正在淡出的 sink 收掉，避免堆 AudioContext。
    this.stopFading();

    if (ms <= 0) {
      sink.destroy();

      return;
    }

    sink.fadeOut(ms);

    const timer = window.setTimeout(() => {
      sink.destroy();
      this.fadingPcms.delete(sink);
    }, ms + 60);

    this.fadingPcms.set(sink, timer);
  }

  private stopFading() {
    for (const [sink, timer] of this.fadingPcms) {
      window.clearTimeout(timer);
      sink.destroy();
    }

    this.fadingPcms.clear();
  }

  reset(pos: number) {
    this.stopFading();
    this.sink.reset(pos);

    if (this.paused) this.sink.pause();
    else this.sink.resume();
  }

  /** Immediate seek：跳过旧 sink 的淡出，立刻从新时间轴出声。 */
  resetNow(pos: number) {
    this.stopFading();
    this.sink.reset(pos);

    if (this.paused) this.sink.pause();
    else this.sink.resume();
  }

  resume() {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    this.sink.resume();
  }

  /** transport.stop 的口径：先让主进程把 GainNode 包络降到 0，停止 sink 要等淡出结束。
   *  load() 会取消这个 timer，所以切歌时不会出现旧 stop 掐掉新歌。 */
  stop() {
    if (this.stopTimer !== null) window.clearTimeout(this.stopTimer);

    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    const fadeOutMs = getFadeMs().outMs;

    if (fadeOutMs <= 0) {
      this.stopTimer = null;
      this.sink.stop();

      return;
    }

    this.stopTimer = window.setTimeout(() => {
      this.stopTimer = null;
      this.sink.stop();
    }, fadeOutMs + 40);
  }

  /** mpv dead：立即停，不留给淡出。 */
  kill() {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    this.stopFading();
    this.sink.stop();
  }

  setGain(v: number) {
    this.gainValue = Math.max(0, Math.min(1, Number(v) || 0));
    this.sink.setGain(this.gainValue);
  }

  setEq(state: EqState) {
    this.eqValue = state;
    this.sink.setEq(state);
  }

  destroy() {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    this.stopFading();
    this.sink.destroy();
  }
}

// —— PcmEngineTransport：pcm 兼容模式的完整传输实现 ————————————————————
// 继承 native 版 EngineTransport，把渲染侧状态机挂进父类的 pcmHook；父类里
// 不留任何 pcm 分支，native 模式的首屏闭包不为兼容模式付一分钱。
export class PcmEngineTransport extends EngineTransport {
  private ctl: PcmController;

  readonly pcmAnalyser = () => pcmSpectrumAnalyser();

  constructor(bridge: EngineBridge) {
    super(bridge, { mode: "pcm" });

    this.ctl = new PcmController({
      invoke: (cmd) => this.invoke(cmd),
      epoch: () => this.pcmEpoch,
      progressDue: () => !!this.loadedUrl && !this.st.paused,
      onEnding: () => this.emit({ type: "ending" }),
      onEnded: () => this.emit({ type: "ended" }),
    });

    this.pcmHook = {
      position: () => this.ctl.position(),
      onPaused: (paused) => this.ctl.onPaused(paused),
      feed: (ev) => this.ctl.feed(ev),
      load: (epoch, startAt, paused) => this.ctl.load(epoch, startAt, paused),
      reset: (pos) => this.ctl.reset(pos),
      resetNow: (pos) => this.ctl.resetNow(pos),
      resume: () => this.ctl.resume(),
      stop: () => this.ctl.stop(),
      kill: () => this.ctl.kill(),
      setGain: (v) => this.ctl.setGain(v),
      setEq: (state) => this.ctl.setEq(state),
      destroy: () => this.ctl.destroy(),
    };

  }
}
