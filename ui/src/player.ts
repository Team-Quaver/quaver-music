// Quaver — 全局播放器状态机（常驻于 SPA 壳层，跨视图不销毁，音频不中断）
// 订阅式：任何状态变化 notify 所有 UI（播放条 / 正在播放页 / 队列面板）。
// 音频走 Transport 抽象（src/lib/transport.ts）：默认 mpv 原生引擎（Electron 壳层），
// 可选浏览器 <audio> 兜底；曲目/队列/循环/歌词归本层，位置/时长/播放态真相在传输层。
import { api, postJson, coverUrl, resolveStreamUrl, effectiveQuality, getSessionQuality, setSessionQuality, getLastStream, setLastStream, writeSongType, type StreamResult } from "./lib/api";
import {
  getDecode, setDecode, getAudioDevice, setAudioDevice, setFade, FADE_PRESETS,
  getVolume as getVolumeConf, setVolume as setVolumeConf,
  getMuted as getMutedConf, setMuted as setMutedConf,
  getShowTrans, setShowTrans,
  getPrevBehavior,
  type DecodeBackend, type FadePreset,
} from "./lib/prefs";
import { WebTransport, EngineTransport, type Transport, type TransportEvent, type AudioDeviceInfo } from "./lib/transport";
import { loadSession, saveSession } from "./lib/session";
import { dayKey, daySeed, shuffleOrder, step } from "./lib/shuffle";
import { parseLrc, type LyricLine } from "./lyric";
import type {SparkleKaraokeLine, SparkleKaraokeProvider} from "@quaver/sparkle";
import { onSparkleChange, sparkleKaraokeProvider, sparkleStreamSources } from "./sparkle/registry";

export type Song = {
  mid: string;
  id?: number;
  type?: number;
  name: string;
  /** 完整展示名（= name + 版本后缀，如「半梦 (Studio Live)」）；展示一律走 lib/api:songTitle */
  title?: string;
  /** 歌曲说明（如「《小时代》电影主题曲」），可为空 */
  subtitle?: string;
  singer?: { name: string; mid?: string; pmid?: string }[];
  album?: { mid?: string; pmid?: string; name?: string };
  interval?: number;
  _key?: string;
};

export type Mode = "off" | "all" | "one";
/** 实际生效的播放管线（transport.kind 投影；设置页据此展示） */
export type ActiveBackend = "mpv" | "web";

type Listener = () => void;

// 红心收藏是「本地数据」不是设置：留在 localStorage（上游无收藏写接口，见 README 约定）。
// 其余偏好（音量/静音/歌词翻译/后端/音质…）一律走 quaver.conf，见 lib/prefs.ts。
const LS_KEY = "quaver.loved.v1";
// 近期写入记录（mid → 写入时刻/期望态）：跨页面重载的读侧滞后庇护 —— 重载会丢进程内状态，
// 而上游读侧缓存不保证单调（不同分页参数各缓存各的），整单预载可能拿到写之前的旧快照。
const LS_WRITES_KEY = "quaver.loved.writes.v1";

// 「我喜欢」(dirid=201) 预载：每页条数 + 总上限（防超大歌单一口气拉爆首屏），
// 以及预载结果的新鲜期——期内视图直接吃缓存，过期才回源对账。
// 页尽量大：上游分页读带缓存，跨页拼接偶发「页码错位少一首」，单请求拿全最稳（500 首 ≈ 700KB）。
const LOVED_PAGE = 500;
const LOVED_MAX = 1000;
const LOVED_TTL = 60_000;

// 写后增量回源：红心写确认后不做整单分页重载，只拉「最近收藏」一小窗与远端对账。
// 上游读侧有 1-2s 滞后（见 api.ts writeSongType），故延迟触发；滞后期间的已确认写入
// 以本地乐观态为准（reconcilePending），别让回源把用户刚点的红心冲掉。
const LOVED_SYNC_DELAY = 2_000;    // 距最后一次写入/进页的静默期（去抖合并连点）
const LOVED_SYNC_PAGE = 100;       // 增量窗口：单请求，覆盖最近收藏段
// 写入庇护期：期内所有读路径都按已确认写入校正读数（读数反映也不提前出名单 ——
// 读侧缓存不保证单调，同一写值可能被更旧的快照再次冲掉）。实测过期快照能活 20s+，取 2 分钟。
const LOVED_PENDING_TTL = 120_000;

// 会话存档（队列 + 指针 + 位置 + 循环模式）节流：notify 是 4Hz 的，不能跟着写盘。
const SESSION_EVERY = 5000;

