// Quaver — SPA 壳层（入口 main.ts 调用 bootShell）
// 顶栏/侧栏/播放条/正在播放页/队列面板 = 常驻不销毁；
// .content 内 = 常驻搜索框（.content-top）+ 按路由切换的视图区（.route），
// 切视图不打断音频、搜索框与输入状态不随视图重建。地址栏 hash 路由
// （file:// 与壳层加载均兼容），旧的多页入口（daily.html 等）保留为薄跳转层。
import "./style.css";
import { api, coverUrl, upPic, identityBadges } from "./lib/api";
import { favSonglists, loadFavSonglists, onFavSonglistsChange } from "./lib/favs";
import { getSidebarCollapsed, setSidebarCollapsed } from "./lib/prefs";
import { player } from "./player";
import { PlayerBar } from "./components/PlayerBar";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";
import { SearchBox } from "./components/SearchBox";
import { views, BACK_SVG } from "./views";
import { extractCoverColor, toUiColors, type RGB } from "./lib/color";

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
  syncRouteStack();
  // 导航高亮
  document.querySelectorAll<HTMLElement>(".nav a").forEach((a) => {
    const p = a.dataset.route || "/";
    a.classList.toggle("active", p === path);
  });
  mountedCleanup?.();
  mountedCleanup = null;

  const view = views[path] ?? sparkleViewAt(path) ?? views["/"];
  state.route.innerHTML = "";
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

// UI 染色：把封面主色提升到 :root 的 --cvg-accent / --cvg-glow，供全局高亮/条目背景消费。
// 与 ambient 环境层同源（同张封面），无色（未播放/中继不可用）则移除变量，CSS 回落默认强调色。
// 与 PlayerBar 的 --tint/--tint-line 互不干扰：播放条进度条仍用自己的颜色对。
function applyCoverTint(rgb: RGB | null) {
  const root = document.documentElement;
  const c = toUiColors(rgb);
  if (!c) {
    root.style.removeProperty("--cvg-accent");
    root.style.removeProperty("--cvg-glow");
    return;
  }
  root.style.setProperty("--cvg-accent", c.accent);
  root.style.setProperty("--cvg-glow", c.glow);
}

export function bootShell() {  // 环境色层：当前封面高斯模糊铺满窗口，供侧栏/播放条等玻璃面板透出色彩
  const ambient = document.createElement("div");
  ambient.className = "ambient";
  ambient.innerHTML = `<div class="ambient-art"></div>`;
  document.body.prepend(ambient);
  const ambArt = ambient.querySelector<HTMLElement>(".ambient-art")!;
  let ambPic = "";
  player.on(() => {
    const pic = player.current ? coverUrl(player.current, 300) : "";
    if (pic === ambPic) return;
    ambPic = pic;
    if (!pic) { ambArt.classList.remove("ready"); applyCoverTint(null); return; }
    const img = new Image();
    img.onload = () => {
      if (ambPic !== pic) return; // 期间已换曲
      ambArt.style.backgroundImage = `url("${pic}")`;
      ambArt.classList.add("ready");
    };
    img.onerror = () => { if (ambPic === pic) ambArt.classList.remove("ready"); }; // 封面 404：保持中性底
    img.src = pic;
    // UI 高亮/条目背景染色：与 ambient 同源，提取主色写入 :root 供全局消费
    // （extractCoverColor 有 url 缓存，与 PlayerBar 各取一份不重复请求网络）
    void extractCoverColor(pic).then((rgb) => { if (ambPic === pic) applyCoverTint(rgb); });
  });

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
function plItem(x: any, sub = ""): HTMLElement {
  const a = document.createElement("a");
  a.className = "pl";
  const pic = upPic(x.picurl || x.bigpic_url);
  const title = String(x.title ?? "歌单");
  a.title = sub ? `${title} · ${sub}` : title;
  a.innerHTML = `<span class="thumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
    <span class="pname"><span class="ptitle">${esc(title)}</span>${sub ? `<span class="psub">${esc(sub)}</span>` : ""}</span>`;
  a.href = `#/playlist?id=${encodeURIComponent(x.id ?? "")}&name=${encodeURIComponent(x.title ?? "歌单")}`;
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
  const group = (label: string, list: any[], sub: (x: any) => string) => {
    if (!list.length) return;
    const head = document.createElement("div");
    head.className = "pl-group";
    head.innerHTML = `<span>${label}</span><span class="pl-cnt">${list.length}</span>`;
    box.append(head);
    for (const x of list) box.append(plItem(x, sub(x)));
  };
  group("我创建的歌单", sidebarCreated, () => "");
  group("收藏的歌单", favs ?? [], (x) => (x.nickname ? `${x.nickname} 创建` : ""));
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
