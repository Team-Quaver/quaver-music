// Quaver — SPA 壳层（入口 main.ts 调用 bootShell）
// 顶栏/侧栏/播放条/正在播放页/队列面板 = 常驻不销毁；
// .content 内 = 常驻搜索框（.content-top）+ 按路由切换的视图区（.route），
// 切视图不打断音频、搜索框与输入状态不随视图重建。地址栏 hash 路由
// （file:// 与壳层加载均兼容），旧的多页入口（daily.html 等）保留为薄跳转层。
import "./style.css";
import { api, upPic, identityBadges } from "./lib/api";
import { favSonglists, loadFavSonglists, onFavSonglistsChange } from "./lib/favs";
import { getSidebarCollapsed, setSidebarCollapsed, getSidebarWidth, setSidebarWidth } from "./lib/prefs";
import { bindHResizer } from "./lib/resizer";
import { sparkleViewAt, sparkleSonglistGroups } from "./sparkle/registry";
import type { SparkleNavItem } from "@quaver/sparkle";
import { player, type Song } from "./player";
import { PlayerBar } from "./components/PlayerBar";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";
import { SearchBox } from "./components/SearchBox";
import { playPlaylistNow, playSongsNow, openPlaylistMenu, openVirtualPlaylistMenu, type PlaylistMenuOptions } from "./components/PlaylistMenu";
import { views, BACK_SVG } from "./views";
import { bootTint } from "./lib/tint";
import { bootBackground } from "./lib/ambient";
import { bootMenuGlass } from "./lib/menu-glass";

export const nav = [
  { path: "#/", label: "首页", icon: "home" },
  { path: "#/guess", label: "猜你喜欢", icon: "sparkle" },
  { path: "#/daily", label: "每日 30 首", icon: "disc" },
  { path: "#/liked", label: "我喜欢", icon: "heart" },
];

const icons: Record<string, string> = {
  home: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>',
  sparkle:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  disc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  heart:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/></svg>',
  // 设置：齿轮（外圈齿形 + 中心孔）。与其它线性图标同一套 24 网格 / currentColor 描边。
  settings:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  // 侧栏缩回/展开：双 chevron。展开态指左（=往左收），缩态由 CSS 翻 180° 指右（=放出来）。
  collapse:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13.5 6.5 8 12l5.5 5.5M18.5 6.5 13 12l5.5 5.5"/></svg>',
  userPh:
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 19c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5"/></svg>',
};

// content = .content 主内容区整体；route = 内容区里可被路由替换的部分。
// 搜索框在 content 内、route 外——随壳层常驻，切视图/刷新视图不重建、输入不丢。
export const state = { content: null as HTMLElement | null, route: null as HTMLElement | null };

export function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = h.split("?");
  return { path: path === "" ? "/" : "/" + path, query: new URLSearchParams(query) };
}

/** 把侧栏歌单条目与当前路由对齐：当前打开的那个歌单挂 .active。
 *  侧栏歌单既可能在首次路由后才由登录数据画出来，也可能因增删/收藏变化重画，
 *  所以路由切换与每次重画后都要同步一次。 */
function syncSidebarActive() {
  const currentHash = location.hash || "#/";
  document.querySelectorAll<HTMLAnchorElement>(".playlists a.pl").forEach((a) => {
    // href 可能是插件注册的自定义路由，因此按完整 hash 对齐，而不是只认 /playlist
    const hrefHash = new URL(a.getAttribute("href") || "", location.href).hash || "#/";
    a.classList.toggle("active", hrefHash === currentHash);
  });
}

let mountedCleanup: (() => void) | null = null;
// 动作打断：每次导航自增。晚到的旧渲染（慢视图 await 恢复后）按代际号判定已被打断，
// 丢弃结果并补跑 cleanup，绝不允许覆盖新导航的页面。
let renderGen = 0;

// —— 顶带返回按钮（搜索框旁）：自维护的路由栈判定「有没有可返回的上级」，
// 不依赖浏览器 history.length（其它标签/窗口共享计数、file:// 下语义不一）。
// hash 赋值（location.hash=… / <a href="#…">）走 hashchange = 新导航压栈；
// 真·返回（我们按钮的 history.back() 或鼠标侧键）落在栈的相邻项上 → 移动指针。
const routeStack: string[] = [];
let stackPos = -1;
let backBtn: HTMLButtonElement | null = null;

