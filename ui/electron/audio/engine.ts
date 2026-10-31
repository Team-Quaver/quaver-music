// Quaver — 主进程音频引擎（mpv 后端）。
// 真相归属：位置/时长/播放态/缓冲归引擎（这里）；曲目/队列/循环/随机归渲染层（player.ts）。
// 渲染层经 preload 桥（quaverAudio.invoke / quaverAudio.onEvent）驱动；MPRIS 快照仍由渲染层
// 合成推送（daemon 协议不动），位置源在两条传输下都收敛到 player.time —— 同一时刻只有一个位置来源。
//
// 生命周期：mpv 惰性拉起（boot/load/device 等需要它的命令触发）；native 换曲不重启，
// PCM 兼容模式为了丢掉无帧边界的管道尾巴会重开会话；
// 崩溃后引擎标记 dead 并复位，下一次命令自动重拉（重试语义交给播放器的错误态，不无限自愈）。
import { app, type BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { probeRuntime, resolveMpv } from "./bins.ts";
import { formatOsVersion, machOMinOs, osVersionGt, parseOsVersion } from "./macho.ts";
import { MpvIpc, PCM_REBIND_TIMEOUT_MS, type MpvEvent, type MpvObject, type MpvValue } from "./mpv-ipc.ts";
import { PcmPipe } from "./pcm-pipe.ts";
import { eqFilterString, normalizeEqState, type EqState } from "./eq-config.ts";
import { loadfileArgs, mpvLoadfileWantsIndex } from "./mpv-loadfile.ts";

const POS_BROADCAST_MS = 250; // 位置广播节流：4Hz 足够渲染层外推出平滑进度/歌词

/** MPV 输出拓扑：native = mpv 自己开音频设备；pcm = mpv 只解码，PCM 交给 renderer。 */
export type AudioOutputMode = "native" | "pcm";

// PCM 兼容管线固定格式：renderer 用 AudioContext 直接消费，捕获软件也按这条地板走。
const PCM_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_SAMPLE_BYTES = 4;
const PCM_FRAME_BYTES = PCM_CHANNELS * PCM_SAMPLE_BYTES;
const PCM_CHUNK_FRAMES = PCM_RATE / 20; // 50ms（比 20ms 少 60% AudioBuffer/IPC 调度）
const PCM_CHUNK_BYTES = PCM_CHUNK_FRAMES * PCM_FRAME_BYTES;
const PCM_MAX_AHEAD_SEC = 1.0; // 主进程硬窗口：不能等 renderer 的 250ms 心跳才刹车

/** loadfile 的异步回执超时：只等 mpv 读完命令并确认参数，不等文件打开。
 *  正常 <20ms；命令线程卡死时给一次快速失败，交给播放器降档/跳曲。 */
const LOAD_ACK_TIMEOUT_MS = 3000;

/** 已下发 loadfile 却迟迟没有 start-file/file-loaded 的兜底。
 *  mpv 的命令线程被旧 AO 写线程卡住时，命令回执可能永远不来；此时重启整个
 *  mpv 比在坏连接上继续排队更可靠（下一次 load 会拉起新进程）。 */
const LOAD_STALL_MS = 25000; // 比渲染层起播看门狗（12/15/20s）更晚：先让播放器换源/跳曲

// 看门狗脚本：父进程（本进程）无论怎么死，mpv 都会被它杀掉（注销/崩溃时 will-quit 跑不到）
const WATCHDOG_SCRIPT = fileURLToPath(new URL("./mpv-watchdog.ts", import.meta.url));

/** 随包音频运行时根目录：打包态 = extraResources 的 <resources>/audio；开发态 = ui/build-res/audio
 *  （CI 在打包前用 ui/scripts/stage-mpv.sh 解 mpv AppImage 到这里；本地留空则回落系统 mpv）。
 *  QUAVER_AUDIO_DIR 可显式顶掉（排障/自检：拿另一份解好的运行时跑）。 */
function bundledAudioRoot() {
  if (process.env.QUAVER_AUDIO_DIR) return process.env.QUAVER_AUDIO_DIR;

  return app?.isPackaged
    ? join(process.resourcesPath ?? "", "audio")
    : fileURLToPath(new URL("../../build-res/audio", import.meta.url));
}

/** 引擎对外广播的播放状态。 */
export interface EngineState {
  pos: number;
  dur: number;
  paused: boolean;
  buffering: boolean;
  idle: boolean;
  volume: number;
  muted: boolean;
}

/** 引擎日志口（main.ts 的 log 同此形态：字符串与其它值混着传）。 */
export type EngineLog = (...a: unknown[]) => void;

/** 渲染层经 contextBridge 传来的命令：结构化克隆后的任意 JSON，字段在各个 case 里就地窄化。
 *  刻意不建全量判别联合 —— 命令集随功能长，收益撑不起维护成本；这里是 IPC 边界，非法字段
 *  由各 case 的取值/默认值兜住。 */
type EngineCmd = Record<string, any>;

/** 淡出收尾时要执行的动作；null = 无。 */
type AfterFade = (() => void) | null;

/**
 * quaver.conf 的 `Playing.AudioDevice` 是两个后端共用的一个字符串，但命名空间不同：
 * Liino 用 `pipewire/default` / `null`，mpv 的 --audio-device 不认这些值（实测 bundled
 * mpv 的列表只有 auto + pulse/*）。把 Liino 的 ID 直接交给 mpv，AO 初始化会失败，
 * 表现就是“切到 MPV 后进度停在原地、完全没有声音”。这类值一律回落系统默认。
 */
function mpvAudioDevice(id: string): string {
  const v = String(id ?? "").trim();

  if (!v || v === "auto") return "auto";

  return v === "pipewire/default" || v === "null" ? "auto" : v;
}

export class AudioEngine {
  readonly kind = "mpv" as const;     // 后端身份（backend.ts 里与 LiinoEngine 同一口径）
  baseUrl: string;                   // 渲染层服务 origin（load 传相对 URL 时绝对化用）
  getWin: () => BrowserWindow | null; // 当前 BrowserWindow getter（CSD 重建窗口后引用会换）
  log: EngineLog;
  mpv: MpvIpc | null;                // MpvIpc 实例（null = 未拉起/已死）
  retiredMpvs: WeakSet<MpvIpc>;      // 主动停掉的旧实例：迟到事件一律丢弃
  starting: Promise<MpvIpc> | null;  // 拉起中的 promise（并发去重）
  watchdog: ChildProcess | null;     // mpv 看门狗子进程（父进程死亡时由它送 mpv 陪葬）
  bin: ReturnType<typeof resolveMpv> | undefined;   // undefined = 未探测；null = 找不到；命中 = 包
  bundledProbe: ReturnType<typeof probeRuntime> | undefined; // 随包运行时自检结果（详见 resolveRuntime）
  binNote: string;                   // 随包运行时不可用的原因（人话，进日志与 status.reason）
  st: EngineState;
  device: string;                    // 音频设备（renderer 持久化，引擎记住以便 respawn 后复用）
  lastUrl: string;                   // 最近挂过的流（eof 后 idle 重挂用）
  currentEntryId: number;            // 当前 playlist entry；丢弃上一首迟到的 end-file
  /** loadfile 载入代次：每次 load / PCM seek 重挂递增。
   *  start-file / file-loaded / end-file 都盖当前代次；旧代次的迟到事件一律丢弃。 */
  loadGen: number;
  startGen: number;                  // 收到 start-file 的代次
  loadedGen: number;                 // 收到 file-loaded 的代次
  loadErrGen: number;                // 载入失败归属的代次
  loadRetried: number;               // 已换过 loadfile 参数布局的代次
  loadEntryId: number;               // 本代 loadfile 的 playlist entry id（旧 mpv 可能拿不到，保持 0）
  loadfileIndex: boolean;            // 当前 mpv 是否需要 loadfile 的 index 占位参数
  loadWatchdog: NodeJS.Timeout | null;
  mode: AudioOutputMode;              // native / pcm（原生兼容）
  pcmPipe: PcmPipe | null;           // pcm 模式的 MPV 输出管道
  pcmReady: boolean;                 // renderer 已接上并允许消费 PCM
  pcmClientReady: boolean;           // renderer 仍持有 PCM 接收器（MPV 重启/seek 后应自动续接）
  pcmBuf: Buffer;                    // MPV 写出的半包，按 50ms 帧切给 renderer
  pcmPos: number;                    // renderer 汇报的“实际听到”位置（秒）
  pcmBase: number;                   // 当前 PCM 时间轴起点（seek 后不是 0）
  pcmSentSec: number;                // 当前时间轴已发给 renderer 的时长
  pcmEnding: boolean;                // mpv 已写完最后一块，等 renderer 排空
  pcmEofSent: boolean;               // pcm-eof 已广播（防止重复）
  pcmLastDataAt: number;             // 最后一块 PCM 到达时刻（EOF 静默判定）
  pcmReloading: boolean;             // seek 重拉期间保留旧时长，等新文件 file-loaded
  pcmEpoch: number;                  // 当前 PCM 会话代际：切歌/seek 后丢弃上一代事件
  pcmSwitchTail: Promise<void>;       // pcm 输出切换串行化（load/seek 可能连续来）
  fade: { inMs: number; outMs: number };
  /** Quark EQ 的当前状态（仅 mpv）：渲染层经 eq 命令下发；mpv 重拉后由 ensureStarted 重新套用。 */
  eq: EqState;
  /** 已发过自然曲末的 entry id；pause/idle 事件晚到也不能重复切歌。 */
  endedEntryId: number;
  fadeLevel: number;
  fadeTarget: number;
  fadeTimer: NodeJS.Timeout | null;
  pendingAfterFadeOut: AfterFade;
  lastPosSent: number;
  wired: boolean;

  constructor() {
    this.baseUrl = "";
    this.getWin = () => null;
    this.log = () => {};

    this.mpv = null;
    this.retiredMpvs = new WeakSet();
    this.starting = null;
    this.watchdog = null;
    this.bin = undefined;
    this.bundledProbe = undefined;
    this.binNote = "";
    this.st = { pos: 0, dur: 0, paused: true, buffering: false, idle: true, volume: 0.8, muted: false };
    this.device = "auto";
    this.lastUrl = "";
    this.currentEntryId = 0;
    this.loadGen = 0;
    this.startGen = 0;
    this.loadedGen = 0;
    this.loadErrGen = 0;
    this.loadRetried = 0;
    this.loadEntryId = 0;
    this.loadfileIndex = false;
    this.loadWatchdog = null;
    this.mode = "native";
    this.pcmPipe = null;
    this.pcmReady = false;
    this.pcmClientReady = false;
    this.pcmBuf = Buffer.alloc(0);
    this.pcmPos = 0;
    this.pcmBase = 0;
    this.pcmSentSec = 0;
    this.pcmEnding = false;
    this.pcmEofSent = false;
    this.pcmLastDataAt = 0;
    this.pcmReloading = false;
    this.pcmEpoch = 0;
    this.pcmSwitchTail = Promise.resolve();
    // —— 淡入淡出：用 mpv `volume` 属性做振幅包络（afade 要掐流时间位置，切歌/暂停场景不好用）——
    // fadeLevel 是乘在用户音量上的瞬时包络；fadeTarget 记住方向（0=正在/将要淡出），
    // 「淡出完成后要执行的动作」放 pendingAfterFadeOut —— 任何更新的播放意图都会把它作废，
    // 否则切歌时那个延迟的 stop 会把刚 loadfile 的新歌掐掉。
    this.fade = { inMs: 400, outMs: 250 };
    this.eq = normalizeEqState(null);
    this.endedEntryId = 0;
    this.fadeLevel = 1;
    this.fadeTarget = 1;
    this.fadeTimer = null;
    this.pendingAfterFadeOut = null;
    this.lastPosSent = 0;
    this.wired = false;
  }

  /** main.ts 在窗口 URL 确定后调用（幂等：重复调用只刷新 baseUrl/窗口引用） */
  init({ baseUrl, getWin, log }: { baseUrl?: string; getWin?: () => BrowserWindow | null; log?: EngineLog }): void {
    if (baseUrl) this.baseUrl = baseUrl;

    if (getWin) this.getWin = getWin;

    if (log) this.log = log;

    // `quaver:audio` 的 handler 归 backend.ts 门面所有（一个通道只能有一个主人）；
    // 引擎只负责命令实现，运行时换后端才不会被「先到先得」钉死在启动时那一份。
    this.wired = true;
  }

  send(ev: unknown): void {
    const wc = this.getWin()?.webContents;

    if (wc && !wc.isDestroyed()) { try { wc.send("quaver:audio-event", ev); } catch (e) { this.log("[audio] send failed:", String(e)); } }
  }

  /** 新开一条 PCM 管道。管道与 epoch 绑定：关闭后仍有在途 stdout 数据时，
   *  onPcmData 会按捕获的 epoch 丢弃，不会把上一代尾巴误标成新歌。 */
  private async openPcmPipe(epoch: number): Promise<PcmPipe> {
    const pipe = new PcmPipe({
      log: this.log,
      onData: (chunk, generation) => this.onPcmData(chunk, generation ?? epoch),
      onError: (e) => this.log("[audio] PCM pipe error:", String(e)),
    });

    try {
      await pipe.start();
      pipe.setGeneration(epoch);

      return pipe;
    } catch (e) {
      try { pipe.close(); } catch {}

      throw e;
    }
  }

  startPcmPipe(): Promise<string> {
    if (this.pcmPipe) return Promise.resolve(this.pcmPipe.path);

    return this.openPcmPipe(this.pcmEpoch).then((pipe) => {
      this.pcmPipe = pipe;

      if (this.pcmClientReady) {
        this.pcmReady = true;
        pipe.resume();
      }

      return pipe.path;
    });
  }

  stopPcmPipe(): void {
    this.pcmReady = false;
    this.pcmBuf = Buffer.alloc(0);

    try { this.pcmPipe?.close(); } catch {}

    this.pcmPipe = null;
  }

  /** 完整停掉当前 mpv 会话：模式切换 / 退出时用。下一次命令会按新模式重拉。 */
  stopMpv(): void {
    this.cancelLoadWatchdog();
    this.stopWatchdog();

    if (this.mpv) this.retiredMpvs.add(this.mpv);

    try { this.mpv?.kill(); } catch {}

    this.mpv = null;
    this.stopPcmPipe();
  }

  /** PCM 重挂流专用：mpv 进程复用，但每一代换一条全新 FIFO 并显式重绑 ao。
   *  这样旧会话的写端/在途字节与新歌物理隔离，不依赖“排空多久才算干净”的时序猜测。 */
  private async restartPcmSession(epoch: number): Promise<MpvIpc> {
    let next: PcmPipe | null = null;
    const startedAt = Date.now();

    try {
      const mpv = await this.ensureStarted();

      if (epoch !== this.pcmEpoch) return mpv;

      const old = this.pcmPipe;
      // 旧读端若正被背压暂停，AO 线程可能卡在 fwrite；先放行才能及时卸掉旧 AO。
      old?.resume();

      // 活跃文件的 AO 拆除走正常 stop 路径：直接 set ao=null 会让 mpv 核心线程
      // 同步等还卡在旧 FIFO 写端的音频线程，一次偶发卡住就吃满整个命令超时。
      try {
        await mpv.command(["stop"], PCM_REBIND_TIMEOUT_MS);
      } catch (e) {
        // idle 下 stop 的非致命错误可以继续；超时/进程死说明核心卡住，
        // 立刻走整进程重启，不再把后续 setProperty 排在死命令后面。
        if (mpv.dead || String((e as Error)?.message).includes("timeout")) throw e;
      }

      // stop 成功后再关旧读端：AO 线程即使还没完全退出，写端也会立刻拿到
      // EPIPE 而收尾。等 configurePcmOutput 时才关的话，ao=null 可能一直等
      // 那个卡在 FIFO write 的 AO 线程，1.5s 超时后整个 mpv 被重启。
      old?.close();

      const pipeAt = Date.now();
      next = await this.openPcmPipe(epoch);

      if (epoch !== this.pcmEpoch) {
        next.close();

        return mpv;
      }

      const openedAt = Date.now();
      await mpv.configurePcmOutput(next.path);
      const reboundAt = Date.now();

      this.pcmPipe = next;
      this.pcmBuf = Buffer.alloc(0);
      this.pcmLastDataAt = Date.now();

      if (this.pcmClientReady) {
        this.pcmReady = true;

        if (!this.st.paused) next.resume();
      }

      this.log(
        `[audio] PCM e${epoch} output ready: pipe ${openedAt - pipeAt}ms, `
        + `ao ${reboundAt - openedAt}ms, total ${reboundAt - startedAt}ms`,
      );

      return mpv;
    } catch (e) {
      try { next?.close(); } catch {}

      this.log("[audio] PCM output rebind unavailable; respawning mpv:", String(e));
      this.stopMpv();

      return this.ensureStarted();
    }
  }

  /** load 与 seek 都会换 AO/FIFO；串行执行，避免两次切换交叉改同一个 mpv。 */
  private serializePcm<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pcmSwitchTail.catch(() => {}).then(task);

    this.pcmSwitchTail = run.then(() => {}, () => {});

    return run;
  }

  /** 发一块 PCM。返回 false = renderer 不可写/发送失败，调用方必须暂停管道。 */
  private sendPcmFrame(frame: Buffer): boolean {
    const wc = this.getWin()?.webContents;

    if (!wc || wc.isDestroyed()) return false;

    try {
      wc.send("quaver:audio-event", { t: "pcm", epoch: this.pcmEpoch, data: new Uint8Array(frame) });

      return true;
    } catch (e) {
      this.log("[audio] PCM send failed:", String(e));

      return false;
    }
  }

  /** 把积压 PCM 按窗口发给 renderer。
   *
   * 不能只靠 renderer 250ms 报一次 queued：那之间的 IPC 速度足以让 mpv 把整首
   * `ao_pcm` 写完并进入 idle。这里的硬窗口按“已发送时长 - renderer 已播时长”算，
   * 超过 PCM_MAX_AHEAD_SEC 就暂停管道，让背压一路传回 mpv 的 fwrite。
   */
  private drainPcm(): void {
    if (this.mode !== "pcm" || !this.pcmReady) return;

    const played = Math.max(0, this.pcmPos - this.pcmBase);
    let ahead = Math.max(0, this.pcmSentSec - played);

    while (this.pcmBuf.length) {
      if (ahead >= PCM_MAX_AHEAD_SEC) {
        this.pcmPipe?.pause();

        return;
      }

      const want = this.pcmEnding ? Math.min(this.pcmBuf.length, PCM_CHUNK_BYTES) : PCM_CHUNK_BYTES;

      // EOF 最后一块可能不足 50ms；按完整 frame 取，不足一个 frame 的尾巴丢弃。
      if (this.pcmBuf.length < want) return;

      if (this.pcmEnding && want < PCM_FRAME_BYTES) {
        this.pcmBuf = Buffer.alloc(0);
        break;
      }

      const frame = this.pcmBuf.subarray(0, want);
      this.pcmBuf = this.pcmBuf.subarray(want);

      if (!this.sendPcmFrame(frame)) {
        this.pcmReady = false;
        this.pcmPipe?.pause();

        return;
      }

      this.pcmSentSec += want / PCM_FRAME_BYTES / PCM_RATE;
      ahead = Math.max(0, this.pcmSentSec - played);
    }

    // mpv 的 end-file 只说明它写完了 FIFO；helper/stdout 里可能还有在途数据。
    // 必须等管道恢复读取并静默一小段时间，才能确认最后一块真的到了。
    if (this.pcmEnding && !this.pcmBuf.length && !this.pcmEofSent
      && !this.pcmPipe?.isPaused() && Date.now() - this.pcmLastDataAt >= 150) {
      this.pcmEofSent = true;
      this.send({ t: "pcm-eof", epoch: this.pcmEpoch });
    }
  }

  /** MPV 的写端可能任意切块；先攒进 pcmBuf，再由 drainPcm 按窗口消费。 */
  onPcmData(chunk: Buffer, epoch = this.pcmEpoch): void {
    if (this.mode !== "pcm" || !this.pcmReady || epoch !== this.pcmEpoch) return;

    // 旧代管道 drain 的最后一截也拒绝入库；代际 + 管道实例双保险
    if (epoch !== this.pcmEpoch) return;

    this.pcmLastDataAt = Date.now();
    this.pcmBuf = this.pcmBuf.length ? Buffer.concat([this.pcmBuf, chunk]) : chunk;
    this.drainPcm();
  }

  /** 位置类变化节流广播；离散变化（暂停/缓冲/时长/idle）立即广播 */
  pushState(force = false): void {
    const now = Date.now();

    if (!force && now - this.lastPosSent < POS_BROADCAST_MS) return;
    this.lastPosSent = now;
    const { dur, paused, buffering, idle } = this.st;
    this.send({ t: "state", pos: this.mode === "pcm" ? this.pcmPos : this.st.pos, dur, paused, buffering, idle });
  }

  /** `end-file(eof)` 是曲末的唯一权威出口；entry id 保证同一首只发一次。 */
  private finishTrack(): void {
    if (this.endedEntryId === this.currentEntryId) return;
    this.endedEntryId = this.currentEntryId;
    this.st.paused = true;
    this.pushState(true);
    this.send({ t: "ended" });
  }

  // —— 淡入淡出 ——

  /** 音量面板 = 用户目标音量 × 淡入淡出包络（静音走 mpv 自己的 mute 属性，不在这里相乘）。
   *  mpv 未运行时不做事：目标值会在 spawn 时随参数落地。 */
  applyVolume(): void {
    if (this.mode === "pcm") {
      // PCM 模式下 mpv 已经预写了最多 1s 音频，改 mpv volume 会慢半拍。
      // 音量/静音/淡入淡出直接在 renderer 的 GainNode 上生效，捕获端拿到的也是处理后的声音。
      const gain = this.st.muted ? 0 : this.st.volume * this.fadeLevel;
      this.send({ t: "pcm-gain", epoch: this.pcmEpoch, value: Math.max(0, Math.min(1, gain)) });

      return;
    }

    if (!this.mpv || this.mpv.dead) return;
    const v = this.st.volume * this.fadeLevel * 100;
    // 淡入淡出 30ms 一步：高频命令只写不等回执，别让 pending/定时器排队。
    this.mpv.commandQuiet(["set_property", "volume", Math.round(v * 100) / 100]);
  }

  /** 把共享模型生成的 af 串原子替换到 mpv。空串 = bypass；滤镜运行时可换，不用重挂流。
   *  返回错误供 eq 命令上报，但 ensureStarted 里只记日志 —— EQ 初始化失败不该让整首歌播不了。 */
  async applyEqualizer(mpv: MpvIpc | null = this.mpv): Promise<void> {
    if (this.mode === "pcm") {
      // PCM 已经预写成块；af 只影响后续解码，会慢一个缓冲。兼容模式改由
      // renderer 的 BiquadFilter 链即时处理，捕获端拿到的也是 EQ 后声音。
      this.send({ t: "pcm-eq", epoch: this.pcmEpoch, state: this.eq });

      return;
    }

    if (!mpv || mpv.dead) return;
    const filter = eqFilterString(this.eq);

    try {
      await mpv.setProp("af", filter);
    } catch (e) {
      this.log("[audio] apply eq failed:", String(e));
      throw e;
    }
  }

  /** 把包络推向 level（线性，30ms 步进）。`after` 三态：
   *    undefined = 保持现有待执行动作（finishFadeOut 用：把淡出提前收尾但照旧执行）；
   *    null      = 清掉（新意图接管，如切歌 load 作废旧 stop）；
   *    fn        = 替换为它（到点后执行）。
   *  淡入（level=1）一律清空待执行动作 —— 回升就意味着「不暂停/不停止」了。 */
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

      try { act?.(); } catch (e) { this.log("[audio] after-fade action failed:", String(e)); }
    };

    if (!(ms > 0) || Math.abs(from - level) < 0.002) return settle();
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

  /** 淡出途中收到 seek（MPRIS Stop = pause + seek(0)）时把淡出立刻收尾：
   *  否则会先听见 250ms 的歌头再静音。 */
  finishFadeOut(): void {
    if (this.fadeTarget !== 0) return;

    if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }

    this.rampTo(0, 0);
  }

  /** 暂停 = 先淡出、到 0 再真停（意图立刻落到状态里，UI/MPRIS 不等那 250ms） */
  doPause() {
    if (!this.mpv || this.mpv.dead) return;
    const mpv = this.mpv;
    this.st.paused = true;
    this.pushState(true);

    if (this.mode === "pcm") {
      // PCM 的暂停真相在 renderer：GainNode 先淡出、sink 随后冻结消费；
      // 主进程同时停住读管，让背压留在这首歌里。继续排空会把暂停期间的
      // 整首 PCM 丢掉，恢复时自然就没声了。
      this.rampTo(0, this.fade.outMs, () => this.pcmPipe?.pause());

      return;
    }

    this.rampTo(0, this.fade.outMs, () => { void mpv.setProp("pause", true).catch(() => {}); });
  }

  findBin() {
    if (this.bin === undefined) this.bin = resolveMpv({ bundledRoot: bundledAudioRoot() });

    return this.bin;
  }

  /** 解析运行时（带一次随包自检）。
   *  为什么要真跑一遍：随包 mpv「文件在、能 exec」不等于「跑得起来」。最典型的是 macOS ——
   *  上游按构建机系统版本出 macos-14/15/26 几档，最低系统版本（Mach-O 的 minos）写死在里面，
   *  装高了在本机系统上被 dyld 直接拒（SIGABRT）；CI 恰好在够新的系统上，永远验不出来。
   *  不认这一步的话，用户看到的只是「点了播放没反应」，日志里也只有一句 exited early。
   *  认出来之后回落宿主 mpv：有就顶用（先能听歌），没有也把原因写进日志与 status.reason。 */
  async resolveRuntime() {
    const found = this.findBin();

    if (!found || found.source !== "bundled") return found;

    if (this.bundledProbe === undefined) this.bundledProbe = probeRuntime(found, 10000);
    const probe = await this.bundledProbe;

    if (probe.ok) return found;
    // 门槛型的失败给一句能直接照做的诊断：读到载荷声明的 macOS 门槛 + 本机系统版本
    const min = process.platform === "darwin" ? machOMinOs(found.payload) : null;
    const running = process.platform === "darwin" ? parseOsVersion(process.getSystemVersion?.() ?? "") : null;

    const why = osVersionGt(min, running)
      ? `它要求 macOS ${formatOsVersion(min)}，本机是 ${formatOsVersion(running)}`
      : `exit=${probe.status}${probe.signal ? `, signal=${probe.signal}` : ""}`;

    this.binNote = `随包 mpv 起不来（${why}）`;
    this.log(`[audio] ${this.binNote}；原始输出：`, probe.output.slice(0, 400));
    this.log("[audio] 回落宿主 mpv（QUAVER_MPV 可显式指定一份能跑的）");
    this.bin = resolveMpv({ bundledRoot: null }); // null = 跳过随包那层，走 env / PATH

    return this.bin;
  }

  /** 给 mpv 配看门狗：spawn 一个 ELECTRON_RUN_AS_NODE 的小进程，stdin 管道写端握在
   *  本进程手里 —— 父进程无论以何种方式死亡（正常退出/崩溃/SIGKILL/注销），管道断 →
   *  看门狗 SIGKILL mpv。兜 will-quit 跑不到的场景（注销时 mpv 成孤儿继续放歌）。 */
  armWatchdog(mpv: MpvIpc): void {
    this.stopWatchdog();
    const pid = mpv.child?.pid ?? 0;

    if (!pid) return;

    try {
      const wd = spawn(process.execPath, [WATCHDOG_SCRIPT, String(pid)], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });

      wd.unref();          // 不挡主进程退出
      // 管道写端同理（unref 只摘事件循环引用，fd 仍握着不断开）；@types/node 的 Writable
      // 没声明 unref（运行期管道其实是 Socket），类型上补个可选口子
      (wd.stdin as { unref?: () => void } | null)?.unref?.();
      this.watchdog = wd;
      this.log("[audio] watchdog armed, mpv pid", pid);
    } catch (e) {
      this.log("[audio] watchdog arm failed:", String(e));
    }
  }

  stopWatchdog(): void {
    const wd = this.watchdog;
    this.watchdog = null;

    if (!wd) return;

    try { wd.stdin?.end(); } catch {}

    try { wd.kill(); } catch {}
  }

  /** 拉起（或复用）mpv。返回 MpvIpc。失败抛错。 */
  async ensureStarted(): Promise<MpvIpc> {
    if (this.mpv && !this.mpv.dead) return this.mpv;

    if (this.starting) return this.starting;
    const found = await this.resolveRuntime();

    if (!found) {
      throw new Error("未找到 mpv 可执行文件（可用 QUAVER_MPV 指定路径）"
        + (this.binNote ? `；${this.binNote}` : ""));
    }

    this.starting = (async () => {
      // 排障口子：QUAVER_MPV_ARGS 追加 mpv 参数（空白分隔，如 "--ao=null"；测试/无声环境用）
      const extraArgs = (process.env.QUAVER_MPV_ARGS ?? "").split(/\s+/).filter(Boolean);
      const pcmFile = this.mode === "pcm" ? await this.startPcmPipe() : "";

      const mpv = new MpvIpc(found.argv, {
        log: this.log,
        volume: this.mode === "pcm" ? 1 : this.st.volume * this.fadeLevel, // PCM 音量在 renderer 侧
        muted: this.mode === "pcm" ? false : this.st.muted,
        audioDevice: mpvAudioDevice(this.device),
        pcmFile,
        extraArgs,
      });

      try {
        await mpv.start();
      } catch (e) {
        this.stopPcmPipe();
        throw e;
      }

      // EQ 必须在第一首歌 file-loaded 前套上；失败只记日志，不能连累播放。
      await this.applyEqualizer(mpv).catch(() => {});
      // —— 状态观察（id 与 mpv-ipc 无耦合，仅作 property-change 归属）——
      // 并行发，别用 5 个串行 IPC 给起播/seek 重拉凭空加一轮 RTT。
      await Promise.all([
        mpv.observe(1, "time-pos"),
        mpv.observe(2, "duration"),
        mpv.observe(3, "pause"),
        mpv.observe(4, "paused-for-cache"),
        mpv.observe(5, "idle-active"),
      ]);
      // 播种一次真实状态：mpv 只在属性「变化」时推 property-change，
      // 初值若与我们默认值重合就永远收不到事件（实测 pause 默认 false 而引擎默认 true → 状态永远错位）。
      const seed = await this.readState(mpv);
      this.st = { ...this.st, ...seed };
      mpv.eventCb = (ev) => this.onMpvEvent(ev, mpv);
      // 只让当前实例的退出停掉当前 watchdog；seek 重拉时旧实例的迟到 exit
      // 不能误杀新实例的 watchdog / PCM 管道。
      mpv.exitCb = () => {
        if (this.mpv === mpv || this.mpv === null) this.stopWatchdog();
      };

      this.armWatchdog(mpv);
      this.mpv = mpv;
      this.loadfileIndex = mpvLoadfileWantsIndex(mpv.mpvVersion);
      this.log("[audio] mpv ready:", mpv.mpvVersion);

      return mpv;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** 读一次 mpv 真实状态（idle 下 time-pos/duration 属「不可用」，逐项兜底）。 */
  async readState(mpv: MpvIpc): Promise<EngineState> {
    const pick = async (prop: string, dflt: number | boolean): Promise<number | boolean> => {
      try {
        const v = await mpv.getProp(prop);

        // get_property 的应答是任意 JSON；出口处已按 typeof 逐项校验，这里只管透传
        return v === null || v === undefined ? dflt : (v as number | boolean);
      } catch { return dflt; }
    };

    const [pause, idle, dur, pos, mute] = await Promise.all([
      pick("pause", false), pick("idle-active", true), pick("duration", 0),
      pick("time-pos", 0), pick("mute", false),
    ]);

    return {
      paused: !!pause,
      idle: !!idle,
      dur: typeof dur === "number" && isFinite(dur) ? dur : 0,
      pos: typeof pos === "number" && isFinite(pos) ? pos : 0,
      // volume 不回读：mpv 那边是「目标 × 淡入淡出包络」，回读会把包络当成用户音量
      volume: this.st.volume,
      muted: !!mute,
      buffering: false,
    };
  }

  private entryIdOf(value: MpvValue): number {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    const n = Number(value.playlist_entry_id);

    return Number.isFinite(n) ? n : 0;
  }

  /** 开一代新载入：上一代的 start-file/file-loaded/end-file 从此刻起全部作废。 */
  private beginLoadGeneration(): number {
    this.cancelLoadWatchdog();
    this.loadGen++;
    this.startGen = 0;
    this.loadedGen = 0;
    this.loadErrGen = 0;
    this.loadEntryId = 0;

    return this.loadGen;
  }

  private cancelLoadWatchdog(): void {
    if (this.loadWatchdog === null) return;
    clearTimeout(this.loadWatchdog);
    this.loadWatchdog = null;
  }

  /** loadfile 已接受但一直没有 start-file/file-loaded：重启 mpv 并把错误交还播放器。
   *  常见于旧 AO 写线程卡死导致 mpv 命令线程停摆 —— 继续在同一条坏连接上换档只会
   *  把整条队列排队到超时。 */
  private armLoadWatchdog(gen: number): void {
    this.cancelLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      this.loadWatchdog = null;

      if (gen !== this.loadGen || this.loadedGen === gen || this.loadErrGen === gen) return;

      this.loadErrGen = gen;
      this.log(`[audio] load e${gen} stalled for ${LOAD_STALL_MS}ms; restarting mpv`);
      this.stopMpv();
      // 走 dead 而不是 error：渲染层会一并 kill PCM sink，别让旧的预写尾巴继续响。
      this.send({ t: "dead", message: "mpv 载入超时（命令通道无响应），已重启播放引擎" });
    }, LOAD_STALL_MS);
    this.loadWatchdog.unref?.();
  }

  /** 异步下发 loadfile，并把 mpv 的即时参数错误（尤其 0.38 前后的 index 布局差异）
   *  当场接住。真正的载入结果由 start-file/file-loaded/end-file 事件补齐。 */
  private async sendLoadfile(mpv: MpvIpc, gen: number, url: string, startAt: number): Promise<void> {
    const send = async (): Promise<MpvValue> => mpv.commandAsync(loadfileArgs(url, startAt, this.loadfileIndex), LOAD_ACK_TIMEOUT_MS);
    let data: MpvValue;

    try {
      data = await send();
    } catch (e) {
      const msg = String(e);

      this.log("[audio] loadfile failed:", msg);

      if (gen === this.loadGen && /invalid parameter/.test(msg) && this.loadRetried !== gen) {
        // 版本探测失配（或宿主 mpv 比预期旧）：换另一种布局原样重发一次。
        this.loadRetried = gen;
        this.loadfileIndex = !this.loadfileIndex;
        this.log(`[audio] loadfile layout rejected; retry ${this.loadfileIndex ? "new" : "old"} layout`);

        try {
          data = await send();
        } catch (retryErr) {
          const retryMsg = String(retryErr);

          if (/timeout|not running|socket closed/i.test(retryMsg)) this.stopMpv();

          throw retryErr;
        }
      } else {
        if (/timeout|not running|socket closed/i.test(msg)) this.stopMpv();

        throw e;
      }
    }

    if (gen !== this.loadGen) return;

    const entry = this.entryIdOf(data);

    if (entry) {
      this.loadEntryId = entry;
      this.currentEntryId = entry;
    }

    this.armLoadWatchdog(gen);
  }

  /** 播放态意图下发。async 回执只证明命令被接收；超时/连接断开意味着命令线程
   *  已经不服务这条连接，直接重启 mpv，别让下一次换档继续排在坏连接后面。 */
  private async setPauseIntent(mpv: MpvIpc, paused: boolean): Promise<void> {
    try {
      await mpv.setPropAsync("pause", paused, LOAD_ACK_TIMEOUT_MS);
    } catch (e) {
      const msg = String(e);

      if (/timeout|not running|socket closed/i.test(msg)) this.stopMpv();

      throw e;
    }
  }

  onMpvEvent(ev: MpvEvent, source: MpvIpc | null = this.mpv): void {
    // seek 重拉 / 崩溃重拉会短暂出现旧实例的迟到事件；它们不能覆盖新实例状态。
    if (source && (this.retiredMpvs.has(source) || (this.mpv && source !== this.mpv))) return;

    if (ev.event === "property-change") {
      const d = ev.data;

      switch (ev.id) {
        case 1: // time-pos（idle 时为 null）
          // pcm 模式的时间轴以 renderer 实际消费的样本为准；mpv 的 time-pos 会被
          // `ao_pcm` 的无时钟解码/管道预写带偏，只留给快照兜底，不用于 UI。
          if (this.mode !== "pcm") this.st.pos = typeof d === "number" && isFinite(d) ? d : 0;
          this.pushState();
          break;
        case 2:
          // mpv 回 idle 时会先把 duration 报成 0；PCM 尾巴还在 renderer 里播，
          // 这时保留当前曲时长，别让进度条在最后一秒失去总长。
          if (!(this.mode === "pcm" && (this.pcmEnding || this.pcmReloading) && Number(d) === 0)) {
            this.st.dur = typeof d === "number" && isFinite(d) ? d : 0;
          }

          this.pushState(true);
          break;
        case 3:
          {
            const loadPending = this.loadedGen !== this.loadGen && this.loadErrGen !== this.loadGen;

            if (!loadPending && !(this.mode === "pcm" && this.pcmEnding)) this.st.paused = !!d;

            // mpv 回 idle 时 pause 可能先于 end-file 到达；这时补发曲末，别把队列挂死。
            // 只认当前载入代：换曲/stop 后的旧 pause 事件不能把新队列项判成曲末。
            if (this.mode !== "pcm" && this.startGen === this.loadGen && d === true && this.st.idle) this.finishTrack();

            this.pushState(true);
            break;
          }
        case 4:
          // pcm 模式的真实缓冲在 renderer AudioBuffer 队列里；mpv 的
          // paused-for-cache 会被 ao_pcm 背压误触发，不能拿它卡住 loading。
          if (this.mode !== "pcm") {
            this.st.buffering = !!d;
            this.pushState(true);
          }

          break;
        case 5:
          {
            this.st.idle = !!d;
            // loadfile 已下发、file-loaded 未到：这次的 idle=true 多半来自上一首
            // 被 replace 的瞬间。不能让它清掉新曲的 buffering/paused（否则 UI 会
            // 在真正出声前先跳成「暂停」）。
            const loadPending = this.loadedGen !== this.loadGen && this.loadErrGen !== this.loadGen;
            const holdIdle = loadPending || (this.mode === "pcm" && (this.pcmEnding || this.pcmReloading));

            if (this.st.idle && !holdIdle) {
              this.st.pos = 0;
              this.st.dur = 0;
              this.st.buffering = false;
              this.st.paused = true;
              this.pcmPos = 0;
            } else if (this.st.idle && holdIdle) {
              // ending：尾音还在 renderer 队列；reloading：切歌/seek 的 stop→重绑间隙。
              // 两种都不能让 idle 事件清掉播放态。
              this.st.idle = false;
              if (this.pcmEnding) this.st.buffering = false;
            }

            this.pushState(true);
          }
          break;
      }

      return;
    }

    switch (ev.event) {
      case "start-file":
        // mpv 总是 start-file 先于 file-loaded/end-file。给当前载入盖章后，
        // 后续事件才允许改播放状态；没有这层，旧档的迟到 end-file(error)
        // 会被算到刚下发的新档头上，好档被判成坏档、整条回退链一起误判。
        // entry id 已经能从异步回执里拿到时，旧载入迟到的 start-file 不许给新代盖章。
        // 旧 mpv 的回执不带 entry id：此时用 start-file 自己补上，别把正常载入误杀。
        const startEntry = Number(ev.playlist_entry_id ?? 0) || 0;

        if (this.loadEntryId && startEntry && startEntry !== this.loadEntryId) {
          this.log("[audio] ignored stale start-file:", startEntry, "current", this.loadEntryId);
          break;
        }

        if (!this.loadEntryId && startEntry) this.loadEntryId = startEntry;
        this.startGen = this.loadGen;
        break;
      case "file-loaded":
        if (this.startGen !== this.loadGen) {
          this.log("[audio] ignored stale file-loaded");
          break;
        }

        const fileEntry = Number(ev.playlist_entry_id ?? 0) || 0;

        if (this.loadEntryId && fileEntry && fileEntry !== this.loadEntryId) {
          this.log("[audio] ignored stale file-loaded:", fileEntry, "current", this.loadEntryId);
          break;
        }

        if (!this.loadEntryId && fileEntry) this.loadEntryId = fileEntry;
        this.cancelLoadWatchdog();
        this.loadedGen = this.loadGen;
        this.currentEntryId = fileEntry || this.loadEntryId || this.currentEntryId;
        this.st.idle = false;
        this.st.buffering = false;
        this.pcmReloading = false;

        // 真正出声的这一刻开始淡入（loadfile 被接受到 file-loaded 之间是静音窗口）
        if (!this.st.paused) this.rampTo(1, this.fade.inMs);
        // 渲染层据此结束 loading（canplay 语义）。loadfile 是异步下发的，
        // 不能再用 invoke 返回当作「已经能播」。
        this.send({ t: "loaded", epoch: this.pcmEpoch });
        this.pushState(true);
        break;
      case "end-file": {
        const endEntryForGate = Number(ev.playlist_entry_id ?? 0) || 0;
        // 正常事件必须先见 start-file；但 loadfile 直接失败时 mpv 可能只回
        // end-file(error)，没有 start-file。entry id 与本次回执一致时放行这条错误，
        // 别让用户干等 12s 的载入看门狗。
        const directLoadError = ev.reason === "error" && !!endEntryForGate
          && !!this.loadEntryId && endEntryForGate === this.loadEntryId;

        // 只认归属于本次载入的 end-file。换曲时我们主动打断的上一首也会补一条
        // reason=stop；把它算到新曲头上会把新曲判成已结束。
        if (this.startGen !== this.loadGen && !directLoadError) {
          this.log("[audio] ignored stale end-file:", ev.playlist_entry_id ?? "?", "gen", this.loadGen);
          break;
        }

        this.cancelLoadWatchdog();
        // loadfile replace 后可能还有上一首的迟到 end-file；entry id 不匹配就丢弃。
        const endEntry = endEntryForGate;
        const expected = this.loadEntryId || this.currentEntryId;

        if (endEntry && expected && endEntry !== expected) {
          this.log("[audio] ignored stale end-file:", endEntry, "current", expected);
          break;
        }

        if (this.loadEntryId && endEntry) this.currentEntryId = this.loadEntryId;

        // stop 命令也发 end-file(reason=stop)：那是我们自己打断，不是自然播完
        if (ev.reason === "eof") {
          if (this.mode === "pcm") {
            // mpv 的 EOF 只代表最后一块 PCM 已写进管道。保持 playing，先把
            // pcmBuf 的尾巴发完；renderer 真正排空后会发 pcm-ended。
            this.pcmEnding = true;
            this.pcmEofSent = false;
            this.st.buffering = false;
            this.drainPcm();
          } else {
            this.finishTrack();
          }

          this.pushState(true);
        } else if (ev.reason === "error") {
          this.loadErrGen = this.loadGen;
          this.st.buffering = false;
          this.st.paused = true;
          this.send({ t: "error", epoch: this.pcmEpoch, message: `mpv 播放失败：${ev.file_error ?? ev.reason}` });
          this.pushState(true);
        }

        break;
      }
      case "__exit__":
        this.log("[audio] mpv exited:", ev.code);
        this.cancelLoadWatchdog();
        this.mpv = null;
        this.stopPcmPipe();
        this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
        this.send({ t: "dead", message: "mpv 进程退出（下一次操作将自动重启它）" });
        break;
    }
  }

  /** 渲染层给的可能是相对路径（/api/stream/...）——mpv 是独立进程，必须绝对化。
   *  vkey/token 依旧只出现在这条本机中继 URL 里，不进命令行与参数。 */
  absolutize(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;

    if (!this.baseUrl) throw new Error("音频引擎未初始化（baseUrl 缺失）");

    return new URL(url, this.baseUrl).href;
  }

  private beginLoadState(paused: boolean, startAt: number): void {
    // 包络压到 0：新流出声即从静音起步（file-loaded 后再淡入）。
    // 已经在淡出就沿用剩余时长继续降；null = 作废「淡出后 stop」——切歌时那个 stop 会把新歌掐掉。
    this.rampTo(0, this.fadeTarget === 0 ? this.fade.outMs : 0, null);
    this.st.paused = paused;
    this.st.buffering = true; // loadfile 被接受 → 到 file-loaded 之间算缓冲
    this.st.idle = false;
    this.pcmPos = startAt;
    this.pcmBase = startAt;
    this.pcmSentSec = 0;
    this.st.pos = startAt;
    this.pcmEnding = false;
    this.pcmEofSent = false;
    this.pcmLastDataAt = Date.now();
    this.pcmReloading = false;
    this.pcmBuf = Buffer.alloc(0);
    this.pushState(true);
  }

  private async loadPcm(url: string, paused: boolean, startAt: number, epoch: number) {
    if (epoch !== this.pcmEpoch) return { ok: true, stale: true };
    const startedAt = Date.now();
    const gen = this.beginLoadGeneration();

    // restartPcmSession 的 stop→重绑期间 mpv 会短暂回 idle；保持 loading 态，
    // 别让 idle-active 事件把新歌的 buffering/paused 清掉。
    this.pcmReloading = true;

    // 从第二首开始先换 FIFO/AO；旧管道的在途数据由回调里捕获的旧 epoch 丢弃。
    const mpv = this.lastUrl
      ? await this.restartPcmSession(epoch)
      : await this.ensureStarted();

    const outputAt = Date.now();

    if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

    this.beginLoadState(paused, startAt);

    if (paused) this.pcmPipe?.pause();
    else this.pcmPipe?.resume();

    // 播放态意图先落到引擎状态，再显式置 mpv pause（loadfile 默认自动开播）：
    // 显式置位还有个副作用是必发 property-change —— 上一次 stop/eof 留下的 pause 分歧靠它收敛。
    await this.setPauseIntent(mpv, paused);
    const pausedAt = Date.now();

    if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

    await this.sendLoadfile(mpv, gen, url, startAt);
    const loadedAt = Date.now();

    if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

    this.lastUrl = url;
    this.drainPcm();

    this.log(
      `[audio] PCM e${epoch} load accepted: output ${outputAt - startedAt}ms, `
      + `pause ${pausedAt - outputAt}ms, loadfile ${loadedAt - pausedAt}ms, total ${loadedAt - startedAt}ms`,
    );

    return { ok: true, gen };
  }

  /** 原生兼容模式的 seek：复用 MPV 进程，换新一代 FIFO 后用 `start=` 重挂。
   *  ao_pcm 的 seek 不提供帧标记，不能原地 seek；新 FIFO 保证旧 PCM 不会混进来。 */
  async restartPcmAt(sec: number, epoch: number): Promise<void> {
    if (epoch < this.pcmEpoch) return;
    this.pcmEpoch = epoch;

    return this.serializePcm(() => this.doRestartPcmAt(sec, epoch));
  }

  private async doRestartPcmAt(sec: number, epoch: number): Promise<void> {
    if (epoch !== this.pcmEpoch) return; // 更新的 load/seek 已经接手
    const url = this.lastUrl;

    if (!url) return;
    const at = Math.max(0, sec);
    const wasPaused = this.st.paused;
    const dur = this.st.dur;
    const gen = this.beginLoadGeneration();

    this.pcmReloading = true;
    this.pcmBase = at;
    this.pcmPos = at;
    this.pcmSentSec = 0;
    this.pcmEnding = false;
    this.pcmEofSent = false;
    this.pcmLastDataAt = Date.now();
    this.pcmBuf = Buffer.alloc(0);
    this.st = { ...this.st, pos: at, dur, paused: wasPaused, buffering: true, idle: false };
    this.pushState(true);

    const mpv = await this.restartPcmSession(epoch);

    if (epoch !== this.pcmEpoch) return; // 等 mpv 期间又切歌/跳转：别让旧 seek 写回状态

    this.st = { ...this.st, pos: at, dur, paused: wasPaused, buffering: true, idle: false };
    this.pcmBase = at;
    this.pcmPos = at;
    this.pcmSentSec = 0;
    this.pcmBuf = Buffer.alloc(0);
    this.pcmEnding = false;
    this.pcmEofSent = false;
    this.pcmLastDataAt = Date.now();

    if (this.mode !== "pcm") await this.setPauseIntent(mpv, wasPaused);

    await this.sendLoadfile(mpv, gen, url, at);

    if (epoch !== this.pcmEpoch) return;

    this.lastUrl = url;

    if (wasPaused) this.pcmPipe?.pause();
    else {
      this.pcmPipe?.resume();
      this.applyVolume();
      this.drainPcm();
    }

    this.pushState(true);
  }

  async onInvoke(cmd: EngineCmd) {
    switch (cmd?.cmd) {
      case "status": {
        const found = await this.resolveRuntime();
        const running = this.mpv && !this.mpv.dead;

        return {
          ok: true, backend: "mpv", mode: this.mode,
          available: !!found,
          // binNote 优先：随包起不来（已回落宿主 mpv）这件事必须让渲染层/日志看得见
          reason: this.binNote || (found ? "" : "未找到 mpv（安装 mpv、设置 QUAVER_MPV，或用随包运行时）"),
          source: found?.source ?? "",          // env | bundled | path
          payload: found?.payload ?? "",
          version: running && this.mpv ? this.mpv.mpvVersion : "",
          running: !!running,
          device: this.device,
          captureCompatible: this.mode === "pcm",
        };
      }

      case "mode": {
        const mode: AudioOutputMode = cmd.mode === "pcm" ? "pcm" : "native";

        if (this.mode !== mode) {
          this.log("[audio] output mode ->", mode);
          this.stopMpv();
          this.mode = mode;
          this.pcmPos = 0;
          this.pcmBase = 0;
          this.pcmSentSec = 0;
          this.pcmClientReady = false;
          this.pcmEnding = false;
          this.pcmEofSent = false;
          this.pcmBuf = Buffer.alloc(0);
          this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
        }

        return { ok: true, mode: this.mode, captureCompatible: this.mode === "pcm", epoch: this.pcmEpoch };
      }

      case "pcm-ready": {
        if (this.mode !== "pcm") return { ok: false, error: "not in pcm mode" };
        this.pcmReady = true;
        this.pcmClientReady = true;
        this.applyVolume();
        this.applyEqualizer();

        if (!this.st.paused) {
          this.pcmPipe?.resume();
          this.drainPcm();
        }

        return {
          ok: true,
          gain: this.st.muted ? 0 : this.st.volume * this.fadeLevel,
          eq: this.eq,
        };
      }

      case "pcm-progress": {
        const pos = Number(cmd.pos);
        const queued = Number(cmd.queued);

        if (isFinite(pos) && pos >= 0) this.pcmPos = pos;

        // 第二层流控（第一层在 drainPcm 的硬窗口里）。这里同时把 PCM 位置
        // 回推给 renderer，否则 mpv 的 time-pos 不动时进度条/歌词不会刷新。
        if (this.pcmReady && isFinite(queued)) {
          if (queued > 0.9) this.pcmPipe?.pause();
          else if (queued < 0.45 && !this.st.paused) this.pcmPipe?.resume();
        }

        this.drainPcm();
        this.pushState(true);

        return { ok: true };
      }

      case "pcm-ended": {
        if (this.mode !== "pcm" || !this.pcmEnding) return { ok: true };

        if (Number(cmd.epoch) !== this.pcmEpoch) return { ok: true };

        const pos = Number(cmd.pos);

        if (isFinite(pos) && pos >= 0) this.pcmPos = pos;

        this.pcmEnding = false;
        this.pcmEofSent = false;
        this.st = {
          ...this.st,
          pos: this.pcmPos,
          paused: true,
          buffering: false,
          idle: true,
        };
        this.pushState(true);

        return { ok: true };
      }

      case "boot": {
        const mpv = await this.ensureStarted();

        return { ok: true, version: mpv.mpvVersion };
      }

      case "snapshot": {
        // 渲染层接管用（CSD/SSD 重建窗口后的新页面）：引擎的真实播放态 + 现挂的流 URL。
        // 引擎活在渲染层之外，窗口拆掉它还在放 —— 新页面问一次就知道「正在放哪条流、放到哪」，
        // 直接接管而不是重新挂流（重新挂会 replace 掉正在放的歌）。
        const running = !!this.mpv && !this.mpv.dead;

        return {
          ok: true, backend: "mpv", mode: this.mode, running,
          pos: this.mode === "pcm" ? this.pcmPos : this.st.pos,
          dur: this.st.dur,
          paused: this.st.paused, buffering: this.st.buffering, idle: this.st.idle,
          url: running ? this.lastUrl : "",
        };
      }

      case "load": {
        const url = this.absolutize(String(cmd.url ?? ""));

        if (!url) return { ok: false, error: "missing url" };

        const epoch = Number(cmd.epoch) || this.pcmEpoch + 1;

        if (epoch < this.pcmEpoch) return { ok: true, stale: true };
        this.pcmEpoch = epoch;

        const paused = !!cmd.paused;
        const startAt = Math.max(0, Number(cmd.startAt) || 0);

        if (this.mode === "pcm") {
          return this.serializePcm(() => this.loadPcm(url, paused, startAt, epoch));
        }

        const mpv = await this.ensureStarted();

        if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

        const gen = this.beginLoadGeneration();
        this.beginLoadState(paused, startAt);
        await this.setPauseIntent(mpv, paused);

        if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

        await this.sendLoadfile(mpv, gen, url, startAt);

        if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

        this.lastUrl = url;

        return { ok: true, gen };
      }

      case "play": {
        const mpv = await this.ensureStarted();
        this.st.paused = false; // 意图先落地（mpv 只在变化时推事件，值相同则不推）

        if (this.mode === "pcm") {
          // 先回升包络并作废 pause 的“淡出后停读”动作，再放行 FIFO；
          // 否则暂停/恢复抢在淡出结束前时，旧动作会把刚恢复的管道重新关掉。
          this.rampTo(1, this.fade.inMs);
        }

        this.pcmPipe?.resume();
        this.drainPcm();
        this.pushState(true);

        if (this.mode !== "pcm") await this.setPauseIntent(mpv, false);
        else {
          // 用户暂停时我们刻意不动 mpv 的 pause；但「挂流不自动播」/seek 重拉
          // 会把它置真。恢复播放只在确实 paused 时解一次，避免向卡在 FIFO 写端的
          // AO 线程重复发命令。
          const mpvPaused = await mpv.command(["get_property", "pause"], LOAD_ACK_TIMEOUT_MS).catch(() => false);

          if (mpvPaused) await this.setPauseIntent(mpv, false);
        }
        // eof 后 mpv 回 idle 会卸载文件：按上一次 URL 重挂（单曲循环/播完再点播放）。
        // 判据实查 mpv（不信缓存的 idle 态）：渲染层的 ended→play 往返可能快过 idle-active 事件落库。

        const idleNow = await mpv.command(["get_property", "idle-active"], LOAD_ACK_TIMEOUT_MS).catch(() => this.st.idle);
        // loadfile 已下发但 file-loaded 还没到时，idle-active 可能仍是上一刻的 true。
        // 这时绝不能按「放下一次」重挂：会把刚发起的载入 replace 掉，表现为切歌慢/切回旧曲。
        const loadPending = this.loadedGen !== this.loadGen && this.loadErrGen !== this.loadGen;

        this.st.idle = !!idleNow && !loadPending;

        if (this.st.idle && this.lastUrl) {
          const gen = this.beginLoadGeneration();
          this.st.buffering = true;
          this.st.idle = false;
          this.pcmPos = 0;
          this.pcmBase = 0;
          this.pcmSentSec = 0;
          this.pcmEnding = false;
          this.pcmEofSent = false;
          this.pcmReloading = false;
          this.pcmBuf = Buffer.alloc(0);
          this.pushState(true);
          await this.sendLoadfile(mpv, gen, this.lastUrl, 0);
        }

        if (this.mode !== "pcm") this.rampTo(1, this.fade.inMs); // 从当前包络淡入（淡出途中按播放 = 掉头回升）

        return { ok: true, gen: this.loadGen };
      }

      case "pause":
        this.doPause();

        return { ok: true };
      case "stop": {
        if (!this.mpv || this.mpv.dead) return { ok: true };
        const mpv = this.mpv;
        this.cancelLoadWatchdog();
        const stopGen = this.loadGen;
        this.pcmPipe?.pause();
        this.st.paused = true;
        this.pushState(true);
        // 先淡出、到 0 再真停；期间若来了新歌（load 会作废这一步）就交给它接管
        this.rampTo(0, this.fade.outMs, () => {
          void mpv.commandAsync(["stop"], LOAD_ACK_TIMEOUT_MS).catch(() => {});
          // stop 是显式「卸载当前流」：清掉 eof 后重挂用的 lastUrl，否则下次 play
          // 会把上一首重新 loadfile 回来。登出/清队列后残留旧曲就是这条路径。
          // 只有仍是同一代才清；淡出期间已经切到新歌时，lastUrl 属于新歌。

          if (this.mpv === mpv && this.loadGen === stopGen) {
            this.beginLoadGeneration();
            // 显式 stop 后不会再有 file-loaded；把这一代标成已结算，
            // 后续 idle/pause 事件才能正常落库（loadPending 不再永久为真）。
            this.loadedGen = this.loadGen;

            this.lastUrl = "";
          }

          this.pcmPos = 0;
          this.pcmBase = 0;
          this.pcmSentSec = 0;
          this.pcmEnding = false;
          this.pcmEofSent = false;
          this.pcmReloading = false;
          this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
          this.pushState(true);
        });

        return { ok: true };
      }

      case "seek": {
        const sec = Number(cmd.sec);

        if (!isFinite(sec)) return { ok: false, error: "bad sec" };
        const at = Math.max(0, sec);
        this.finishFadeOut(); // 淡出途中 seek（MPRIS Stop）：马上收尾，别听见歌头再静音

        if (this.mode === "pcm" && this.lastUrl) {
          await this.restartPcmAt(at, Number(cmd.epoch) || this.pcmEpoch + 1);

          return { ok: true };
        }

        if (!this.mpv || this.mpv.dead) return { ok: false, error: "mpv not running" };

        try {
          await this.mpv.commandAsync(["seek", at, "absolute"], LOAD_ACK_TIMEOUT_MS);
        } catch (e) {
          return { ok: false, error: String(e) };
        }

        this.st.pos = at; // 乐观位置：state 事件马上会对齐
        this.pushState(true);

        return { ok: true };
      }

      case "volume": {
        const v = Math.max(0, Math.min(1, Number(cmd.value)));

        if (!isFinite(v)) return { ok: false, error: "bad volume" };
        this.st.volume = v;
        this.applyVolume(); // 乘包络：不在淡出途中打断淡出，也不在淡入途中跳音量

        return { ok: true };
      }

      case "mute": {
        this.st.muted = !!cmd.value;

        if (this.mode === "pcm") this.applyVolume();
        else if (this.mpv && !this.mpv.dead) await this.mpv.setProp("mute", !!cmd.value).catch(() => {});

        return { ok: true };
      }

      case "fade": {
        const clamp = (n: unknown): number => Math.max(0, Math.min(3000, Math.round(Number(n) || 0)));
        this.fade = { inMs: clamp(cmd.inMs), outMs: clamp(cmd.outMs) };

        // 关掉淡入淡出时别把音量卡在半路上（只在淡入方向兜底；淡出途中说明有 pending 动作，别打断）
        if (!this.fade.inMs && !this.fade.outMs && this.fadeTarget === 1 && this.fadeLevel < 1) this.rampTo(1, 0);

        return { ok: true, fade: this.fade };
      }

      case "eq": {
        // IPC 边界统一 normalize：freq/gain/Q 越界会夹紧，未知 type 落 bell，段数封顶。
        this.eq = normalizeEqState(cmd.state);

        if (this.mode === "pcm") {
          this.applyEqualizer();

          return { ok: true, state: this.eq, filter: eqFilterString(this.eq) };
        }

        if (this.mpv && !this.mpv.dead) {
          try {
            await this.applyEqualizer(this.mpv);
          } catch (e) {
            return { ok: false, error: String((e as Error)?.message ?? e), state: this.eq };
          }
        }

        return { ok: true, state: this.eq, filter: eqFilterString(this.eq) };
      }

      case "devices": {
        const mpv = await this.ensureStarted();
        const [list, current] = await Promise.all([mpv.getProp("audio-device-list"), mpv.getProp("audio-device")]);

        return {
          ok: true,
          current: String(current ?? "auto"),
          devices: (Array.isArray(list) ? list : []).map((d) => {
            // SAFETY: mpv 的 audio-device-list 每项都是 {name, description} 对象；非对象条目兜底成空
            const o = (d && typeof d === "object" ? d : {}) as MpvObject;

            return { id: String(o.name), desc: String(o.description ?? o.name) };
          }),
        };
      }

      case "device": {
        const id = mpvAudioDevice(String(cmd.id ?? "auto"));
        this.device = id;

        if (this.mpv && !this.mpv.dead) await this.mpv.setProp("audio-device", id).catch(() => {});

        return { ok: true, current: id };
      }

      default:
        return { ok: false, error: `unknown cmd: ${cmd?.cmd}` };
    }
  }

  /** 收尾：杀 mpv、拆看门狗。will-quit 与信号路径（注销时 will-quit 跑不到，见
   *  main.ts 的 SIGTERM 接管）都会走这里；幂等。 */
  shutdown() {
    this.stopMpv();
  }
}

export const audioEngine = new AudioEngine();
