// Quaver — PCM 兼容模式的 AudioWorklet 内核。
//
// 主线程只负责把 50ms 的 interleaved float32 PCM 扔进 ring buffer；这里按 128 帧
// 连续输出。相比每秒创建几十个 AudioBufferSourceNode，这里一个 worklet 节点到底，
// 避免频繁分配/调度造成的卡顿。
const CHANNELS = 2;
const CAPACITY_FRAMES = 96000; // 2s @ 48k，远大于主进程 0.6s 预读窗口

class QuaverPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(CAPACITY_FRAMES * CHANNELS);
    this.readFrame = 0;
    this.writeFrame = 0;
    this.availableFrames = 0;
    this.playedFrames = 0;
    this.blocks = 0;
    this.underrun = false;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (!msg) return;

    if (msg.type === "reset") {
      this.readFrame = 0;
      this.writeFrame = 0;
      this.availableFrames = 0;
      this.playedFrames = 0;
      this.blocks = 0;
      this.underrun = false;
      this.postStatus();

      return;
    }

    if (msg.type !== "pcm") return;

    const source = new Float32Array(msg.data);
    const frames = Math.floor(source.length / CHANNELS);
    const room = CAPACITY_FRAMES - this.availableFrames;
    const take = Math.min(frames, room);

    for (let i = 0; i < take; i++) {
      const dst = this.writeFrame * CHANNELS;
      const src = i * CHANNELS;
      this.ring[dst] = source[src];
      this.ring[dst + 1] = source[src + 1];
      this.writeFrame = (this.writeFrame + 1) % CAPACITY_FRAMES;
    }

    this.availableFrames += take;
  }

  postStatus() {
    this.port.postMessage({
      type: "status",
      playedFrames: this.playedFrames,
      availableFrames: this.availableFrames,
      underrun: this.underrun,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output && output[0];
    const right = output && output[1];

    if (!left || !right) return true;

    let consumed = 0;
    let under = false;

    for (let i = 0; i < left.length; i++) {
      if (this.availableFrames <= 0) {
        left[i] = 0;
        right[i] = 0;
        under = true;
        continue;
      }

      const src = this.readFrame * CHANNELS;
      left[i] = this.ring[src];
      right[i] = this.ring[src + 1];
      this.readFrame = (this.readFrame + 1) % CAPACITY_FRAMES;
      this.availableFrames--;
      consumed++;
    }

    this.playedFrames += consumed;
    this.underrun = under;
    this.blocks++;

    if (this.blocks >= 8) {
      this.blocks = 0;
      this.postStatus();
    }

    return true;
  }
}

registerProcessor("quaver-pcm", QuaverPcmProcessor);
