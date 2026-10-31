// Quaver — MPV PCM 输出管道（原生兼容模式）。
//
// 作用：让 mpv 仍然负责解码 / 缓存 / EQ / 音量包络，但不再自己打开 WASAPI；
// `--ao=pcm` 把 float32 PCM 写进本管道，主进程再转交 renderer 的 WebAudio。
// 这样 Oopz / Discord / OBS 捕获共享窗口时，音频会话归属 renderer，而不是 mpv.exe。
//
// 平台差异：
//   win32 = Node net.Server 命名管道（mpv 用 fopen 打开 `\\.\pipe\...`）
//   POSIX = mkfifo 创建的 FIFO，Node 以 ReadStream 读取
//
// 管道默认暂停。renderer 发出 pcm-ready 后才恢复读取，否则 FIFO/命名管道会
// 自然背压到 mpv，避免解码器一口气把整首歌写进内存。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type Socket } from "node:net";

export interface PcmPipeOpts {
  onData: (chunk: Buffer, generation?: number) => void;
  onError?: (e: Error) => void;
  log?: (...a: unknown[]) => void;
}

export class PcmPipe {
  path = "";
  private opts: PcmPipeOpts;
  private server: Server | null = null;
  private sock: Socket | null = null;
  private fifoChild: ChildProcess | null = null;
  private fifoWatchdog: ChildProcess | null = null;
  private dir = "";
  private paused = true;
  private closed = false;
  /** 当前会话代际：换流/seek 都会推进；旧代 stdout drain 不再进入新播放会话。 */
  private generation = 0;

  /** 换代后旧代 drain 的数据必须被识别并丢弃；主进程以这个代际做双保险。 */
  setGeneration(value: number): void {
    this.generation = value;
  }

  constructor(opts: PcmPipeOpts) {
    this.opts = opts;
  }

  async start(): Promise<string> {
    if (this.path) return this.path;

    if (process.platform === "win32") {
      const name = `\\\\.\\pipe\\quaver-pcm-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const server = createServer((sock) => this.attachSocket(sock));

      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => { server.off("listening", onListen); reject(e); };
        const onListen = () => { server.off("error", onError); resolve(); };

        server.once("error", onError);
        server.once("listening", onListen);
        server.listen(name);
      });

      this.server = server;
      this.path = name;

      return name;
    }

    this.dir = mkdtempSync(join(tmpdir(), "quaver-pcm-"));
    const path = join(this.dir, "pcm");
    const r = spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8" });

    if (r.status !== 0) {
      throw new Error(`mkfifo 失败: ${(r.stderr || r.error?.message || "").trim()}`);
    }

    // FIFO 读端放到 helper：主进程只消费 helper 的 stdout。helper 监听 stdin，
    // 主进程一死 stdin 断开，helper 自动退出，不会留下卡在 FIFO 的 cat/sh。
    const helper = fileURLToPath(new URL("./pcm-pipe-helper.ts", import.meta.url));

    const child = spawn(process.execPath, [helper, path, String(process.pid)], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true, // 独立进程组：close 时能连 helper 一起收掉
    });

    child.stdout?.on("data", (chunk) => this.opts.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), this.generation));
    child.stdout?.on("error", (e) => {
      if (!this.closed) this.opts.onError?.(e);
    });
    child.stdout?.pause();
    this.fifoChild = child;
    this.path = path;

    // helper 自己已经监听 stdin，但父进程 SIGKILL 时不同平台的 pipe EOF 时序并不完全一致；
    // 复用 mpv 的看门狗模式再钉一层：父进程无论怎么死，watchdog 都会把 helper 带走。
    if (child.pid) {
      const watchdog = fileURLToPath(new URL("./mpv-watchdog.ts", import.meta.url));

      const wd = spawn(process.execPath, [watchdog, String(child.pid)], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });

      wd.unref();
      // SAFETY: Node 运行期把子进程 stdin 建成 Socket（有 unref），但 @types/node 的
      // ChildProcess.stdin 声明没有；这里只补这个可选方法，不改变管道本身。
      (wd.stdin as { unref?: () => void } | null)?.unref?.();
      this.fifoWatchdog = wd;
    }

    return path;
  }

  private attachSocket(sock: Socket) {
    if (this.closed) { sock.destroy(); return; }

    sock.on("data", (chunk) => this.opts.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), this.generation));
    sock.on("error", (e) => {
      if (!this.closed) this.opts.onError?.(e);
    });
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
    });

    if (this.paused) sock.pause();
    else sock.resume();
    this.sock = sock;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause() {
    if (this.closed) return;
    this.paused = true;
    this.fifoChild?.stdout?.pause();
    this.sock?.pause();
  }

  resume() {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.fifoChild?.stdout?.resume();
    this.sock?.resume();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.paused = true;

    // 先关 stdin 让 helper 走 EOF 清理；随后 SIGKILL 兜底（helper 可能正卡在
    // FIFO read，不能把主进程退出押在信号处理及时跑完上）。
    try { this.fifoChild?.stdin?.end(); } catch {}

    try { this.fifoChild?.stdout?.destroy(); } catch {}

    if (this.fifoChild?.pid) {
      try { process.kill(-this.fifoChild.pid, "SIGKILL"); } catch {}
    }

    try { this.fifoChild?.kill("SIGKILL"); } catch {}

    try { this.fifoWatchdog?.stdin?.end(); } catch {}

    try { this.fifoWatchdog?.kill(); } catch {}

    this.fifoWatchdog = null;

    try { this.sock?.destroy(); } catch {}

    try { this.server?.close(); } catch {}

    this.fifoChild = null;
    this.sock = null;
    this.server = null;

    if (this.dir) {
      try { rmSync(this.dir, { recursive: true, force: true }); } catch {}

      this.dir = "";
    }

    this.opts.log?.("[audio] PCM pipe closed");
  }
}
