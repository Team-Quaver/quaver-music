// Quaver — 全局播放器状态机（常驻于 SPA 壳层，跨视图不销毁，音频不中断）
// 订阅式：任何状态变化 notify 所有 UI（播放条 / 正在播放页 / 队列面板）。
// 音频走 Transport 抽象（src/lib/transport.ts）：默认 mpv 原生引擎（Electron 壳层），
// 可选浏览器 <audio> 兜底；曲目/队列/循环/歌词归本层，位置/时长/播放态真相在传输层。
import { api, postJson, coverUrl, resolveStreamUrl, effectiveQuality, getSessionQuality, setSessionQuality, getLastStream, setLastStream, writeSongType, type StreamResult } from "./lib/api";
import {
  getDecode, setDecode, getAudioDevice, setAudioDevice, setFade, FADE_PRESETS,
  getFadeMs,
  getEqualizerState, setEqualizerState,
  getVolume as getVolumeConf, setVolume as setVolumeConf,
  getMuted as getMutedConf, setMuted as setMutedConf,
  getShowTrans, setShowTrans, getLyricAux, setLyricAux, type LyricAuxMode,
  getPrevBehavior,
  getOnlineTtml, getTtmlDatabase, getTtmlLibrary,
  getReportListenTime,
  type DecodeBackend, type FadePreset,
} from "./lib/prefs";
import { cjkConvert } from "./lib/cjk-convert";
import { expandTtmlUrl, fetchTtml, ttmlMissCached, ttmlMissRemember } from "./lib/ttml";
import { WebTransport, createEngineTransport, EngineTransport, type Transport, type TransportEvent, type AudioDeviceInfo } from "./lib/transport";
import { normalizeEqState, type EqState } from "../electron/audio/eq-config.ts";
import { loadSession, saveSession } from "./lib/session";
import { dayKey, daySeed, shuffleOrder, step, walk } from "./lib/shuffle";
import { coerceLyricToLrc, parseLrc, type LyricLine } from "./lyric";
import type {SparkleKaraokeLine, SparkleKaraokeProvider} from "@quaver/sparkle";
import { onSparkleChange, sparkleKaraokeProvider, sparkleStreamSources } from "./sparkle/registry";
import { isLocalSong, localSongStreamUrl, loadLocalLibrary, onLocalLibraryChange, trackById, type LocalSongFingerprint } from "./lib/local.ts";
import type { ListenReportTarget, ListenTimeReporter } from "./lib/listen-report";
import { PlaybackEndGate } from "./lib/playback-end";

export type Song = {
  mid: string;
  id?: number;
  type?: number;
  name: string;
  /** 完整展示名（= name + 版本后缀，如「半梦 (Studio Live)」）；展示一律走 lib/api:songTitle */
  title?: string;
  /** 歌曲说明（如「《小时代》电影主题曲」），可为空 */
  subtitle?: string;
  singer?: { id?: number; name: string; mid?: string; pmid?: string }[];
  album?: { mid?: string; pmid?: string; name?: string };
  interval?: number;
  _key?: string;
  /** 本地/NAS 曲目指纹（「本地音乐」页与 lib/local.ts:trackToSong 生成）。
   *  带这个字段的歌不走 QQ 取链/红心/档位回退，取流 = /api/local/stream/<id>。 */
  local?: LocalSongFingerprint;
};

/** 播放模式只剩循环两档：「顺序播放（off）」已移除 —— 列表到尾一律回绕。 */
export type Mode = "all" | "one";

/** 实际生效的播放管线（transport.kind 投影；设置页据此展示） */
export type ActiveBackend = "mpv" | "mpv-compat" | "web";

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

