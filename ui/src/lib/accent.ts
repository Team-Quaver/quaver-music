// Quaver — 系统强调色（渲染层侧）：读同源 /api/accent 的一层薄封装。
//
// 探测本身在主进程（electron/accent.ts：Noctalia / matugen / KDE / GNOME / GTK…），这里只管：
//   · 拉一份当前值并缓存（applyTint 是同步的，得有个能立刻读到的真相）；
//   · 要用的时候才轮询（10s 一次：换壁纸/换配色后，最迟 10s 跟上，不用重启应用）；
//   · 值变了通知订阅者（染色模块据此重写 --cvg-*）。
// 与 ambient.ts 的分工：那个管背景那张图，这个只管一个色值；两者都可能在「系统强调色」
// 档位下同时工作，但互不依赖。
//
// 注意：本模块不能 import player / views —— 它被 lib/tint.ts（被 shell 拉起）和设置页共用，
// 只能往下依赖 lib/color.ts 的纯函数。

/** 同源系统强调色端点（dev/preview = src/relay.ts，打包态 = electron/native-server.ts） */
export const ACCENT_ROUTE = "/api/accent";

/** /api/accent 的应答（electron/accent.ts:accentPayload 产出，这里只是它的形状）。 */
export interface SystemAccent {
  /** `#rrggbb`；读不到系统强调色为 null（调用方回落默认色） */
  color: string | null;
  /** 来源 id（quaver-template / noctalia / matugen / kde / gnome / gtk / macos / windows…） */
  source: string;
  /** 来源的可读名（设置页提示用） */
  label: string;
  /** 从哪份文件读到的（排障用；只展示，不参与任何路径拼接） */
  path: string;
  /** 当前深浅（探测端挑 JSON 那支用的） */
  mode: "dark" | "light";
}

/** 轮询间隔：换壁纸/换配色是低频操作，10s 足够跟手，开销只是一个本地 GET。 */
const POLL_MS = 10_000;

let last: SystemAccent | null = null;
let inflight: Promise<SystemAccent | null> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(a: SystemAccent) => void>();

/** 最近一次读到的值（还没读过 = null）。同步读，给 applyTint 这类不能等的地方用。 */
export function currentAccent(): SystemAccent | null {
  return last;
}

/** 拉一次。失败（dev 纯浏览器 / 中继不可用）静默保持旧值 —— 染色回落默认青色即可。 */
export async function refreshAccent(): Promise<SystemAccent | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(ACCENT_ROUTE, { cache: "no-store" });
      if (!r.ok) return last;
      const v = (await r.json()) as Partial<SystemAccent> | null;
      if (v && typeof v === "object" && (v.color === null || typeof v.color === "string")) {
        last = {
          color: v.color && /^#[0-9a-f]{6}$/.test(v.color) ? v.color : null, // 探测端已规范过，这里再守一道
          source: String(v.source ?? ""),
          label: String(v.label ?? ""),
          path: String(v.path ?? ""),
          mode: v.mode === "light" ? "light" : "dark",
        };
      }
      return last;
    } catch {
      return last;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 订阅强调色变化（换壁纸 / 换配色 / 换深浅都会触发）。第一个订阅者进来就开始轮询，
 * 最后一个退订停表 —— 没人用的时候不该有一个常驻定时器在跑。
 * 返回退订函数。
 */
export function watchAccent(onChange: (a: SystemAccent) => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    void refreshAccent().then((a) => { if (a) notify(); });
    timer = setInterval(() => {
      void refreshAccent().then((a) => { if (a) notify(); });
    }, POLL_MS);
    timer.unref?.(); // 只在有人订阅时才存在，但还是不许拽住事件循环
  }
  return () => {
    listeners.delete(onChange);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 值真的变了才广播（轮询空转不该把订阅方唤醒成 10s 一次的重绘）。 */
function notify() {
  const prev = notifyPrev;
  const now = last;
  if (prev && now && prev.color === now.color && prev.source === now.source) return;
  notifyPrev = now ? { ...now } : now;
  for (const fn of listeners) {
    try { fn(now as SystemAccent); } catch (e) { console.warn("accent listener failed", e); }
  }
}

let notifyPrev: SystemAccent | null = null;
