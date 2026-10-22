// Quaver — 原生兼容模式的 renderer PCM 播放器。
//
// MPV 在兼容模式下只写 48kHz / stereo / float32 的裸 PCM；主线程把 PCM 塞进单个
// AudioWorklet 的 ring buffer，最终由 AudioContext 打开本机音频设备。媒体会话因此
// 归属 renderer，Oopz/Discord/OBS 的窗口音频捕获能看到它。
//
// 不再使用 AudioBufferSourceNode：实时音频不需要每秒新建几十个节点，也不会因主线程
// 调度抖动在相邻 source 之间制造微小断点。
const PCM_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_FRAME_BYTES = PCM_CHANNELS * 4;
const WORKLET_URL = "/pcm-worklet.js";

type WorkletStatus = {
  playedFrames?: number;
  availableFrames?: number;
  underrun?: boolean;
};

export interface PcmSinkOpts {
  /** 最后一块 PCM 播完（且收到 pcm-eof）时回调。 */
  onEnded: () => void;
}

export class PcmSink {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private gain: GainNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private pending: Float32Array[] = [];
  private pendingFrames = 0;
  private gainValue = 1;
  private basePos = 0;
  private playedFrames = 0;
  private availableFrames = 0;
  private lastStatusAt = 0;
  private underrun = false;
  private started = false;
  private eof = false;
  private ended = false;
  private suspended = false;
  private disposed = false;
  private opts: PcmSinkOpts;

  constructor(opts: PcmSinkOpts) {
    this.opts = opts;
  }

  private ensureCtx(): AudioContext | null {
    if (this.disposed) return null;

    if (this.ctx) {
      if (!this.suspended && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});

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
    const gain = ctx.createGain();
    this.ctx = ctx;
    this.input = input;
    this.gain = gain;
    input.connect(gain);
    gain.gain.value = this.gainValue;
    gain.connect(ctx.destination);
    void this.initWorklet(ctx);

    if (this.suspended) void ctx.suspend().catch(() => {});
    else if (ctx.state === "suspended") void ctx.resume().catch(() => {});

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
    this.ended = false;
    this.worklet?.port.postMessage({ type: "reset" });
  }

  pause() {
    if (this.eofPending()) return;
    this.suspended = true;
    void this.ctx?.suspend().catch(() => {});
  }

  eofPending(): boolean {
    return this.eof && !this.ended && (this.availableFrames > 0 || this.pendingFrames > 0);
  }

  resume() {
    this.eof = false;
    this.suspended = false;
    void this.ctx?.resume().catch(() => {});
  }

  stop() {
    this.reset(0);
  }

  markEof() {
    this.eof = true;
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
    this.gain?.disconnect();
    this.input = null;
    this.gain = null;

    if (this.ctx) void Promise.resolve(this.ctx.close()).catch(() => {});
    this.ctx = null;
  }

  private maybeEnded() {
    if (this.ended || !this.eof || this.availableFrames > 0 || this.pendingFrames > 0) return;
    this.ended = true;
    this.opts.onEnded();
  }
}