function syncRouteStack() {
  const cur = location.hash || "#/";
  if (stackPos >= 0 && routeStack[stackPos] === cur) { /* 同址刷新视图：不动栈 */ }
  else if (stackPos > 0 && routeStack[stackPos - 1] === cur) stackPos--;      // 返回
  else if (stackPos < routeStack.length - 1 && routeStack[stackPos + 1] === cur) stackPos++; // 前进
  else { routeStack.splice(stackPos + 1); routeStack.push(cur); stackPos = routeStack.length - 1; }
  if (backBtn) backBtn.hidden = stackPos <= 0;
}

export async function renderRoute() {
  if (!state.route) return;
  const { path, query } = currentRoute();
  const gen = ++renderGen;
  syncRouteStack();
  // 导航高亮
  document.querySelectorAll<HTMLElement>(".nav a").forEach((a) => {
    const p = a.dataset.route || "/";
    a.classList.toggle("active", p === path);
  });
  syncSidebarActive();
  mountedCleanup?.();
  mountedCleanup = null;

  const view = views[path] ?? sparkleViewAt(path) ?? views["/"];
  // —— 每次导航发放一个全新的 host 容器（.route > .entering）——
  // 进入动画：entering class 挂在 host 上、随 host 一起每轮换新 —— view 填充的节点
  // 一进 DOM 即匹配 .route>.entering>* 选择器，从 from 态（opacity:0）开始播放，
  // 避免先 paint 出 1 再跳回 0 闪烁；class 常驻该 host，视图中途 append 的节点同样匹配。
  // （它也是竞态护栏的一半：晚到的旧渲染写的是已脱离 DOM 的死容器，gen 校验会整轮丢弃。）
  // 注：这套机制曾在 feat/plugins 合并重写本函数时被误删，页面切换动画因此失效（2026-09-26 恢复）。
  const host = document.createElement("div");
  host.className = "entering";
  state.route.replaceChildren(host);
  state.route.scrollTop = 0;
  try {
    const cleanup = await view(host, query);
    if (gen !== renderGen) {
      if (typeof cleanup === "function") cleanup();
      return;
    }
    if (typeof cleanup === "function") mountedCleanup = cleanup;
  } catch (e) {
    console.error(e);
    if (gen !== renderGen) return;
    host.innerHTML = `<div class="muted">页面加载失败：${String((e as Error).message ?? e)}</div>`;
  }
  player.markActive();
}

