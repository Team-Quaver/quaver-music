// Quaver — 听歌识曲系统声音采集（Linux）：录默认输出设备的 monitor source。
// Chromium 的 display-capture loopback 在 Electron 里只覆盖 Windows，Linux 桌面走
// PulseAudio/PipeWire 的 monitor source 才能抓到「其他应用正在播放」的声音。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const SYSTEM_CAPTURE_RATE = 8000;
export const DEFAULT_CAPTURE_MS = 8000;

export type SystemCaptureResult =
  | { ok: true; pcm: Float32Array }
  | { ok: false; reason: "unsupported" | "unavailable" | "failed"; message: string };

type RunResult =
  | { kind: "ok"; data: Buffer }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

const execFileAsync = promisify(execFile);

/** capture 进程在收到停止信号后，给它的最后退场时间 */
const EXIT_GRACE_MS = 350;

/**
 * 跑一个持续写到 stdout 的采集命令。
 * 到时长后先 SIGTERM；超时仍未退出再 SIGKILL，避免一次识曲留下僵尸录音进程。
 */
function runCapture(command: string, args: string[], durationMs: number, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const chunks: Buffer[] = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const stop = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, EXIT_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = () => {
      stop();
      finish({ kind: "failed", message: "已取消" });
    };

    let killTimer: NodeJS.Timeout | undefined;
    const stopTimer = setTimeout(stop, durationMs);
    stopTimer.unref();

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (data: Buffer) => {
      if (stderr.length < 4096) stderr += data.toString("utf8");
    });
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish({ kind: "missing" });
      else finish({ kind: "failed", message: error.message || `${command} 启动失败` });
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      const data = Buffer.concat(chunks);

      if (data.byteLength >= 4) {
        finish({ kind: "ok", data });

        return;
      }

      const detail = stderr.trim();

      finish({
        kind: "failed",
        message: detail || `${command} 未返回音频（退出码 ${String(code ?? sig ?? "unknown")}）`,
      });
    });
  });
}

/** PipeWire/PulseAudio 默认输出的 monitor source；pactl 不存在时让 parec 自己解析。 */
async function monitorTarget(): Promise<string> {
  const override = process.env.QUAVER_RECOGNITION_MONITOR?.trim();

  if (override) return override;

  try {
    const { stdout } = await execFileAsync("pactl", ["get-default-sink"], { timeout: 1500 });
    const sink = stdout.trim().split(/\r?\n/, 1)[0];

    if (sink) return `${sink}.monitor`;
  } catch { /* 走 @DEFAULT_MONITOR@ */ }

  return "@DEFAULT_MONITOR@";
}

/** Float32LE raw bytes → 8 kHz 单声道 PCM，按请求时长截尾。 */
function pcmFromBytes(data: Buffer, durationMs: number): Float32Array {
  const samples = Math.min(
    Math.round(durationMs / 1000 * SYSTEM_CAPTURE_RATE),
    Math.floor(data.byteLength / 4),
  );

  const pcm = new Float32Array(Math.max(0, samples));

  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readFloatLE(i * 4);

  return pcm;
}

/**
 * 采集默认输出设备的系统声音。
 * Linux 优先 parec（PulseAudio 兼容层），再退回 pw-record（纯 PipeWire）。
 */
export async function captureSystemPcm(
  durationMs = DEFAULT_CAPTURE_MS,
  signal = new AbortController().signal,
): Promise<SystemCaptureResult> {
  if (process.platform !== "linux") {
    return { ok: false, reason: "unsupported", message: "当前平台请使用屏幕/窗口音频采集" };
  }

  const ms = Math.max(500, Math.min(15_000, Math.round(durationMs)));
  const target = await monitorTarget();

  const parec = await runCapture(
    "parec",
    [
      `--device=${target}`,
      "--format=float32le",
      `--rate=${SYSTEM_CAPTURE_RATE}`,
      "--channels=1",
      "--latency-msec=50",
      "--raw",
    ],
    ms,
    signal,
  );

  if (parec.kind === "ok") return { ok: true, pcm: pcmFromBytes(parec.data, ms) };

  if (signal.aborted) return { ok: false, reason: "failed", message: "已取消" };

  const pw = await runCapture(
    "pw-record",
    [
      "--target", target,
      "--rate", String(SYSTEM_CAPTURE_RATE),
      "--channels", "1",
      "--format", "f32",
      "--raw",
      "-",
    ],
    ms,
    signal,
  );

  if (pw.kind === "ok") return { ok: true, pcm: pcmFromBytes(pw.data, ms) };

  if (signal.aborted) return { ok: false, reason: "failed", message: "已取消" };

  if (parec.kind === "missing" && pw.kind === "missing") {
    return {
      ok: false,
      reason: "unavailable",
      message: "没有找到 parec 或 pw-record，请先安装 PipeWire/PulseAudio 录音工具",
    };
  }

  const detail = parec.kind === "failed" ? parec.message : pw.kind === "failed" ? pw.message : "系统声音没有输出";

  return { ok: false, reason: "failed", message: detail };
}
