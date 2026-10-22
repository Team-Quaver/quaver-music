// Quaver — 主进程音频引擎（mpv 后端）。
// 真相归属：位置/时长/播放态/缓冲归引擎（这里）；曲目/队列/循环/随机归渲染层（player.ts）。
// 渲染层经 preload 桥（quaverAudio.invoke / quaverAudio.onEvent）驱动；MPRIS 快照仍由渲染层
// 合成推送（daemon 协议不动），位置源在两条传输下都收敛到 player.time —— 同一时刻只有一个位置来源。
//
// 生命周期：mpv 惰性拉起（boot/load/device 等需要它的命令触发）；native 换曲不重启，
// PCM 兼容模式为了丢掉无帧边界的管道尾巴会重开会话；
// 崩溃后引擎标记 dead 并复位，下一次命令自动重拉（重试语义交给播放器的错误态，不无限自愈）。
import { app, ipcMain, type BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { probeRuntime, resolveMpv } from "./bins.ts";
import { formatOsVersion, machOMinOs, osVersionGt, parseOsVersion } from "./macho.ts";
import { MpvIpc, type MpvEvent, type MpvObject, type MpvValue } from "./mpv-ipc.ts";
import { PcmPipe } from "./pcm-pipe.ts";
import { eqFilterString, normalizeEqState, type EqState } from "./eq-config.ts";

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

export class AudioEngine {
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
  restartingPcm: Promise<void> | null; // pcm seek 串行化（拖动/媒体键可能连续来）
  fade: { inMs: number; outMs: number };
  /** Quark EQ 的当前状态（仅 mpv）：渲染层经 eq 命令下发；mpv 重拉后由 ensureStarted 重新套用。 */
  eq: EqState;
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
    this.restartingPcm = null;
    // —— 淡入淡出：用 mpv `volume` 属性做振幅包络（afade 要掐流时间位置，切歌/暂停场景不好用）——
    // fadeLevel 是乘在用户音量上的瞬时包络；fadeTarget 记住方向（0=正在/将要淡出），
    // 「淡出完成后要执行的动作」放 pendingAfterFadeOut —— 任何更新的播放意图都会把它作废，
    // 否则切歌时那个延迟的 stop 会把刚 loadfile 的新歌掐掉。
    this.fade = { inMs: 400, outMs: 250 };
    this.eq = normalizeEqState(null);
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

    if (!this.wired) {
      this.wired = true;
      ipcMain.handle("quaver:audio", (_e, cmd) => this.onInvoke(cmd).catch((e) => ({ ok: false, error: String(e?.message ?? e) })));
    }
  }

  send(ev: unknown): void {
    const wc = this.getWin()?.webContents;

    if (wc && !wc.isDestroyed()) { try { wc.send("quaver:audio-event", ev); } catch (e) { this.log("[audio] send failed:", String(e)); } }
  }

  startPcmPipe(): Promise<string> {
    if (this.pcmPipe) return Promise.resolve(this.pcmPipe.path);

    const pipe = new PcmPipe({
      log: this.log,
      onData: (chunk) => this.onPcmData(chunk),
      onError: (e) => this.log("[audio] PCM pipe error:", String(e)),
    });

    this.pcmPipe = pipe;

    return pipe.start().then((path) => {
      if (this.pcmClientReady) {
        this.pcmReady = true;
        pipe.resume();
      }

      return path;
    }).catch((e) => {
      try { pipe.close(); } catch {}

      this.pcmPipe = null;
      throw e;
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
    this.stopWatchdog();

    if (this.mpv) this.retiredMpvs.add(this.mpv);

    try { this.mpv?.kill(); } catch {}

    this.mpv = null;
    this.stopPcmPipe();
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
  onPcmData(chunk: Buffer): void {
    if (this.mode !== "pcm" || !this.pcmReady) return;

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
    void this.mpv.setProp("volume", Math.round(v * 100) / 100).catch(() => {});
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
      // 兼容模式不要让 mpv 参与 pause：它的 AO 线程正卡在 FIFO 写端，
      // pause 命令偶尔要等几秒。停止读管道本身就会把背压传回 mpv。
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
        audioDevice: this.device,
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

  onMpvEvent(ev: MpvEvent, source: MpvIpc | null = this.mpv): void {
    // seek 重拉 / 崩溃重拉会短暂出现旧实例的迟到事件；它们不能覆盖新实例状态。
    if (source && (this.retiredMpvs.has(source) || (this.mpv && source !== this.mpv))) return;

    if (ev.event === "property-change") {
      const d = ev.data;

      switch (ev.id) {
        case 1: // time-pos（idle 时为 null）
          // pcm 模式的时间轴以 renderer 实际消费的样本为准；mpv 的 time-pos 会被
          // `ao_pcm` 的无时钟解码/管道预写带偏，只留给快照兜底，不用于 UI。
          this.st.pos = typeof d === "number" && isFinite(d) ? d : 0;
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
          if (!(this.mode === "pcm" && this.pcmEnding)) this.st.paused = !!d;
          this.pushState(true);
          break;
        case 4:
          // pcm 模式的真实缓冲在 renderer AudioBuffer 队列里；mpv 的
          // paused-for-cache 会被 ao_pcm 背压误触发，不能拿它卡住 loading。
          if (this.mode !== "pcm") {
            this.st.buffering = !!d;
            this.pushState(true);
          }

          break;
        case 5:
          this.st.idle = !!d;

          if (this.st.idle && !(this.mode === "pcm" && this.pcmEnding)) {
            this.st.pos = 0;
            this.st.dur = 0;
            this.st.buffering = false;
            this.st.paused = true;
            this.pcmPos = 0;
          } else if (this.st.idle && this.mode === "pcm" && this.pcmEnding) {
            // mpv 先回 idle，不代表 renderer 队列已经播完；保持非 paused，等 pcm-ended。
            this.st.idle = false;
            this.st.buffering = false;
          }

          this.pushState(true);
          break;
      }

      return;
    }

    switch (ev.event) {
      case "file-loaded":
        this.currentEntryId = Number(ev.playlist_entry_id ?? this.currentEntryId) || this.currentEntryId;
        this.st.idle = false;
        this.st.buffering = false;
        this.pcmReloading = false;

        // 真正出声的这一刻开始淡入（loadfile 被接受到 file-loaded 之间是静音窗口）
        if (!this.st.paused) this.rampTo(1, this.fade.inMs);
        this.pushState(true);
        break;
      case "end-file":
        // loadfile replace 后可能还有上一首的迟到 end-file；entry id 不匹配就丢弃。
        if (ev.playlist_entry_id && this.currentEntryId && ev.playlist_entry_id !== this.currentEntryId) {
          this.log("[audio] ignored stale end-file:", ev.playlist_entry_id, "current", this.currentEntryId);
          break;
        }

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
            this.st.paused = true; // mpv eof 后回 idle，pause 属性回落
            this.send({ t: "ended" });
          }

          this.pushState(true);
        } else if (ev.reason === "error") {
          this.send({ t: "error", message: `mpv 播放失败：${ev.file_error ?? ev.reason}` });
        }

        break;
      case "__exit__":
        this.log("[audio] mpv exited:", ev.code);
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

  /** 原生兼容模式的 seek：重拉 MPV + PCM 管道，彻底丢掉旧 FIFO 里的预写音频。
   *  ao_pcm 的 seek 不提供帧标记，单靠暂停管道只能拖住旧数据，不能区分新旧 PCM。 */
  async restartPcmAt(sec: number, epoch: number): Promise<void> {
    const run = (this.restartingPcm ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.doRestartPcmAt(sec, epoch));

    this.restartingPcm = run.finally(() => {
      if (this.restartingPcm === run) this.restartingPcm = null;
    });

    return this.restartingPcm;
  }

  private async doRestartPcmAt(sec: number, epoch: number): Promise<void> {
    if (epoch < this.pcmEpoch) return; // 更新的 load/seek 已经接手
    const url = this.lastUrl;

    if (!url) return;
    const at = Math.max(0, sec);
    this.pcmEpoch = epoch;
    const wasPaused = this.st.paused;
    const dur = this.st.dur;

    this.pcmReloading = true;
    this.stopMpv();
    this.pcmBase = at;
    this.pcmPos = at;
    this.pcmSentSec = 0;
    this.pcmEnding = false;
    this.pcmEofSent = false;
    this.pcmLastDataAt = Date.now();
    this.pcmBuf = Buffer.alloc(0);
    this.st = { ...this.st, pos: at, dur, paused: wasPaused, buffering: true, idle: false };
    this.pushState(true);

    const mpv = await this.ensureStarted();

    if (epoch !== this.pcmEpoch) return; // 等 mpv 期间又切歌/跳转：别让旧 seek 写回状态

    this.st = { ...this.st, pos: at, dur, paused: wasPaused, buffering: true, idle: false };
    this.pcmBase = at;
    this.pcmPos = at;
    this.pcmSentSec = 0;
    this.pcmBuf = Buffer.alloc(0);
    this.pcmEnding = false;
    this.pcmEofSent = false;
    this.pcmLastDataAt = Date.now();

    if (this.mode !== "pcm") await mpv.setProp("pause", wasPaused);

    const loaded = await mpv.command(["loadfile", url, "replace", -1, `start=${at}`]);

    if (epoch !== this.pcmEpoch) return;

    this.currentEntryId = this.entryIdOf(loaded);

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

        return { ok: true };
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

        // PCM 管道没有帧边界；换歌/换音质时旧 FIFO 里可能还有上一首的尾巴。
        // 主动换 MPV 会话，确保新 epoch 的第一个字节不会混进旧数据。
        if (this.mode === "pcm" && this.lastUrl) {
          this.stopMpv();
          this.lastUrl = "";
        }

        const mpv = await this.ensureStarted();

        if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

        // 包络压到 0：新流出声即从静音起步（file-loaded 后再淡入）。
        // 已经在淡出就沿用剩余时长继续降；null = 作废「淡出后 stop」——切歌时那个 stop 会把新歌掐掉。
        this.rampTo(0, this.fadeTarget === 0 ? this.fade.outMs : 0, null);
        // 播放态意图先落到引擎状态，再显式置 mpv pause（loadfile 默认自动开播）：
        // 显式置位还有个副作用是必发 property-change —— 上一次 stop/eof 留下的 pause 分歧靠它收敛。
        const paused = !!cmd.paused;
        const startAt = Math.max(0, Number(cmd.startAt) || 0);
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
        this.pcmPipe?.pause();
        this.pushState(true);
        await mpv.setProp("pause", paused);

        if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

        const loaded = await mpv.command(startAt > 0
          ? ["loadfile", url, "replace", -1, `start=${startAt}`]
          : ["loadfile", url, "replace"]);

        if (epoch !== this.pcmEpoch) return { ok: true, stale: true };

        this.currentEntryId = this.entryIdOf(loaded);
        this.lastUrl = url;

        return { ok: true };
      }

      case "play": {
        const mpv = await this.ensureStarted();
        this.st.paused = false; // 意图先落地（mpv 只在变化时推事件，值相同则不推）
        this.pcmPipe?.resume();
        this.drainPcm();
        this.pushState(true);

        if (this.mode !== "pcm") await mpv.setProp("pause", false);
        else {
          // 用户暂停时我们刻意不动 mpv 的 pause；但「挂流不自动播」/seek 重拉
          // 会把它置真。恢复播放只在确实 paused 时解一次，避免向卡在 FIFO 写端的
          // AO 线程重复发命令。
          const mpvPaused = await mpv.getProp("pause").catch(() => false);

          if (mpvPaused) await mpv.setProp("pause", false);
        }
        // eof 后 mpv 回 idle 会卸载文件：按上一次 URL 重挂（单曲循环/播完再点播放）。
        // 判据实查 mpv（不信缓存的 idle 态）：渲染层的 ended→play 往返可能快过 idle-active 事件落库。
        const idleNow = await mpv.getProp("idle-active").catch(() => this.st.idle);
        this.st.idle = !!idleNow;

        if (this.st.idle && this.lastUrl) {
          this.st.buffering = true;
          this.st.idle = false;
          this.pcmPos = 0;
          this.pcmBase = 0;
          this.pcmSentSec = 0;
          this.pcmEnding = false;
          this.pcmEofSent = false;
          this.pcmBuf = Buffer.alloc(0);
          this.pushState(true);
          await mpv.command(["loadfile", this.lastUrl, "replace"]);
        }

        this.rampTo(1, this.fade.inMs); // 从当前包络淡入（淡出途中按播放 = 掉头回升）

        return { ok: true };
      }

      case "pause":
        this.doPause();

        return { ok: true };
      case "stop": {
        if (!this.mpv || this.mpv.dead) return { ok: true };
        const mpv = this.mpv;
        this.pcmPipe?.pause();
        this.st.paused = true;
        this.pushState(true);
        // 先淡出、到 0 再真停；期间若来了新歌（load 会作废这一步）就交给它接管
        this.rampTo(0, this.fade.outMs, () => {
          void mpv.command(["stop"]).catch(() => {});
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
        await this.mpv.command(["seek", at, "absolute"]);
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
        const id = String(cmd.id ?? "auto");
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
