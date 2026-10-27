// Quaver — 路由视图注册表（**按需动态加载**）
//
// 为什么不再是 `import { views } from "./views"` 一张静态表：那张表把 14 个视图（含 1200 行的
// 设置页）全钉在 SPA 入口的静态闭包里，首屏必须把用户可能一辈子不进的那些页面一起解析。
// 现在入口只解析壳层要用的部分，视图各自成块：`/settings` 的字节只在真去设置页时才付，
// `/search`、`/local` 同理 —— 桌面客户端的首屏不该为第 13 号页面买单。
//
// 三条口径：
//   ① 优先级与拆分前逐字一致：宿主路由 > 插件注册的自定义路由 > 回落首页；
//   ② 模块只在**首次访问**时解析，解析到的函数留在本表里（第二次进同一页不再拉）；
//   ③ 预取只由**交互意图**触发（侧栏/卡片 hover、pointerdown），不做 idle 全量预热 ——
//      那是把刚省下的解析与内存再吃回去，还顺带污染首屏。
// 验证：scripts/verify-bundle.ts（视图块存在、且不在任何入口的静态闭包里）。
import type { SparkleView } from "@quaver/sparkle";
import { sparkleViewAt } from "../sparkle/registry";

/** 宿主视图：可同步返回 cleanup，也可异步（拆分前就是两种混用，await 都兜得住）。 */
export type ViewFn = (root: HTMLElement, q: URLSearchParams) => Promise<(() => void) | void> | ((() => void) | void);

/** 交给 shell 的形态：宿主视图或插件视图（SparkleView 是同步签名，调用方一律 await）。 */
export type ViewLike = ViewFn | SparkleView;

type Loader = () => Promise<ViewFn>;

const loaders: Record<string, Loader> = {
  "/": () => import("./home").then((m) => m.default),
  "/search": () => import("./search").then((m) => m.default),
  "/guess": () => import("./guess").then((m) => m.default),
  "/daily": () => import("./daily").then((m) => m.default),
  "/liked": () => import("./liked").then((m) => m.default),
  "/local": () => import("./local").then((m) => m.default),
  "/all": () => import("./all").then((m) => m.default),
  "/playlists": () => import("./playlists").then((m) => m.default),
  "/playlist": () => import("./playlist").then((m) => m.default),
  "/toplist": () => import("./toplist").then((m) => m.default),
  "/singer": () => import("./singer").then((m) => m.default),
  "/singer-albums": () => import("./singer-albums").then((m) => m.default),
  "/album": () => import("./album").then((m) => m.default),
  "/settings": () => import("./settings").then((m) => m.default),
  "/log": () => import("./log").then((m) => m.default),
  "/user": () => import("./user").then((m) => m.default),
  "/login": () => import("./login").then((m) => m.default),
};

const loaded = new Map<string, ViewFn>();
const inFlight = new Set<string>();

/** 路由 → 视图实现。宿主路由走懒加载；插件路由与未知路径沿用拆分前的回落次序。 */
export async function loadView(path: string): Promise<ViewLike> {
  const cached = loaded.get(path);

  if (cached) return cached;
  const loader = loaders[path];

  if (!loader) {
    const spark = sparkleViewAt(path);

    if (spark) return spark;

    return await loaders["/"](); // 未知路径回落首页；不缓存（那是插件的自由命名空间）
  }

  const fn = await loader();
  loaded.set(path, fn);

  return fn;
}

/** 预取某路由的视图模块（hover/pointerdown 触发；重复调用、未知路由、已加载都是 no-op）。 */
export function prefetchView(path: string): void {
  const loader = loaders[path];

  if (!loader || loaded.has(path) || inFlight.has(path)) return;
  inFlight.add(path);
  void loader().then(
    (fn) => { loaded.set(path, fn); inFlight.delete(path); },
    () => { inFlight.delete(path); }, // 预取失败不作声：真导航时自会在界面上报错
  );
}

/** 宿主自有路由（插件宿主判「这条路径归不归我」可用）。 */
export const appRoutes: string[] = Object.keys(loaders);
