// Quaver — 主进程音频引擎（Liino 后端：纯 Go 音频管线，经 koffi FFI 同进程调用）。
//
// 为什么单独一个类而不是往 engine.ts 里塞分支：mpv 那条线要维护 spawn/IPC/看门狗/PCM 管道
// 四套状态机，任何一处判断漏了都是一次线上无声。Liino 是**同进程会话**（没有子进程、没有
// FIFO、没有 IPC socket），把它压进 mpv 的骨架只会让两边都更难读。
//
// 契约不变：渲染层还是那一套 `quaver:audio` 命令 + `quaver:audio-event` 广播
// （见 engine.ts 顶部注释与 src/lib/transport.ts），player / MPRIS / 桌面歌词零改动。
//
// 两条 FFI 纪律（违反就是「界面卡死」级别）：
//   1. **绝不用 waitEvent()**：它阻塞调用线程。位置广播、取流中继、窗口事件都在同一条
//      主进程事件循环上 —— 阻塞 5s 等于冻窗 + 断流。只用非阻塞的 nextEvent() 轮询。
//   2. 位置读 clock()（亚毫秒、不碰设备），状态读事件里的 snapshot；两者都只在会话存在时读。
import { type BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import type { Liino, LiinoPlayer } from "@team-quaver/liino-node";
import { normalizeEqState, type EqState } from "./eq-config.ts";
import type { EngineLog, EngineState } from "./engine.ts";
import {
  caught, liinoDevicePlan, liinoEqPlan, liinoMasterGain, liinoStateFields, resolveLiinoLibrary,
  type LiinoDeviceEntry, type LiinoDevicePlan, type LiinoEqPlan, type LiinoRuntime, type RemoteJson,
} from "./liino-runtime.ts";

/** 事件轮询周期：25ms 比 30ms 的淡入淡出步进更细，loaded/ended 都在肉眼内落地。 */
const POLL_MS = 25;

/** 位置广播节流：与 mpv 引擎一致（4Hz 足够渲染层外推出平滑进度/歌词）。 */
const POS_BROADCAST_MS = 250;

/** 一次 FFI 轮询最多排空多少条事件：洪水（设备反复掉线）时也要给事件循环留空隙。 */
const MAX_EVENTS_PER_TICK = 16;

/** 开发态随包目录：ui/electron/audio → 仓库根的 vendor/Liino/build（stage 脚本产出）。 */
function vendorBuildRoot(): string {
  return fileURLToPath(new URL("../../../vendor/Liino/build", import.meta.url));
}

/** QUAVER_LIINO 认库文件也认库目录（与 bins.ts 的 QUAVER_MPV 同一口气：排障刚需）。 */
function liinoOverride(): string {
  return String(process.env.QUAVER_LIINO ?? process.env.QUAVER_LIINO_LIB ?? process.env.QUAVER_LIINO_DIR ?? "").trim();
}

/** snapshot()/clock() 的 JSON 里我们真消费的字段（自己收口，不依赖绑定的类型口径）。 */
interface SnapshotFields {
  state?: string;
  position_ms?: number;
  duration_ms?: number;
  buffered_ms?: number;
  device?: string;
  driver?: string;
  decoder?: string;
  codec?: string;
  underruns?: number;
  error?: string;
}

interface ClockFields {
  position_ms?: number;
  buffer_pos_ms?: number;
  latency_ms?: number;
}

interface EventFields {
  kind?: string;
  name?: string;
  gen?: number;
  seek_gen?: number;
  snapshot?: SnapshotFields;
}

/** 命令失败回包：ok 恒为 false 的具名事实，接入方据此走错误分支。 */
interface CommandFailure {
  ok: false;
  error: string;
}

/** Liino 的 create() 配置：应用名进 PipeWire/WASAPI 的媒体角色，设备/音量/EQ 随后由命令覆盖。 */
function sessionConfig(device: string, eq: LiinoEqPlan) {
  return {
    app_name: "Quaver Music",
    stream_name: "Quaver Music",
    device_id: device === "auto" ? "" : device,
    // 安全限幅会把 F32 软削成非零底噪；正常流交给 0dBFS 防爆音，不开它。
    limiter: false,
    eq: eq.bands,
    // PipeWire 的 quantum 会跟随会话设置；显式 5ms period 仍交给驱动建议值，
    // 但 ring/preroll 提高到 ≥200ms，避免 Easy Effects 这类复杂图里 1 quantum(21ms)
    // 的瞬时消耗把 50ms preroll 打穿，造成“状态在走但输出全是静音”。
    preroll_ms: 200,
  };
}

/** 渲染层命令的值判断按各 case 就地窄化；结构化克隆后的命令包就是 JSON 对象，
 *  值域取 Liino 侧声明的 RemoteJson（递归 JSON），不用 any/unknown 兜整个包。 */
type CommandEnvelope = { [key: string]: import("./liino-runtime.ts").RemoteJson };

/** 淡出收尾时要执行的动作；null = 无。 */
type AfterFade = (() => void) | null;

/** 引擎 → 渲染层的广播（quaver:audio-event）。t 是事件种类，其余字段按文档各取。 */
interface AudioEvent {
  t: "state" | "loaded" | "ended" | "error";
  pos?: number;
  dur?: number;
  paused?: boolean;
  buffering?: boolean;
  idle?: boolean;
  epoch?: number;
  message?: string;
}

/** 命令回包的统一形状：各 case 只填自己关心的字段，未填的一律 undefined。
 *  渲染层本来就把回包当 JSON 读，这里给探针/自检一个可命名的边界。 */
export interface EngineReply {
  ok: boolean;
  error?: string;
  backend?: string;
  mode?: string;
  available?: boolean;
  reason?: string;
  source?: string;
  payload?: string;
  version?: string;
  running?: boolean;
  device?: string;
  current?: string;
  devices?: LiinoDeviceEntry[];
  captureCompatible?: boolean;
  decoder?: string;
  gen?: number;
  epoch?: number;
  stale?: boolean;
  pos?: number;
  dur?: number;
  paused?: boolean;
  buffering?: boolean;
  idle?: boolean;
  url?: string;
  state?: EqState;
  bands?: number;
  dropped?: number;
  note?: string;
  fade?: { inMs: number; outMs: number };
}

export class LiinoEngine {
  readonly kind = "liino" as const;

  baseUrl: string;
  getWin: () => BrowserWindow | null;
  log: EngineLog;
  st: EngineState;
  device: string;                    // 输出设备（"auto" = 平台默认）
  lastUrl: string;                   // 最近挂过的流（曲末后 play 重挂由 Liino 自己接管）
  mode: "native";                    // Liino 只有原生直出这一种拓扑
  /** 渲染层世代（load/seek 带上来）：比它旧的一律丢弃，切歌竞态不靠时序碰运气。 */
  epoch: number;
  /** 已发过曲末的世代：同一首只发一次 ended（同 engine.ts 的 endedEntryId 语义）。 */
  endedEpoch: number;
  eq: EqState;
  eqPlan: LiinoEqPlan;
  fade: { inMs: number; outMs: number };
  fadeLevel: number;
  fadeTarget: number;
  fadeTimer: NodeJS.Timeout | null;
  pendingAfterFadeOut: AfterFade;
  lastPosSent: number;
  wired: boolean;
  runtime: LiinoRuntime;             // libliino 解析结果（path/source/note）
  liino: Liino | null;               // FFI 库句柄（null = 未加载）
  player: LiinoPlayer | null;        // native 播放会话（null = 未创建/已销毁）
  pollTimer: NodeJS.Timeout | null;
  dead: boolean;                     // native 会话硬错：下一条命令重建
  note: string;                      // 最近一次失败的人话原因（进 status.reason）

  constructor() {
    this.baseUrl = "";
    this.getWin = () => null;
    this.log = () => {};

    this.st = { pos: 0, dur: 0, paused: true, buffering: false, idle: true, volume: 0.8, muted: false };
    this.device = "auto";
    this.lastUrl = "";
    this.mode = "native";
    this.epoch = 0;
    this.endedEpoch = -1;
    this.eq = normalizeEqState(null);
    this.eqPlan = liinoEqPlan(this.eq);
    this.fade = { inMs: 400, outMs: 250 };
    this.fadeLevel = 1;
    this.fadeTarget = 1;
    this.fadeTimer = null;
    this.pendingAfterFadeOut = null;
    this.lastPosSent = 0;
    this.wired = false;
    this.runtime = resolveLiinoLibrary({});
    this.liino = null;
    this.player = null;
    this.pollTimer = null;
    this.dead = false;
    this.note = "";
  }

  /** 解析随包/开发态的 libliino（幂等：init 与 probe 都走这一条）。 */
  resolveRuntime(): LiinoRuntime {
    this.runtime = resolveLiinoLibrary({
      override: liinoOverride(),
      resourcesRoot: process.resourcesPath,
      vendorBuildRoot: vendorBuildRoot(),
    });

    return this.runtime;
  }

  /** 后端切换前的实证：库要能真被 dlopen 才算可用（找不到就老实回到 mpv）。 */
  async probe(): Promise<boolean> {
    this.resolveRuntime();

    return !!(await this.ensureLib());
  }

  /** 与 AudioEngine.init 同签名：main.ts 在窗口 URL 定下后调用（幂等，二选一 init）。 */
  init({ baseUrl, getWin, log }: { baseUrl?: string; getWin?: () => BrowserWindow | null; log?: EngineLog }): void {
    if (baseUrl) this.baseUrl = baseUrl;

    if (getWin) this.getWin = getWin;

    if (log) this.log = log;

    // `quaver:audio` 的 handler 归 backend.ts 门面所有（一个通道只能有一个主人）；
    // 这样设置页运行时切 Liino/MPV 才能真正换掉在答话的引擎。
    if (!this.wired) {
      this.wired = true;
      this.resolveRuntime();
    }
  }

  send(ev: AudioEvent): void {
    const wc = this.getWin()?.webContents;

    if (wc && !wc.isDestroyed()) { try { wc.send("quaver:audio-event", ev); } catch (e) { this.log("[liino] send failed:", String(e)); } }
  }

  // —— 会话生命周期 ——————————————————————————————————————————

  /** 加载 libliino（惰性、一次）。失败把原因写进 note，status 如实上报给渲染层。 */
  async ensureLib(): Promise<Liino | null> {
    if (this.liino) return this.liino;

    if (!this.runtime.path) {
      this.note = this.runtime.note;

      return null;
    }

    try {
      const { Liino } = await import("@team-quaver/liino-node");
      this.liino = new Liino(this.runtime.path);
      this.log("[liino] loaded", this.liino.version, this.runtime.path, `source=${this.runtime.source}`);

      return this.liino;
    } catch (e) {
      // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
      this.note = `加载 libliino 失败：${String(caught(e))}`;
      this.log("[liino]", this.note);

      return null;
    }
  }

  /** 开一条原生播放会话（同进程，不 spawn）。设备/音量/EQ 都随配置在这一步落地。 */
  async ensurePlayer(): Promise<LiinoPlayer | null> {
    if (this.player && !this.dead) return this.player;

    const lib = await this.ensureLib();

    if (!lib) return null;

    try {
      this.player = lib.create(sessionConfig(this.device, this.eqPlan));
      this.dead = false;
      this.startPolling();

      return this.player;
    } catch (e) {
      // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
      this.note = `创建 Liino 会话失败：${String(caught(e))}`;
      this.log("[liino]", this.note);

      return null;
    }
  }

  startPolling(): void {
    if (this.pollTimer) return;
    const timer = setInterval(() => this.tick(), POLL_MS);
    timer.unref?.(); // 别因为轮询把主进程钉住
    this.pollTimer = timer;
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  parseJSON<T>(raw: string | null): T | null {
    if (!raw) return null;

    try {
      // SAFETY: raw 来自 libliino 自己的 JSON 序列化（capi 层），字段在调用点按可选值收口
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** 位置读 clock()：它不碰设备，暂停/取流拥塞时也不会给出假进度。 */
  currentPosition(player: LiinoPlayer): number {
    const clock = this.parseJSON<ClockFields>(player.clock());
    const ms = Number(clock?.position_ms);

    return isFinite(ms) && ms >= 0 ? ms / 1000 : this.st.pos;
  }

  /** 进度条/歌词用的位置：已知时长时钳在媒体里。clock() 是「已消费 PCM」的算术时间，
   *  native 侧不按帧重新基线，缓冲耗尽后会越过时长继续增长，不能原样交给渲染层。 */
  clampedPosition(player: LiinoPlayer): number {
    const raw = this.currentPosition(player);

    return this.st.dur > 0 ? Math.min(raw, this.st.dur) : raw;
  }

  tick(): void {
    const player = this.player;

    if (!player || this.dead) return;

    for (let i = 0; i < MAX_EVENTS_PER_TICK; i++) {
      const raw = player.nextEvent();

      if (!raw) break;
      this.onEvent(this.parseJSON<EventFields>(raw), player);
    }

    if (this.st.paused || this.st.idle) return;

    try {
      this.st.pos = this.clampedPosition(player);
      this.pushState();
    } catch (e) {
      this.log("[liino] tick failed:", String(caught(e)));
    }
  }

  /** native 事件 → 渲染层事件。状态字段一律由 liinoStateFields 单点映射，kind 只管副作用。 */
  onEvent(ev: EventFields | null, player: LiinoPlayer): void {
    if (!ev?.kind) return;
    const snap = ev.snapshot;
    const state = String(snap?.state ?? "");
    const dur = Number(snap?.duration_ms);

    if (isFinite(dur) && dur >= 0) this.st.dur = dur / 1000;
    this.st = { ...this.st, ...liinoStateFields(state, this.st.paused) };

    // 注意：snapshot.device 是**人话设备名**（"PipeWire default sink"），不是设备 ID。
    // 把它写回 this.device 会在下一次 create() 时变成 device_id，输出直接打不开 ——
    // 表现就是切一次后端再切回来，状态在走、PCM 在算，但一直没有声。

    switch (ev.kind) {
      case "loaded":
        // 「这条流真的能播」：渲染层用它熄 loading 转圈（与 mpv 的 file-loaded 同语义）
        this.send({ t: "loaded", epoch: this.epoch });
        this.st.pos = this.clampedPosition(player);
        this.pushState(true);

        return;
      case "ended":
        this.st.pos = this.st.dur;
        this.finishTrack();

        return;
      case "failed":
        this.send({ t: "error", epoch: this.epoch, message: String(snap?.error ?? "Liino 播放失败") });
        this.pushState(true);

        return;
      case "seeked":
        this.st.pos = this.clampedPosition(player);
        this.pushState(true);

        return;
      case "device-lost":
      case "device-changed":
        this.log("[liino] device event:", ev.kind, snap?.device ?? "", snap?.driver ?? "");
        this.pushState(true);

        return;
      case "playing":
      case "ready":
      case "buffering":
      case "paused":
        // 状态位已在上面按 snapshot 落好；这里只负责把变化立刻广播出去
        this.pushState(true);

        return;
      default:
        return;
    }
  }

  pushState(force = false): void {
    const now = Date.now();

    if (!force && now - this.lastPosSent < POS_BROADCAST_MS) return;
    this.lastPosSent = now;
    const { pos, dur, paused, buffering, idle } = this.st;
    this.send({ t: "state", pos, dur, paused, buffering, idle });
  }

  /** 曲末只发一次；发送前先把位置钉在时长上，进度条不会「差半秒再跳下一首」。 */
  finishTrack(): void {
    if (this.endedEpoch === this.epoch) return;
    this.endedEpoch = this.epoch;
    this.pushState(true);
    this.send({ t: "ended" });
  }

  // —— 音量 / 淡入淡出（与 mpv 引擎同一套包络语义）—————————————

  applyVolume(): void {
    const player = this.player;

    if (!player || this.dead) return;

    // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
    try {
      // 前级折进主增益；Liino 内部 20ms 平滑，拖推子不会 zipper
      player.setVolume(liinoMasterGain(this.st.volume, this.fadeLevel, this.eqPlan.preamp, this.st.muted));
    } catch (e) { this.log("[liino] set volume failed:", String(caught(e))); }
  }

  applyEqualizer(): void {
    const player = this.player;

    if (!player || this.dead) return;

    // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
    try {
      player.setEQ(this.eqPlan.bands);
      // NOTE: Liino 的 SetBypass(true) 会整链短路（连 meter 都不过），
      // 但 Quaver 的“关 EQ”语义是“不加工，不是不出声”。这里永远不旁通，
      // 只把 bands 清空，让 meter 仍能给出真实电平。
      player.setBypass(false);
    } catch (e) { this.log("[liino] apply eq failed:", String(caught(e))); }
  }

  /** 把包络推向 level（线性，30ms 步进）。`after` 三态与 mpv 引擎一致：
   *  undefined = 保持现有待执行动作；null = 清掉（新意图接管）；fn = 替换为它。 */
  rampTo(level: number, ms: number, after?: AfterFade): void {
    this.fadeTarget = level;

    if (level === 1) this.pendingAfterFadeOut = null;
    else if (after !== undefined) this.pendingAfterFadeOut = after;

    if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }

    const from = this.fadeLevel;

    const settle = () => {
      this.fadeLevel = level;
      this.applyVolume();
      const act = this.pendingAfterFadeOut;
      this.pendingAfterFadeOut = null;

      // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
      try { act?.(); } catch (e) { this.log("[liino] after-fade action failed:", String(caught(e))); }
    };

    if (!(ms > 0) || Math.abs(from - level) < 0.002) { settle(); return; }

    const t0 = Date.now();

    const timer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      this.fadeLevel = from + (level - from) * k;
      this.applyVolume();

      if (k >= 1) { clearInterval(timer); this.fadeTimer = null; settle(); }
    }, 30);

    this.fadeTimer = timer;
    timer.unref?.();
  }

  /** 淡出途中收到 seek（MPRIS Stop = pause + seek(0)）：马上收尾，别听见歌头再静音。 */
  finishFadeOut(): void {
    if (this.fadeTarget !== 0) return;

    if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }

    this.rampTo(0, 0);
  }

  absolutize(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;

    if (!this.baseUrl) throw new Error("音频引擎未初始化（baseUrl 缺失）");

    return new URL(url, this.baseUrl).href;
  }

  /** native 会话硬错（CLOSED/INTERNAL）：标记 dead 并拆会话，下一条命令重建。
   *  message 由调用方（catch 里）caught(e) 收口成字符串；这里只管标记 + 拆会话。 */
  hardFail(message: string): CommandFailure {
    this.log("[liino] session error:", message);
    this.dead = true;
    this.destroyPlayer();

    return { ok: false, error: message };
  }

  destroyPlayer(): void {
    const player = this.player;
    this.player = null;

    if (!player) return;

    // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
    try { player.close(); } catch (e) { this.log("[liino] close failed:", String(caught(e))); }
  }

  /** 当前设备 **ID**（设置页下拉的选中值）。snapshot.device 是显示名，不能拿来当键。 */
  currentDeviceId(): string {
    return this.device;
  }

  /** 设置页/日志用的自述（随包还是 vendor，路径是什么）。 */
  describe(): LiinoRuntime {
    return { path: this.runtime.path, source: this.runtime.source, note: this.note || this.runtime.note };
  }

  /** 探针/自检入口：与 onInvoke 同一命令面，只是把回包收进命名边界（渲染层走 IPC，不经这里）。 */
  async call(cmd: CommandEnvelope): Promise<EngineReply> {
    // SAFETY: 回包就是下面 onInvoke 各分支的字面量合集，字段全部可选，读不到就是 undefined
    return await this.onInvoke(cmd) as EngineReply;
  }

  // —— 命令面（与 engine.ts 的 onInvoke 同一套 cmd / 回包字段）————

  async onInvoke(cmd: CommandEnvelope) {
    switch (cmd?.cmd) {
      case "status": {
        const lib = await this.ensureLib();

        return {
          ok: true, backend: "liino", mode: this.mode,
          available: !!lib,
          // note 优先：库找到了但加载失败，这件事必须让渲染层/日志看得见
          reason: !lib ? (this.note || this.runtime.note) : "",
          source: this.runtime.source,
          payload: this.runtime.path,
          version: lib?.version ?? "",
          running: !!this.player && !this.dead,
          device: this.device,
          // Liino 自己开输出会话：窗口级音频捕获（OBS/Oopz 那套）只有 mpv 兼容模式能做
          captureCompatible: false,
          decoder: this.decodeNote(),
        };
      }

      case "mode": {
        if (cmd.mode === "pcm") {
          return { ok: false, error: "liino 后端只支持原生直出（无 PCM 兼容模式）", mode: this.mode };
        }

        return { ok: true, mode: this.mode, captureCompatible: false, epoch: this.epoch };
      }

      case "boot": {
        const player = await this.ensurePlayer();

        if (!player) return { ok: false, error: this.note || "libliino 不可用" };

        return { ok: true, version: this.liino?.version ?? "" };
      }

      case "snapshot": {
        // 渲染层接管用（CSD/SSD 重建窗口后的新页面）：引擎活在渲染层之外，窗口拆了还在放。
        const running = !!this.player && !this.dead;

        return {
          ok: true, backend: "liino", mode: this.mode, running,
          pos: this.st.pos, dur: this.st.dur,
          paused: this.st.paused, buffering: this.st.buffering, idle: this.st.idle,
          url: running && this.lastUrl ? this.lastUrl : "",
        };
      }

      case "level": {
        const player = this.player;

        if (!player || this.dead) return { ok: false, error: "liino 会话未运行" };

        try {
          return { ok: true, payload: this.parseJSON(player.level()) ?? {} };
        } catch (e) { return { ok: false, error: caught(e) }; }
      }

      case "load": {
        const url = this.absolutize(String(cmd.url ?? ""));

        if (!url) return { ok: false, error: "missing url" };

        // 世代**不按「只能变大」判旧**：渲染层换了一页（窗口 CSD/SSD 重建、页面 reload）
        // 后从 1 重新计数，而主进程里的引擎还停在旧的较大值。把它当成迟到的旧命令丢掉，
        // 新页面就永远等不到 loaded/playing —— 用户看到的是「点了播放没声音、一直在加载」。
        // 同一页面的命令经 IPC 保序，所以更小的世代只可能来自新页面，直接以它为准。
        const epoch = Number(cmd.epoch) || this.epoch + 1;

        this.epoch = epoch;

        const paused = !!cmd.paused;
        const startAt = Math.max(0, Number(cmd.startAt) || 0);
        const player = await this.ensurePlayer();

        if (!player) return { ok: false, error: this.note || "libliino 不可用" };

        // 包络压到 0：新流出声即从静音起步（loaded 后随 play 淡入）。
        // null = 作废「淡出后 stop」—— 切歌时那个 stop 会把新歌掐掉。
        this.rampTo(0, this.fadeTarget === 0 ? this.fade.outMs : 0, null);
        this.st = { ...this.st, pos: startAt, dur: 0, paused, buffering: true, idle: false };
        this.endedEpoch = -1;
        this.pushState(true);

        // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
        try {
          player.open(url, { start_ms: Math.round(startAt * 1000), auto_play: !paused });
        } catch (e) { return this.hardFail(caught(e)); }

        this.lastUrl = url;
        // Open 会 Reset() 整条 DSP 链：EQ 与增益必须在挂流后重新套用一次
        this.applyEqualizer();
        this.applyVolume();

        return { ok: true, gen: epoch };
      }

      case "play": {
        const player = await this.ensurePlayer();

        if (!player) return { ok: false, error: this.note || "libliino 不可用" };

        // 真停（Stop）后的 native 会话不能直接 Play()：那条路不重新排环形缓冲的世代，
        // 解码线程写进去的帧会被当作旧世代丢弃，播放器永远停在 ready（native 侧自已在
        // 曲末/Ended 走的是 reopen()）。所以这里对齐 mpv 引擎的「idle 重挂 lastUrl」语义。
        const native = String(this.parseJSON<SnapshotFields>(player.snapshot())?.state ?? "");
        const unloaded = native === "stopped" || native === "idle" || native === "failed" || native === "closed";

        // 没可重挂的流就是「没东西可放」：说老实话回 ok:false，渲染层会重新取链起播。
        if (unloaded && !this.lastUrl) return { ok: false, error: "没有已挂载的播放流" };

        this.st.paused = false; // 意图先落地（native 只在变化时推事件，值相同则不推）
        this.rampTo(1, this.fade.inMs);

        // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
        try {
          if (unloaded) {
            player.open(this.lastUrl, { start_ms: 0, auto_play: true });
            this.st = { ...this.st, pos: 0, paused: false, buffering: true, idle: false };
            this.endedEpoch = -1;
            this.applyEqualizer();
          } else {
            player.play();
          }
        } catch (e) { return this.hardFail(caught(e)); }

        this.pushState(true);

        return { ok: true, gen: this.epoch };
      }

      case "pause": {
        this.st.paused = true;
        this.pushState(true);
        // 先淡出、到 0 再真停；期间来了新歌（load 作废这步）就交给它接管
        // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
        this.rampTo(0, this.fade.outMs, () => { try { this.player?.pause(); } catch (e) { this.hardFail(caught(e)); } });

        return { ok: true };
      }

      case "stop": {
        const stopEpoch = this.epoch;
        this.st.paused = true;
        this.pushState(true);

        this.rampTo(0, this.fade.outMs, () => {
          // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
          try { this.player?.stop(); } catch (e) { this.hardFail(caught(e)); }

          // 仍是同一代才清 lastUrl：淡出期间已切到新歌时那条 URL 属于新歌
          if (this.epoch === stopEpoch) {
            this.lastUrl = "";
            this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
            this.pushState(true);
          }
        });

        return { ok: true };
      }

      case "seek": {
        const sec = Number(cmd.sec);

        if (!isFinite(sec)) return { ok: false, error: "bad sec" };

        const at = Math.max(0, sec);
        const player = this.player;

        if (!player || this.dead) return { ok: false, error: "liino 会话未运行" };
        this.finishFadeOut();

        // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
        try {
          player.seek(Math.round(at * 1000));
        } catch (e) { return this.hardFail(caught(e)); }

        this.st.pos = at; // 乐观位置：seeked/state 事件马上对齐
        this.st.idle = false;
        this.pushState(true);

        return { ok: true };
      }

      case "volume": {
        const v = Number(cmd.value);

        if (!isFinite(v)) return { ok: false, error: "bad volume" };
        this.st.volume = Math.max(0, Math.min(1, v));
        this.applyVolume(); // 乘包络：不在淡出途中打断淡出，也不在淡入途中跳音量

        return { ok: true };
      }

      case "mute": {
        this.st.muted = !!cmd.value;
        this.applyVolume(); // 静音也乘在包络上（单一增益真相在 JS 侧，不双通道）

        return { ok: true };
      }

      case "fade": {
        const clamp = (value: RemoteJson): number => Math.max(0, Math.min(3000, Math.round(Number(value) || 0)));
        this.fade = { inMs: clamp(cmd.inMs), outMs: clamp(cmd.outMs) };

        // 关掉淡入淡出时别把音量卡在半路上（只在淡入方向兜底；淡出途中说明有 pending 动作，别打断）
        if (!this.fade.inMs && !this.fade.outMs && this.fadeTarget === 1 && this.fadeLevel < 1) this.rampTo(1, 0);

        return { ok: true, fade: this.fade };
      }

      case "eq": {
        this.eq = normalizeEqState(cmd.state);
        this.eqPlan = liinoEqPlan(this.eq);
        this.applyEqualizer();
        this.applyVolume(); // 前级变了要重算主增益

        return {
          ok: true, state: this.eq, backend: "liino", bands: this.eqPlan.bands.length,
          dropped: this.eqPlan.dropped,
          note: this.eqPlan.dropped ? `Liino 只支持峰值/低频架/高频架，${this.eqPlan.dropped} 个低通/高通节点已跳过` : "",
        };
      }

      case "devices": {
        const lib = await this.ensureLib();

        if (!lib) return { ok: false, error: this.note || "libliino 不可用" };

        let payload: string | null = null;

        // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
        try {
          payload = lib.devices();
        } catch (e) { this.log("[liino] devices failed:", String(caught(e))); }

        const plan: LiinoDevicePlan = liinoDevicePlan(payload, this.currentDeviceId());

        return { ok: true, current: plan.current, devices: plan.devices };
      }

      case "device": {
        const id = String(cmd.id ?? "auto");
        const target = id === "auto" ? "" : id;

        // Liino 能活切设备（重建输出会话，不重挂解码流）；「auto」= 交回平台默认。
        // 失败时**不改** this.device：把 mpv 的设备名（pipewire/default 之类）记成 Liino 的
        // 选择，下一次 create() 会带着一个它认不出的 id，输出打开即失败（用户只看到没声）。
        // SAFETY: catch 边界进来的都是 unknown；只取 message 拼日志/回包，字段缺失兜 "unknown"
        try {
          if (this.player && !this.dead) this.player.setDevice(target);
        } catch (e) {
          return { ok: false, error: String(caught(e)) };
        }

        this.device = id;

        return { ok: true, current: id };
      }

      default:
        return { ok: false, error: `unknown cmd: ${cmd?.cmd}` };
    }
  }

  /** 解码器实况（诊断用）：native 后端需要系统 FFmpeg 共享库，WASM 后端需要 libav.js 资产。 */
  decodeNote(): string {
    if (!this.liino || this.dead || !this.player) return "";

    const snap = this.parseJSON<SnapshotFields>(this.player.snapshot());

    return String(snap?.decoder ?? "");
  }

  /** 收尾：停轮询、停会话、拆 native handle。幂等；will-quit 与信号路径都会走这里。 */
  shutdown() {
    this.stopPolling();

    if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }

    const player = this.player;

    if (player && !this.dead) { try { player.stop(); } catch { /* 设备可能已被拆走 */ } }

    this.destroyPlayer();
    this.dead = false;
    this.lastUrl = "";
    this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
  }
}

/** main.ts 用的单例（与 mpv 的 audioEngine 同名同位，二选一 init）。 */
export const liinoEngine = new LiinoEngine();
