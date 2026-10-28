// Quaver — 账号侧数据热更新（手机/网页改了收藏，桌面端不必重启）
//
// 收藏歌单与「我喜欢」都是进程内缓存：本机写入有即时广播，但他端写入只有服务端知道。
// 这里在窗口重新可见/获得焦点时主动对账，并在前台每 30s 探一次：
//   · 收藏歌单量小，直接整表回源；
//   · 「我喜欢」先拉 20 首的头部窗口 + total 做指纹，真变了才整单重载，避免每分钟搬几百 KB。
import { player } from "../player";
import { loadFavSonglists } from "./favs";
import { api, ApiError } from "./api";
import { resetFavSonglists } from "./favs";
import { resetSidebarUser } from "../shell";

/** 前台轮询间隔：足够让手机操作在回到桌面后很快出现，又不至于把两个读接口打穿。 */
const POLL_MS = 30_000;

// 探针与数据对账共用 30s 周期：手机端下线后，一个轮询周期内 Quaver 就会感知并回登录页。

/** focus 与 visibilitychange 经常成对触发：短窗口内只发一轮，避免重复请求。 */
const WAKE_MIN_GAP = 5_000;

let started = false;
let lastAttemptAt = 0;
let inflight: Promise<void> | null = null;
let wakeOff: (() => void) | null = null;
let pollTimer: number | null = null;

/** 只在前台对账：最小化/隐藏时网络与缓存都没必要跟着跑。 */
const foreground = () => document.visibilityState !== "hidden";

async function refresh(reason: "wake" | "poll" | "manual"): Promise<void> {
  if (!foreground()) return;
  const now = Date.now();

  if (reason === "wake" && now - lastAttemptAt < WAKE_MIN_GAP) return;

  // 探针先于数据对账：设备被下线后继续拉收藏/我喜欢只会产生一串 401 噪音。
  try {
    await api("/login/probe");
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 401) {
      // sidecar 已清本地凭证并交接 null 给主进程。先清账号态 UI 缓存再跳转，
      // 否则头像/侧栏歌单会带着上一个账号的数据残留在登录页旁边。
      resetFavSonglists();
      stopAccountSync();
      resetSidebarUser();
      player.clearForLogout();
      location.href = "/login.html";

      return;
    }
  }

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

  const onVisibility = () => {
    if (foreground()) wake();
  };

  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", onVisibility);
  wakeOff = () => {
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", onVisibility);
  };

  pollTimer = window.setInterval(() => { void refresh("poll"); }, POLL_MS);
}

/** 账号边界：登出/被下线时停掉旧账号的前台轮询。
 *  重新登录后 startAccountSync 会再启动一轮；不停止的话，旧 30s 定时器会继续带着
 *  上一个账号的节奏发 /login/probe，且 started 锁会让新账号无法重新绑定。 */
export function stopAccountSync(): void {
  if (!started) return;
  started = false;
  lastAttemptAt = 0;
  inflight = null;
  wakeOff?.();
  wakeOff = null;

  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

// 开发钩子：不打开 DevTools 也能手动触发一轮，便于本地验证手机端改动是否上屏。
if (import.meta.env?.DEV) {
  (window as any).__quaverRefreshAccount = refreshAccountData;
}
