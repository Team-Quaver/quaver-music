// Quaver — 主进程音频引擎（mpv 后端）。
// 真相归属：位置/时长/播放态/缓冲归引擎（这里）；曲目/队列/循环/随机归渲染层（player.ts）。
// 渲染层经 preload 桥（quaverAudio.invoke / quaverAudio.onEvent）驱动；MPRIS 快照仍由渲染层
// 合成推送（daemon 协议不动），位置源在两条传输下都收敛到 player.time —— 同一时刻只有一个位置来源。
//
// 生命周期：mpv 惰性拉起（boot/load/device 等需要它的命令触发），idle 常驻换曲不重启；
// 崩溃后引擎标记 dead 并复位，下一次命令自动重拉（重试语义交给播放器的错误态，不无限自愈）。
import { app, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveMpv } from "./bins.mjs";
import { MpvIpc } from "./mpv-ipc.mjs";

const POS_BROADCAST_MS = 250; // 位置广播节流：4Hz 足够渲染层外推出平滑进度/歌词
// 看门狗脚本：父进程（本进程）无论怎么死，mpv 都会被它杀掉（注销/崩溃时 will-quit 跑不到）
const WATCHDOG_SCRIPT = fileURLToPath(new URL("./mpv-watchdog.mjs", import.meta.url));

/** 随包音频运行时根目录：打包态 = extraResources 的 <resources>/audio；开发态 = ui/build-res/audio
 *  （CI 在打包前用 ui/scripts/stage-mpv.sh 解 mpv AppImage 到这里；本地留空则回落系统 mpv）。
 *  QUAVER_AUDIO_DIR 可显式顶掉（排障/自检：拿另一份解好的运行时跑）。 */
function bundledAudioRoot() {
  if (process.env.QUAVER_AUDIO_DIR) return process.env.QUAVER_AUDIO_DIR;
  return app?.isPackaged
    ? join(process.resourcesPath ?? "", "audio")
    : fileURLToPath(new URL("../../build-res/audio", import.meta.url));
}

/** @typedef {{pos:number, dur:number, paused:boolean, buffering:boolean, idle:boolean, volume:number, muted:boolean}} EngineState */

export class AudioEngine {
  constructor() {
    this.baseUrl = "";                 // 渲染层服务 origin（load 传相对 URL 时绝对化用）
    this.getWin = () => null;          // 当前 BrowserWindow getter（CSD 重建窗口后引用会换）
    this.log = () => {};
    this.mpv = null;                   // MpvIpc 实例（null = 未拉起/已死）
    this.starting = null;              // 拉起中的 promise（并发去重）
    this.watchdog = null;              // mpv 看门狗子进程（父进程死亡时由它送 mpv 陪葬）
    this.bin = undefined;              // undefined = 未探测；null = 找不到；{path,source} = 命中
    /** @type {EngineState} */
    this.st = { pos: 0, dur: 0, paused: true, buffering: false, idle: true, volume: 0.8, muted: false };
    this.device = "auto";              // 音频设备（renderer 持久化，引擎记住以便 respawn 后复用）
    this.lastUrl = "";                 // 最近挂过的流（eof 后 idle 重挂用）
    // —— 淡入淡出：用 mpv `volume` 属性做振幅包络（afade 要掐流时间位置，切歌/暂停场景不好用）——
    // fadeLevel 是乘在用户音量上的瞬时包络；fadeTarget 记住方向（0=正在/将要淡出），
    // 「淡出完成后要执行的动作」放 pendingAfterFadeOut —— 任何更新的播放意图都会把它作废，
    // 否则切歌时那个延迟的 stop 会把刚 loadfile 的新歌掐掉。
    this.fade = { inMs: 400, outMs: 250 };
    this.fadeLevel = 1;
    this.fadeTarget = 1;
    this.fadeTimer = null;
    this.pendingAfterFadeOut = null;
    this.lastPosSent = 0;
    this.wired = false;
  }

  /** main.mjs 在窗口 URL 确定后调用（幂等：重复调用只刷新 baseUrl/窗口引用） */
  init({ baseUrl, getWin, log }) {
    if (baseUrl) this.baseUrl = baseUrl;
    if (getWin) this.getWin = getWin;
    if (log) this.log = log;
    if (!this.wired) {
      this.wired = true;
      ipcMain.handle("quaver:audio", (_e, cmd) => this.onInvoke(cmd).catch((e) => ({ ok: false, error: String(e?.message ?? e) })));
    }
  }

