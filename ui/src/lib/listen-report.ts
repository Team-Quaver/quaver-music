// Quaver — QQ 音乐听歌时长（音响力）上报。
//
// 只累计「真实出声」的时间：playing 开始计时，pause/waiting/ended 停止。播放器按
// transport 事件持续调用 pulse()，这里每满 60 秒切一段交给 sidecar；切歌/停止时把
// 不足一分钟的尾段一起交出。上报走 /sound-power/report，vkey 与凭证只在后端。
export type ListenReportTarget = {
  mid: string;
  mediaMid: string;
  songId: number;
  audioTimeMs: number;
  songType: number;
  singerId: number;
  coSinger: string;
  streamToken: string;
};

type ReportResponse = { ok?: boolean; reason?: string };

type Sender = (body: Record<string, unknown>, keepalive: boolean) => Promise<ReportResponse>;

type Clock = () => number;

type Job = { target: ListenReportTarget; seconds: number };

const CHUNK_SECONDS = 60;
const MIN_TAIL_SECONDS = 5; // 连点切歌时别把 1-4 秒碎片打成上报洪水

// 事件循环被短暂挂起时不把整段空白算成听歌；正常 time 事件远密于此。
const MAX_SAMPLE_SECONDS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

/** 把播放器的 transport 状态折成可测试的听歌时长累加器。 */
export class ListenTimeReporter {
  private target: ListenReportTarget | null = null;
  private playing = false;
  private active = false;
  private lastAt: number | null = null;
  private pending = 0;
  private queue: Job[] = [];
  private sending = false;
  private retryAt = 0;
  private failures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly enabled: () => boolean;
  private readonly now: Clock;
  private readonly send: Sender;
  private readonly tickMs: number;

  constructor(opts: {
    send: Sender;
    enabled?: () => boolean;
    now?: Clock;
    tickMs?: number;
  }) {
    this.enabled = opts.enabled ?? (() => true);
    this.now = opts.now ?? (() => performance.now());
    this.send = opts.send;
    this.tickMs = opts.tickMs ?? 1_000;
  }

  setTarget(target: ListenReportTarget | null): void {
    this.sample();

    if (sameTarget(this.target, target)) return;
    this.deactivate();

    if (this.target && this.pending >= MIN_TAIL_SECONDS) {
      this.enqueue(this.target, this.pending);
    }

    this.pending = 0;
    this.target = target;
    this.drain();
  }

  setPlaying(playing: boolean): void {
    if (this.active) this.sample();
    this.playing = playing;
    const shouldRun = playing && !!this.target && this.enabled();
    this.active = shouldRun;

    if (!shouldRun) {
      this.lastAt = null;
      this.stopTimer();
      this.drain();

      return;
    }

    this.lastAt = this.now();
    this.startTimer();
  }

  /** transport time / 定时器心跳：推进累计并尽量清空发送队列。 */
  pulse(): void {
    // 设置页刚把开关重新打开时没有新的 play 事件，这里补一次启动。
    if (this.playing && !this.active && this.target && this.enabled()) {
      this.active = true;
      this.lastAt = this.now();
      this.startTimer();
    }

    this.sample();
    this.drain();
  }

  /** 切歌、停止、页面退出前调用；keepalive=true 用于 pagehide。 */
  flush(keepalive = false): void {
    this.sample();

    if (this.target && this.pending >= MIN_TAIL_SECONDS) {
      this.enqueue(this.target, Math.floor(this.pending));
    }

    this.pending = 0;
    this.drain(keepalive);
  }

  stopTarget(): void {
    this.flush();
    this.playing = false;
    this.target = null;
  }

  dispose(): void {
    this.stopTimer();
    this.active = false;
    this.lastAt = null;
    this.pending = 0;
    this.queue = [];
  }

  private sample(): void {
    const now = this.now();

    if (!this.enabled()) {
      this.pending = 0;
      this.queue = [];
      this.active = false;
      this.lastAt = now;
      this.stopTimer();

      return;
    }

    if (!this.active || !this.target) {
      this.lastAt = now;

      return;
    }

    if (this.lastAt === null) {
      this.lastAt = now;

      return;
    }

    const elapsed = Math.min(MAX_SAMPLE_SECONDS, Math.max(0, now - this.lastAt) / 1_000);
    this.lastAt = now;
    this.pending += elapsed;

    while (this.pending >= CHUNK_SECONDS) {
      this.pending -= CHUNK_SECONDS;
      this.enqueue(this.target, CHUNK_SECONDS);
    }
  }

  private enqueue(target: ListenReportTarget, seconds: number): void {
    const whole = Math.floor(seconds);

    if (whole < MIN_TAIL_SECONDS || !this.enabled()) return;
    this.queue.push({ target, seconds: whole });
  }

  private drain(keepalive = false): void {
    if (this.sending || !this.queue.length || !this.enabled()) return;
    const now = this.now();

    if (!keepalive && now < this.retryAt) return;
    const job = this.queue.shift()!;
    this.sending = true;
    void this.send(reportBody(job), keepalive)
      .then((res) => {
        if (!res?.ok) {
          // 上游明确拒绝（未登录/无权限/凭证失效）不重放，避免同一段无限撞墙。
          this.failures = 0;
          this.retryAt = 0;

          return;
        }

        this.failures = 0;
        this.retryAt = 0;
      })
      .catch((err: any) => {
        if (keepalive) return;
        const status = Number(err?.status ?? 0);

        // 401（未登录）/403/422 这类明确拒绝重试也不会变成功；408/429 与 5xx 继续退避。
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) return;
        this.failures++;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 4));
        this.retryAt = this.now() + delay;
        this.queue.unshift(job);
      })
      .finally(() => {
        this.sending = false;

        if (this.queue.length) this.drain();
      });
  }

  private startTimer(): void {
    if (this.timer !== null || this.tickMs <= 0) return;
    this.timer = setInterval(() => this.pulse(), this.tickMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private deactivate(): void {
    this.active = false;
    this.lastAt = null;
    this.stopTimer();
  }
}

function sameTarget(a: ListenReportTarget | null, b: ListenReportTarget | null): boolean {
  if (a === b) return true;

  if (!a || !b) return false;

  return a.mid === b.mid && a.songId === b.songId && a.streamToken === b.streamToken;
}

function reportBody(job: Job): Record<string, unknown> {
  return {
    stream_token: job.target.streamToken,
    song_id: job.target.songId,
    mid: job.target.mid,
    media_mid: job.target.mediaMid,
    audio_time_ms: job.target.audioTimeMs,
    play_duration_seconds: job.seconds,
    song_type: job.target.songType,
    singer_id: job.target.singerId,
    co_singer: job.target.coSinger,
  };
}
