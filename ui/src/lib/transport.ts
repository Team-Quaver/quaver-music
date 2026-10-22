// Quaver — 播放传输层抽象（渲染侧）。
// 两条实现：
//   WebTransport     —— 包一个 HTMLAudioElement（浏览器/dev/无原生引擎时的兜底，行为与旧管线一致）
//   EngineTransport  —— 主进程 mpv 引擎（native=mpv 直接出声；pcm=mpv 解码、renderer 出声）
// 位置/时长/播放态/缓冲的真相在传输实现里；曲目/队列/循环/随机仍是 player.ts 的职责。
//
// 时间轴诚实性：
//   native —— 引擎按 ~4Hz 推位置快照，渲染层外推插值；外推有闸（0.35s 上限/两帧不动冻结）。
//   pcm    —— 位置来自 renderer 实际消费的 PCM 样本，不能信 mpv `ao_pcm` 的预写时间戳。
import { getEqualizerState, getFadeMs } from "./prefs";
import { PcmSink } from "./pcm-sink";
import type { EqState } from "../../electron/audio/eq-config.ts";

export type TransportKind = "engine" | "web";

export interface AudioDeviceInfo {
  id: string;
  desc: string;
}

export type TransportEvent =
  | { type: "time" } // 位置变化（timeupdate 等价物）
  | { type: "duration" } // 时长/元数据就绪（durationchange/loadedmetadata 等价物）
  | { type: "play" }
  | { type: "pause" }
  | { type: "waiting" } // 需要缓冲（含 stalled）
  | { type: "playing" } // 真正出声（起播/缓冲恢复）
  | { type: "canplay" }
  | { type: "ending" } // PCM EOF 已到，但本地队列还有尾音（跨曲重叠窗口）
  | { type: "ended" }
  | { type: "error"; message?: string };

export interface Transport {
  readonly kind: TransportKind;
  /** engine 传输的输出拓扑；web 传输没有这个字段。 */
  readonly mode?: EngineMode;
  /** 已挂流 URL（'' = 空，播放器据此走重试语义） */
  readonly src: string;
  /** 当前位置（秒）；engine 实现为外推时钟 */
  readonly position: number;
  /** 时长（秒）；未知为 0 */
  readonly duration: number;
  /** 无媒体或暂停时为 true */
  readonly paused: boolean;
  load(url: string, opts?: { paused?: boolean; startAt?: number }): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(sec: number): void;
  /** 音量统一入口：0..1 + 静音（两条传输各自映射） */
  setVolume(vol: number, muted: boolean): void;
  listDevices?(): Promise<{ current: string; devices: AudioDeviceInfo[] }>;
  setDevice?(id: string): Promise<void>;
  /** 淡入淡出时长（ms）；引擎后端才支持 */
  setFade?(inMs: number, outMs: number): Promise<void>;
  /** Quark EQ；只有 mpv 引擎传输支持，浏览器 <audio> 没有对应实现。 */
  setEqualizer?(state: EqState): Promise<void>;
  onEvent(cb: (e: TransportEvent) => void): () => void;
  /** 退订底层事件、关闭私有 AudioContext/定时器；热切换 transport 时必须调用。 */
  dispose?(): void;
}

// —— WebTransport：HTMLAudioElement 直包 ————————————————————————————

export class WebTransport implements Transport {
  readonly kind = "web" as const;
  readonly audio = new Audio();
  private listeners = new Set<(e: TransportEvent) => void>();

  constructor() {
    this.audio.preload = "auto";
    const a = this.audio;
    const emit = (e: TransportEvent) => this.emit(e);
    a.addEventListener("timeupdate", () => emit({ type: "time" }));
    a.addEventListener("durationchange", () => emit({ type: "duration" }));
    a.addEventListener("loadedmetadata", () => emit({ type: "duration" }));
    a.addEventListener("play", () => emit({ type: "play" }));
    a.addEventListener("pause", () => emit({ type: "pause" }));
    a.addEventListener("ended", () => emit({ type: "ended" }));
    a.addEventListener("waiting", () => emit({ type: "waiting" }));
    a.addEventListener("playing", () => emit({ type: "playing" }));
    a.addEventListener("canplay", () => emit({ type: "canplay" }));
    // stalled 单独处理：仅播放中才算「需要缓冲」，静默期不误报加载指示
    a.addEventListener("stalled", () => { if (!a.paused && a.src) emit({ type: "waiting" }); });
    a.addEventListener("error", () => emit({ type: "error" }));
    // src 加载/解码失败（含 token 过期、上游断流）→ 可重试错误态（默认文案由 player 决定）
  }