export function bootShell() {
  // 背景层（关闭背景 / 专辑封面 / 自定义图片 + 模糊强度）由 lib/ambient.ts 接管；
  // 高亮色（固定青色 / 跟随封面 / 自定义色）由 lib/tint.ts 接管；浮层菜单的毛玻璃
  // （右键菜单 / 音质·播放模式·音量浮窗 / 正在播放页「更多操作」）由 lib/menu-glass.ts 接管 ——
  // 三者都可能被 Sparkle 主题接管，是同一套「宿主功能 ⇄ 主题插件」归属口径，各归各的模块。
  bootBackground();
  bootTint();
  bootMenuGlass();

  const frame = document.createElement("div");
  frame.className = "frame";
  frame.innerHTML = `
    <!-- CSD：无标题栏、无浮窗。三钮（min/max/close）+抓握点平铺窗口右上角，簇底即拖拽区；
         搜索框所在整条顶带同样是拖拽把手，由顶带内的 .top-drag 层承担（右缘让开按钮簇——
         drag 矩形会吞掉其下所有指针事件，按钮的 no-drag 只在同子树内豁免） -->
    <div class="win-dragtop" aria-hidden="true"></div>
    <div class="winbtns" data-csd-drag>
      <span class="win-grip" aria-hidden="true"><svg viewBox="0 0 16 12" width="14" height="11"><g fill="currentColor"><circle cx="4" cy="3.5" r="1.1"/><circle cx="8" cy="3.5" r="1.1"/><circle cx="12" cy="3.5" r="1.1"/><circle cx="4" cy="8.5" r="1.1"/><circle cx="8" cy="8.5" r="1.1"/><circle cx="12" cy="8.5" r="1.1"/></g></svg></span>
      <button aria-label="最小化" data-win="min"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 6h8" stroke="currentColor" stroke-width="1.2"/></svg></button>
      <button aria-label="最大化" data-win="max"><svg viewBox="0 0 12 12" width="11" height="11"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
      <button aria-label="关闭" data-win="close"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2"/></svg></button>
    </div>
    <div class="body">
      <aside class="sidebar">
        <a class="user" id="user-header" href="#/login" title="点击登录">
          <span class="avatar" id="avatar">${icons.userPh}</span>
          <span class="user-meta">
            <span class="nick" id="nick">未登录</span>
            <span class="badges" id="badges"></span>
          </span>
        </a>
        <nav class="nav">
          ${nav.map((n) => `<a href="${n.path}" data-route="${n.path.slice(1) || "/"}" title="${n.label}">${icons[n.icon]}<span>${n.label}</span></a>`).join("")}
        </nav>
        <hr class="sep" />
        <div class="playlists" id="playlists"><div class="pl-empty">登录后可见歌单</div></div>
        <!-- 侧栏底部：设置（齿轮）+ 缩回/展开。缩态下竖排居中，是缩态保留的两颗按钮之一。 -->
        <div class="side-foot">
          <a class="side-btn settings" href="#/settings" title="设置" aria-label="设置">${icons.settings}</a>
          <button class="side-btn" id="side-collapse" type="button" title="缩回侧栏" aria-label="缩回侧栏">${icons.collapse}</button>
        </div>
      </aside>
      <main class="content">
        <div class="content-top"></div>
        <div class="content-body">
          <div class="route" id="route"></div>
          <!-- 队列面板停靠位：QueuePanel 宽度足够时挂到这里（.dock），route 自动让宽；
               宽度不够时挂回 body 变浮窗（.float）。挂载由 QueuePanel 自身管理。 -->
        </div>
      </main>
    </div>
  `;
  document.body.prepend(frame);
  state.content = frame.querySelector<HTMLElement>(".content")!;
  state.route = frame.querySelector<HTMLElement>("#route")!;

  // —— 侧栏宽度：可拖拽（侧栏与内容区接缝处的分隔条），持久化在 Window.SidebarWidth。
  //    宽度走 <body> 上的 --side-w 变量驱动 .sidebar 的 flex-basis（缩态 64px 由
  //    body.side-collapsed 的高优先级规则接管，与变量互不干扰）；双击恢复内置默认。 ——
  const SIDEBAR_DEFAULT_W = 216;
  const SIDEBAR_MIN_W = 180;
  const SIDEBAR_MAX_W = 440;
  const applySideW = (px: number | null) => {
    if (px == null) document.body.style.removeProperty("--side-w");
    else document.body.style.setProperty("--side-w", `${px}px`);
  };
  let sideW = getSidebarWidth() ?? SIDEBAR_DEFAULT_W;
  applySideW(getSidebarWidth());
  // 上限再让一层给窗口：内容区至少留 320px 可用，极窄窗口时上限自动收
  const clampSideW = (w: number) =>
    Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, window.innerWidth - 320, w)));
  const sideResizer = document.createElement("div");
  sideResizer.className = "side-resizer";
  sideResizer.title = "拖拽调整侧栏宽度；双击恢复默认";
  state.content.before(sideResizer);
  bindHResizer(sideResizer, {
    start: () => sideW,
    move: (w) => {
      sideW = clampSideW(w);
      document.body.classList.add("side-resizing"); // 停掉 .sidebar 的宽度过渡，跟手
      applySideW(sideW);
    },
    end: () => {
      document.body.classList.remove("side-resizing");
      setSidebarWidth(sideW);
    },
    dbl: () => {
      sideW = SIDEBAR_DEFAULT_W;
      applySideW(null);
      setSidebarWidth(null);
    },
  });
  // 搜索框常驻壳层顶带（.content-top，与 CSD 按钮簇同一水平带）：路由切换/视图刷新只重建 #route，
  // 它不动；顶带把标题行整个让给页面内容，窄窗口下不再互相遮挡。
  // 返回按钮 = 搜索框的兄弟节点（同一个居中组里），没有可返回的上级时隐藏（syncRouteStack）。
  const top = state.content.querySelector<HTMLElement>(".content-top")!;
  const topCenter = document.createElement("div");
  topCenter.className = "top-center";
  backBtn = document.createElement("button");
  backBtn.className = "top-back";
  backBtn.type = "button";
  backBtn.setAttribute("aria-label", "返回上级");
  backBtn.title = "返回上级";
  backBtn.innerHTML = BACK_SVG;
  backBtn.hidden = true;
  backBtn.onclick = () => {
    if (stackPos > 0) { stackPos--; history.back(); } // renderRoute/hashchange 不会再压栈（同址判定）
  };
  topCenter.append(backBtn, SearchBox());
  // CSD 拖拽把手层：顶带内的独立层（右缘让开窗口按钮簇，几何见 style.css .top-drag 注释）。
  // 放在 .top-center 之前 → DOM 序在后者的下层，搜索组照样收得到指针事件。
  const topDrag = document.createElement("div");
  topDrag.className = "top-drag";
  topDrag.setAttribute("aria-hidden", "true");
  top.append(topDrag, topCenter);
  // 播放条必须在 .frame 流内（占 flex 高度）；np/队列是 fixed 覆盖层，挂 body 即可
  frame.append(PlayerBar());
  document.body.append(NowPlaying(), QueuePanel());

  window.addEventListener("hashchange", renderRoute);

  // CSD 按钮：Electron 壳层里走 quaverCSD 桥；浏览器/dev 下仅派发事件占位
  document.querySelectorAll<HTMLElement>("[data-win]").forEach((b) =>
    b.addEventListener("click", () => {
      const csd = (window as any).quaverCSD;
      if (csd?.[b.dataset.win!]) csd[b.dataset.win!]();
      else window.dispatchEvent(new CustomEvent("quaver:window", { detail: b.dataset.win }));
    }),
  );

  // —— 每日 30 首 / 我喜欢：与侧栏歌单条目同一套交互 —— 双击立即播放，右键菜单含插队播放。
  //    两者是系统虚拟歌单（没有固定 disstid 可翻页拉详情），取歌各走专用接口：
  //    每日走 /recommend/daily（30 首一把拿全）；我喜欢走 player 的预载缓存（loadLoved
  //    自带 TTL 对账，多数时候直接命中，不打网络）。 ——
  const VIRTUAL_LISTS: Record<string, { id: string; title: string; fetch: () => Promise<Song[]> }> = {
    "/daily": {
      id: "daily",
      title: "每日 30 首",
      fetch: async () => (await api<{ songs?: Song[] }>("/recommend/daily?page=1&num=100"))?.songs ?? [],
    },
    "/liked": {
      id: "liked",
      title: "我喜欢",
      fetch: async () => ((await player.loadLoved()) ? (player.likedCache ?? []) : []),
    },
  };
  for (const a of frame.querySelectorAll<HTMLAnchorElement>(".nav a")) {
    const v = VIRTUAL_LISTS[a.dataset.route ?? ""];
    if (!v) continue;
    // 双击 = 立即播放（单击仍导航进页面；两击的第一次导航先落地，双击随即开播）
    a.addEventListener("dblclick", () => { void playSongsNow(v.title, v.fetch); });
    a.addEventListener("contextmenu", (e) => {
      e.preventDefault(); // 不弹系统菜单
      e.stopPropagation();
      openVirtualPlaylistMenu(e.clientX, e.clientY, v.title, v.fetch, a, v.id);
    });
  }

  // 侧栏缩回/展开：状态真相在 quaver.conf（Window.SidebarCollapsed），样式由 body.side-collapsed
  // 驱动（启动时的初始 class 已在 main.ts 的 applySidebar() 里挂好，这里只接管交互后同步）。
  // 图标方向靠 CSS 翻转，按钮文案/aria 得跟着状态走，否则缩态下读屏与悬停提示是反的。
  const collapseBtn = frame.querySelector<HTMLButtonElement>("#side-collapse")!;
  const syncCollapseBtn = () => {
    const off = document.body.classList.contains("side-collapsed");
    const label = off ? "展开侧栏" : "缩回侧栏";
    collapseBtn.title = label;
    collapseBtn.setAttribute("aria-label", label);
    collapseBtn.setAttribute("aria-expanded", String(!off));
  };
  collapseBtn.addEventListener("click", () => {
    setSidebarCollapsed(!getSidebarCollapsed());
    syncCollapseBtn();
  });
  syncCollapseBtn();

  bootSidebar();
  renderRoute();
}

