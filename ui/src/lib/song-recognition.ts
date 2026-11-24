// Quaver — 听歌识曲（渲染侧）：系统声音/麦克风采集 + 主进程 AFP 指纹 + 网易云匹配 → QQ 曲库。
// Linux 的系统声音由主进程录默认输出的 monitor source；Windows 走 display-capture loopback。

export type RecognitionPhase = "idle" | "capturing" | "fingerprinting" | "matching" | "done" | "error";
export type RecognitionSource = "system" | "microphone";

export type RecognitionCandidate = {
  id: string;
  /** QQ songmid；回查 QQ 曲库命中时可直接起播，缺失则走搜索。 */
  mid?: string;
  title: string;
  artists: string[];
  album?: string;
  cover?: string;
  startTimeMs?: number;
};

export type RecognitionResult =
  | { phase: "done"; candidates: RecognitionCandidate[] }
  | { phase: "error"; message: string };

/** /api/recognition/match 中继返回的候选（与 electron/recognition-match.ts 同形）。 */
type RecognitionCandidateWire = {
  song?: {
    id?: number | string;
    songId?: number | string;
    mid?: string;
    name?: string;
    artists?: Array<{ name?: string }>;
    album?: { name?: string; picUrl?: string };
  };
  startTime?: number;
};

const TARGET_RATE = 8000;
const CAPTURE_MS = 8000;
const WINDOW_MS = 3000;
const STEP_MS = 1000;

type CapturedPcm = { pcm: Float32Array; sampleRate: number };

/** 静音判定与归一化共用同一套 RMS */
function rms(pcm: Float32Array): number {
  let sum = 0;

  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];

  return Math.sqrt(sum / Math.max(1, pcm.length));
}

/** 弱回采增益补偿；目标电平参考 SPlayer 同款识曲链路 */
function normalizeLevel(pcm: Float32Array): Float32Array {
  const current = rms(pcm);

  if (current <= 0) return pcm;

  const gain = Math.min(50, 0.1 / current);

  if (gain <= 1) return pcm;

  const out = new Float32Array(pcm.length);

  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain;

  return out;
}

type CaptureSession = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  ctx: AudioContext;
  chunks: Float32Array[];
  total: number;
};

const WORKLET_SOURCE = `
class QuaverMicCapture extends AudioWorkletProcessor {
  constructor() { super(); this.port.onmessage = (e) => { if (e.data === "flush") this.port.postMessage({ type: "flush", pcm: this.pending }); this.pending = []; }; this.pending = []; }
  process(inputs) {
    const input = inputs[0]; if (!input?.length || !input[0]) return true;
    if (!this.pending) this.pending = [];
    this.pending.push(new Float32Array(input[0]));
    return true;
  }
}
registerProcessor("quaver-mic-capture", QuaverMicCapture);
`;

/**
 * 用 AudioWorklet 采集一条 MediaStream 的 PCM
 * @param stream - 麦克风或系统声音流
 * @param signal - 取消信号
 * @returns 单声道样本与 AudioContext 实际采样率（设备可能拒绝 8 kHz）
 */
async function captureStreamPcm(stream: MediaStream, signal: AbortSignal): Promise<CapturedPcm> {
  let ctx: AudioContext;

  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE });
  } catch {
    // 个别设备的音频栈拒绝 8 kHz 上下文；用设备默认率采集，后面线性重采样。
    ctx = new AudioContext();
  }

  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));

  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const processor = new AudioWorkletNode(ctx, "quaver-mic-capture");
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();

  sink.gain.value = 0;
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

  const session: CaptureSession = { stream, source, processor, ctx, chunks: [], total: 0 };

  const cleanup = () => {
    try { source.disconnect(); } catch { /* noop */ }

    try { processor.disconnect(); } catch { /* noop */ }

    try { sink.disconnect(); } catch { /* noop */ }

    for (const track of stream.getTracks()) track.stop();
    void ctx.close().catch(() => {});
  };

  processor.port.onmessage = (event) => {
    // SAFETY: AudioWorklet 只回传我们定义的 pcm 数据，这里按协议取值
    const pcm = event.data?.pcm as Float32Array | undefined;

    if (!pcm?.length) return;
    session.chunks.push(pcm);
    session.total += pcm.length;
  };

  try {
    const duration = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CAPTURE_MS);

      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    await duration;

    if (signal.aborted) return { pcm: new Float32Array(0), sampleRate: ctx.sampleRate };

    processor.port.postMessage("flush");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const merged = new Float32Array(session.total);
    let offset = 0;

    for (const chunk of session.chunks) { merged.set(chunk, offset); offset += chunk.length; }

    return { pcm: merged, sampleRate: ctx.sampleRate };
  } finally {
    cleanup();
  }
}

