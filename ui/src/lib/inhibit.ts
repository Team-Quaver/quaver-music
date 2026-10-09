// Quaver — 播放音频/画廊模式的系统电源抑制桥。
//
// 渲染层只负责「要不要」：
//   - 正在播 & [Playing] InhibitSleep 开 → mode=sleep
//   - 画廊模式打开 → mode=idle（禁止屏幕因空闲熄灭）
// 「怎么禁」在 Go 侧 vendor/Typhoeus-go/inhibit，各模式独立持有和释放。
//
// 可靠性设计（sidecar 侧幂等，重复 POST 无副作用）：
//   - player.notify 约 4Hz，指纹不变不打请求；
//   - 30s 心跳无条件重申期望态 —— sidecar 重启、请求丢失、其他进程误清后自愈；
//   - 失败静默（抑制丢了不致命），等下一轮心跳/状态变化再补，不向用户弹错。
//
// 生命周期：不挂 pagehide 释放 —— 应用退出时 sidecar 随之退出，OS 自动回收持有
// （门户随 D-Bus 断开、Windows 句柄/macOS 断言随进程关闭）；CSD/SSD 拆窗重建期间
// mpv 还在放歌，持有恰好该延续到新页面的下一次同步。
import { player } from "../player";
import { postJson } from "./api";
import { getInhibitSleep } from "./prefs";

const HEARTBEAT_MS = 30_000;

type InhibitMode = "sleep" | "idle";
const MODES: InhibitMode[] = ["sleep", "idle"];

let started = false;
const lastRequested: Record<InhibitMode, boolean | null> = { sleep: null, idle: null };
const requestQueues: Record<InhibitMode, Promise<void>> = {
  sleep: Promise.resolve(),
  idle: Promise.resolve(),
};

/** sleep：开关开 & 有曲目 & 正在播（loading 中还不算「出声」，等 play 事件再持有）。 */
function desired(mode: InhibitMode): boolean {
  if (mode === "idle") return player.gallery && player.expanded;
  return getInhibitSleep() && !!player.current && player.playing;
}

function push(mode: InhibitMode, force = false): void {
  const want = desired(mode);
  if (!force && want === lastRequested[mode]) return;
  lastRequested[mode] = want;
  requestQueues[mode] = requestQueues[mode]
    .catch(() => {})
    .then(() => postJson("/inhibit", { active: want, mode }))
    .then(() => {})
    .catch(() => {
      if (lastRequested[mode] === want) lastRequested[mode] = null;
    }); // 送达失败：下轮心跳重试
}

export function startInhibitBridge(): void {
  if (started) return;
  started = true;
  player.on(() => { for (const mode of MODES) push(mode); });
  setInterval(() => { for (const mode of MODES) push(mode, true); }, HEARTBEAT_MS);
  for (const mode of MODES) push(mode, true); // 首次同步：把启动时的两种状态先对齐
}

/** 设置开关或画廊状态变更后立即对齐（不等下一次播放状态变化）。 */
export function syncInhibit(): void {
  if (!started) return;
  for (const mode of MODES) push(mode, true);
}