  private emit(e: TransportEvent) {
    for (const fn of [...this.listeners]) { try { fn(e); } catch (err) { console.warn(err); } }
  }

  onEvent(cb: (e: TransportEvent) => void) {
    this.listeners.add(cb);

    return () => { this.listeners.delete(cb); };
  }

  get src() { return this.audio.src; }
  get position() { return this.audio.currentTime || 0; }
  get duration() { return isFinite(this.audio.duration) ? this.audio.duration : 0; }
  get paused() { return this.audio.paused; }

  async load(url: string, _opts?: { paused?: boolean; startAt?: number }) {
    // src 赋值本身就会触发媒体 load 算法，绝不能再补 load()——
    // 双 load 会把随后的 play() 以 AbortError 打断。暂停态由调用方决定是否 play()（赋 src 不会出声）。
    this.audio.src = url;
  }

  async play() {
    // AbortError（被新 load 打断）原样上抛：player.startCurrent 持有轮次令牌，由它决定重试还是放弃
    await this.audio.play();
  }

  pause() {
    try { this.audio.pause(); } catch { /* noop */ }
  }

  stop() {
    // 断开旧流下载（token 中继无 Range 请求即停）；load() 让旧 play() promise 以 AbortError 结束
    try { this.audio.pause(); } catch { /* noop */ }

    this.audio.removeAttribute("src");

    try { this.audio.load(); } catch { /* noop */ }
  }

  seek(sec: number) {
    try { this.audio.currentTime = Math.max(0, sec); } catch { /* 无媒体时抛 InvalidStateError，忽略 */ }
  }

  setVolume(vol: number, muted: boolean) {
    // 统一走 volume，避免 muted/volume 双通道状态不一致
    this.audio.volume = muted ? 0 : vol;
    this.audio.muted = false;
  }
}

// —— EngineTransport：主进程 mpv 引擎 ————————————————————————————

type EngineBridge = {
  invoke(cmd: unknown): Promise<any>;
  onEvent(cb: (ev: any) => void): () => void;
};

export type EngineMode = "native" | "pcm";

declare global {
  interface Window {
    quaverAudio?: EngineBridge;
  }
}

/** 外推单帧上限：引擎事件断供时进度最多再走 0.35s 就冻结（防时钟跳变甩飞进度条） */
const EXTRAP_CAP_SEC = 0.35;

export class EngineTransport implements Transport {
  readonly kind = "engine" as const;
  readonly mode: EngineMode;
  private bridge: EngineBridge;
  private listeners = new Set<(e: TransportEvent) => void>();
  private st = { pos: 0, dur: 0, paused: true, buffering: false, idle: true };
  private posAt = 0; // 最近一次位置采样时刻（performance.now）
  private frozen = 0; // 播放中位置连续不动的采样数（≥2 → 冻结外推）
  private loadedUrl = "";
  private pcm: PcmSink | null = null;
  private offEngine: () => void;
  private modeReady: Promise<any>;
  private progressTimer: number | null = null;
  private pcmPauseTimer: number | null = null;
  private pcmStopTimer: number | null = null;
  private pcmEpoch = 0;
  private fadingPcms = new Map<PcmSink, number>();

  constructor(bridge: EngineBridge, opts: { mode?: EngineMode } = {}) {
    this.bridge = bridge;
    this.mode = opts.mode ?? "native";

    if (this.mode === "pcm") {
      this.pcm = this.makePcm(0);
      this.progressTimer = window.setInterval(() => {
        if (!this.loadedUrl || this.st.paused) return;
        void this.invoke({
          cmd: "pcm-progress",
          pos: this.pcm?.position() ?? 0,
          queued: this.pcm?.queued() ?? 0,
        }).catch(() => {});
      }, 100);
    }

    this.offEngine = bridge.onEvent((ev) => this.onEngineEvent(ev));
    // mode 必须在 load 之前落地：引擎会按它决定 mpv 是直接开设备还是写 PCM 管道。
    this.modeReady = this.invoke({ cmd: "mode", mode: this.mode }).then((r) => {
      // 窗口重建 / 后端热切时，主进程的 PCM 世代可能已经往前走；新 renderer
      // 必须接上同一个 epoch，否则第一块 PCM 就被当成旧会话丢掉。
      const epoch = Number(r?.epoch);

      if (this.mode === "pcm" && Number.isFinite(epoch) && epoch >= 0) this.pcmEpoch = epoch;

      return r;
    }).catch(() => null);

    if (this.mode === "pcm") {
      void this.modeReady.then(() => this.invoke({ cmd: "pcm-ready" })).catch(() => {});
    }

    // 淡入淡出 / EQ 只对 engine 生效；先下发，真正拉起 mpv 时由 ensureStarted 套用。
    const f = getFadeMs();
    const eq = getEqualizerState();
    this.pcm?.setEq(eq);
    void this.invoke({ cmd: "fade", inMs: f.inMs, outMs: f.outMs }).catch(() => {});
    void this.invoke({ cmd: "eq", state: eq }).catch(() => {});
  }