// 前台轮询的轻量探针：先比「最近收藏头部 + total」，变了才做整单回源。
// 他端的收藏/取消都会体现在这两个量上；没变化时每轮只要一个小请求。
const LOVED_PROBE_PAGE = 20;

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
  /** 猜你喜欢无限电台：开关与当前轮次随会话存档恢复。
   *  radioEnd = 当前这一轮最后一首在 queue 里的下标；播到它时补下一轮并裁掉当前曲之前的历史。 */
  private radioOn = false;
  private radioEnd = -1;
  private _radioLoading = false;
  private radioWaitingNext = false;
  private radioSeq = 0;
  private radioRetryTimer: number | null = null;
  radioError = "";
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
  /** 歌词内容版本：每次解析结果被替换 +1（不只是状态迁移）。
   *  重导入同一首歌词时 lyricState 仍是 ok，渲染层必须靠它识别「内容换了、DOM 要重建」。 */
  lyricRevision = 0;
  /** 逐字歌词（Sparkle 逐字提供器解析的词级时间轴行，毫秒）；无逐字数据时为空 */
  karaoke: SparkleKaraokeLine[] = [];
  loading = false; // 正在取链/缓冲（UI 画加载指示）
  expanded = false; // 正在播放页是否展开
  /** 画廊模式（运行时态，不持久化）：正在播放页全屏化展示。开 = 展开本页并进全屏，
   *  收起本页即退出（NowPlaying 在 expanded 迁移里联动全屏并清零本标志）。 */
  gallery = false;
  queueOpen = false;
  lyricAux: LyricAuxMode = getLyricAux(); // 歌词辅助行：off/translation/romanization
  /** 行级/插件门面：非 off 即显示辅助行（翻译档优先翻译、音译档优先音译，缺则回落另一路） */
  get showTrans(): boolean { return this.lyricAux !== "off"; }
  /** 实际生效后端（"mpv"=原生直出；"mpv-compat"=MPV 解码 + renderer 出声；"web"=浏览器 <audio>） */
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
  /** PCM `ending` 与旧 sink 迟到的 `ended` 共用的一次性曲末闸门。 */
  private endGate = new PlaybackEndGate();
  /** 启动还原的续播点：流还没就绪时保住它，别让存档被 0 覆盖 */
  private savedPos = 0;
  /** 存档闸门：启动还原完成前不写盘 —— 否则启动瞬间的空队列会覆盖上一轮的存档 */
  private sessionReady = false;
  private sessionAt = 0;
  private sessionTimer: number | null = null;
  /** 后端选择完成（首播若发生在启动检查完成前，startCurrent 会等它） */
  private backendInit: Promise<void>;
  /** 真实出声时长上报器：首次播放 QQ 曲目时懒加载，避免把协议/计时器塞进首屏。 */
  private listenReporter: ListenTimeReporter | null = null;
  private listenReporterInit: Promise<ListenTimeReporter> | null = null;

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
    window.addEventListener("pagehide", () => this.listenReporter?.flush(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.saveSessionNow();
    });
    // 主进程拆窗重建（CSD/SSD 切换）前派发：立刻落一次存档 —— destroy() 不保证触发
    // pagehide，而重建后的新页面要靠这份存档对齐队列/指针去接管 mpv 正在放的歌
    window.addEventListener("quaver:flush-session", () => {
      this.saveSessionNow();
      this.listenReporter?.flush(true);
    });
    // 歌词提供器是异步注册的（内置 AMLL 由 initSparkle 动态 import，晚于首帧）：首曲歌词
    // 可能在 provider 到位前就按纯 LRC 拉完了 → provider 出现时对当前曲补拉一次
    // （fetchLyric 自带竞态守卫）
    let lastKaraProvider: SparkleKaraokeProvider | null = null;
    onSparkleChange(() => {
      const p = sparkleKaraokeProvider();

      if (p === lastKaraProvider) return;
      lastKaraProvider = p;

      if (p && this.current) void this.fetchLyric(this.current);
    });
    // 本地库快照变化（扫描/自动刮削落定）→ 当前本地曲目的 qqMid/封面指纹原地跟进
    onLocalLibraryChange(() => this.refreshLocalCurrent());
  }

  // —— 传输层接线 ——

  private bindTransport(t: Transport) {
    this.transport = t;
    t.onEvent((e) => this.onTransportEvent(e));
  }

  /** 供 Node 单测直接驱动 transport 事件（生产只由 bindTransport 调用）。 */
  handleTransportEvent(e: TransportEvent) {
    this.onTransportEvent(e);
  }

  private onTransportEvent(e: TransportEvent) {
    switch (e.type) {
      case "time":
        this.listenReporter?.pulse();
        this.notify();
        break;
      case "duration":
        this.consumePendingSeek();
        this.notify();
        break;
      case "play":
      case "pause":
        this.listenReporter?.setPlaying(e.type === "play" && !this.transport.paused);
        this.notify();
        break;
      case "waiting": // 起播后仍需缓冲（网络卡顿）→ 保持加载指示
        this.listenReporter?.setPlaying(false);

        if (this.current) { this.loading = true; this.notify(); }

        break;
      case "playing": // playing = 真的出声了（起播/缓冲恢复）
        this.listenReporter?.setPlaying(true);

        if (this.loading) { this.loading = false; this.error = ""; this.notify(); }

        this.endGate.reset();
        this.failStreak = 0; // 出声即成功：自动跳曲的连续失败计数清零
        break;
      case "canplay":
        if (this.loading && !this.transport.paused) { this.loading = false; this.notify(); }

        break;
      case "ending":
        // PCM 已收到 EOF，但本地还有一段尾音：此刻先起下一首，旧尾在新曲头下淡出。
        // 单曲循环和无限电台仍走完整 ended；前者要原地重播，后者可能要等下一轮取歌。
        if (this.mode === "one" || this.radioOn || this.transport.paused || !this.endGate.consume()) break;
        this.onEnded();
        break;
      case "ended":
        if (!this.endGate.consume()) break; // PCM ending 已提前切歌；旧 sink 的迟到 ended 不再跳一首
        this.listenReporter?.setPlaying(false);
        this.listenReporter?.flush();
        this.onEnded();
        break;
      case "error": {
        this.listenReporter?.setPlaying(false);

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
    const pref = getDecode();

    if (pref === "Blink" || !window.quaverAudio) return;

    try {
      const st = await window.quaverAudio.invoke({ cmd: "status" });

      if (!st?.ok || !st.available) {
        this.backendNotice = st?.reason || "mpv 不可用，已回退浏览器音频";

        return;
      }

      const mode = pref === "MPVCompat" ? "pcm" : "native";
      const t = await createEngineTransport(window.quaverAudio, { mode });
      const dev = getAudioDevice();

      if (mode === "native" && dev) void t.setDevice?.(dev).catch(() => {});
      const resume = this.swapTransport(t);
      this.backend = mode === "pcm" ? "mpv-compat" : "mpv";
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
    this.radioOn = !!snap.radio;
    // radioEnd 是轮末续批的边界。旧/过渡存档可能没有它（或存到了 -1），
    // 有队列时按当前队列尾部兜底；否则保留空电台，等首轮取回。
    this.radioEnd = this.radioOn && this.queue.length
      ? Math.min(this.queue.length - 1, Math.max(this.index, snap.radioEnd ?? this.queue.length - 1, 0))
      : -1;
    this._radioLoading = false;
    this.radioWaitingNext = false;
    this.radioError = "";

    if (this.radioOn) this.queueOpen = false;
    this.queueVersion++;
    this.savedPos = snap.position;
    this.notify();
    this.sessionReady = true;

    // 首轮还没取回就退出的空电台：恢复电台会话但继续走非自动播放的启动语义。
    if (this.radioOn && !this.current) {
      void this.startRadio(false).catch(() => { /* 错误态已写进 radioError；保留电台态并定时重试 */ });

      return;
    }

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
      radio: this.radioOn, radioEnd: this.radioEnd,
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
    this.listenReporter?.setPlaying(false);

    try { this.transport.stop(); } catch { /* noop */ }

    try { this.transport.dispose?.(); } catch { /* noop */ }

    this.pendingSeek = 0;
    this.bindTransport(t);
    this.applyVolume();

    if (!song || !hadStream || this.current !== song) return Promise.resolve();

    return this.startCurrent(at > 1 ? at : 0, wasPlaying);
  }

  /** 设置页切换播放模式：MPV 原生 / 原生（兼容）/ Blink 浏览器。
   *  热切换当前曲目换轨续播、保留播放态；兼容模式由 MPV 解码、renderer 打开音频设备。 */
  async setBackend(kind: DecodeBackend): Promise<void> {
    setDecode(kind);

    if (kind === "Blink") {
      if (this.backend === "web") { this.notify(); return; }

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

    const mode = kind === "MPVCompat" ? "pcm" : "native";

    if (this.transport.kind === "engine" && this.transport.mode === mode) {
      this.backend = mode === "pcm" ? "mpv-compat" : "mpv";
      this.backendNotice = "";
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

      const t = await createEngineTransport(window.quaverAudio, { mode });
      const dev = getAudioDevice();

      if (mode === "native" && dev) void t.setDevice?.(dev).catch(() => {});
      await this.swapTransport(t);
      this.backend = mode === "pcm" ? "mpv-compat" : "mpv";
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

    // 兼容模式设备由 renderer AudioContext 决定（当前跟随系统默认），MPV 的
    // audio-device 列表在这里没有意义，别把用户引到无效开关上。
    if (this.backend === "mpv-compat") return null;

    try { return await this.transport.listDevices(); } catch { return null; }
  }

  /** 选择音频设备（持久化 + 应用到引擎） */
  async selectAudioDevice(id: string): Promise<boolean> {
    setAudioDevice(id);

    if (this.backend === "mpv-compat" || !this.transport.setDevice) return false;

    try { await this.transport.setDevice(id); return true; } catch { return false; }
  }

  /** 淡入淡出预设（持久化 + 立即下发时长；仅引擎后端消费） */
  async setFadePreset(p: FadePreset): Promise<void> {
    setFade(p);
    const ms = FADE_PRESETS[p];

    if (!this.transport.setFade) return;

    try { await this.transport.setFade(ms.inMs, ms.outMs); } catch { /* 引擎不在：下次建立传输时随配置下发 */ }
  }

  /** Quark EQ：持久化 + 立即下发到当前 mpv 传输。浏览器后端没有 setEqualizer，静默跳过。
   *  返回规范化后的状态，调用方以它回写 UI（夹紧值/非法类型不会留在界面上）。 */
  async setEqualizer(eq: EqState): Promise<EqState> {
    const next = normalizeEqState(eq);
    setEqualizerState(next);

    if (this.transport.setEqualizer) {
      try { await this.transport.setEqualizer(next); } catch { /* mpv 未起：状态留在引擎侧，首播时套用 */ }
    }

    return next;
  }

  /** 当前持久化的 EQ。播放器不持有第二份真相，设置浮窗每次打开都从这里取。 */
  getEqualizer(): EqState { return getEqualizerState(); }

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
  /** 浏览器 <audio> 后端时的真实媒体元素（频谱分析直接接管它；mpv 后端为 null）。
   *  只给同页的只读采集用，不参与队列/状态语义。 */
  get webAudioElement(): HTMLAudioElement | null {
    return this.transport.kind === "web" ? (this.transport as WebTransport).audio : null;
  }

  /** 频谱/诊断用的实际输出拓扑：按 transport 判断，不靠旧 AnalyserNode 是否残留。 */
  get outputMode(): "web" | "pcm" | "native" {
    if (this.transport.kind === "web") return "web";

    return this.transport.mode === "pcm" ? "pcm" : "native";
  }

  /** 兼容模式 PCM 输出的 AnalyserNode：频谱直接吃扬声器同一份样本。 */
  get pcmAnalyser(): AnalyserNode | null {
    return this.outputMode === "pcm" ? (this.transport.pcmAnalyser?.() ?? null) : null;
  }
  /** 无限电台是否生效（播放条据此屏蔽上一曲、QueuePanel 可据此显示电台态） */
  get radioActive() { return this.radioOn; }
  get radioLoading() { return this._radioLoading; }
  /** 上一曲是否可用：电台只向前走，必须把按钮/媒体键的入口一并关掉，不能只藏 UI */
  get canPrev() { return this.queue.length > 0 && !this.radioOn; }
  get time() { return this.transport.position; }
  /** 歌词时钟补偿（秒）：native/web 沿用现有 +0.2s；PCM 兼容模式启动有预缓冲，不能再叠这一层。 */
  get lyricComp() { return this.backend === "mpv-compat" ? 0 : 0.2; }
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

  /** SDK 的 toggleTrans 只有布尔名分；这里让它循环三档，插件不用访问 player 也能切到音译。 */
  toggleTrans() {
    const order: LyricAuxMode[] = ["off", "translation", "romanization"];
    this.setLyricAuxMode(order[(order.indexOf(this.lyricAux) + 1) % order.length]!);
  }

  /** 翻译选项：off/translation/romanization，一次写盘（含兼容旧 ShowTranslation） */
  setLyricAuxMode(mode: LyricAuxMode) {
    if (mode === this.lyricAux) return;
    this.lyricAux = mode;
    setLyricAux(mode);
    this.notify();
  }

  /** 歌词相关设置变更后重拉当前曲（繁简档位 / 在线 TTML 开关 / 数据库地址 / 本地库目录）。
   *  不重走取链/播放，只重跑歌词管线 —— 导入件/优先级规则由 fetchLyric 自己摆正。 */
  reloadLyric(): void {
    if (this.current) void this.fetchLyric(this.current);
  }

  private clearRadioRetry() {
    if (this.radioRetryTimer !== null) {
      window.clearTimeout(this.radioRetryTimer);
      this.radioRetryTimer = null;
    }
  }

  /** 退出电台会话（不动当前播放）：任何“换整张队列/手动改队列”的动作都先走这里。 */
  private exitRadio() {
    this.radioSeq++;
    this.clearRadioRetry();
    this.radioOn = false;
    this.radioEnd = -1;
    this._radioLoading = false;
    this.radioWaitingNext = false;
    this.radioError = "";
  }

  stopRadio() {
    if (!this.radioOn) return;
    this.exitRadio();
    this.notify();
  }

  /**
   * 开启猜你喜欢无限电台：先取一轮 5 首，取到后整队列起播。
   * 电台主 UI 留在 Content View（views/guess.ts）；本轮第五首开始播放时由 maybeExtendRadio()
   * 续下一轮，每一轮都只请求 rounds=1。
   */
  async startRadio(autoplay = true): Promise<boolean> {
    const seq = ++this.radioSeq;
    const wasRadio = this.radioOn;
    const prev = { on: this.radioOn && this.radioEnd >= 0, end: this.radioEnd, waiting: this.radioWaitingNext };
    this.clearRadioRetry();
    this.radioOn = true;
    this.radioEnd = -1;
    this._radioLoading = true;
    this.radioWaitingNext = false;
    this.radioError = "";
    this.error = "";
    this.queueOpen = false; // 无限电台没有可编辑的播放列表，进入即收掉队列面板
    this.notify();

    try {
      const songs = await this.fetchRadioRound();

      if (seq !== this.radioSeq) return false;

      if (!songs.length) throw new Error("猜你喜欢暂无推荐，登录后可得");
      this.queue = songs;
      this.index = 0;
      this.radioEnd = this.queue.length - 1;
      this._radioLoading = false;
      this.queueVersion++;
      this.error = "";
      this.notify();
      void this.startCurrent(0, autoplay);

      return true;
    } catch (e) {
      if (seq !== this.radioSeq) return false;
      // 换一批失败时把上一轮电台会话放回去；从存档恢复的空电台也必须继续保留开关。
      // 只有用户第一次主动进入、且此前不在电台里时才回到普通播放态。
      this.radioOn = prev.on || wasRadio;
      this.radioEnd = prev.on ? prev.end : this.radioOn && this.queue.length ? this.queue.length - 1 : -1;
      this._radioLoading = false;
      this.radioWaitingNext = prev.waiting;
      this.radioError = String((e as Error)?.message ?? e);
      this.notify();

      if (this.radioOn && this.radioEnd < 0 && !this.queue.length) {
        this.clearRadioRetry();
        this.radioRetryTimer = window.setTimeout(() => {
          this.radioRetryTimer = null;
          void this.startRadio(autoplay).catch(() => { /* 保留电台态并继续退避重试 */ });
        }, 5_000);
      } else if (this.radioOn && this.radioEnd >= 0 && this.index >= this.radioEnd) {
        this.clearRadioRetry();
        this.radioRetryTimer = window.setTimeout(() => {
          this.radioRetryTimer = null;
          this.maybeExtendRadio();
        }, 5_000);
      }

      throw e;
    }
  }

  /** 单轮电台取歌：上游一次固定 5 首，所以这里显式 rounds=1，不把多轮结果当成一张歌单。 */
  private async fetchRadioRound(): Promise<Song[]> {
    const r = await api<{ songs?: Song[] }>("/recommend/guess?rounds=1");

    return (r?.songs ?? []).filter((s) => !!s?.mid).slice(0, 5);
  }

  /** 播到本轮最后一首时续批；radioLoading 同时挡住自然结束与手点下一首的重复请求。 */
  private maybeExtendRadio() {
    if (!this.radioOn || this._radioLoading || this.radioEnd < 0 || this.index < this.radioEnd) return;
    void this.extendRadio();
  }

  /** 追加下一轮 5 首，并删除当前曲之前的全部历史。当前曲对象本身留在队列首位。 */
  private async extendRadio() {
    if (!this.radioOn || this._radioLoading || this.radioEnd < 0 || this.index < this.radioEnd) return;
    this.clearRadioRetry();
    const seq = this.radioSeq;
    this._radioLoading = true;
    this.radioError = "";
    this.notify();

    try {
      const songs = await this.fetchRadioRound();

      if (seq !== this.radioSeq) return;

      if (!songs.length) throw new Error("猜你喜欢暂无更多推荐");
      this.queue.push(...songs);
      const anchor = this.current;
      const at = anchor ? this.queue.indexOf(anchor) : this.index;
      const drop = Math.max(0, at);

      if (drop) this.queue.splice(0, drop);
      this.index = Math.max(0, this.index - drop);
      this.queueVersion++;
      this.radioEnd = this.queue.length - 1;
      this._radioLoading = false;
      this.notify();

      if (this.radioWaitingNext) {
        this.radioWaitingNext = false;

        if (this.index + 1 < this.queue.length) this.jump(this.index + 1);
      }
    } catch (e) {
      if (seq !== this.radioSeq) return;
      this._radioLoading = false;
      this.radioError = String((e as Error)?.message ?? e);
      this.notify();
      // 网络/上游节流时别让第五首放完后回绕到旧歌：停在轮末，稍后自动再续。
      this.radioRetryTimer = window.setTimeout(() => {
        this.radioRetryTimer = null;
        this.maybeExtendRadio();
      }, 5_000);
    }
  }

  /** 用新列表替换队列并从 i 播放（整队列替换：视图语义一致）。不 await：双击即刻打断切歌。 */
  playList(songs: Song[], i = 0) {
    this.exitRadio();
    this.queue = songs.filter((s) => s?.mid);
    this.index = Math.max(0, Math.min(i, this.queue.length - 1));
    this.queueVersion++;
    void this.startCurrent();
  }

  /** 插队播放：把这首插到**当前曲之后**就完事 —— 当前曲继续放，下一首轮到它。
   *  语义是「排进队列的下一位」，**不是**打断当前曲立刻切过去；右键菜单「插队播放」走这条。
   *  无限电台期间拒绝执行：电台队列只由取歌轮次推进，不能被外部歌曲插队。
   *  队列还空着（没播过任何东西）时没有「下一首」可言，退化成单曲起播。 */
  enqueueNext(song: Song): boolean {
    if (!song?.mid || this.radioOn) return false;

    if (this.index < 0 || !this.queue.length) { this.playList([song], 0); return true; }

    this.queueVersion++;
    this.queue.splice(this.index + 1, 0, song);
    this.notify();

    return true;
  }

  /** 整批插队：把一批歌（歌单「插队播放」）按原序排到当前曲之后等着播 —— 不切歌、不打断。
   *  与 enqueueNext 同一分叉：队列还空着时没有「下一首」可言，退化成整列起播；电台期间一律拒绝。 */
  enqueueNextMany(songs: Song[]): boolean {
    if (this.radioOn) return false;
    const list = songs.filter((s) => s?.mid);

    if (!list.length) return false;

    if (this.index < 0 || !this.queue.length) { this.playList(list, 0); return true; }

    this.queueVersion++;
    this.queue.splice(this.index + 1, 0, ...list);
    this.notify();

    return true;
  }

  /** 立即插队播放：插到**当前曲之后**并**马上切过去**（打断当前曲）。与 enqueueNext 只差时机 ——
   *  不等当前曲放完。只带这一首进队列，队列原有内容不动（其余搜索结果不入列）。
   *  搜索页双击用：即点即播，但不把搜索结果整列灌进队列。
   *  这是用户显式选择的立即播放，不是排队插队：电台期间先退出电台，再正常切歌。
   *  队列还空着（没播过任何东西）时没有「插队」可言，退化成单曲起播。 */
  playNextNow(song: Song): boolean {
    if (!song?.mid) return false;

    if (this.index < 0 || !this.queue.length) { this.playList([song], 0); return true; }

    this.exitRadio();
    this.queue.splice(this.index + 1, 0, song);
    this.index++;
    this.queueVersion++;
    void this.startCurrent();

    return true;
  }

  /** 从队列移除第 i 首。删除的是当前曲：停流停在原地（指针落到同槽位的下一首），不自动续播；
   *  删当前曲之前的歌：指针前移；删之后的歌：指针不动。 */
  removeAt(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    this.exitRadio();
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
    this.exitRadio();
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

    this.exitRadio();
    this.queue = [];
    this.index = -1;
    this.queueVersion++;
    this.interrupt();
    this.notify();
  }

  jump(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.maybeExtendRadio();
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
  private interrupt(stopOutput = true) {
    this.listenReporter?.stopTarget();
    this.playSeq++;
    this.loading = false;
    this.error = "";
    this.endGate.reset();
    this.pendingSeek = 0;
    this.streamUrl = "";

    if (stopOutput) { try { this.transport.stop(); } catch { /* noop */ } }
  }

  /** 当前流对应的听歌时长上报目标；本地/NAS 曲目和异常 URL 一律返回 null。 */
  private listenTargetOf(s: Song, url: string): ListenReportTarget | null {
    const prefix = "/api/stream/";

    if (isLocalSong(s) || !s.id || !url.startsWith(prefix)) return null;
    const streamToken = url.slice(prefix.length).split(/[?#]/, 1)[0] ?? "";

    if (!streamToken) return null;
    const singer = s.singer?.[0];
    const file = (s as Song & { file?: { media_mid?: string } }).file;
    const interval = Number(s.interval || this.transport.duration || 0);

    if (!(interval > 0)) return null;

    return {
      mid: s.mid,
      mediaMid: String(file?.media_mid ?? ""),
      songId: Number(s.id),
      audioTimeMs: Math.round(interval * 1000),
      songType: Number(s.type ?? 1),
      singerId: Number(singer?.id ?? 0),
      coSinger: String(singer?.name ?? ""),
      streamToken,
    };
  }

  /** 首次播放 QQ 曲目才加载上报器；初始化完成时若已切歌，旧目标直接丢弃。 */
  private initListenReporter(song: Song, url: string): void {
    const target = this.listenTargetOf(song, url);

    if (!target) return;
    void this.ensureListenReporter().then((reporter) => {
      if (this.current !== song || this.streamUrl !== url) return;
      reporter.setTarget(target);
      reporter.setPlaying(!this.loading && !this.transport.paused && this.transport.src === url);
    }).catch(() => { /* 上报是旁路能力：加载失败不能影响播放 */ });
  }

  private ensureListenReporter(): Promise<ListenTimeReporter> {
    if (this.listenReporter) return Promise.resolve(this.listenReporter);

    if (!this.listenReporterInit) {
      this.listenReporterInit = import("./lib/listen-report").then(({ ListenTimeReporter }) => {
        this.listenReporter = new ListenTimeReporter({
          enabled: getReportListenTime,
          send: (body, keepalive) => api("/sound-power/report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            keepalive,
          }),
        });

        return this.listenReporter;
      });
    }

    return this.listenReporterInit;
  }

  private async startCurrent(resumeTo = 0, autoplay = true, overrideTier?: string) {
    const s = this.current;
    // PCM 兼容模式切歌时先让旧曲继续出声，等新流链就绪后由 transport.load
    // 做交叉淡化。其它后端保持原来的硬打断语义。
    this.interrupt(!(this.transport.kind === "engine" && this.transport.mode === "pcm"));

    // 降级尝试记录按曲归属：换到别的歌就重置（每首都有完整的一次回退机会）
    if (s && s.mid !== this.fallbackMid) { this.fallbackMid = s.mid; this.fallbackTried.clear(); }

    this.lastAutoplay = autoplay;
    this.lyrics = [];
    this.karaoke = [];
    this.lyricState = "idle";
    this.lyricRevision++;
    // 换曲即作废在途歌词请求：fetchLyric 的序号守卫只防「更新的 fetch」，不防换曲 ——
    // 不作废的话，上一曲慢悠悠的歌词响应会在新曲起播期间回写（快速连点下一首时显示前前一首的歌词）
    this.lyricSeq++;

    if (!s) { this.notify(); return; }

    this.loading = true;
    this.notify();
    // 歌词与取流/起播互不依赖：从换曲第一刻并行拉取，别让音频加载 RTT 串在歌词前面。
    void this.fetchLyric(s);
    const seq = this.playSeq;

    try {
      await this.backendInit; // 首播发生在启动后端检查完成前：等检查定再挂流

      if (seq !== this.playSeq || this.current !== s) return; // 期间又切了歌：本轮作废
      const r = await this.getStream(s, overrideTier); // 命中单击预取的链接 → 直接跳过取链；降级重试带指定档

      if (seq !== this.playSeq || this.current !== s) return;
      this.streamUrl = r.url;
      this.initListenReporter(s, r.url);
      setLastStream({ tier: r.tier, label: r.label, degraded: r.degraded });
      const startAt = resumeTo > 1 ? resumeTo : 0;
      // engine 直接把 start= 交给 mpv，避免「先从头加载再 seek」多一次重拉；
      // web 仍需等元数据就绪后由 consumePendingSeek 跳转。
      await this.transport.load(r.url, { paused: !autoplay, startAt });

      if (startAt > 1 && this.transport.kind === "web") this.pendingSeek = startAt;

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
      this.prefetchNextForCrossfade();
    } catch (e: any) {
      if (seq === this.playSeq && this.current === s) {
        // 取链失败：旧曲不能一直垫着，收掉后再走降级/跳曲。
        if (this.transport.kind === "engine" && this.transport.mode === "pcm") this.transport.stop();
        this.loading = false;
        const msg = String(e?.message ?? e);
        this.error = msg;
        // 取链失败 = 后端 auto 全链回退 + 128 兜底都没拿到流（无源/网络故障）：
        // 前端再逐档重试是重复劳动，直接按「回退失败」跳下一曲
        this.skipSong(msg);
      }
    }

    this.notify();
  }

  // —— 播放失败自动回退：流加载/解码失败 → 沿档位链逐档降级重试（不动会话音质选择，
  //     播放条胶囊由 setLastStream 跟随实际降到的档）；链穷尽 → 自动跳下一曲。
  //     已败档位按曲记录：请求档与后端实际下发的档都记 —— auto 模式后端可能把请求档
  //     降级成它档返回，只记其一会被「同一请求」绕回死循环。 ——

  /** 前端降级链（与后端 tierTable rank 降序对齐，见 vendor/Typhoeus-go/typhoeus/quality.go） */
  private static readonly FALLBACK_CHAIN = ["master", "atmos71", "atmos51", "atmos2", "flac", "640ogg", "320ogg", "320", "192ogg", "128", "96ogg"];

  private handleStreamError(msg: string) {
    const s = this.current;

    if (!s) return;

    // 本地/NAS 曲目没有档位阶梯可下（文件就是那一档）：直接跳下一曲
    if (isLocalSong(s)) { this.skipSong(msg); return; }

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
   *  不用 next(true)（单曲循环语义是原地重播，坏流会死循环）—— 换曲是救济路径，
   *  必须一直有下一首可试；随机开着时同样沿当日顺序走，免得坏流把当天的听感打乱。 */
  private skipSong(reason: string) {
    this.failStreak++;

    if (!this.queue.length || this.failStreak >= this.queue.length) {
      this.loading = false;
      this.error = `播放失败（${reason}），已停止自动切歌`;
      this.notify();

      return;
    }

    // 电台的“下一首”还负责轮末续批；这里不能绕过 next() 直接 stepInOrder 回绕。
    if (this.radioOn) { this.next(true); return; }

    const i = this.stepInOrder(1);

    if (i < 0) { this.loading = false; this.notify(); return; }

    this.jump(i);
  }

  // —— 单击预加载：行点击即后台协商播放链接（含上游取链+嗅探这两次慢 RTT），
  //    双击起播时命中缓存即刻开流。单击新内容就清旧预取再预载新的（只留一份，释放内存/后端 token 表）。
  private prefetchedMid = "";

  prefetchSong(song: Song | undefined) {
    if (!song?.mid) return;

    if (isLocalSong(song)) return; // 本地流是现成的同源 URL，没有「取链预热」可言
    const q = String(effectiveQuality());

    if (song.mid === this.prefetchedMid && this.prefetch.has(q + "|" + song.mid)) return;
    this.prefetch.clear(); // 清理旧预加载链接引用（token 由后端 TTL 回收；前端不再持有下载）
    this.prefetchedMid = song.mid;
    const key = q + "|" + song.mid;
    const p = this.resolveWithSources(song, q);
    p.catch(() => { if (this.prefetch.get(key) === p) this.prefetch.delete(key); });
    this.prefetch.set(key, p);
  }

  /** PCM 跨曲的隐藏前置：当前曲稳定起播后，提前协商下一首的流。
   *  EOF 的 ending 事件只留出本地约 0.5~1s 尾音；取链 RTT 若到那时才开始，
   *  交叉淡化仍会被网络打进空档。只保留下一首一份预取，不扩成整队列缓存。 */
  private prefetchNextForCrossfade() {
    if (this.transport.kind !== "engine" || this.transport.mode !== "pcm") return;

    if (this.radioOn || this.mode === "one" || getFadeMs().outMs <= 0) return;

    const i = this.stepInOrder(1);

    if (i < 0) return;
    this.prefetchSong(this.queue[i]);
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
    // 本地/NAS 曲目：同源流（Range 在服务端处理），档位就是文件本身，别过 QQ 取链。
    // 顺手确保库快照在手（一次 GET，命中缓存零成本）：封面标记与刮削命中的 qqMid
    // 经 onLocalLibraryChange → refreshLocalCurrent 回填到当前曲目。
    if (isLocalSong(s)) {
      void loadLocalLibrary().catch(() => {});
      const l = localSongStreamUrl(s);

      return { url: l.url, tier: l.tier, label: l.label, degraded: false };
    }

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

  /** 右键「重新设置刮削信息」保存后原地补展示字段：队列里就是这些对象引用，
   *  播放条/正在播放页/队列面板跟着 notify 换字，不用等重进页面回读库。 */
  patchCurrentMeta(id: string, meta: { title: string; artist: string; album: string }) {
    const s = this.current;

    if (!isLocalSong(s) || s.local.id !== id) return;

    if (meta.title) { s.name = meta.title; s.title = meta.title; }

    if (meta.artist) s.singer = meta.artist.split(/\s*\/\s*/).filter(Boolean).map((name) => ({ name }));

    if (meta.album && s.album) s.album.name = meta.album;
    this.notify();
  }

  /** 拉取并解析当前歌曲歌词（startCurrent 内部调用；也供外部预热/测试）。
   *
   *  在线管线（官方曲目恒用；本地曲目仅在**刮削命中 QQ 曲库**（local.qqMid）时优先尝试）：
   *  一次请求顺带要逐字（qrc=1）—— 上游有 QRC 时 lyric 字段就是逐字内容，交给在位的
   *  逐字提供器（默认 = 宿主内置 AMLL，见 src/lyrics；插件注册了自己的提供器则顶掉它）
   *  解析成 karaoke 行 + 派生行级列表；提供器缺席（内置注册失败）、逐字解析失败或请求
   *  结果为空时回退普通 LRC 行级。
   *
   *  TTML 补刀（2026-10 [Lyrics] 设置引入）：**没有逐字内容**的歌才走一次逐字库查询
   *  （本地 TTML 歌词库 → 在线 TTML 数据库，顺序与开关见 pullTtml）。已有逐字（QRC）或
   *  用户手动导入了歌词的曲目一个请求都不发 —— TTML 是补齐逐字的能力，不是换掉既有来源的抢答。
   *  命中后逐字/行级都按 TTML 重解析；行级歌词没有逐字时间轴，会被 TTML 的词级时间轴升级。
   *
   *  本地通路（2026-10 与「本地音乐/NAS」同批引入，QRC 优先是用户明确要求）：
   *  在线拿不到内容（未刮削到 / sidecar 不可达 / 上游无词）才落回 /local/lyric ——
   *  服务端按「sidecar .lrc > 在线刮削缓存 > 内嵌歌词」合成。未匹配的本地曲目
   *  根本不发在线请求（mid 是 "local:…"，打到 /song 只会白吃一个 404），但本地 TTML 库
   *  可以按「歌名-歌手」文件名命中它 —— 这正是本地库为未刮削曲目准备的通路。
   *
   *  繁简转换（[Lyrics] ChineseConvert）：所有「文本进播放器」的口子（QRC/LRC/TTML/本地合成）
   *  在解析前过一次 cjkConvert；音译（罗马音/拼音）不转。原文缓存一律不动，档位关掉即回原样。 */
  async fetchLyric(s: Song) {
    const seq = ++this.lyricSeq;
    this.lyricState = "loading";
    this.notify();
    const local = isLocalSong(s) ? s.local : null;
    // 手动导入的歌词 = 用户显式意图，压过在线 QRC（在线命中是机器猜的，导入是人给的）。
    const qqMid = local ? (local.lyricImport ? "" : String(local.qqMid ?? "")) : s.mid;

    if (qqMid) {
      const has = await this.pullQqLyric(qqMid, seq, s);

      if (seq !== this.lyricSeq || this.current !== s) return; // 已被更新的 fetch 作废

      // 主歌词已拿到就先上屏；TTML 只是后台升级逐字，不能让镜像首字节延迟压在
      // 「歌词加载中」上（未命中实测 1–3s，旧代码到补刀返回才统一 notify）。
      if (has) this.notify();

      // 无逐字内容 → TTML 逐字补刀（导入件在上面已被排除，走不到这里）
      if (!this.karaoke.length && (await this.pullTtml(qqMid, seq, s))) {
        if (seq === this.lyricSeq && this.current === s) this.notify();

        return;
      }

      if (seq !== this.lyricSeq || this.current !== s) return;

      if (has || !local) { this.notify(); return; } // 官方曲目：在线就是唯一通路，拉不到=none（行为不变）
    } else if (local && !local.lyricImport) {
      // 未匹配 QQ 的本地曲：在线没有身份可用，TTML 只剩本地库的名字通路
      if (await this.pullTtml("", seq, s)) { this.notify(); return; }

      if (seq !== this.lyricSeq || this.current !== s) return;
    }

    // —— 本地通路 ——
    try {
      const d = await api<{ lyric: string; trans: string; roma: string; source: string; format?: string }>(`/local/lyric/${encodeURIComponent(local!.id)}`);

      if (seq !== this.lyricSeq || this.current !== s) return;
      const lyricC = await cjkConvert(String(d?.lyric ?? ""));
      const transC = await cjkConvert(String(d?.trans ?? ""));

      if (seq !== this.lyricSeq || this.current !== s) return; // 转换是惰性 async，别拿旧曲文本写新曲状态
      this.applyLyricText(lyricC, transC, String(d?.roma ?? ""), String(d?.format ?? "lrc"));
    } catch {
      if (seq === this.lyricSeq && this.lyricState === "loading") { this.karaoke = []; this.lyricState = "none"; }
    }

    this.notify();
  }

  /** 官方 QRC/LRC 拉取（官方曲目与「匹配到 QQ 的本地曲目」共用同一条管线）。
   *  返回「是否拿到了内容」；被更新的 fetch 作废时返回 true，让调用方直接收线。 */
  private async pullQqLyric(midRaw: string, seq: number, s: Song): Promise<boolean> {
    const mid = encodeURIComponent(midRaw);

    try {
      let d: any = await api(`/song/${mid}/lyric?trans=1&roma=1&qrc=1`);

      if (seq !== this.lyricSeq || this.current !== s) return true;

      if (!String(d?.lyric ?? "").trim()) {
        // qrc=1 下无逐字内容的歌曲可能整包为空 → 退回普通歌词请求再试一次
        d = await api(`/song/${mid}/lyric?trans=1&roma=1`);

        if (seq !== this.lyricSeq || this.current !== s) return true;
      }

      let raw = await cjkConvert(String(d?.lyric ?? ""));
      let trans = await cjkConvert(String(d?.trans ?? ""));
      let roma = String(d?.roma ?? ""); // 音译 = 拉丁转写，繁简转换不碰

      if (seq !== this.lyricSeq || this.current !== s) return true;
      const provider = sparkleKaraokeProvider();
      let kara = provider ? provider.parse(raw, trans, roma) : null;

      if (!kara && !/^\[\d{1,2}:/.test(raw)) {
        // 逐字解析失败（或无提供器）且内容不是行级 LRC（QRC XML / 纯文本 QRC / TTML
        // 都是 parseLrc 读不了的格式）→ 退回普通歌词请求，「停用逐字」时行级歌词仍有内容
        d = await api(`/song/${mid}/lyric?trans=1&roma=1`);

        if (seq !== this.lyricSeq || this.current !== s) return true;
        raw = await cjkConvert(String(d?.lyric ?? ""));
        trans = await cjkConvert(String(d?.trans ?? ""));
        roma = String(d?.roma ?? "");

        if (seq !== this.lyricSeq || this.current !== s) return true;
        kara = provider ? provider.parse(raw, trans, roma) : null;
      }

      if (kara?.length) {
        this.karaoke = kara;
        this.lyrics = karaokeToLines(kara);
        this.lyricState = "ok";
        this.lyricRevision++;

        return true;
      }

      this.karaoke = [];
      this.lyrics = parseLrc(raw, trans, roma);
      this.lyricState = this.lyrics.length ? "ok" : "none";
      this.lyricRevision++;

      return this.lyrics.length > 0;
    } catch {
      if (seq === this.lyricSeq) { this.karaoke = []; this.lyricState = "none"; this.lyricRevision++; }

      return false;
    }
  }

  /** TTML 逐字歌词补刀：仅在**没有逐字内容**时由 fetchLyric 调用。顺序 = 本地 TTML 歌词库
   *  （离线的、按 id/名字都能找，走 /local/ttml 让主进程按 [Lyrics] TtmlLibrary 现查）→
   *  在线 TTML 数据库（[Lyrics] OnlineTtml 开关 + TtmlDatabase 地址模板，%p=qq-lyrics、%s=songmid）。
   *  未命中记会话级负缓存（TTL 内同一首歌换档重进不再打服务器）；命中经繁简转换后按
   *  format="ttml" 统一应用。返回「是否命中」；被更新的 fetch 作废时返回 true 让调用方收线
   *  （与 pullQqLyric 同一约定）。 */
  private async pullTtml(mid: string, seq: number, s: Song): Promise<boolean> {
    const name = String(s.title || s.name || "").trim();
    const artist = (s.singer ?? []).map((x) => x?.name).filter(Boolean).join(",");

    // ① 本地 TTML 歌词库（目录未设置就一个请求都不发；渲染层看不见盘，路径真相在主进程的配置里）
    if (getTtmlLibrary()) {
      try {
        const qs = new URLSearchParams();

        if (mid) qs.set("qq", mid);

        if (name) qs.set("name", name);

        if (artist) qs.set("artist", artist);
        const d = await api<{ found?: boolean; text?: string }>(`/local/ttml?${qs.toString()}`);

        if (seq !== this.lyricSeq || this.current !== s) return true;

        if (d?.found && d.text) {
          const text = await cjkConvert(d.text);

          if (seq !== this.lyricSeq || this.current !== s) return true;
          this.applyLyricText(text, "", "", "ttml");

          if (this.lyrics.length) return true; // 坏文件（解不出行）：不锁死，继续走在线档
        }
      } catch { /* 库不可达/目录坏了：交回在线档，与本地通路同一「静默回落」语义 */ }
    }

    // ② 在线 TTML 数据库：要开关开启 + 有 QQ 歌曲身份（songmid）。行级 LRC 已在位时也放行 ——
    //    TTML 带词级时间轴，命中就是把行级升级成逐字，这正是本功能的主场景。
    if (!mid || !getOnlineTtml()) return false;
    const url = expandTtmlUrl(getTtmlDatabase(), "qq", mid);

    if (!url || ttmlMissCached(url)) return false;
    const raw = await fetchTtml(url);

    if (seq !== this.lyricSeq || this.current !== s) return true;

    if (!raw) { ttmlMissRemember(url); return false; }

    const text = await cjkConvert(raw);

    if (seq !== this.lyricSeq || this.current !== s) return true;
    this.applyLyricText(text, "", "", "ttml");

    return this.lyrics.length > 0;
  }

  /** 把一段歌词文本应用为当前歌词状态。解析三档：逐字提供器在场先归它
   *  （内置 AMLL 认 QRC XML/TTML/纯文本 QRC 与 [kana:] 注音，吃到词级时间轴）；
   *  解不出或提供器缺席 → parseLrc；仍是空且格式标是 qrc/ttml → coerceLyricToLrc 拍平成行级 LRC 再解一次
   *  （用户手动导入的歌词没有「在线再拉一次」可退，行级也必须出来）。 */
  private applyLyricText(raw: string, trans: string, roma: string, format = "lrc") {
    const provider = sparkleKaraokeProvider();
    const kara = provider && raw ? provider.parse(raw, trans, roma) : null;

    if (kara?.length) {
      this.karaoke = kara;
      this.lyrics = karaokeToLines(kara);
    } else {
      this.karaoke = [];
      this.lyrics = parseLrc(raw, trans, roma);

      if (!this.lyrics.length && raw && format !== "lrc") {
        this.lyrics = parseLrc(coerceLyricToLrc(raw, format), trans, roma);
      }
    }

    this.lyricState = this.lyrics.length ? "ok" : "none";
    this.lyricRevision++;
  }

  /** 库快照更新（扫描/自动刮削/手动导入落定）→ 正在播的本地曲目跟进新指纹：
   *  ① 刚刮到 qqMid 且此前无词 → 重拉一次（这回升级到在线 QRC 管线）；
   *  ② 封面从无到有/从有到无 → 原地更新标记并 notify（播放条/正在播放页据此换图）；
   *  ③ 歌词来源在「导入 ⇄ 自动」之间切换（右键导入/撤销导入）→ 无条件重拉。 */
  private refreshLocalCurrent() {
    const s = this.current;

    if (!isLocalSong(s)) return;
    const t = trackById(s.local.id);

    if (!t) return;
    const qqMid = t.match?.qqMid ?? "";
    const cover = !!t.coverRel;
    const lyricImport = t.lyricSource === "import";
    const importFlipped = s.local.lyricImport !== lyricImport;
    const midAppeared = !!qqMid && s.local.qqMid !== qqMid;
    s.local.qqMid = qqMid;
    s.local.hasCover = cover;
    s.local.lyricImport = lyricImport;

    if (importFlipped || (midAppeared && this.lyricState !== "ok")) void this.fetchLyric(s);
    // 快照落定就广播，**不按指纹相等早退**：重导封面是「同 id 原地换图」——指纹三个字段全不变，
    // 但 URL 已被 api.ts:bumpLocalCover 加了版本，tint/背景这些按 coverUrl 缓存的层要收到
    // 一次换曲级 notify 才会重取色（notify 4Hz 本来就在跑，多这一次不是成本）。
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
    if (this.current && isLocalSong(this.current)) { this.notify(); return; } // 本地文件无在线档位

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
  /** 当日洗牌序（缓存键 = 队列版本 + 日期键） */
  private dailyOrder(): number[] {
    const day = dayKey();
    const c = this.shuffleCache;

    if (c && c.ver === this.queueVersion && c.day === day) return c.order;
    const order = shuffleOrder(this.queue.length, daySeed(day));
    this.shuffleCache = { ver: this.queueVersion, day, order };

    return order;
  }

  /** 恒等顺序（0..n-1，缓存到队列长度变化为止）：非随机时它就是「播放顺序数组」，
   *  这样「走一步 / 走 N 步」两种模式共用同一套 step/walk，不必各写一份下标算术。 */
  private identityOrder: number[] = [];
  private orderOf(): number[] {
    // 电台固定按队列原序向前走：随机/单曲循环都不能打乱“每五首一轮”的边界。
    if (this.radioOn) {
      if (this.identityOrder.length !== this.queue.length) {
        this.identityOrder = Array.from({ length: this.queue.length }, (_, i) => i);
      }

      return this.identityOrder;
    }

    if (this.shuffle) return this.dailyOrder();

    if (this.identityOrder.length !== this.queue.length) {
      this.identityOrder = Array.from({ length: this.queue.length }, (_, i) => i);
    }

    return this.identityOrder;
  }

  /** 按当前播放顺序走一步（从当前曲出发），返回目标下标；-1 = 空队列。
   *  shuffle 开 → 当日洗牌顺序；关 → 队列原序。末位一律回绕（顺序播放档已移除）。 */
  private stepInOrder(dir: 1 | -1): number {
    if (!this.queue.length) return -1;

    return step(this.orderOf(), this.index, dir, true);
  }

  /** 播放顺序上的相邻下标（-1 = 没有）：随机播放时按当日洗牌序，与 stepInOrder 同源。
   *  正在播放页的封面流用它取左右邻曲 —— 别自己写 index±1（随机序下会指错歌）。 */
  neighbors(): { prev: number; next: number } {
    // 电台是单向流：左侧没有「上一首」，轮末也绝不回绕到本轮第一首。
    if (this.radioOn) {
      const next = this.index >= 0 && this.index + 1 < this.queue.length ? this.index + 1 : -1;

      return { prev: -1, next };
    }

    return { prev: this.stepInOrder(-1), next: this.stepInOrder(1) };
  }

  /**
   * 以当前曲为原点、按**播放顺序**偏移 offset 首（0 = 当前，1 = 下一首，-1 = 上一首，
   * 2 = 下下首）。随机播放时走当日洗牌序 —— 与 stepInOrder 同源，插件别自己算。
   *
   * 给「封面流」这类需要一整列邻曲的视图用：只有 prev/next 各一首时，
   * 切歌动画做不出「中间转出去 → 右边顶上 → 新的从右边转进来」的三段式
   * （第三张没有数据源，DOM 只能停在两张）。
   *
   * **回绕**（wrap=true）：与 stepInOrder / jumpToOffset 同一条语义 —— 队首的「上一首」
   * 就是队尾那首（顺序播放档已移除，播放推进一律回绕）。所以歌单**第一首**的左侧两格
   * 也有封面，点下去跳的正是那一首。这条必须与 jumpToOffset 口径一致：否则「取邻曲」
   * 说没有、而「跳过去」却回绕，封面流拿旧邻居表做的方向判定会当场失配（点了不滚格）。
   * 无限电台例外：只向前、不回绕 —— 负偏移恒为空，正向越过当前队列末尾也为空。
   * 只有队列为空才返回 undefined。
   */
  songAtOffset(offset: number): Song | undefined {
    if (!this.queue.length) return undefined;

    if (offset === 0) return this.current;

    if (!Number.isInteger(offset)) return undefined;

    if (this.radioOn) {
      if (offset < 0) return undefined;
      const i = this.index + offset;

      return i >= 0 && i < this.queue.length ? this.queue[i] : undefined;
    }

    const dir: 1 | -1 = offset > 0 ? 1 : -1;
    // walk 逐首前进、每步从上一步的落点继续。**别改成循环调 stepInOrder** ——
    // 它每次都从 this.index 出发，循环 N 次也只走一步，±2 会取回 ±1 那首
    // （封面流两侧各出现一对重复封面的根因，见 lib/shuffle.ts:walk 的注释）。
    const i = walk(this.orderOf(), this.index, Math.abs(offset), dir, true); // wrap：取邻曲与跳转同一条回绕语义

    return i < 0 ? undefined : this.queue[i]; // 只可能是空队列；下标越界由 walk 夹紧后不会发生
  }

  /** 跳到播放顺序上偏移 offset 首（0 = 当前即原地重播）。给封面流「点第几张跳第几首」用。
   *  无限电台只接受正向且未越过队列末尾的偏移，负偏移与回绕一律 no-op。 */
  jumpToOffset(offset: number) {
    if (!Number.isInteger(offset) || offset === 0) return;

    if (this.radioOn) {
      const i = this.index + offset;

      if (i < 0 || i >= this.queue.length) return;
      this.jump(i);

      return;
    }

    const dir: 1 | -1 = offset > 0 ? 1 : -1;
    const i = walk(this.orderOf(), this.index, Math.abs(offset), dir, true); // wrap：手动跳允许回绕

    if (i < 0) return;
    this.jump(i);
  }

  next(auto = false) {
    if (!this.queue.length) return;

    if (this.radioOn) {
      if (this.radioEnd < 0) return; // 首轮还没取回：旧队列不参与电台推进

      // 轮末还没等到下一轮时先挂起，绝不回绕到旧队列。
      if (this.index >= this.radioEnd && this.index >= this.queue.length - 1) {
        this.radioWaitingNext = true;
        this.maybeExtendRadio();

        return;
      }

      const i = this.index + 1;

      if (i >= this.queue.length) {
        this.radioWaitingNext = true;
        this.maybeExtendRadio();

        return;
      }

      this.jump(i);

      return;
    }

    if (auto && this.mode === "one") {
      this.transport.seek(0);

      if (this.transport.paused) void this.transport.play().catch(() => {});

      return;
    }

    // 手动/自然结束都走下一步：末位回绕到队首，与洗牌无关（顺序播放档已移除）
    const i = this.stepInOrder(1);

    if (i < 0) { this.notify(); return; }

    this.jump(i);
  }

  prev(force = false) {
    if (!this.queue.length) return;

    if (this.radioOn) return; // 无限电台屏蔽上一曲（按钮/热键/媒体键最终都落到这里）

    // 「上一首」逻辑（Playing.PrevReplay，设置页即时生效）：
    // replay=把当前曲从头重放（播放条双击走 force 直接切上一首）；previous=直接切到队列里的上一首。
    // force 只由播放条双击与媒体键/热键的连按判定传：单次动作永远按单击逻辑走
    if (!force && getPrevBehavior() === "replay") { this.transport.seek(0); return; }

    const i = this.stepInOrder(-1);

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
    this.setMode(this.mode === "all" ? "one" : "all");
  }

  /** 播放模式菜单用：直接落某一档（不再靠 cycleMode 推进，菜单点哪档就是哪档） */
  setMode(m: Mode) {
    if (this.radioOn) return; // 无限电台按固定轮次向前走，循环档不生效也不可改

    if (this.mode === m) return;
    this.mode = m;
    this.notify();
  }

  /** 随机播放开关。开着时按当日种子重排当日顺序 —— 因为种子只由日期决定，
   *  当天反复开关得到的都是同一套顺序（不会每次开关都换一批歌）。 */
  toggleShuffle() {
    if (this.radioOn) return; // 电台不支持随机播放
    this.shuffle = !this.shuffle;
    this.notify();
  }

  /** `immediate` 只给歌词行这类明确跳转：兼容模式跳过淡出，新 PCM 一到就出声。 */
  seek(sec: number, opts?: { immediate?: boolean }) {
    const d = this.transport.duration;

    if (d > 0) this.transport.seek(Math.max(0, Math.min(sec, d)), opts);
    this.notify();
  }

  seekSettled() { this.transport.seekSettled?.(); }

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

  /** 前台对账：轻量探针发现他端增删后，再走整单 loadLoved(true) 收敛红心与列表。
   *  探针比较「头部 20 首 + total」：手机端收藏/取消都会改变其一，没变就不搬整单数据。 */
  async refreshLovedFromRemote(): Promise<boolean> {
    if (this.likedFlight) return this.likedFlight;

    if (!this.likedCache) return this.loadLoved(true);

    try {
      const r: any = await api(`/user/liked?page=1&num=${LOVED_PROBE_PAGE}`);
      const head: Song[] = ((r?.songs ?? []) as Song[]).filter((s) => s?.mid);
      const probeLen = Math.min(this.likedCache.length, LOVED_PROBE_PAGE);

      const sameHead = head.length === probeLen
        && head.every((s, i) => s.mid === this.likedCache![i]?.mid);

      if (sameHead && Number(r?.total ?? 0) === this.likedTotal) {
        this.likedAt = Date.now(); // 确认远端没变：整单缓存重新算新鲜，避免进页白拉

        return true;
      }
    } catch (e) {
      console.warn("「我喜欢」远端探针失败（保留本地）", e);

      return false;
    }

    return this.loadLoved(true);
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

    if (isLocalSong(song)) return null; // 红心是 QQ 侧概念：本地曲目无在线收藏
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

    // 广播列表变更：新增行让打开中的我喜欢页立刻出现；移除由该页逐行淡出消化（src/views/liked.ts）
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
 *  （与 src/views/_shared.ts 的 sameMids 同义；player 不能反向 import songs.ts —— 会成环） */
function sameLovedOrder(a: Song[], b: Song[]) {
  return a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);
}

/** 逐字行 → 行级展示列表（逐字提供器缺位/解析失败回退时的行级视图，与 LRC 行为一致） */
function karaokeToLines(lines: SparkleKaraokeLine[]): LyricLine[] {
  const out: LyricLine[] = [];

  for (const l of lines) {
    const text = l.words.map((w) => w.word).join("").trim();

    if (!text) continue;
    out.push({
      t: l.startTime / 1000,
      text,
      trans: l.translatedLyric?.trim() || undefined,
      roma: l.romanLyric?.trim() || undefined,
    });
  }

  return out;
}

// 开发/自动化测试钩子：shell 挂载时暴露单例（生产构建里 vite define 会剔除）
declare global { interface Window { __quaverPlayer?: Player } }

if (import.meta.env?.DEV) window.__quaverPlayer = player;