/** 麦克风采集：保留设备原始音频，关闭回声消除/降噪/AGC，避免把音乐削坏 */
async function captureMicrophone(signal: AbortSignal): Promise<CapturedPcm> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  return captureStreamPcm(stream, signal);
}

/** Linux 主进程录好的 8 kHz PCM；非 Linux 返回 null，让调用方走 display-capture。 */
async function captureSystemFromHost(signal: AbortSignal): Promise<CapturedPcm | null> {
  const r = await fetch(`/api/recognition/system-pcm?duration=${CAPTURE_MS}`, {
    method: "POST",
    signal,
    headers: { accept: "application/octet-stream" },
  });

  if (r.ok) {
    const buffer = await r.arrayBuffer();
    const samples = Math.floor(buffer.byteLength / 4);

    if (samples > 0) {
      // SAFETY: 中继只回主进程捕获的 Float32LE 原始 PCM，长度已按 4 字节向下取整
      return { pcm: new Float32Array(buffer, 0, samples), sampleRate: TARGET_RATE };
    }
  }

  if (r.status !== 501) {
    const body = await r.json().catch(() => null) as { msg?: string } | null;

    throw new Error(body?.msg || `系统声音采集失败 HTTP ${r.status}`);
  }

  return null;
}

/**
 * Windows/macOS 的系统声音回退：由主进程的 display-media handler 给 loopback 音频。
 * getDisplayMedia 必须带 video，拿到流后立刻停掉视频轨，只留下音频。
 */
async function captureSystemFromDisplay(signal: AbortSignal): Promise<CapturedPcm> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

  for (const track of stream.getVideoTracks()) track.stop();

  if (!stream.getAudioTracks().length) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("没有捕获到系统声音，请改用麦克风");
  }

  return captureStreamPcm(new MediaStream(stream.getAudioTracks()), signal);
}

/** 系统声音：Linux 走主进程 monitor，其他平台走 Electron loopback。 */
async function captureSystem(signal: AbortSignal): Promise<CapturedPcm> {
  const host = await captureSystemFromHost(signal).catch((error: unknown) => {
    if (signal.aborted) throw error;

    return null;
  });

  if (host) return host;

  return captureSystemFromDisplay(signal);
}

/** 线性重采样到 AFP 要求的 8 kHz；AudioContext 偶尔会忽略构造参数。 */
function resampleTo8k(pcm: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === TARGET_RATE || !pcm.length) return pcm;
  const outLength = Math.max(1, Math.round(pcm.length * TARGET_RATE / sampleRate));
  const out = new Float32Array(outLength);
  const step = sampleRate / TARGET_RATE;

  for (let i = 0; i < outLength; i++) {
    const pos = Math.min(pcm.length - 1, i * step);
    const left = Math.floor(pos);
    const right = Math.min(pcm.length - 1, left + 1);
    const frac = pos - left;

    out[i] = pcm[left] * (1 - frac) + pcm[right] * frac;
  }

  return out;
}

/** 采集错误映射成用户能看懂的一句提示 */
function captureErrorMessage(error: Error, source: RecognitionSource): string {
  const system = source === "system";

  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return system ? "系统声音权限被拒绝" : "麦克风权限被拒绝";
    }

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return system ? "没有找到可用的系统声音来源" : "没有可用的麦克风";
    }

    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return system ? "系统声音被占用或不可读，请改用麦克风" : "麦克风被占用或不可读";
    }

    if (system && (error.name === "NotSupportedError" || error.name === "AbortError")) {
      return "当前平台无法采集系统声音，请改用麦克风";
    }
  }

  return error.message || "采集失败";
}

