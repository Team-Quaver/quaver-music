// Quaver — mpv JSON IPC 客户端（libmpv 的 --input-ipc-server 线协议）。
// 线协议：unix socket 上每行一个 JSON。
//   我方请求  {"command":["loadfile","<url>","replace"],"request_id":N}
//   mpv 应答  {"error":"success","data":...,"request_id":N}
//   mpv 事件  {"event":"property-change","id":1,"name":"time-pos","data":...}
//             {"event":"end-file","reason":"eof"|"stop"|"error"|...}
//
// 安全口径：播放 URL（/api/stream/<token>）只经 socket 传输，绝不进 mpv 命令行参数
// （命令行对同机所有用户可见，token 虽 2h 过期也不该晒在 ps 里）。
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** socket 就绪轮询上限：mpv 冷启动通常 <100ms，5s 足够兜极端机器 */
const SOCK_WAIT_MS = 5000;

/**
 * @param {string[]} argv 完整 spawn argv（argv[0] = 可执行文件）。随包运行时时是
 *   `[包内 loader, "--library-path", <lp>, <载荷>]` 的形式（见 bins.mjs），mpv 参数接在其后。
 * @param {{
 *   log?: (…a: any[]) => void,
 *   volume?: number,        // 0..1，映射 mpv volume 0..100
 *   muted?: boolean,
 *   audioDevice?: string,   // mpv audio-device（"auto" = 系统默认）
 *   extraArgs?: string[],   // 追加参数（测试用 --ao=null 等）
 * }} opts
 */
export class MpvIpc {
  constructor(argv, opts = {}) {
    if (!Array.isArray(argv) || !argv.length) throw new Error("MpvIpc: argv 不能为空");
    this.argv = argv;
    this.bin = argv[0];
    this.log = opts.log ?? (() => {});
    this.volume = opts.volume ?? 0.8;
    this.muted = !!opts.muted;
    this.audioDevice = opts.audioDevice || "auto";
    this.extraArgs = opts.extraArgs ?? [];
    this.child = null;
    this.sock = null;
    this.sockDir = null;
    this.reqId = 0;
    /** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
    this.pending = new Map();
    this.buf = "";
    this.eventCb = null;
    this.dead = false;
    this.exitCb = null;
  }

  /** 拉起 mpv 并连上 IPC socket。失败抛错（调用方决定报错/回落）。 */
  async start() {
    if (this.dead) throw new Error("mpv already dead");
    this.sockDir = mkdtempSync(join(tmpdir(), "quaver-mpv-"));
    const sockPath = join(this.sockDir, "ipc.sock"); // socket 是 0 字节，tmpfs 大小无关紧要

    const args = [
      // 受控子进程：不吃用户 ~/.config/mpv 的 mpv.conf / 自动加载的脚本 ——
      // 用户配置能直接把我们搞坏（no-audio、自定义 vo、ytdl=yes…），本项目里音频/设备全由我们显式下发。
      "--no-config",
      "--load-scripts=no",
      "--idle=yes",                 // 常驻：换曲不重启进程
      "--no-terminal",              // 不占 tty
      "--no-video",                 // 纯音频
      "--audio-display=no",
      `--input-ipc-server=${sockPath}`,
      // —— 缓存：有上限的滑动窗口，纯内存，绝不落盘（合规线：不做整曲持久化）——
      "--cache-on-disk=no",
      "--demuxer-max-bytes=32MiB",  // 前向窗口
      "--demuxer-max-back-bytes=64MiB", // 回看窗口（seek 回退不必重新拉全流）
      // —— 断流韧性：上游 CDN 抖动时 ffmpeg http 层自动重连，别直接判死 ——
      "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=2",
      "--network-timeout=15",
      // —— 行为对齐 web <audio> 管线 ——
      "--gapless-audio=no",         // 每曲独立 ended 事件（循环/切歌逻辑吃这个）
      "--ytdl=no",                  // 别让 ytdl_hook 碰 http URL
      `--volume=${Math.round(Math.min(1, Math.max(0, this.volume)) * 100)}`,
      `--mute=${this.muted ? "yes" : "no"}`,
      `--audio-device=${this.audioDevice}`,
      ...this.extraArgs,
    ];
    this.log("[audio] spawning mpv:", this.bin, this.argv.length > 1 ? "(bundled runtime)" : "");
    const child = spawn(this.bin, [...this.argv.slice(1), ...args], { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => this.log("[mpv]", String(d).trimEnd()));
    const exited = new Promise((_, rej) => child.once("exit", (c) => rej(new Error(`mpv exited early: ${c}`))));

    // 等 socket 出现（mpv 起来才创建）；期间进程死了要立刻知道
    const deadline = Date.now() + SOCK_WAIT_MS;
    while (!existsSync(sockPath)) {
      if (child.exitCode !== null) throw new Error(`mpv exited early: ${child.exitCode}`);
      if (Date.now() > deadline) {
        try { child.kill(); } catch {}
        throw new Error("mpv IPC socket 超时未就绪");
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 50))]);
    }

    await new Promise((resolve, reject) => {
      const s = connect(sockPath, () => resolve());
      s.on("error", reject);
      this.sock = s;
    });
    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk) => this.onData(chunk));
    this.sock.on("close", () => this.onSockClose());
    this.sock.on("error", (e) => this.log("[audio] sock error:", String(e)));
    child.once("exit", (code) => {
      this.dead = true;
      this.rejectAll(new Error(`mpv exited: ${code}`));
      try { this.sock?.destroy(); } catch {}
      this.eventCb?.({ event: "__exit__", code });
      this.exitCb?.(code);
      this.cleanup(); // socket 目录随进程退出回收
    });

    // 主动摸一把 get_version：既验证协议通了，也拿到版本串给设置页展示
    this.mpvVersion = String(await this.command(["get_property", "mpv-version"]));
    return this;
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error === "success") p.resolve(msg.data);
        else p.reject(new Error(`mpv: ${msg.error}`));
      } else if (msg.event) {
        this.eventCb?.(msg);
      }
    }
  }

  rejectAll(e) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  onSockClose() {
    this.dead = true; // socket 断开视同实例作废（进程退出/IPC 关闭都会走到这里）
    this.rejectAll(new Error("mpv IPC socket closed"));
  }

  /** 发一条命令，返回 data（error 非 success 时 reject）。dead 时 reject。 */
  command(args, timeoutMs = 8000) {
    if (this.dead || !this.sock?.writable) return Promise.reject(new Error("mpv not running"));
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv command timeout: ${args[0]}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.sock.write(JSON.stringify({ command: args, request_id: id }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  observe(id, prop) { return this.command(["observe_property", id, prop]); }
  getProp(prop) { return this.command(["get_property", prop]); }
  setProp(prop, value) { return this.command(["set_property", prop, value]); }

  /** 温和退出：裸写 quit（不走 command()——dead 标志会挡）+ SIGTERM 直杀（不依赖 socket
   *  flush：主进程可能在 quit 字节刷出前就退出，信号是内核直接递的不怕），2s 后仍在就 SIGKILL。 */
  kill() {
    const c = this.child;
    if (!c) return;
    try { this.sock?.write(JSON.stringify({ command: ["quit"] }) + "\n"); } catch {}
    try { c.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 2000).unref?.();
  }

  cleanup() {
    if (this.sockDir) { try { rmSync(this.sockDir, { recursive: true, force: true }); } catch {} this.sockDir = null; }
  }
}
