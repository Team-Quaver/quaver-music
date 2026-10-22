// Quaver — 账号侧数据热更新（手机/网页改了收藏，桌面端不必重启）
//
// 收藏歌单与「我喜欢」都是进程内缓存：本机写入有即时广播，但他端写入只有服务端知道。
// 这里在窗口重新可见/获得焦点时主动对账，并在前台每 30s 探一次：
//   · 收藏歌单量小，直接整表回源；
//   · 「我喜欢」先拉 20 首的头部窗口 + total 做指纹，真变了才整单重载，避免每分钟搬几百 KB。
import { loadFavSonglists } from "./favs";
import { player } from "../player";

/** 前台轮询间隔：足够让手机操作在回到桌面后很快出现，又不至于把两个读接口打穿。 */
const POLL_MS = 30_000;

/** focus 与 visibilitychange 经常成对触发：短窗口内只发一轮，避免重复请求。 */
const WAKE_MIN_GAP = 5_000;

let started = false;
let lastAttemptAt = 0;
let inflight: Promise<void> | null = null;

/** 只在前台对账：最小化/隐藏时网络与缓存都没必要跟着跑。 */
const foreground = () => document.visibilityState !== "hidden";

async function refresh(reason: "wake" | "poll" | "manual"): Promise<void> {
  if (!foreground()) return;
  const now = Date.now();

  if (reason === "wake" && now - lastAttemptAt < WAKE_MIN_GAP) return;

  if (inflight) return inflight;
  lastAttemptAt = now;
  inflight = (async () => {
    // 两个来源独立降级：收藏歌单失败不能挡住我喜欢，反之亦然。
    await Promise.allSettled([
      loadFavSonglists(true),
      player.refreshLovedFromRemote(),
    ]);
  })();

  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

/** 立即对账一次（测试/调试也可显式触发；正常生命周期由 startAccountSync 驱动）。 */
export const refreshAccountData = (): Promise<void> => refresh("manual");

/** 登录确认后调用一次。窗口恢复、网络回线、前台轮询都会进入同一个合流器。 */
export function startAccountSync(): void {
  if (started) return;
  started = true;
  // bootSidebar 已经拉过首屏数据；把起点记下，避免启动瞬间的 focus 再打一遍。
  lastAttemptAt = Date.now();

  const wake = () => { void refresh("wake"); };

  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => {
    if (foreground()) wake();
  });
  window.setInterval(() => { void refresh("poll"); }, POLL_MS);
}

// 开发钩子：不打开 DevTools 也能手动触发一轮，便于本地验证手机端改动是否上屏。
if (import.meta.env?.DEV) {
  (window as any).__quaverRefreshAccount = refreshAccountData;
}
