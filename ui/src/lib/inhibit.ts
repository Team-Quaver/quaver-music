// Quaver — 播放音频时睡眠禁止（设置 [Playing] InhibitSleep，默认开）。
//
// 渲染层只负责「要不要」：订阅播放器状态，把「正在播 & 开关开」投影成对 sidecar 的
// POST /api/inhibit {active}；「怎么禁」在 Go 侧 vendor/Typhoeus-go/inhibit
// （Linux=xdg 门户 Suspend 位、门户假成功走 Logind 直连；Windows=PowerRequestSystemRequired；
// macOS=IOKit PreventUserIdleSystemSleep —— 三平台都只禁睡眠，不碰屏幕）。
//
// 可靠性设计（sidecar 侧幂等，重复 POST 无副作用）：
//   - player.notify 约 4Hz，指纹不变不打请求；
//   - 30s 心跳无条件重申期望态 —— sidecar 重启、请求丢失、其他进程误清后自愈；
//   - 失败静默（睡眠禁止丢了不致命），等下一轮心跳/状态变化再补，不向用户弹错。
//
// 生命周期：不挂 pagehide 释放 —— 应用退出时 sidecar 随之退出，OS 自动回收持有
// （门户随 D-Bus 断开、Windows 句柄/macOS 断言随进程关闭）；CSD/SSD 拆窗重建期间
// mpv 还在放歌，持有恰好该延续到新页面的下一次同步。
import { player } from "../player";
import { postJson } from "./api";
import { getInhibitSleep } from "./prefs";

const HEARTBEAT_MS = 30_000;

let started = false;
let lastPushed: boolean | null = null; // 最近一次成功送达 sidecar 的期望态（null = 从未送达）

/** 当前期望态：开关开 & 有曲目 & 正在播（loading 中还不算「出声」，等 play 事件再持有）。 */
function desired(): boolean {
  return getInhibitSleep() && !!player.current && player.playing;
}

function push(force = false): void {
  const want = desired();
  if (!force && want === lastPushed) return;
  postJson("/inhibit", { active: want })
    .then(() => { lastPushed = want; })
    .catch(() => { lastPushed = null; }); // 送达失败：下轮心跳重试
}

export function startInhibitBridge(): void {
  if (started) return;
  started = true;
  player.on(() => push());
  setInterval(() => push(true), HEARTBEAT_MS);
  push(true); // 首次同步：把启动时的状态先对齐（暂停还原场景 → active:false）
}

/** 设置开关变更后立即对齐（不等下一次播放状态变化）。 */
export function syncInhibit(): void {
  if (!started) return;
  push(true);
}