class Player {
  private transport: Transport = new WebTransport();
  queue: Song[] = [];
  index = -1;
  /** 队列内容版本号：任何队列变更 +1（QueuePanel 据此做 4Hz 去重，
   *  免得每次位置广播都把整条队列拼成大字符串比对） */
  queueVersion = 0;
  mode: Mode = "all";
  /** 随机播放（每日一套顺序，种子 = 本地日期，见 lib/shuffle.ts）。
   *  会话存档字段：与 mode 同一个生命周期 —— 退出前开着，重进还是开着。 */
  shuffle = false;
  /** 当日随机顺序的缓存：{ 队列版本, 日期键, 下标序列 }。
   *  队列变了（增删/换单/排序）或跨了本地零点即失效重建 —— 顺序必须与当下队列对得上。 */
  private shuffleCache: { ver: number; day: string; order: number[] } | null = null;
  loved = new Set<string>(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"));
  /** 红心态版本号：每次变更 +1（UI 侧据此去重，避免 notify 空转重画几百行） */
  loveVersion = 0;
  /** 「我喜欢」预载的歌曲列表（视图首帧直接渲染，不再空转一轮分页拉取） */
  likedCache: Song[] | null = null;
  /** 我喜欢总曲数（服务端 total；被 LOVED_MAX 截断时用于展示） */
  likedTotal = 0;
  /** mid → 收藏写接口所需引用：song_id + 读接口的 song_type（预载回填；行对象缺 id 时兜底） */
  private lovedRef = new Map<string, { id: number; type: number }>();
  private likedAt = 0;                       // 预载完成时刻（LOVED_TTL 判新鲜）
  private likedFlight: Promise<boolean> | null = null; // 飞行中的预载（并发共享）
  /** 「我喜欢」列表版本号：likedCache/likedTotal 变更 +1（打开中的我喜欢页据此增量重画） */
  lovedListVersion = 0;
  private lovedListListeners = new Set<Listener>();
  private lovedSyncTimer: number | null = null;        // 增量回源去抖定时器
  private lovedSyncFlight: Promise<void> | null = null;
  private lovedSyncTries = 0;                          // 滞后未对上的连续重试次数（封顶防打转）
  private lovedSyncCorrected = false;                  // 上一轮回源是否校正过（决定要不要重试）
  /** 近期写入庇护名单（localStorage 持久化，跨重载存活）：mid → 期望态 + 写入时刻 */
  private recentWrites: Map<string, { on: boolean; at: number }> = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_WRITES_KEY) ?? "{}") as Record<string, { on: boolean; at: number }>;
      const now = Date.now();
      return new Map(Object.entries(raw ?? {}).filter(([, w]) => w && now - Number(w.at) <= LOVED_PENDING_TTL));
    } catch { return new Map(); }
  })();
  lyrics: LyricLine[] = [];
  lyricState: "idle" | "loading" | "ok" | "none" = "idle";
  /** 逐字歌词（Sparkle 逐字提供器解析的词级时间轴行，毫秒）；无逐字数据时为空 */
  karaoke: SparkleKaraokeLine[] = [];
  loading = false; // 正在取链/缓冲（UI 画加载指示）
  expanded = false; // 正在播放页是否展开
  /** 画廊模式（运行时态，不持久化）：正在播放页全屏化展示。开 = 展开本页并进全屏，
   *  收起本页即退出（NowPlaying 在 expanded 迁移里联动全屏并清零本标志）。 */
  gallery = false;
  queueOpen = false;
  showTrans = getShowTrans(); // 歌词翻译显示开关（quaver.conf [Style] ShowTranslation，默认开）
  /** 实际生效后端（"mpv"=原生引擎；"web"=浏览器 <audio>） */
  backend: ActiveBackend = "web";
  /** 当前已挂载播放流的 URL（/api/stream/<token> 或插件源；运行时态，不进存档）。
   *  流信息探测（lib/streaminfo）据此取头字节；打断/换曲即失效。 */
  streamUrl = "";
  /** 后端不可用/回退原因（设置页提示；空 = 正常） */
  backendNotice = "";
  /** 引擎（mpv）版本串；未拉起时为空 */
  engineVersion = "";
  private _vol = 0.8;    // 0..1（静音前保留）
  private _muted = false;
  private listeners = new Set<Listener>();
  private lyricSeq = 0;
  private playSeq = 0;   // startCurrent 竞态令牌：换曲即作废上一轮
  // —— 播放失败自动回退链（流加载失败 → 逐档降级重试 → 穷尽跳下一曲）——
  private fallbackMid = "";                  // 降级尝试记录归属的曲（换曲即重置）
  private fallbackTried = new Set<string>(); // 该曲已失败的档位：请求档与实际档都记（auto 降级下发它档时不绕回）
  private failStreak = 0;                    // 自动跳曲连续失败数（真出声即清零；达队列长度停止跳，防断网时无限快跳）
  private lastAutoplay = true;               // 最近一轮 startCurrent 的 autoplay（error 分类：还原挂流失败不自动重试）
  private lastPrevPressAt = 0;               // 媒体键/热键「上一曲」连按判定时刻（prevPress 专用；播放条双击走原生 dblclick，不共用计时器）
  private prefetch = new Map<string, Promise<StreamResult>>(); // mid+档 → 已协商流（单击预热，双击秒起播）
  private pendingSeek = 0; // 换音质续播：新流时长就绪后跳到旧进度
  /** 启动还原的续播点：流还没就绪时保住它，别让存档被 0 覆盖 */
  private savedPos = 0;
  /** 存档闸门：启动还原完成前不写盘 —— 否则启动瞬间的空队列会覆盖上一轮的存档 */
  private sessionReady = false;
  private sessionAt = 0;
  private sessionTimer: number | null = null;
  /** 后端选择完成（首播若发生在启动检查完成前，startCurrent 会等它） */
  private backendInit: Promise<void>;

  constructor() {
    this.bindTransport(this.transport);
    // 音量/静音来自 quaver.conf（[Playing] Volume / Muted），静音时保留原音量值
    this._vol = getVolumeConf();
    this._muted = getMutedConf();
    this.applyVolume();
    // 默认 MPV：启动即探测可用性并热切换传输（浏览器 dev / mpv 缺失时留在 <audio>）
    this.backendInit = this.initBackend();
    // 后端定稳后再还原上一次的队列/进度（挂流不自动播，见 restoreSession）
    void this.backendInit.then(() => this.restoreSession());
    // 关窗/切后台立刻落一次存档，别把最后一段进度丢在节流窗口里
    window.addEventListener("pagehide", () => this.saveSessionNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.saveSessionNow();
    });
    // 主进程拆窗重建（CSD/SSD 切换）前派发：立刻落一次存档 —— destroy() 不保证触发
    // pagehide，而重建后的新页面要靠这份存档对齐队列/指针去接管 mpv 正在放的歌
    window.addEventListener("quaver:flush-session", () => this.saveSessionNow());
    // Sparkle 逐字提供器是异步注册的（initSparkle 晚于首帧）：首曲歌词可能在 provider
    // 到位前就按纯 LRC 拉完了 → provider 出现时对当前曲补拉一次（fetchLyric 自带竞态守卫）
    let lastKaraProvider: SparkleKaraokeProvider | null = null;
    onSparkleChange(() => {
      const p = sparkleKaraokeProvider();
      if (p === lastKaraProvider) return;
      lastKaraProvider = p;
      if (p && this.current) void this.fetchLyric(this.current);
    });
  }

  // —— 传输层接线 ——

  private bindTransport(t: Transport) {
    this.transport = t;
    t.onEvent((e) => this.onTransportEvent(e));
  }

  private onTransportEvent(e: TransportEvent) {
    switch (e.type) {
      case "time":
        this.notify();
        break;
      case "duration":
        this.consumePendingSeek();
        this.notify();
        break;
      case "play":
      case "pause":
        this.notify();
        break;
      case "waiting": // 起播后仍需缓冲（网络卡顿）→ 保持加载指示
        if (this.current) { this.loading = true; this.notify(); }
        break;
      case "playing": // playing = 真的出声了（起播/缓冲恢复）
        if (this.loading) { this.loading = false; this.error = ""; this.notify(); }
        this.failStreak = 0; // 出声即成功：自动跳曲的连续失败计数清零
        break;
      case "canplay":
        if (this.loading && !this.transport.paused) { this.loading = false; this.notify(); }
        break;
      case "ended":
        this.onEnded();
        break;
      case "error": {
        // src 加载/解码失败（token 过期、上游断流、mpv 退出）→ 在播/正常起播态自动回退音质，
        // 回退链穷尽（最低档仍失败）→ 直接下一曲，别把队列卡死在一首坏流上。
        // 非自动播放轮（还原挂流失败）与用户暂停态不自动动：留错误态，点播放键重试。
        if (!this.current || !this.transport.src) return;
        const wasLoading = this.loading; // 起播尚未成功过（区别于「用户暂停后」的流错误）
        this.loading = false;
        if (!this.lastAutoplay || (this.transport.paused && !wasLoading)) { this.notify(); return; }
        this.handleStreamError(e.message ?? "音频流加载失败");
        break;
      }
    }
  }

  /** 启动时的后端选择：偏好 MPV 且引擎可用 → 热切到引擎传输（此时通常还没开播，无损替换） */
  private async initBackend() {
    if (getDecode() !== "MPV" || !window.quaverAudio) return;
    try {
      const st = await window.quaverAudio.invoke({ cmd: "status" });
      if (!st?.ok || !st.available) {
        this.backendNotice = st?.reason || "mpv 不可用，已回退浏览器音频";
        return;
      }
      const t = new EngineTransport(window.quaverAudio);
      const dev = getAudioDevice();
      if (dev) void t.setDevice?.(dev).catch(() => {});
      const resume = this.swapTransport(t);
      this.backend = "mpv";
      this.engineVersion = String(st.version ?? "");
      await resume; // 启动竞态里已有歌在播：换传输后从原进度续播
    } catch {
      this.backendNotice = "音频引擎桥接失败，已回退浏览器音频";
    }
    this.notify();
  }

  // —— 会话存档：退出前保留队列与进度，启动时还原 ——
  // 还原分两段：(1) 同步/异步恢复队列与指针（列表、播放条立刻有内容），
  // (2) 按存下的位置**挂流但不自动播** —— 进度条与歌词回到退出前那一刻，
  // 按播放键从原处继续，不替用户决定「开机就出声」。
  // 竞态：还原期间用户已经点了歌（队列非空）就放弃还原，用户意图优先。
  private async restoreSession() {
    const snap = loadSession();
    if (!snap || this.queue.length || this.index >= 0) { this.sessionReady = true; return; }
    this.queue = snap.queue;
    this.index = snap.index;
    this.mode = snap.mode;
    this.shuffle = !!snap.shuffle;
    this.queueVersion++;
    this.savedPos = snap.position;
    this.notify();
    this.sessionReady = true;
    // 引擎正在播（CSD/SSD 重建窗口：mpv 跨重建没停）→ 直接接管，**绝不重新挂流** ——
    // startCurrent 的 load 是 loadfile replace，会把正在放的歌掐掉。位置/时长/播放态
    // 由引擎 snapshot 如实汇报（比 ≤5s 节流的存档位置准），进度条/歌词/MPRIS 随即对齐。
    if (this.transport.kind === "engine") {
      const t = this.transport as EngineTransport;
      const es = await t.snapshot();
      if (es && this.current) {
        t.adopt(es.url, es);
        this.streamUrl = es.url; // 接管正在放的流：流信息浮窗（正在播放页）照样可探测
        // 会话音质覆盖与实际流档位一并接管：播放条音质胶囊显示正在放的档，
        // 而不是跳回「自动」（这两个是渲染层内存态，靠拆窗前的存档带过来）
        setSessionQuality((snap.quality ?? null) as Parameters<typeof setSessionQuality>[0]);
        setLastStream(snap.lastStream ?? null);
        this.loading = false;
        this.error = "";
        this.savedPos = 0;
        void this.fetchLyric(this.current);
        this.notify();
        return;
      }
    }
    if (this.current) await this.startCurrent(snap.position, false);
    this.notify();
  }

  /** 当前应存的位置：流未就绪（还原后还没拿到真实位置）时保住还原点 */
  private posForSave(): number {
    const p = this.transport.position;
    if (p > 1) { this.savedPos = 0; return p; }
    return this.savedPos || p;
  }

  private saveSessionNow() {
    if (!this.sessionReady) return;
    if (this.sessionTimer !== null) { window.clearTimeout(this.sessionTimer); this.sessionTimer = null; }
    this.sessionAt = Date.now();
    // 音质两项随档走：播放条会话覆盖 + 已应用流档位 —— 窗口重建接管时恢复，
    // 否则新页面的音质胶囊会跳回「自动」（这两个是内存态，只有这里能跨重建）
    saveSession({
      queue: this.queue, index: this.index, position: this.posForSave(), mode: this.mode,
      shuffle: this.shuffle,
      quality: getSessionQuality(), lastStream: getLastStream(),
    });
  }

  /** notify 每帧都会来（4Hz 位置广播），存档按 SESSION_EVERY 合并 */
  private scheduleSessionSave() {
    if (!this.sessionReady) return;
    const elapsed = Date.now() - this.sessionAt;
    if (elapsed >= SESSION_EVERY) { this.saveSessionNow(); return; }
    if (this.sessionTimer !== null) return;
    this.sessionTimer = window.setTimeout(() => { this.sessionTimer = null; this.saveSessionNow(); }, SESSION_EVERY - elapsed);
  }

  /** 换传输：停旧、绑新、复用音量。返回「续播闭包」（有歌在播/加载中时由调用方 await）；
   *  播放态保留：原本在播就续播，原本暂停就停在原进度。 */
  private swapTransport(t: Transport): Promise<void> {
    const song = this.current;
    const at = this.transport.position;
    const wasPlaying = !this.transport.paused;
    const hadStream = !!this.transport.src || this.loading;
    try { this.transport.stop(); } catch { /* noop */ }
    this.pendingSeek = 0;
    this.bindTransport(t);
    this.applyVolume();
    if (!song || !hadStream || this.current !== song) return Promise.resolve();
    return this.startCurrent(at > 1 ? at : 0, wasPlaying);
  }

  /** 设置页切换后端（默认 MPV / Blink 浏览器）：立即生效，当前曲目换轨续播、保留播放态 */
  async setBackend(kind: DecodeBackend): Promise<void> {
    setDecode(kind);
    const wantEngine = kind === "MPV";
    const isEngine = this.transport.kind === "engine";
    if (wantEngine === isEngine) { this.notify(); return; }
    if (!wantEngine) {
      await this.swapTransport(new WebTransport());
      this.backend = "web";
      this.backendNotice = "";
      this.engineVersion = "";
      this.notify();
      return;
    }
    if (!window.quaverAudio) {
      this.backendNotice = "当前环境无原生音频引擎（浏览器模式）";
      this.notify();
      return;
    }
    try {
      const st = await window.quaverAudio.invoke({ cmd: "status" });
      if (!st?.ok || !st.available) {
        this.backendNotice = st?.reason ?? "mpv 不可用";
        this.notify();
        return;
      }
      const t = new EngineTransport(window.quaverAudio);
      const dev = getAudioDevice();
      if (dev) void t.setDevice?.(dev).catch(() => {});
      await this.swapTransport(t);
      this.backend = "mpv";
      this.engineVersion = String(st.version ?? "");
      this.backendNotice = "";
    } catch (e: any) {
      this.backendNotice = String(e?.message ?? e);
    }
    this.notify();
  }

  /** 引擎可用性（设置页禁用态/提示用；后端偏好的归 setBackend） */
  async probeEngine(): Promise<{ available: boolean; reason: string; version: string; source: string }> {
    if (!window.quaverAudio) return { available: false, reason: "当前环境无原生音频引擎", version: "", source: "" };
    try {
      const st = await window.quaverAudio.invoke({ cmd: "status" });
      return { available: !!st?.ok && !!st.available, reason: st?.reason ?? "", version: String(st?.version ?? ""), source: String(st?.source ?? "") };
    } catch {
      return { available: false, reason: "音频引擎桥接失败", version: "", source: "" };
    }
  }

  /** 音频设备列表（仅引擎传输支持；web 返回 null） */
  async listAudioDevices(): Promise<{ current: string; devices: AudioDeviceInfo[] } | null> {
    if (!this.transport.listDevices) return null;
    try { return await this.transport.listDevices(); } catch { return null; }
  }

  /** 选择音频设备（持久化 + 应用到引擎） */
  async selectAudioDevice(id: string): Promise<boolean> {
    setAudioDevice(id);
    if (!this.transport.setDevice) return false;
    try { await this.transport.setDevice(id); return true; } catch { return false; }
  }

  /** 淡入淡出预设（持久化 + 立即下发时长；仅引擎后端消费） */
  async setFadePreset(p: FadePreset): Promise<void> {
    setFade(p);
    const ms = FADE_PRESETS[p];
    if (!this.transport.setFade) return;
    try { await this.transport.setFade(ms.inMs, ms.outMs); } catch { /* 引擎不在：下次建立传输时随配置下发 */ }
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private notify() {
    for (const fn of [...this.listeners]) { try { fn(); } catch (e) { console.warn(e); } }
    this.scheduleSessionSave();
  }
  /** UI 组件反向驱动状态（展开/收起等）后广播 */
  notifyPublic() { this.notify(); }

  get current(): Song | undefined { return this.queue[this.index]; }
  get playing() { return !this.transport.paused; }
  get paused() { return this.transport.paused; }
  get time() { return this.transport.position; }
  get duration() { return this.transport.duration || this.current?.interval || 0; }
  /** 供 MPRIS/外部控制的暂停（与 toggle 分离：不带重试/取消语义） */
  pause() { if (!this.transport.paused) this.transport.pause(); }
  /** 供 MPRIS/外部控制的续播 */
  resume() { if (this.transport.paused && this.transport.src) void this.transport.play().catch(() => {}); }

  // —— 音量 ——
  get volume() { return this._vol; }        // 0..1（静音时保留原值）
  get muted() { return this._muted; }
  private applyVolume() {
    this.transport.setVolume(this._vol, this._muted);
  }
  setVolume(v: number, unmute = true) {
    this._vol = Math.max(0, Math.min(1, v));
    if (unmute && this._muted && this._vol > 0) this._muted = false;
    setVolumeConf(this._vol);           // 拖拽高频：内存即时、落盘合并
    if (!this._muted) setMutedConf(false);
    this.applyVolume();
    this.notify();
  }
  toggleMute() {
    this._muted = !this._muted;
    setMutedConf(this._muted);
    this.applyVolume();
    this.notify();
  }

  toggleTrans() {
    this.showTrans = !this.showTrans;
    setShowTrans(this.showTrans);
    this.notify();
  }

  /** 用新列表替换队列并从 i 播放（整队列替换：视图语义一致）。不 await：双击即刻打断切歌。 */
  playList(songs: Song[], i = 0) {
    this.queue = songs.filter((s) => s?.mid);
    this.index = Math.max(0, Math.min(i, this.queue.length - 1));
    this.queueVersion++;
    void this.startCurrent();
  }

  /** 插队播放：把这首插到**当前曲之后**就完事 —— 当前曲继续放，下一首轮到它。
   *  语义是「排进队列的下一位」，**不是**打断当前曲立刻切过去；搜索页双击、右键菜单
   *  「插队播放」共用这一条（试听不打断自己正在放的整张列表）。
   *  队列还空着（没播过任何东西）时没有「下一首」可言，退化成单曲起播。 */
  enqueueNext(song: Song) {
    if (!song?.mid) return;
    if (this.index < 0 || !this.queue.length) { this.playList([song], 0); return; }
    this.queueVersion++;
    this.queue.splice(this.index + 1, 0, song);
    this.notify();
  }

  /** 整批插队：把一批歌（歌单「插队播放」）按原序排到当前曲之后等着播 —— 不切歌、不打断。
   *  与 enqueueNext 同一分叉：队列还空着时没有「下一首」可言，退化成整列起播。 */
  enqueueNextMany(songs: Song[]) {
    const list = songs.filter((s) => s?.mid);
    if (!list.length) return;
    if (this.index < 0 || !this.queue.length) { this.playList(list, 0); return; }
    this.queueVersion++;
    this.queue.splice(this.index + 1, 0, ...list);
    this.notify();
  }

  /** 立即插队播放：插到**当前曲之后**并**马上切过去**（打断当前曲）。与 enqueueNext 只差时机 ——
   *  不等当前曲放完。只带这一首进队列，队列原有内容不动（其余搜索结果不入列）。
   *  搜索页双击用：即点即播，但不把搜索结果整列灌进队列。
   *  队列还空着（没播过任何东西）时没有「插队」可言，退化成单曲起播。 */
  playNextNow(song: Song) {
    if (!song?.mid) return;
    if (this.index < 0 || !this.queue.length) { this.playList([song], 0); return; }
    this.queue.splice(this.index + 1, 0, song);
    this.index++;
    this.queueVersion++;
    void this.startCurrent();
  }

  /** 从队列移除第 i 首。删除的是当前曲：停流停在原地（指针落到同槽位的下一首），不自动续播；
   *  删当前曲之前的歌：指针前移；删之后的歌：指针不动。 */
  removeAt(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    const cur = this.index;
    this.queue.splice(i, 1);
    this.queueVersion++;
    if (!this.queue.length) { this.index = -1; this.interrupt(); this.notify(); return; }
    if (i < cur) this.index = cur - 1;
    else if (i === cur) {
      this.index = Math.min(cur, this.queue.length - 1);
      this.interrupt();
    }
    this.notify();
  }

  /** 队列内排序：把 from 位置的歌挪到 to。当前曲指针始终跟随这首歌本身走。 */
  moveInQueue(from: number, to: number) {
    const n = this.queue.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const [s] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, s);
    this.queueVersion++;
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.notify();
  }

  /** 清空队列并停止播放 */
  clearQueue() {
    if (!this.queue.length && this.index < 0) { this.notify(); return; }
    this.queue = [];
    this.index = -1;
    this.queueVersion++;
    this.interrupt();
    this.notify();
  }

  jump(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    void this.startCurrent();
  }

  private consumePendingSeek() {
    const dur = this.transport.duration;
    if (this.pendingSeek > 1 && dur > this.pendingSeek) {
      const t = this.pendingSeek;
      this.pendingSeek = 0;
      try { this.transport.seek(t); } catch { /* 稍后 time 事件再补 */ this.pendingSeek = t; }
    } else if (this.pendingSeek > 1 && !dur) {
      /* 元数据未就绪：保留 pendingSeek 等下一次 duration 事件 */
    } else {
      this.pendingSeek = 0;
    }
    this.notify();
  }

  /** 立即打断当前取链/缓冲并跳转（双击新歌用：旧流的排队 play promise 一并作废） */
  private interrupt() {
    this.playSeq++;
    this.loading = false;
    this.error = "";
    this.pendingSeek = 0;
    this.streamUrl = "";
    try { this.transport.stop(); } catch { /* noop */ }
  }

  private async startCurrent(resumeTo = 0, autoplay = true, overrideTier?: string) {
    const s = this.current;
    this.interrupt();
    // 降级尝试记录按曲归属：换到别的歌就重置（每首都有完整的一次回退机会）
    if (s && s.mid !== this.fallbackMid) { this.fallbackMid = s.mid; this.fallbackTried.clear(); }
    this.lastAutoplay = autoplay;
    this.lyrics = [];
    this.karaoke = [];
    this.lyricState = "idle";
    // 换曲即作废在途歌词请求：fetchLyric 的序号守卫只防「更新的 fetch」，不防换曲 ——
    // 不作废的话，上一曲慢悠悠的歌词响应会在新曲起播期间回写（快速连点下一首时显示前前一首的歌词）
    this.lyricSeq++;
    if (!s) { this.notify(); return; }
    this.loading = true;
    this.notify();
    const seq = this.playSeq;
    try {
      await this.backendInit; // 首播发生在启动后端检查完成前：等检查定再挂流
      if (seq !== this.playSeq || this.current !== s) return; // 期间又切了歌：本轮作废
      const r = await this.getStream(s, overrideTier); // 命中单击预取的链接 → 直接跳过取链；降级重试带指定档
      if (seq !== this.playSeq || this.current !== s) return;
      this.streamUrl = r.url;
      setLastStream({ tier: r.tier, label: r.label, degraded: r.degraded });
      await this.transport.load(r.url, { paused: !autoplay }); // web: 赋 src；engine: loadfile replace
      if (resumeTo > 1) this.pendingSeek = resumeTo; // 换音质/换后端：时长就绪后从旧进度续播
      if (autoplay) {
        try {
          await this.transport.play();
        } catch (pe: any) {
          // AbortError = play 被更新的 load 打断（web）。旧轮次直接弃；新轮次重试一次再放弃。
          if (pe?.name === "AbortError") {
            if (seq !== this.playSeq || this.current !== s) return;
            await this.transport.play(); // load 竞态后的补播（此时资源选定应已稳定）
          } else throw pe;
        }
      }
      if (seq !== this.playSeq) return;
      this.loading = false;
      this.error = "";
    } catch (e: any) {
      if (seq === this.playSeq && this.current === s) {
        this.loading = false;
        const msg = String(e?.message ?? e);
        this.error = msg;
        // 取链失败 = 后端 auto 全链回退 + 128 兜底都没拿到流（无源/网络故障）：
        // 前端再逐档重试是重复劳动，直接按「回退失败」跳下一曲
        this.skipSong(msg);
      }
    }
    if (seq === this.playSeq && this.current === s) this.fetchLyric(s); // 被作废的轮次不拉歌词，防竞态覆盖
    this.notify();
  }

  // —— 播放失败自动回退：流加载/解码失败 → 沿档位链逐档降级重试（不动会话音质选择，
  //     播放条胶囊由 setLastStream 跟随实际降到的档）；链穷尽 → 自动跳下一曲。
  //     已败档位按曲记录：请求档与后端实际下发的档都记 —— auto 模式后端可能把请求档
  //     降级成它档返回，只记其一会被「同一请求」绕回死循环。 ——

  /** 前端降级链（与后端 tierTable rank 降序对齐，见 vendor/Typhoeus-go/typhoeus/quality.go） */
  private static readonly FALLBACK_CHAIN = ["master", "atmos71", "atmos51", "atmos2", "flac", "640ogg", "320ogg", "320", "128"];

  private handleStreamError(msg: string) {
    const s = this.current;
    if (!s) return;
    if (this.fallbackMid !== s.mid) { this.fallbackMid = s.mid; this.fallbackTried.clear(); }
    const applied = getLastStream()?.tier; // 实际在放的档（auto 降级后 ≠ 会话选择）
    if (applied) this.fallbackTried.add(applied);
    const nextTier = Player.FALLBACK_CHAIN.find((t) => !this.fallbackTried.has(t));
    if (!nextTier) { this.skipSong(msg); return; } // 最低档仍失败：这首在本会话里播不动了
    this.fallbackTried.add(nextTier); // 请求档也记：它失败（或被降级后失败）时不重发同一请求
    this.error = "";
    this.loading = true;
    this.notify();
    // 断流点续播：position ≤1（起播就失败）自然从头；换档后时长一致，pendingSeek 机制接管
    void this.startCurrent(this.transport.position > 1 ? this.transport.position : 0, true, nextTier);
  }

  /** 回退穷尽/取链失败 → 跳下一曲。failStreak 防全队列坏流/断网时无限快跳：连续失败满队列长度即停。
   *  不用 next(true)（单曲循环语义是原地重播，坏流会死循环），也不走 stepInOrder 的
   *  「顺序播放到末尾就停」—— 换曲是救济路径，必须一直有下一首可试；随机开着时同样沿
   *  当日顺序走，免得坏流把当天的听感打乱。 */
  private skipSong(reason: string) {
    this.failStreak++;
    if (!this.queue.length || this.failStreak >= this.queue.length) {
      this.loading = false;
      this.error = `播放失败（${reason}），已停止自动切歌`;
      this.notify();
      return;
    }
    const i = this.stepInOrder(1, true);
    if (i < 0) { this.loading = false; this.notify(); return; }
    this.jump(i);
  }

  // —— 单击预加载：行点击即后台协商播放链接（含上游取链+嗅探这两次慢 RTT），
  //    双击起播时命中缓存即刻开流。单击新内容就清旧预取再预载新的（只留一份，释放内存/后端 token 表）。
  private prefetchedMid = "";

  prefetchSong(song: Song | undefined) {
    if (!song?.mid) return;
    const q = String(effectiveQuality());
    if (song.mid === this.prefetchedMid && this.prefetch.has(q + "|" + song.mid)) return;
    this.prefetch.clear(); // 清理旧预加载链接引用（token 由后端 TTL 回收；前端不再持有下载）
    this.prefetchedMid = song.mid;
    const key = q + "|" + song.mid;
    const p = this.resolveWithSources(song, q);
    p.catch(() => { if (this.prefetch.get(key) === p) this.prefetch.delete(key); });
    this.prefetch.set(key, p);
  }

  /** 取流收口：先过 Sparkle 插件播放源链（注册序 FIFO，抛错/null 放行下一环），全落空走官方 resolve */
  private async resolveWithSources(song: Song, q: string): Promise<StreamResult> {
    for (const src of sparkleStreamSources()) {
      try {
        const r = await src.resolve(song, q);
        if (r?.url) return { url: r.url, tier: r.tier ?? "plugin", label: r.label ?? src.id, degraded: false };
      } catch (e) {
        console.warn(`[sparkle] 播放源 ${src.id} 解析失败，放行下一环`, e);
      }
    }
    return resolveStreamUrl(song, q as any);
  }

  /** getPlayUrl 语义的内部入口：预取命中用预取结果，否则现场协商；
   *  overrideTier = 播放失败自动回退的指定档（预取按 effectiveQuality 键存，指定档时必须绕开）。 */
  private async getStream(s: Song, overrideTier?: string): Promise<StreamResult> {
    if (overrideTier) return this.resolveWithSources(s, overrideTier);
    const q = String(effectiveQuality());
    const hit = this.prefetch.get(q + "|" + s.mid);
    this.prefetch.clear(); // 用后即弃：链接是一次性上下文（会员/曲库状态可能变化），不跨切歌复用
    if (hit) {
      try { return await hit; } catch { /* 预取失败 → 现场重来 */ }
    }
    return this.resolveWithSources(s, q);
  }

  error = "";

  /** 拉取并解析当前歌曲歌词（startCurrent 内部调用；也供外部预热/测试）。
   *  一次请求顺带要逐字（qrc=1）：上游有 QRC 时 lyric 字段就是逐字内容，交给 Sparkle
   *  逐字提供器（如 amll 插件）解析成 karaoke 行 + 派生行级列表；没有提供器、逐字
   *  解析失败或请求结果为空时回退普通 LRC 行级，行为不变。 */
  async fetchLyric(s: Song) {
    const seq = ++this.lyricSeq;
    this.lyricState = "loading";
    this.notify();
    try {
      const mid = encodeURIComponent(s.mid);
      let d: any = await api(`/song/${mid}/lyric?trans=1&qrc=1`);
      // 双守卫：序号防更新的 fetch；current 防换曲（startCurrent 已作废序号，这里是兜底）
      if (seq !== this.lyricSeq || this.current !== s) return;
      if (!String(d?.lyric ?? "").trim()) {
        // qrc=1 下无逐字内容的歌曲可能整包为空 → 退回普通歌词请求再试一次
        d = await api(`/song/${mid}/lyric?trans=1`);
        if (seq !== this.lyricSeq || this.current !== s) return;
      }
      let raw = String(d?.lyric ?? "");
      let trans = String(d?.trans ?? "");
      const provider = sparkleKaraokeProvider();
      let kara = provider ? provider.parse(raw, trans) : null;
      if (!kara && !/^\[\d{1,2}:/.test(raw)) {
        // 逐字解析失败（或无提供器）且内容不是行级 LRC（QRC XML / 纯文本 QRC / TTML
        // 都是 parseLrc 读不了的格式）→ 退回普通歌词请求，「停用逐字」时行级歌词仍有内容
        d = await api(`/song/${mid}/lyric?trans=1`);
        if (seq !== this.lyricSeq || this.current !== s) return;
        raw = String(d?.lyric ?? "");
        trans = String(d?.trans ?? "");
        kara = provider ? provider.parse(raw, trans) : null;
      }
      if (kara?.length) {
        this.karaoke = kara;
        this.lyrics = karaokeToLines(kara);
      } else {
        this.karaoke = [];
        this.lyrics = parseLrc(raw, trans);
      }
      // 纯音乐占位行（"[00:00.00]此歌曲为没有填词…"）也照常显示
      this.lyricState = this.lyrics.length ? "ok" : "none";
    } catch {
      if (seq === this.lyricSeq) { this.karaoke = []; this.lyricState = "none"; }
    }
    this.notify();
  }

  toggle() {
    if (!this.current) return;
    // 上轮取链/加载失败或流已断开 → 重新协商起播（重试语义）
    if (this.error || (!this.transport.src && !this.loading)) { void this.startCurrent(this.transport.position > 1 ? this.transport.position : 0); return; }
    if (this.loading) { this.interrupt(); this.notify(); return; } // 加载中再点 = 取消
    if (this.transport.paused) void this.transport.play().catch(() => {});
    else this.transport.pause();
  }

  // —— 播放条音质切换（会话级：不持久化；带 Fallback 协商，切档即从当前进度重挂流） ——
  switchQuality(q: Parameters<typeof setSessionQuality>[0]) {
    const cur = getSessionQuality();
    if ((q ?? null) === cur && this.current && this.transport.src && !this.error) { this.notify(); return; } // 同档重复点：不打断
    const at = this.transport.position;
    setSessionQuality(q);
    this.prefetch.clear();
    this.prefetchedMid = "";
    if (this.current) void this.startCurrent(at > 1 ? at : 0);
    else this.notify();
  }

  /** 当日随机顺序（懒建 + 缓存）：种子取本地日期，所以同一天反复调用结果一致。
   *  缓存键 = 队列版本 + 日期键：队列一改或跨了本地零点就重建，顺序必须与当下队列对得上。 */
  private dailyOrder(): number[] {
    const day = dayKey();
    const c = this.shuffleCache;
    if (c && c.ver === this.queueVersion && c.day === day) return c.order;
    const order = shuffleOrder(this.queue.length, daySeed(day));
    this.shuffleCache = { ver: this.queueVersion, day, order };
    return order;
  }

  /** 按当前播放顺序走一步，返回目标队列下标；-1 = 已到序列末尾（该停）。
   *  shuffle 开 → 当日洗牌顺序；关 → 队列原序。
   *  wrap=false 用于「顺序播放」的自然结束：走到末尾就收尾，不回到队首。 */
  private stepInOrder(dir: 1 | -1, wrap: boolean): number {
    const n = this.queue.length;
    if (!n) return -1;
    if (this.shuffle) return step(this.dailyOrder(), this.index, dir, wrap);
    const i = (this.index + dir + n) % n;
    if (!wrap && ((dir > 0 && i <= this.index) || (dir < 0 && i >= this.index))) return -1;
    return i;
  }

  /** 播放顺序上的相邻下标（-1 = 没有）：随机播放时按当日洗牌序，与 stepInOrder 同源。
   *  正在播放页的封面流用它取左右邻曲 —— 别自己写 index±1（随机序下会指错歌）。 */
  neighbors(): { prev: number; next: number } {
    return { prev: this.stepInOrder(-1, true), next: this.stepInOrder(1, true) };
  }

  /**
   * 以当前曲为原点、按**播放顺序**偏移 offset 首（0 = 当前，1 = 下一首，-1 = 上一首，
   * 2 = 下下首）。随机播放时走当日洗牌序 —— 与 stepInOrder 同源，插件别自己算。
   *
   * 给「封面流」这类需要一整列邻曲的视图用：只有 prev/next 各一首时，
   * 切歌动画做不出「中间转出去 → 右边顶上 → 新的从右边转进来」的三段式
   * （第三张没有数据源，DOM 只能停在两张）。越界返回 undefined。
   */
  songAtOffset(offset: number): Song | undefined {
    if (!this.queue.length) return undefined;
    if (offset === 0) return this.current;
    if (!Number.isInteger(offset)) return undefined;
    const dir: 1 | -1 = offset > 0 ? 1 : -1;
    let i = this.index;
    // 上限 = 队列长度：绕回一圈就是同一首，再往外没有意义
    for (let step = 0; step < this.queue.length; step++) {
      const at = this.stepInOrder(dir, false);
      if (at < 0) return undefined;
      i = at;
      if (step === Math.abs(offset) - 1) return this.queue[i];
    }
    return undefined;
  }

  /** 跳到播放顺序上偏移 offset 首（0 = 当前即原地重播）。给封面流「点第几张跳第几首」用。 */
  jumpToOffset(offset: number) {
    if (!Number.isInteger(offset) || offset === 0) return;
    let i = this.index;
    const dir: 1 | -1 = offset > 0 ? 1 : -1;
    for (let n = 0; n < Math.abs(offset); n++) {
      const at = this.stepInOrder(dir, true); // wrap：手动跳允许回绕（与 prev/next 一致）
      if (at < 0) return;
      i = at;
    }
    this.jump(i);
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.mode === "one") {
      this.transport.seek(0);
      if (this.transport.paused) void this.transport.play().catch(() => {});
      return;
    }
    // 手动点「下一首」永远能走（末位回绕到队首，与洗牌无关）；自然结束才受「顺序播放」收尾约束
    const i = this.stepInOrder(1, !auto || this.mode !== "off");
    if (i < 0) { this.notify(); return; }
    this.jump(i);
  }

  prev(force = false) {
    if (!this.queue.length) return;
    // 「上一首」逻辑（Playing.PrevReplay，设置页即时生效）：
    // replay=把当前曲从头重放（播放条双击走 force 直接切上一首）；previous=直接切到队列里的上一首。
    // force 只由播放条双击与媒体键/热键的连按判定传：单次动作永远按单击逻辑走
    if (!force && getPrevBehavior() === "replay") { this.transport.seek(0); return; }
    const i = this.stepInOrder(-1, true);
    if (i < 0) return;
    this.jump(i);
  }

  /** 媒体键/热键的「上一曲」入口：快速连按两次（≤400ms，系统双击时长同级）视为双击 ——
   *  跳到队列里的上一首（force），单按仍遵循 PrevReplay 设置；三连按链式回退两首。
   *  播放条按钮不走这里：它有原生 dblclick（用系统双击时长），共用计时器会跨输入互相误触。 */
  prevPress() {
    const now = Date.now();
    const dbl = now - this.lastPrevPressAt <= 400;
    this.lastPrevPressAt = now;
    this.prev(dbl);
  }

  private onEnded() {
    this.error = "";
    // 收尾判定收进 stepInOrder：随机模式下「末尾」是当日顺序的末尾，不是队列的末尾
    this.next(true);
  }

  cycleMode() {
    this.setMode(this.mode === "off" ? "all" : this.mode === "all" ? "one" : "off");
  }

  /** 播放模式菜单用：直接落某一档（不再靠 cycleMode 推进，菜单点哪档就是哪档） */
  setMode(m: Mode) {
    if (this.mode === m) return;
    this.mode = m;
    this.notify();
  }

  /** 随机播放开关。开着时按当日种子重排当日顺序 —— 因为种子只由日期决定，
   *  当天反复开关得到的都是同一套顺序（不会每次开关都换一批歌）。 */
  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.notify();
  }

  seek(sec: number) {
    const d = this.transport.duration;
    if (d > 0) this.transport.seek(Math.max(0, Math.min(sec, d)));
    this.notify();
  }

  // —— 单曲收藏（红心）：本地「我喜欢」是全站红心的唯一真相源 ——

  private persistLoved() {
    localStorage.setItem(LS_KEY, JSON.stringify([...this.loved]));
    // 庇护名单一起落盘：页面重载后，整单预载的旧快照照样冲不掉近期写入
    const now = Date.now();
    const writes: Record<string, { on: boolean; at: number }> = {};
    for (const [mid, w] of this.recentWrites) if (now - w.at <= LOVED_PENDING_TTL) writes[mid] = w;
    localStorage.setItem(LS_WRITES_KEY, JSON.stringify(writes));
  }

  /** 红心态唯一写入口（渲染读 this.loved，落盘走这里） */
  private setLoved(mid: string, on: boolean, ref?: { id: number; type: number }) {
    if (on) {
      this.loved.add(mid);
      if (ref) this.lovedRef.set(mid, ref);
    } else this.loved.delete(mid);
    this.loveVersion++;
    this.persistLoved();
  }

  /** 「我喜欢」预载：分页拉全收藏的单曲 → 灌满红心态（各视图默认点亮）+ 缓存列表。
   *  - 幂等：飞行中共享同一次请求；fresh=false 且缓存未过期（LOVED_TTL）直接复用。
   *  - 拉全了整体以服务端为准；被 LOVED_MAX 截断时只做并集，不误灭本地已亮红心。
   *  - 读侧滞后庇护：本会话刚写确认的收藏可能还没反映进读数，以本地为准补回/剔除。
   *  - 失败不清空红心态（未登录/上游抖动时保留本地缓存），返回是否成功。 */
  loadLoved(fresh = false): Promise<boolean> {
    if (this.likedFlight) return this.likedFlight;
    if (!fresh && this.likedCache && Date.now() - this.likedAt < LOVED_TTL) return Promise.resolve(true);
    let flight!: Promise<boolean>;
    flight = (async () => {
      const all: Song[] = [];
      let total = 0;
      for (let page = 1; all.length < LOVED_MAX; page++) {
        const r: any = await api(`/user/liked?page=${page}&num=${LOVED_PAGE}`);
        const batch: Song[] = r?.songs ?? [];
        if (page === 1) total = Number(r?.total ?? 0);
        all.push(...batch);
        if (!r?.hasmore || !batch.length) break;
      }
      // 别让整单预载冲掉刚点的红心：滞后写入以本地为准校正读数（love-song-reload 的教训）
      const old = this.likedCache;
      const rec = this.reconcilePending(all, total);
      total = rec.total;
      for (const mid of [...rec.laggingOn].reverse()) {
        const row = old?.find((x) => x.mid === mid);
        if (row) all.unshift(row); // 本地乐观行插回头部（收藏顺序 = 最近在前）
      }
      const mids = new Set<string>();
      for (const s of all) {
        if (!s?.mid) continue;
        mids.add(s.mid);
        if (s.id) this.lovedRef.set(s.mid, { id: s.id, type: s.type ?? 1 }); // 存读侧原值，写时再转写侧枚举
      }
      for (const mid of rec.laggingOn) mids.add(mid); // 无行可插的滞后 like 至少保住红心
      if (all.length >= total) this.loved = mids;
      else for (const m of mids) this.loved.add(m);
      this.likedCache = all;
      this.likedTotal = total || all.length;
      this.likedAt = Date.now();
      this.loveVersion++;
      this.persistLoved();
      this.notify();
      this.emitLovedListChange();
      return true;
    })()
      .catch((e) => {
        console.warn("「我喜欢」预载失败（保留本地红心态）", e);
        return false;
      })
      .finally(() => { if (this.likedFlight === flight) this.likedFlight = null; });
    this.likedFlight = flight;
    return flight;
  }

  /** 订阅「我喜欢」列表内容变更（写确认新增 / 增量回源 / 整单预载后触发）。返回退订函数。 */
  onLovedListChange(fn: Listener): () => void {
    this.lovedListListeners.add(fn);
    return () => { this.lovedListListeners.delete(fn); };
  }
  private emitLovedListChange() {
    this.lovedListVersion++;
    for (const fn of [...this.lovedListListeners]) { try { fn(); } catch (e) { console.warn(e); } }
  }

  /** 安排一次写后增量回源（去抖：连点合并成最后一击后的一次）。进我喜欢页也用它顺带对账。 */
  syncLovedSoon() {
    if (this.lovedSyncTimer !== null) window.clearTimeout(this.lovedSyncTimer);
    this.lovedSyncTimer = window.setTimeout(() => {
      this.lovedSyncTimer = null;
      void this.syncLoved();
    }, LOVED_SYNC_DELAY);
  }

  /** 读侧滞后庇护：把「已写确认但读数（或其缓存）还没反映」的收藏校正进拉取结果
   *  （loadLoved/syncLoved 共用）。名单在庇护期内不删除 —— 读数反映也不提前出名单，
   *  同一写入可能被更旧的快照再次冲掉；只按 LOVED_PENDING_TTL 过期（persistLoved 落盘）。
   *  - like 不可见 → 红心补回 + 计数 +1，mid 归入 laggingOn（行由调用方插回）；
   *  - unlike 仍在读数 → 从结果剔除 + 计数 -1；
   *  - corrected = 本轮真的校正过（增量回源据此决定要不要重试追平）。 */
  private reconcilePending(songs: Song[], total: number): {
    songs: Song[]; total: number; laggingOn: string[]; corrected: boolean;
  } {
    const now = Date.now();
    for (const [mid, w] of this.recentWrites) if (now - w.at > LOVED_PENDING_TTL) this.recentWrites.delete(mid);
    const laggingOn: string[] = [];
    let t = total;
    for (const [mid, w] of this.recentWrites) {
      const at = songs.findIndex((s) => s?.mid === mid);
      if (w.on && at < 0) { laggingOn.push(mid); this.loved.add(mid); t++; continue; }
      if (w.on) continue; // 已反映：无需校正，但更旧的快照仍可能缺它
      if (at >= 0) { songs.splice(at, 1); t--; continue; } // unlike 滞后：从读数剔除
      // unlike 已反映：无需校正
    }
    return { songs, total: t, laggingOn, corrected: laggingOn.length > 0 || t !== total };
  }

  /** 写后增量回源：只拉「最近收藏」一小窗（LOVED_SYNC_PAGE）与本地对账，不做整单分页重载。
   *  - **只增不灭**：窗口内以服务端顺序/字段为准（滞后 unlike 剔除、滞后 like 插回头部），
   *    窗口外与读数里缺失的条目一律保留 —— 读侧缓存不保证单调，不能凭一次拉取把用户
   *    看得见的红心/行灭掉；他端取消收藏的最终收敛交给整单预载（TTL 过期/进页）。
   *  - 滞后写入以本地为准（reconcilePending），没对上的限次重试；全程静默失败 ——
   *    本地乐观态本就是兜底。 */
  private syncLoved(): Promise<void> {
    if (!this.likedCache || this.likedFlight) return Promise.resolve(); // 无基线不凭空造列表；整单预载在跑则交给它
    if (this.lovedSyncFlight) return this.lovedSyncFlight;
    let flight!: Promise<void>;
    flight = (async () => {
      try {
        const r: any = await api(`/user/liked?page=1&num=${LOVED_SYNC_PAGE}`);
        const fetched: Song[] = ((r?.songs ?? []) as Song[]).filter((s) => s?.mid);
        const rec = this.reconcilePending(fetched, Number(r?.total ?? 0));
        this.lovedSyncCorrected = rec.corrected;
        const old = this.likedCache!;
        const prevOrder = old.slice();
        const prevTotal = this.likedTotal;
        const prevLoved = new Set(this.loved);
        // 窗口内以服务端顺序为准；滞后 like 的本地乐观行插回头部（收藏顺序 = 最近在前）
        const head = [...rec.songs];
        const seen = new Set(head.map((s) => s.mid));
        for (const mid of [...rec.laggingOn].reverse()) {
          seen.add(mid);
          const row = old.find((x) => x.mid === mid);
          if (row) head.unshift(row);
        }
        const tail = old.filter((s) => s?.mid && !seen.has(s.mid));
        this.likedCache = [...head, ...tail];
        for (const s of head) {
          if (!s.mid) continue;
          this.loved.add(s.mid);
          if (s.id) this.lovedRef.set(s.mid, { id: s.id, type: s.type ?? 1 }); // 存读侧原值，写时再转写侧枚举
        }
        for (const mid of rec.laggingOn) this.loved.add(mid);
        this.likedTotal = Math.max(rec.total, prevTotal); // 计数同理不回退（stale 读数只会更旧）
        const changed = !sameLovedOrder(prevOrder, this.likedCache)
          || prevTotal !== this.likedTotal
          || prevLoved.size !== this.loved.size
          || [...prevLoved].some((m) => !this.loved.has(m));
        if (changed) this.emitLovedListChange();
      } catch (e) {
        console.warn("「我喜欢」增量回源失败（保留本地）", e);
      } finally {
        this.lovedSyncFlight = null;
        if (this.lovedSyncCorrected && this.lovedSyncTries < 3) {
          this.lovedSyncTries++; // 读侧滞后没追平：稍后再对一轮（封顶，防上游真丢了无限打转）
          this.syncLovedSoon();
        } else if (!this.lovedSyncCorrected) {
          this.lovedSyncTries = 0;
        }
        this.lovedSyncCorrected = false;
      }
    })();
    this.lovedSyncFlight = flight;
    return flight;
  }

  /** 切换单曲收藏（红心）：乐观更新、失败回滚，返回写接口终态（null = 缺少 song_id 无从下手）。
   *  取消收藏同样走在线 unlike 接口，「我喜欢」缓存同步移出该曲。
   *  写确认后进滞后庇护名单并安排一次增量回源（syncLovedSoon）：拉一小窗与远端对账。 */
  async toggleLove(song?: Song): Promise<boolean | null> {
    const mid = song?.mid;
    if (!mid) return null;
    // 行对象可能来自不带数字 id 的上下文（如专辑曲目）：回落到预载时记下的 song_id
    const ref = song.id ? { id: song.id, type: song.type ?? 1 } : this.lovedRef.get(mid);
    if (!ref) return null;
    const on = !this.loved.has(mid);
    this.setLoved(mid, on, ref);
    this.notify();
    try {
      const r = await postJson<boolean>(on ? "/song/like" : "/song/unlike",
        { song_id: ref.id, song_type: writeSongType(ref.type) });
      // 上游把 retCode≠0（含 80092）压成 false 且不抛错 —— 不拦就是「看着收藏了、其实没有」
      if (r === false) throw new Error("上游未接受本次收藏写入");
    } catch (e: any) {
      this.recentWrites.delete(mid);
      console.warn("收藏同步失败", e);
      this.setLoved(mid, !on, ref); // 回滚
      this.error = "收藏失败：" + (e?.message ?? e);
      this.notify();
      return !on;
    }
    this.recentWrites.set(mid, { on, at: Date.now() });
    this.lovedSyncTries = 0;
    // 缓存与列表计数跟进（写接口已确认，视图据此即时自洽）
    if (on) {
      if (this.likedCache && !this.likedCache.some((x) => x.mid === mid)) this.likedCache.unshift(song!);
      this.likedTotal++;
    } else {
      if (this.likedCache) this.likedCache = this.likedCache.filter((x) => x.mid !== mid);
      if (this.likedTotal > 0) this.likedTotal--;
    }
    // 广播列表变更：新增行让打开中的我喜欢页立刻出现；移除由该页逐行淡出消化（views.ts）
    this.emitLovedListChange();
    this.syncLovedSoon();
    return on;
  }

  /** 高亮当前页面对应的歌曲行（.playing 类），与旧行为一致 */
  markActive() {
    document.querySelectorAll(".card.playing,.row.playing").forEach((e) => e.classList.remove("playing"));
    const key = this.current?.mid;
    if (!key) return;
    document.querySelectorAll(`[data-songkey="${CSS.escape(key)}"]`).forEach((e) => e.classList.add("playing"));
  }
}

export const player = new Player();
export { coverUrl };

// —— 逐字歌词辅助（模块级纯函数，便于复用与测试） ——

/** 两个列表是否同一批曲（同序同 mid）：一样就不广播/不重画，避免打断滚动。
 *  （与 views.ts 的 sameMids 同义；player 不能反向 import songs.ts —— 会成环） */
function sameLovedOrder(a: Song[], b: Song[]) {
  return a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);
}

/** 逐字行 → 行级展示列表（逐字提供器缺位/解析失败回退时的行级视图，与 LRC 行为一致） */
function karaokeToLines(lines: SparkleKaraokeLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const l of lines) {
    const text = l.words.map((w) => w.word).join("").trim();
    if (!text) continue;
    out.push({ t: l.startTime / 1000, text, trans: l.translatedLyric?.trim() || undefined });
  }
  return out;
}

// 开发/自动化测试钩子：shell 挂载时暴露单例（生产构建里 vite define 会剔除）
declare global { interface Window { __quaverPlayer?: Player } }
if (import.meta.env?.DEV) window.__quaverPlayer = player;