  send(ev) {
    const wc = this.getWin()?.webContents;
    if (wc && !wc.isDestroyed()) { try { wc.send("quaver:audio-event", ev); } catch (e) { this.log("[audio] send failed:", String(e)); } }
  }

  /** 位置类变化节流广播；离散变化（暂停/缓冲/时长/idle）立即广播 */
  pushState(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPosSent < POS_BROADCAST_MS) return;
    this.lastPosSent = now;
    const { pos, dur, paused, buffering, idle } = this.st;
    this.send({ t: "state", pos, dur, paused, buffering, idle });
  }

  // —— 淡入淡出 ——

  /** 音量面板 = 用户目标音量 × 淡入淡出包络（静音走 mpv 自己的 mute 属性，不在这里相乘）。
   *  mpv 未运行时不做事：目标值会在 spawn 时随参数落地。 */
  applyVolume() {
    if (!this.mpv || this.mpv.dead) return;
    const v = this.st.volume * this.fadeLevel * 100;
    void this.mpv.setProp("volume", Math.round(v * 100) / 100).catch(() => {});
  }

  /** 把包络推向 level（线性，30ms 步进）。`after` 三态：
   *    undefined = 保持现有待执行动作（finishFadeOut 用：把淡出提前收尾但照旧执行）；
   *    null      = 清掉（新意图接管，如切歌 load 作废旧 stop）；
   *    fn        = 替换为它（到点后执行）。
   *  淡入（level=1）一律清空待执行动作 —— 回升就意味着「不暂停/不停止」了。 */
  rampTo(level, ms, after) {
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
    this.fadeTimer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      this.fadeLevel = from + (level - from) * k;
      this.applyVolume();
      if (k >= 1) { clearInterval(this.fadeTimer); this.fadeTimer = null; settle(); }
    }, 30);
    this.fadeTimer.unref?.();
  }

  /** 淡出途中收到 seek（MPRIS Stop = pause + seek(0)）时把淡出立刻收尾：
   *  否则会先听见 250ms 的歌头再静音。 */
  finishFadeOut() {
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
    this.rampTo(0, this.fade.outMs, () => { void mpv.setProp("pause", true).catch(() => {}); });
  }

  findBin() {
    if (this.bin === undefined) this.bin = resolveMpv({ bundledRoot: bundledAudioRoot() });
    return this.bin;
  }

  /** 给 mpv 配看门狗：spawn 一个 ELECTRON_RUN_AS_NODE 的小进程，stdin 管道写端握在
   *  本进程手里 —— 父进程无论以何种方式死亡（正常退出/崩溃/SIGKILL/注销），管道断 →
   *  看门狗 SIGKILL mpv。兜 will-quit 跑不到的场景（注销时 mpv 成孤儿继续放歌）。 */
  armWatchdog(mpv) {
    this.stopWatchdog();
    const pid = mpv.child?.pid ?? 0;
    if (!pid) return;
    try {
      const wd = spawn(process.execPath, [WATCHDOG_SCRIPT, String(pid)], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      wd.unref();          // 不挡主进程退出
      wd.stdin?.unref?.(); // 管道写端同理（unref 只摘事件循环引用，fd 仍握着不断开）
      this.watchdog = wd;
      this.log("[audio] watchdog armed, mpv pid", pid);
    } catch (e) {
      this.log("[audio] watchdog arm failed:", String(e));
    }
  }

  stopWatchdog() {
    const wd = this.watchdog;
    this.watchdog = null;
    if (!wd) return;
    try { wd.stdin?.end(); } catch {}
    try { wd.kill(); } catch {}
  }

  /** 拉起（或复用）mpv。返回 MpvIpc。失败抛错。 */
  async ensureStarted() {
    if (this.mpv && !this.mpv.dead) return this.mpv;
    if (this.starting) return this.starting;
    const found = this.findBin();
    if (!found) throw new Error("未找到 mpv 可执行文件（可用 QUAVER_MPV 指定路径）");
    this.starting = (async () => {
      // 排障口子：QUAVER_MPV_ARGS 追加 mpv 参数（空白分隔，如 "--ao=null"；测试/无声环境用）
      const extraArgs = (process.env.QUAVER_MPV_ARGS ?? "").split(/\s+/).filter(Boolean);
      const mpv = new MpvIpc(found.argv, {
        log: this.log,
        volume: this.st.volume * this.fadeLevel, // 带上包络：重拉时若正处于淡出/淡入中途，别一上来就满音量
        muted: this.st.muted,
        audioDevice: this.device,
        extraArgs,
      });
      await mpv.start();
      // —— 状态观察（id 与 mpv-ipc 无耦合，仅作 property-change 归属）——
      await mpv.observe(1, "time-pos");
      await mpv.observe(2, "duration");
      await mpv.observe(3, "pause");
      await mpv.observe(4, "paused-for-cache");
      await mpv.observe(5, "idle-active");
      // 播种一次真实状态：mpv 只在属性「变化」时推 property-change，
      // 初值若与我们默认值重合就永远收不到事件（实测 pause 默认 false 而引擎默认 true → 状态永远错位）。
      const seed = await this.readState(mpv);
      this.st = { ...this.st, ...seed };
      mpv.eventCb = (ev) => this.onMpvEvent(ev);
      mpv.exitCb = () => this.stopWatchdog(); // mpv 没了看门狗也就没用了，别留驻
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
  async readState(mpv) {
    const pick = async (prop, dflt) => {
      try {
        const v = await mpv.getProp(prop);
        return v === null || v === undefined ? dflt : v;
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

  onMpvEvent(ev) {
    if (ev.event === "property-change") {
      const d = ev.data;
      switch (ev.id) {
        case 1: // time-pos（idle 时为 null）
          this.st.pos = typeof d === "number" && isFinite(d) ? d : 0;
          this.pushState();
          break;
        case 2:
          this.st.dur = typeof d === "number" && isFinite(d) ? d : 0;
          this.pushState(true);
          break;
        case 3:
          this.st.paused = !!d;
          this.pushState(true);
          break;
        case 4:
          this.st.buffering = !!d;
          this.pushState(true);
          break;
        case 5:
          this.st.idle = !!d;
          if (this.st.idle) { this.st.pos = 0; this.st.dur = 0; this.st.buffering = false; this.st.paused = true; }
          this.pushState(true);
          break;
      }
      return;
    }
    switch (ev.event) {
      case "file-loaded":
        this.st.idle = false;
        this.st.buffering = false;
        // 真正出声的这一刻开始淡入（loadfile 被接受到 file-loaded 之间是静音窗口）
        if (!this.st.paused) this.rampTo(1, this.fade.inMs);
        this.pushState(true);
        break;
      case "end-file":
        // stop 命令也发 end-file(reason=stop)：那是我们自己打断，不是自然播完
        if (ev.reason === "eof") {
          this.st.paused = true; // mpv eof 后回 idle，pause 属性回落
          this.send({ t: "ended" });
          this.pushState(true);
        } else if (ev.reason === "error") {
          this.send({ t: "error", message: `mpv 播放失败：${ev.file_error ?? ev.reason}` });
        }
        break;
      case "__exit__":
        this.log("[audio] mpv exited:", ev.code);
        this.mpv = null;
        this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
        this.send({ t: "dead", message: "mpv 进程退出（下一次操作将自动重启它）" });
        break;
    }
  }

  /** 渲染层给的可能是相对路径（/api/stream/...）——mpv 是独立进程，必须绝对化。
   *  vkey/token 依旧只出现在这条本机中继 URL 里，不进命令行与参数。 */
  absolutize(url) {
    if (/^https?:\/\//i.test(url)) return url;
    if (!this.baseUrl) throw new Error("音频引擎未初始化（baseUrl 缺失）");
    return new URL(url, this.baseUrl).href;
  }

  async onInvoke(cmd) {
    switch (cmd?.cmd) {
      case "status": {
        const found = this.findBin();
        const running = this.mpv && !this.mpv.dead;
        return {
          ok: true, backend: "mpv",
          available: !!found,
          reason: found ? "" : "未找到 mpv（安装 mpv、设置 QUAVER_MPV，或用随包运行时）",
          source: found?.source ?? "",          // env | bundled | path
          payload: found?.payload ?? "",
          version: running ? this.mpv.mpvVersion : "",
          running: !!running,
          device: this.device,
        };
      }
      case "boot":
        await this.ensureStarted();
        return { ok: true, version: this.mpv.mpvVersion };
      case "snapshot": {
        // 渲染层接管用（CSD/SSD 重建窗口后的新页面）：引擎的真实播放态 + 现挂的流 URL。
        // 引擎活在渲染层之外，窗口拆掉它还在放 —— 新页面问一次就知道「正在放哪条流、放到哪」，
        // 直接接管而不是重新挂流（重新挂会 replace 掉正在放的歌）。
        const running = !!this.mpv && !this.mpv.dead;
        return {
          ok: true, backend: "mpv", running,
          pos: this.st.pos, dur: this.st.dur,
          paused: this.st.paused, buffering: this.st.buffering, idle: this.st.idle,
          url: running ? this.lastUrl : "",
        };
      }
      case "load": {
        const mpv = await this.ensureStarted();
        const url = this.absolutize(String(cmd.url ?? ""));
        if (!url) return { ok: false, error: "missing url" };
        // 包络压到 0：新流出声即从静音起步（file-loaded 后再淡入）。
        // 已经在淡出就沿用剩余时长继续降；null = 作废「淡出后 stop」——切歌时那个 stop 会把新歌掐掉。
        this.rampTo(0, this.fadeTarget === 0 ? this.fade.outMs : 0, null);
        // 播放态意图先落到引擎状态，再显式置 mpv pause（loadfile 默认自动开播）：
        // 显式置位还有个副作用是必发 property-change —— 上一次 stop/eof 留下的 pause 分歧靠它收敛。
        const paused = !!cmd.paused;
        this.st.paused = paused;
        this.st.buffering = true; // loadfile 被接受 → 到 file-loaded 之间算缓冲
        this.st.idle = false;
        this.pushState(true);
        await mpv.setProp("pause", paused);
        await mpv.command(["loadfile", url, "replace"]);
        this.lastUrl = url;
        return { ok: true };
      }
      case "play": {
        const mpv = await this.ensureStarted();
        this.st.paused = false; // 意图先落地（mpv 只在变化时推事件，值相同则不推）
        this.pushState(true);
        await mpv.setProp("pause", false);
        // eof 后 mpv 回 idle 会卸载文件：按上一次 URL 重挂（单曲循环/播完再点播放）。
        // 判据实查 mpv（不信缓存的 idle 态）：渲染层的 ended→play 往返可能快过 idle-active 事件落库。
        const idleNow = await mpv.getProp("idle-active").catch(() => this.st.idle);
        this.st.idle = !!idleNow;
        if (this.st.idle && this.lastUrl) {
          this.st.buffering = true;
          this.st.idle = false;
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
        this.st.paused = true;
        this.pushState(true);
        // 先淡出、到 0 再真停；期间若来了新歌（load 会作废这一步）就交给它接管
        this.rampTo(0, this.fade.outMs, () => {
          void mpv.command(["stop"]).catch(() => {});
          this.st = { ...this.st, pos: 0, dur: 0, paused: true, buffering: false, idle: true };
          this.pushState(true);
        });
        return { ok: true };
      }
      case "seek": {
        if (!this.mpv || this.mpv.dead) return { ok: false, error: "mpv not running" };
        const sec = Number(cmd.sec);
        if (!isFinite(sec)) return { ok: false, error: "bad sec" };
        this.finishFadeOut(); // 淡出途中 seek（MPRIS Stop）：马上收尾，别听见歌头再静音
        await this.mpv.command(["seek", Math.max(0, sec), "absolute"]);
        this.st.pos = Math.max(0, sec); // 乐观位置：state 事件马上会对齐
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
        if (this.mpv && !this.mpv.dead) await this.mpv.setProp("mute", !!cmd.value).catch(() => {});
        return { ok: true };
      }
      case "fade": {
        const clamp = (n) => Math.max(0, Math.min(3000, Math.round(Number(n) || 0)));
        this.fade = { inMs: clamp(cmd.inMs), outMs: clamp(cmd.outMs) };
        // 关掉淡入淡出时别把音量卡在半路上（只在淡入方向兜底；淡出途中说明有 pending 动作，别打断）
        if (!this.fade.inMs && !this.fade.outMs && this.fadeTarget === 1 && this.fadeLevel < 1) this.rampTo(1, 0);
        return { ok: true, fade: this.fade };
      }
      case "devices": {
        const mpv = await this.ensureStarted();
        const [list, current] = await Promise.all([mpv.getProp("audio-device-list"), mpv.getProp("audio-device")]);
        return {
          ok: true,
          current: String(current ?? "auto"),
          devices: (Array.isArray(list) ? list : []).map((d) => ({ id: String(d.name), desc: String(d.description ?? d.name) })),
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
   *  main.mjs 的 SIGTERM 接管）都会走这里；幂等。 */
  shutdown() {
    this.stopWatchdog();
    try { this.mpv?.kill(); } catch {}
    this.mpv = null;
  }
}

export const audioEngine = new AudioEngine();