  private makePcm(epoch: number): PcmSink {
    const sink = new PcmSink({
      onEnding: () => {
        if (this.pcm !== sink || epoch !== this.pcmEpoch) return;

        if (getFadeMs().outMs <= 0) return;

        this.emit({ type: "ending" });
      },
      onEnded: () => {
        if (this.pcm !== sink || epoch !== this.pcmEpoch) return; // 旧曲淡出队列的迟到 ended
        // 先让主进程把 PCM 状态收口，再通知 player 切下一首；否则 ended 触发的
        // load 可能和迟到的 pcm-ended 抢状态。
        void this.invoke({ cmd: "pcm-ended", epoch, pos: sink.position() })
          .catch(() => {})
          .then(() => this.emit({ type: "ended" }));
      },
    });

    sink.setEq(getEqualizerState());

    return sink;
  }

  /** 跨曲：旧 sink 保留已排好的 PCM，独立淡出；新 sink 立即接管主进程的新 PCM。 */
  private retirePcm(sink: PcmSink) {
    const fade = getFadeMs();
    // 旧曲降幅与新曲升幅取同一时长，才是交叉淡化；outMs 单用会比淡入短一截。
    const ms = Math.max(fade.inMs, fade.outMs);

    // 快速连切只允许一层交叉；再切就把上一条正在淡出的 sink 收掉，避免堆 AudioContext。
    this.stopFadingPcms();

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

  private stopFadingPcms() {
    for (const [sink, timer] of this.fadingPcms) {
      window.clearTimeout(timer);
      sink.destroy();
    }

    this.fadingPcms.clear();
  }

  private emit(e: TransportEvent) {
    for (const fn of [...this.listeners]) { try { fn(e); } catch (err) { console.warn(err); } }
  }

  onEvent(cb: (e: TransportEvent) => void) {
    this.listeners.add(cb);

    return () => { this.listeners.delete(cb); };
  }

  private onEngineEvent(ev: any) {
    if (!ev || typeof ev !== "object") return;

    switch (ev.t) {
      case "state": {
        const prev = { ...this.st };
        this.st = {
          pos: this.pcm ? this.pcm.position() : Number(ev.pos) || 0,
          dur: Number(ev.dur) || 0,
          paused: !!ev.paused,
          buffering: !!ev.buffering,
          idle: !!ev.idle,
        };

        if (this.pcm && this.st.paused !== prev.paused) {
          if (this.st.paused) {
            // 等主进程把 250ms 淡出走完、管道停住后再清 renderer 队列；
            // 立刻 pause 会切断淡出，也会让 resume 首块看起来“卡一下”。
            if (this.pcmPauseTimer !== null) window.clearTimeout(this.pcmPauseTimer);

            if (!this.pcm.eofPending()) {
              this.pcmPauseTimer = window.setTimeout(() => {
                this.pcmPauseTimer = null;

                if (this.st.paused) this.pcm?.pause();
              }, getFadeMs().outMs);
            }
          } else {
            if (this.pcmPauseTimer !== null) {
              window.clearTimeout(this.pcmPauseTimer);
              this.pcmPauseTimer = null;
            }

            this.pcm.resume();
          }
        }

        // 冻结检测：播放中位置两帧不动 → 停止外推（引擎卡住/谎报时时间轴冻结而非漂移）
        if (!this.st.paused && !this.st.idle && !this.st.buffering) {
          this.frozen = Math.abs(this.st.pos - prev.pos) < 0.001 ? this.frozen + 1 : 0;
        } else this.frozen = 0;
        this.posAt = performance.now();

        if (this.st.dur !== prev.dur) this.emit({ type: "duration" });

        if (this.st.paused !== prev.paused) this.emit(this.st.paused ? { type: "pause" } : { type: "play" });

        if (this.st.buffering && !prev.buffering) this.emit({ type: "waiting" });
        // 缓冲恢复，或从 idle/暂停进入出声状态 → playing（起播后 loading 指示靠它熄灭）
        const started = !this.st.paused && !this.st.idle && !this.st.buffering && (prev.idle || prev.paused || prev.buffering);

        if ((!this.st.buffering && prev.buffering) || started) this.emit({ type: "playing" });

        if (this.st.pos !== prev.pos) this.emit({ type: "time" });

        return;
      }

      case "pcm": {
        if (Number(ev.epoch) !== this.pcmEpoch) return; // 旧 MPV 会话在途的尾巴
        const d = ev.data;

        if (d instanceof Uint8Array) this.pcm?.push(d);
        else if (d instanceof ArrayBuffer) this.pcm?.push(new Uint8Array(d));
        else if (d?.data && Array.isArray(d.data)) this.pcm?.push(Uint8Array.from(d.data));

        return;
      }

      case "pcm-gain":
        if (ev.epoch !== undefined && Number(ev.epoch) !== this.pcmEpoch) return;
        this.pcm?.setGain(Number(ev.value) || 0);

        return;

      case "pcm-eq":
        if (ev.epoch !== undefined && Number(ev.epoch) !== this.pcmEpoch) return;
        this.pcm?.setEq(ev.state);

        return;

      case "pcm-eof":
        if (Number(ev.epoch) !== this.pcmEpoch) return;
        this.pcm?.markEof();

        return;
      case "ended":
        // pcm 模式的 ended 由 PcmSink 在缓冲真正播完后发出；引擎侧只发 pcm-eof。
        if (!this.pcm) this.emit({ type: "ended" });

        return;
      case "error":
        this.emit({ type: "error", message: String(ev.message ?? "") });

        return;
      case "dead":
        // mpv 退出：冻结时间轴并报错；下一次 load 会自动重拉 mpv（重试语义交给播放器）
        this.stopFadingPcms();
        this.pcm?.stop();
        this.st = { pos: this.st.pos, dur: this.st.dur, paused: true, buffering: false, idle: true };
        this.emit({ type: "error", message: String(ev.message ?? "mpv 进程退出") });

        return;
    }
  }

  get src() { return this.loadedUrl; }
  get paused() { return this.st.paused || this.st.idle; }
  get duration() { return this.st.dur; }
  get position() {
    if (this.pcm) {
      const p = this.pcm.position();

      return this.st.dur > 0 ? Math.min(p, this.st.dur) : p;
    }

    if (this.paused || this.st.buffering || this.frozen >= 2) return this.st.pos;
    const dt = (performance.now() - this.posAt) / 1000;
    const p = this.st.pos + Math.min(Math.max(dt, 0), EXTRAP_CAP_SEC);

    return this.st.dur > 0 ? Math.min(p, this.st.dur) : p;
  }

  /** 引擎播放快照（引擎侧 snapshot 命令）：CSD/SSD 重建窗口后的新页面据此接管。
   *  running=false / 引擎不在 = 问卷失败均返回 null，调用方走常规还原。 */
  async snapshot(): Promise<{ running: boolean; url: string; pos: number; dur: number; paused: boolean; buffering: boolean; idle: boolean } | null> {
    try {
      const r = await this.invoke({ cmd: "snapshot" });

      if (!r?.ok || !r.running || !r.url || r.idle) return null;

      return {
        running: true,
        url: String(r.url),
        pos: Number(r.pos) || 0,
        dur: Number(r.dur) || 0,
        paused: !!r.paused,
        buffering: !!r.buffering,
        idle: !!r.idle,
      };
    } catch { return null; }
  }

  /** 接管引擎里正在进行的播放（窗口重建后的新页面）：不重新取链挂流（load 会 replace
   *  掉正在放的歌），只把引擎的真实状态灌进本地外推时钟，src 记为引擎现挂的流。
   *  此后引擎的 4Hz state 广播照常驱动进度/歌词。 */
  adopt(url: string, s: { pos: number; dur: number; paused: boolean; buffering: boolean; idle: boolean }) {
    this.stopFadingPcms();
    this.loadedUrl = url;
    this.st = { pos: s.pos, dur: s.dur, paused: s.paused, buffering: s.buffering, idle: s.idle };
    this.pcm?.reset(s.pos);
    this.posAt = performance.now();
    this.frozen = 0;
    this.emit({ type: "duration" });
    this.emit(this.st.paused ? { type: "pause" } : { type: "play" });
    this.emit({ type: "time" });
  }

  private invoke(cmd: Record<string, unknown>): Promise<any> {
    return this.bridge.invoke(cmd);
  }

  async load(url: string, opts?: { paused?: boolean; startAt?: number }) {
    await this.modeReady;

    // 上一轮 stop 的延迟清理不能碰新歌；load 是新的 PCM 世代。
    if (this.pcmStopTimer !== null) {
      window.clearTimeout(this.pcmStopTimer);
      this.pcmStopTimer = null;
    }

    if (this.pcmPauseTimer !== null) {
      window.clearTimeout(this.pcmPauseTimer);
      this.pcmPauseTimer = null;
    }

    if (this.pcm) await this.invoke({ cmd: "pcm-ready" }).catch(() => {});
    const startAt = Math.max(0, Number(opts?.startAt) || 0);
    const epoch = ++this.pcmEpoch;

    if (this.mode === "pcm") {
      const old = this.pcm;
      const next = this.makePcm(epoch);

      next.setGain(0);
      this.pcm = next;

      if (old) this.retirePcm(old);
      next.reset(startAt);
    }

    const r = await this.invoke({ cmd: "load", url, paused: !!opts?.paused, startAt, epoch });

    if (!r?.ok) throw new Error(r?.error ?? "音频引擎加载失败");
    this.loadedUrl = url;
    this.frozen = 0;
  }

  async play() {
    await this.modeReady;

    if (this.pcmStopTimer !== null) {
      window.clearTimeout(this.pcmStopTimer);
      this.pcmStopTimer = null;
    }

    if (this.pcm) await this.invoke({ cmd: "pcm-ready" }).catch(() => {});
    this.pcm?.resume();
    // eof 后 mpv 回 idle 会卸载文件（区别于 <audio> 保留 src）——重挂由引擎侧处理（它才知道 mpv 真实 idle 态）
    const r = await this.invoke({ cmd: "play" });

    if (!r?.ok) throw new Error(r?.error ?? "音频引擎播放失败");
  }

  pause() {
    void this.invoke({ cmd: "pause" }).catch(() => {});
  }

  stop() {
    this.loadedUrl = "";
    void this.invoke({ cmd: "stop" }).catch(() => {});

    if (!this.pcm) return;

    // 先让主进程把 GainNode 包络降到 0；停止 sink 要等淡出结束。
    // load() 会取消这个 timer，所以切歌时不会出现旧 stop 掐掉新歌。
    if (this.pcmStopTimer !== null) window.clearTimeout(this.pcmStopTimer);

    const fadeOutMs = getFadeMs().outMs;

    if (fadeOutMs <= 0) {
      this.pcmStopTimer = null;
      this.pcm.stop();

      return;
    }

    this.pcmStopTimer = window.setTimeout(() => {
      this.pcmStopTimer = null;
      this.pcm?.stop();
    }, fadeOutMs + 40);
  }

  seek(sec: number) {
    // 乐观位置：进度条/歌词立刻跟手，引擎 state 事件（含真实边界钳制）马上对齐
    const at = Math.max(0, sec);
    const epoch = ++this.pcmEpoch;

    this.stopFadingPcms();
    this.pcm?.reset(at);
    this.st.pos = at;
    this.posAt = performance.now();
    this.frozen = 0;
    this.emit({ type: "time" });
    void this.invoke({ cmd: "seek", sec: at, epoch }).catch(() => {});
  }

  dispose() {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    if (this.pcmPauseTimer !== null) {
      window.clearTimeout(this.pcmPauseTimer);
      this.pcmPauseTimer = null;
    }

    if (this.pcmStopTimer !== null) {
      window.clearTimeout(this.pcmStopTimer);
      this.pcmStopTimer = null;
    }

    try { this.offEngine(); } catch {}

    this.stopFadingPcms();
    this.pcm?.destroy();
    this.pcm = null;
  }

  setVolume(vol: number, muted: boolean) {
    // 兼容模式先本地落 GainNode（0 延迟），IPC 再让主进程记住状态并同步淡入淡出包络。
    this.pcm?.setGain(muted ? 0 : vol);
    void this.invoke({ cmd: "volume", value: vol }).catch(() => {});
    void this.invoke({ cmd: "mute", value: muted }).catch(() => {});
  }

  async listDevices() {
    const r = await this.invoke({ cmd: "devices" });

    if (!r?.ok) throw new Error(r?.error ?? "获取音频设备列表失败");

    return { current: String(r.current ?? "auto"), devices: (r.devices ?? []) as AudioDeviceInfo[] };
  }

  async setDevice(id: string) {
    const r = await this.invoke({ cmd: "device", id });

    if (!r?.ok) throw new Error(r?.error ?? "切换音频设备失败");
  }

  async setFade(inMs: number, outMs: number) {
    await this.invoke({ cmd: "fade", inMs, outMs });
  }

  async setEqualizer(state: EqState) {
    // 兼容模式的 EQ 先落 renderer 滤波链，主进程再同步状态；不等返回才有声音变化。
    this.pcm?.setEq(state);
    const r = await this.invoke({ cmd: "eq", state });

    if (!r?.ok) throw new Error(r?.error ?? "应用 EQ 失败");
  }
}