/** 插件侧栏导航项（Sparkle host 调用）：复用内置 nav 的 DOM 形态，追加在内置项之后。
 *  返回锚点元素 —— 停用插件时由 host 移除。高亮逻辑复用 renderRoute 的 .nav a 扫描。 */
export function addNavItem(item: SparkleNavItem): HTMLElement {
  const a = document.createElement("a");
  a.href = item.path;
  a.dataset.route = item.path.replace(/^#\//, "");
  a.title = item.label;
  a.innerHTML = `${item.iconSvg ?? icons.sparkle}<span>${esc(item.label)}</span>`;
  document.querySelector(".nav")!.append(a);
  return a;
}

// 侧栏状态（头像/昵称/会员徽章/歌单）
// 歌单分两团：我创建的歌单（PlaylistBaseRead）+ 收藏的歌单（PlaylistFavRead，见 lib/favs）。
// 后者独立拉取、失败只影响本团；收藏态变化（歌单页红心）经 favs 订阅即时回灌侧栏。
let sidebarCreated: any[] = [];
let sidebarFavsReady = false;
let sidebarPainted = false; // 首次 renderSidebarPlaylists 后才允许插件触发重画（登录前保持占位）

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// 单个歌单条目：封面 + 标题（副行可选，收藏的歌单用来标创建者）
// title 恒给：侧栏缩回后只剩封面图，鼠标悬停是唯一认得出来的途径。
// menu 给了（自建/收藏两团）就挂双击播放与右键菜单；插件歌单组不挂。
function plItem(x: any, sub = "", menu?: { kind: PlaylistMenuOptions["kind"]; onDeleted?: (pl: any) => void }): HTMLElement {
  const a = document.createElement("a");
  a.className = "pl";
  const pic = upPic(x.picurl || x.bigpic_url);
  const title = String(x.title ?? "歌单");
  a.title = sub ? `${title} · ${sub}` : title;
  a.innerHTML = `<span class="thumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
    <span class="pname"><span class="ptitle">${esc(title)}</span>${sub ? `<span class="psub">${esc(sub)}</span>` : ""}</span>`;
  a.href = `#/playlist?id=${encodeURIComponent(x.id ?? "")}&name=${encodeURIComponent(x.title ?? "歌单")}`;
  if (menu) {
    // 双击 = 直接播放该歌单（单击仍导航进歌单页；两击的第一次导航先落地，双击随即开播）
    a.addEventListener("dblclick", () => { void playPlaylistNow(x); });
    a.addEventListener("contextmenu", (e) => {
      e.preventDefault(); // 不弹系统菜单
      e.stopPropagation();
      openPlaylistMenu(e.clientX, e.clientY, x, menu, a);
    });
  }
  return a;
}

function renderSidebarPlaylists(box: HTMLElement) {
  sidebarPainted = true;
  const favs = sidebarFavsReady ? favSonglists() : null; // null = 尚未拉回：不画空态，避免闪一下「暂无」
  const sparkGroups = sparkleSonglistGroups().map((g) => ({ label: g.label, items: g.items() }));
  box.innerHTML = "";
  if (!sidebarCreated.length && !favs?.length && !sparkGroups.some((g) => g.items.length)) {
    box.innerHTML = `<div class="pl-empty">暂无歌单</div>`;
    return;
  }
  const group = (label: string, list: any[], sub: (x: any) => string, menu?: { kind: PlaylistMenuOptions["kind"]; onDeleted?: (pl: any) => void }) => {
    if (!list.length) return;
    const head = document.createElement("div");
    head.className = "pl-group";
    head.innerHTML = `<span>${label}</span><span class="pl-cnt">${list.length}</span>`;
    box.append(head);
    for (const x of list) box.append(plItem(x, sub(x), menu));
  };
  // 自建歌单删除成功后从侧栏数据里摘掉并重画（playlists 数据层缓存由 deleteSonglist 自理）；
  // 正开着被删歌单的详情页则立刻重渲染回上游真实状态，不留「还在」的缓存假象
  group("我创建的歌单", sidebarCreated, () => "", {
    kind: "created",
    onDeleted: (x) => {
      const at = sidebarCreated.indexOf(x);
      if (at >= 0) sidebarCreated.splice(at, 1);
      renderSidebarPlaylists(box);
      const { path, query } = currentRoute();
      if (path === "/playlist" && String(query.get("id") ?? "") === String(x.id)) void renderRoute();
    },
  });
  // 收藏歌单取消收藏后由 favs 订阅重画（bootSidebar 已挂监听），这里不用回调
  group("收藏的歌单", favs ?? [], (x) => (x.nickname ? `${x.nickname} 创建` : ""), { kind: "fav" });
  // 插件自定义歌单组（Sparkle）：条目 href 由插件给定（通常是它自己注册的路由）
  for (const g of sparkGroups) {
    if (!g.items.length) continue;
    const head = document.createElement("div");
    head.className = "pl-group";
    head.innerHTML = `<span>${esc(g.label)}</span><span class="pl-cnt">${g.items.length}</span>`;
    box.append(head);
    for (const item of g.items) {
      const a = document.createElement("a");
      a.className = "pl";
      const pic = upPic(item.picurl ?? "");
      a.title = item.title;
      a.href = item.href;
      a.innerHTML = `<span class="thumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
        <span class="pname"><span class="ptitle">${esc(item.title)}</span></span>`;
      box.append(a);
    }
  }
  syncSidebarActive();
}

/** 侧栏歌单区重画（Sparkle 注册/反注册歌单组时调用）。登录前不重画（保持占位样式） */
export function repaintSidebarPlaylists() {
  if (!sidebarPainted) return;
  const box = document.getElementById("playlists");
  if (box) renderSidebarPlaylists(box);
}

async function bootSidebar() {
  try {
    const st: any = await api("/login/status");
    if (!st?.logged_in) return; // 未登录：保持占位样式
    // 「我喜欢」预载：全站红心态（行内红心/播放条）都读它，登录确认后立刻后台拉回，不阻塞首屏
    void player.loadLoved();
    const [me, vip] = await Promise.all([
      api<any>("/user/me").catch(() => null),
      api<any>("/user/vip").catch(() => null),
    ]);
    const base = me?.base_info;
    if (!base?.name) return;
    document.querySelector("#user-header")!.setAttribute("href", "#/user");
    document.querySelector<HTMLElement>("#avatar")!.innerHTML = base.avatar
      ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>`
      : icons.userPh;
    document.getElementById("nick")!.textContent = base.name;
    // 徽章数据驱动：会员最高档（橙=超级会员/绿=绿钻系）+ 音乐人（蓝）
    document.getElementById("badges")!.innerHTML = identityBadges(me, vip);

    // 我喜欢（dirid=201 固定）不进歌单列表——导航栏已有入口
    const pl: any = await api("/user/created-songlists").catch(() => null);
    sidebarCreated = (pl?.playlists ?? []).filter((p: any) => p.dirid !== 201);
    const box = document.getElementById("playlists")!;
    renderSidebarPlaylists(box);

    // 收藏的歌单：与创建列表分开拉（未登录/上游失败都不影响已有内容）
    onFavSonglistsChange(() => renderSidebarPlaylists(box));
    loadFavSonglists()
      .catch(() => {})
      .finally(() => { sidebarFavsReady = true; renderSidebarPlaylists(box); });
  } catch (e) {
    console.warn("sidebar boot failed", e);
  }
}
