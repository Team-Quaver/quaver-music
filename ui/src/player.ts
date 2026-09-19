// Quaver — 全局播放器状态机（常驻于 SPA 壳层，跨视图不销毁，音频不中断）
// 订阅式：任何状态变化 notify 所有 UI（播放条 / 正在播放页 / 队列面板）。
// 音频走 Transport 抽象（src/lib/transport.ts）：默认 mpv 原生引擎（Electron 壳层），
// 可选浏览器 <audio> 兜底；曲目/队列/循环/歌词归本层，位置/时长/播放态真相在传输层。
import { api, postJson, coverUrl, resolveStreamUrl, effectiveQuality, getSessionQuality, setSessionQuality, setLastStream, writeSongType, type StreamResult } from "./lib/api";
import {
  getDecode, setDecode, getAudioDevice, setAudioDevice, setFade, FADE_PRESETS,
  getVolume as getVolumeConf, setVolume as setVolumeConf,
  getMuted as getMutedConf, setMuted as setMutedConf,
  getShowTrans, setShowTrans,
  type DecodeBackend, type FadePreset,
} from "./lib/prefs";
import { WebTransport, EngineTransport, type Transport, type TransportEvent, type AudioDeviceInfo } from "./lib/transport";
import { loadSession, saveSession } from "./lib/session";
import { parseLrc, type LyricLine } from "./lyric";

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

// 「我喜欢」(dirid=201) 预载：每页条数 + 总上限（防超大歌单一口气拉爆首屏），
// 以及预载结果的新鲜期——期内视图直接吃缓存，过期才回源对账。
// 页尽量大：上游分页读带缓存，跨页拼接偶发「页码错位少一首」，单请求拿全最稳（500 首 ≈ 700KB）。
const LOVED_PAGE = 500;
const LOVED_MAX = 1000;
const LOVED_TTL = 60_000;

// 会话存档（队列 + 指针 + 位置 + 循环模式）节流：notify 是 4Hz 的，不能跟着写盘。
const SESSION_EVERY = 5000;