/** 3 秒窗口 / 1 秒步长；失败继续尝试下一个窗口 */
function slidingWindows(pcm: Float32Array): Float32Array[] {
  const size = TARGET_RATE * WINDOW_MS / 1000;
  const step = TARGET_RATE * STEP_MS / 1000;
  const out: Float32Array[] = [];

  if (pcm.length < size) return pcm.length ? [pcm] : [];

  for (let start = 0; start + size <= pcm.length; start += step) out.push(pcm.subarray(start, start + size));

  return out;
}

/**
 * 对一段采集样本跑指纹与匹配
 * @param signal - 取消信号
 * @param onPhase - UI 阶段回调
 * @param source - 采集来源，默认系统声音
 * @returns 候选或错误
 */
export async function recognizeAudio(
  signal: AbortSignal,
  onPhase?: (phase: RecognitionPhase) => void,
  source: RecognitionSource = "system",
): Promise<RecognitionResult> {
  onPhase?.("capturing");

  let captured: CapturedPcm;

  try {
    captured = source === "system" ? await captureSystem(signal) : await captureMicrophone(signal);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));

    if (signal.aborted) return { phase: "error", message: "已取消" };

    return { phase: "error", message: captureErrorMessage(error, source) };
  }

  if (signal.aborted) return { phase: "error", message: "已取消" };

  if (!captured.pcm.length) return { phase: "error", message: "采集过早结束" };

  const pcm = resampleTo8k(captured.pcm, captured.sampleRate);
  const normalized = normalizeLevel(pcm);

  if (rms(normalized) < 0.005) return { phase: "error", message: "没有采集到足够声音" };

  let lastError = "没有识别到结果";

  for (const window of slidingWindows(normalized)) {
    if (signal.aborted) return { phase: "error", message: "已取消" };

    onPhase?.("fingerprinting");

    try {
      const fr = await fetch("/api/recognition/fingerprint", {
        method: "POST",
        body: new Float32Array(window).buffer,
        signal,
        headers: { "content-type": "application/octet-stream" },
      });

      // SAFETY: /api/recognition/fingerprint 是同源中继，返回固定信封 JSON
      const fpBody = await fr.json() as { code?: number; msg?: string; data?: { fingerprint?: string } };

      if (!fr.ok || Number(fpBody?.code) !== 0 || !fpBody.data?.fingerprint) {
        const message = String(fpBody?.msg ?? `指纹计算失败 HTTP ${fr.status}`);

        if (fr.status === 503) return { phase: "error", message };
        lastError = message;
        continue;
      }

      onPhase?.("matching");

      const q = new URLSearchParams({
        fingerprint: fpBody.data.fingerprint,
        duration: String(WINDOW_MS / 1000),
      });

      const r = await fetch(`/api/recognition/match?${q.toString()}`, {
        signal,
        headers: { accept: "application/json" },
      });

      // SAFETY: /api/recognition/match 是同源中继，返回协议 JSON
      const body = await r.json() as {
        code?: number;
        msg?: string;
        data?: { result?: RecognitionCandidateWire[] };
      };

      const songs = Array.isArray(body?.data?.result) ? body.data.result : [];

      if (Number(body?.code) === 0) {
        if (!songs.length) {
          lastError = "没有识别到结果";
          continue;
        }

        const candidates: RecognitionCandidate[] = songs.slice(0, 3).map((item, index) => {
          const song = item?.song ?? {};
          const artists = Array.isArray(song.artists) ? song.artists : [];

          return {
            id: String(song.id ?? song.songId ?? `${index}`),
            mid: song.mid,
            title: String(song.name ?? "未知歌曲"),
            artists: artists.map((a) => a.name ?? "").filter(Boolean),
            album: song.album?.name,
            cover: song.album?.picUrl,
            startTimeMs: Number(item?.startTime ?? 0) * 1000,
          };
        });

        if (candidates.length) return { phase: "done", candidates };

        lastError = "没有识别到结果";
        continue;
      }

      lastError = String(body?.msg ?? "没有识别到结果");
    } catch (error: unknown) {
      if (signal.aborted) return { phase: "error", message: "已取消" };

      // SAFETY: catch 边界只读取错误 message，不信任其余字段
      lastError = String((error as Error)?.message ?? error ?? "匹配请求失败");
    }
  }

  return { phase: "error", message: lastError };
}
