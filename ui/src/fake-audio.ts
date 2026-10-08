// Quaver — 假音频保活（win/mac SMTC / Now Playing 专用）
//
// 为什么需要它：mpv 后端下渲染层没有任何音频元素，Chromium 的媒体会话从未激活，
// SMTC / Now Playing 压根不注册（Blink 后端有真实 <audio> 所以正常）。解法是业界
// 成熟 workaround：渲染层循环播放一段运行时生成的近静音 WAV，让媒体会话保持激活；
// SMTC 显示的元数据/播放态/时间线仍完全由 mpris.ts 的快照推送驱动（来源是 mpv 的
// pos/dur，经 setPositionState 上报），控制链路不变（actionHandler → player → mpv）。
//
// 静音源为什么不是全 0：Chromium AudioStreamMonitor 对解码后的样本算功率，数字
// 静音会被判 inaudible，媒体会话可能照样不激活。这里用 4 Hz 正弦、振幅 32 LSB
// （≈ −60 dBFS），乘元素 volume 0.01（−40 dB）后听感 ≈ −100 dBFS——任何设备
// 都听不见，但离静音判定阈值（−70～−80 dBFS 一带）留了 10–20 dB 余量。
// 监测点在解码后、元素音量施加前，所以 volume 极小不影响「audible」判定。
//
// Inhibit 语义（本模块唯一的系统副作用）：
//   - 纯音频播放只持 prevent-app-suspension 级 powerSaveBlocker（win/mac 防系统
//     空闲睡眠，不阻止熄屏/锁屏）。mpv 自带 --stop-screensaver（默认开，播放期
//     抑制、暂停即解除），两者语义一致、叠加无害。
//   - Linux 上本模块根本不初始化（mpris.ts 的平台门 + initFakeAudio 的 UA 复查
//     双保险），idle-inhibit / D-Bus inhibitor 零接触面。
//   - 因此唯一的回归窗口是「mpv 已暂停、假音频还在放」→ 空闲睡眠被无限推迟。
//     由 sync() 的 want 三条件状态机堵死：player.paused（= transport.paused =
//     st.paused || st.idle）把 dead/error/eof/stop 全部坍缩为暂停，任一路径失灵
//     的最坏结果也只是多持一个无声 blocker，不会出声、不会显示错状态。
//
// 依赖：Electron 默认 autoplay 策略 no-user-gesture-required（main.ts webPreferences
// 未改）。若将来给 webPreferences 加 user-gesture-required，本模块会静默失效。
import { player } from "./player";

const SAMPLE_RATE = 8000; // 最低标准档，解码/CPU 开销最小
const CYCLES = 4; // 1 秒 4 个整周期 → 循环点零相位跳变
const AMPLITUDE = 32; // 16-bit 满幅的 1/1024 ≈ −60 dBFS
const VOLUME = 0.01; // 固定值，与用户音量/静音完全解耦（静音不能连 SMTC 会话一起弄没）
const RETRY_MS = 1000; // play() 失败的自愈重试退避

let el: HTMLAudioElement | null = null;
let lastPlayAttempt = 0;
let warned = false;

/** 近静音 WAV data URI：8000 Hz / mono / 16-bit PCM / 1 秒，4 Hz 低振幅正弦。
 *  模块级缓存，进程生命周期只算一次（≈16 KB → base64 ≈21 KB，一次性驻内存无压力）。 */
function makeSilentWavDataUri(): string {
  const n = SAMPLE_RATE; // 1 秒
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  // 标准 44 字节 RIFF/WAVE 头
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt 块长
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.round(AMPLITUDE * Math.sin((2 * Math.PI * CYCLES * i) / n)), true);
  }
  // btoa 分块编码：16 KB 一次 apply 会撞参数上限
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return "data:audio/wav;base64," + btoa(bin);
}

function ensureEl(): HTMLAudioElement {
  if (el) return el;
  // src 永不变（规避 media load 算法的 AbortError 竞态）；loop=true 永不触发 ended
  const a = new Audio();
  a.loop = true;
  a.volume = VOLUME;
  a.src = makeSilentWavDataUri();
  a.addEventListener("error", () => {
    if (!warned) {
      console.warn("[fake-audio] decode failed — SMTC 会话可能失效");
      warned = true;
    }
  });
  el = a;
  return a;
}

/** 幂等同步：want 三条件缺一不可。每次 player notify 都跑（4Hz 级，两次布尔比较，
 *  开销可忽略）。backend !== "mpv" 时必停——防止循环假音频抢走真实 <audio> 的媒体会话。 */
function sync(): void {
  const want = player.backend === "mpv" && !!player.current && !player.paused;
  if (!want) {
    if (el && !el.paused) el.pause();
    return;
  }
  if (el && !el.paused) return;
  // 自愈：want 播放但元素不在播（首次创建 / play() 曾失败 / 异常被打断）→ 1s 退避重试，
  // 防 4Hz notify 疯狂重试刷日志
  const now = Date.now();
  if (now - lastPlayAttempt < RETRY_MS) return;
  lastPlayAttempt = now;
  const a = ensureEl();
  a.play().then(
    () => (warned = false),
    (e) => {
      if (!warned) {
        console.warn("[fake-audio] play() failed:", String(e));
        warned = true;
      }
    },
  );
}

/** 由 mpris.ts 在 makeMediaSessionPush() 返回非 null 时调用——平台门（quaverMpris 桥
 *  存在 + /Windows|Macintosh/ UA + mediaSession API + actionHandler 注册成功）已在
 *  那里过完，这里只做一次纵深复查。 */
export function initFakeAudio(): void {
  if (!/Windows|Macintosh/.test(navigator.userAgent)) return;
  player.on(sync);
  sync();
}