class Player {
  private transport: Transport = new WebTransport();
  queue: Song[] = [];
  index = -1;
  mode: Mode = "all";
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
  lyrics: LyricLine[] = [];
  lyricState: "idle" | "loading" | "ok" | "none" = "idle";
  loading = false; // 正在取链/缓冲（UI 画加载指示）
  expanded = false; // 正在播放页是否展开
  queueOpen = false;
  showTrans = getShowTrans(); // 歌词翻译显示开关（quaver.conf [Style] ShowTranslation，默认开）
  /** 实际生效后端（"mpv"=原生引擎；"web"=浏览器 <audio>） */
  backend: ActiveBackend = "web";
  /** 后端不可用/回退原因（设置页提示；空 = 正常） */
  backendNotice = "";
  /** 引擎（mpv）版本串；未拉起时为空 */
  engineVersion = "";
  private _vol = 0.8;    // 0..1（静音前保留）
  private _muted = false;
  private listeners = new Set<Listener>();
  private lyricSeq = 0;
  private playSeq = 0;   // startCurrent 竞态令牌：换曲即作废上一轮
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
        break;
      case "canplay":
        if (this.loading && !this.transport.paused) { this.loading = false; this.notify(); }
        break;
      case "ended":
        this.onEnded();
        break;
      case "error":
        // src 加载/解码失败（含 token 过期、上游断流、mpv 退出）→ 可重试错误态，避免永久转圈
        if (!this.current || !this.transport.src) return;
        this.loading = false;
        this.error = e.message || "音频流加载失败，可能已过期：再次点击播放或换一首";
        this.notify();
        break;
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
    this.savedPos = snap.position;
    this.notify();
    this.sessionReady = true;
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
    saveSession({ queue: this.queue, index: this.index, position: this.posForSave(), mode: this.mode });
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
    void this.startCurrent();
  }

  /** 插队播放：把这首插到**当前曲之后**就完事 —— 当前曲继续放，下一首轮到它。
   *  语义是「排进队列的下一位」，**不是**打断当前曲立刻切过去；搜索页双击、右键菜单
   *  「插队播放」共用这一条（试听不打断自己正在放的整张列表）。
   *  队列还空着（没播过任何东西）时没有「下一首」可言，退化成单曲起播。 */
  enqueueNext(song: Song) {
    if (!song?.mid) return;
    if (this.index < 0 || !this.queue.length) { this.playList([song], 0); return; }
    this.queue.splice(this.index + 1, 0, song);
    this.notify();
  }

  /** 从队列移除第 i 首。删除的是当前曲：停流停在原地（指针落到同槽位的下一首），不自动续播；
   *  删当前曲之前的歌：指针前移；删之后的歌：指针不动。 */
  removeAt(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    const cur = this.index;
    this.queue.splice(i, 1);
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
    try { this.transport.stop(); } catch { /* noop */ }
  }

  private async startCurrent(resumeTo = 0, autoplay = true) {
    const s = this.current;
    this.interrupt();
    this.lyrics = [];
    this.lyricState = "idle";
    if (!s) { this.notify(); return; }
    this.loading = true;
    this.notify();
    const seq = this.playSeq;
    try {
      await this.backendInit; // 首播发生在启动后端检查完成前：等检查定再挂流
      if (seq !== this.playSeq || this.current !== s) return; // 期间又切了歌：本轮作废
      const r = await this.getStream(s); // 命中单击预取的链接 → 直接跳过取链
      if (seq !== this.playSeq || this.current !== s) return;
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
        this.error = String(e?.message ?? e);
      }
    }
    if (seq === this.playSeq && this.current === s) this.fetchLyric(s); // 被作废的轮次不拉歌词，防竞态覆盖
    this.notify();
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
    const p = resolveStreamUrl(song, q as any);
    p.catch(() => { if (this.prefetch.get(key) === p) this.prefetch.delete(key); });
    this.prefetch.set(key, p);
  }

  /** getPlayUrl 语义的内部入口：预取命中用预取结果，否则现场协商 */
  private async getStream(s: Song): Promise<StreamResult> {
    const q = String(effectiveQuality());
    const hit = this.prefetch.get(q + "|" + s.mid);
    this.prefetch.clear(); // 用后即弃：链接是一次性上下文（会员/曲库状态可能变化），不跨切歌复用
    if (hit) {
      try { return await hit; } catch { /* 预取失败 → 现场重来 */ }
    }
    return resolveStreamUrl(s, q as any);
  }

  error = "";

  /** 拉取并解析当前歌曲歌词（startCurrent 内部调用；也供外部预热/测试） */
  async fetchLyric(s: Song) {
    const seq = ++this.lyricSeq;
    this.lyricState = "loading";
    this.notify();
    try {
      const d: any = await api(`/song/${encodeURIComponent(s.mid)}/lyric?trans=1`);
      if (seq !== this.lyricSeq) return;
      const lines = parseLrc(d?.lyric ?? "", d?.trans ?? "");
      // 纯音乐占位行（"[00:00.00]此歌曲为没有填词…"）也照常显示
      this.lyrics = lines;
      this.lyricState = lines.length ? "ok" : "none";
    } catch {
      if (seq === this.lyricSeq) this.lyricState = "none";
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

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.mode === "one") {
      this.transport.seek(0);
      if (this.transport.paused) void this.transport.play().catch(() => {});
      return;
    }
    this.jump((this.index + 1) % this.queue.length);
  }

  prev() {
    if (!this.queue.length) return;
    if (this.time > 3) { this.transport.seek(0); return; }
    this.jump((this.index - 1 + this.queue.length) % this.queue.length);
  }

  private onEnded() {
    this.error = "";
    if (this.mode === "off" && this.index === this.queue.length - 1) { this.notify(); return; }
    this.next(true);
  }

  cycleMode() {
    this.mode = this.mode === "off" ? "all" : this.mode === "all" ? "one" : "off";
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
      const mids = new Set<string>();
      for (const s of all) {
        if (!s?.mid) continue;
        mids.add(s.mid);
        if (s.id) this.lovedRef.set(s.mid, { id: s.id, type: s.type ?? 1 }); // 存读侧原值，写时再转写侧枚举
      }
      if (all.length >= total) this.loved = mids;
      else for (const m of mids) this.loved.add(m);
      this.likedCache = all;
      this.likedTotal = total || all.length;
      this.likedAt = Date.now();
      this.loveVersion++;
      this.persistLoved();
      this.notify();
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

  /** 切换单曲收藏（红心）：乐观更新、失败回滚，返回写接口终态（null = 缺少 song_id 无从下手）。
   *  取消收藏同样走在线 unlike 接口，「我喜欢」缓存同步移出该曲。 */
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
      await postJson(on ? "/song/like" : "/song/unlike",
        { song_id: ref.id, song_type: writeSongType(ref.type) });
    } catch (e: any) {
      console.warn("收藏同步失败", e);
      this.setLoved(mid, !on, ref); // 回滚
      this.error = "收藏失败：" + (e?.message ?? e);
      this.notify();
      return !on;
    }
    // 缓存与列表计数跟进（写接口已确认，视图据此即时自洽）
    if (on) {
      if (this.likedCache && !this.likedCache.some((x) => x.mid === mid)) this.likedCache.unshift(song!);
      this.likedTotal++;
    } else {
      if (this.likedCache) this.likedCache = this.likedCache.filter((x) => x.mid !== mid);
      if (this.likedTotal > 0) this.likedTotal--;
    }
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

// 开发/自动化测试钩子：shell 挂载时暴露单例（生产构建里 vite define 会剔除）
declare global { interface Window { __quaverPlayer?: Player } }
if (import.meta.env?.DEV) window.__quaverPlayer = player;
