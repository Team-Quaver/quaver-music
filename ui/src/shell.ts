// Quaver — SPA 壳层（入口 main.ts 调用 bootShell）
// 骨架 = Verse：v-titlebar(36) / [v-nav(220) + 内容区] / v-player(76)，三者常驻不销毁。
// .route 按 hash 路由切换；切视图不打断音频、搜索框输入状态不随视图重建。
// 旧的多页入口（daily.html 等）保留为薄跳转层。
import "./verse/verse-tokens.css";
import "./verse/verse-components.css";
import "./verse/verse-app.css";
import "./style.css";
import { api, upPic, identityBadges } from "./lib/api";
import { favSonglists, loadFavSonglists, onFavSonglistsChange } from "./lib/favs";
import { player } from "./player";
import { PlayerBar } from "./components/PlayerBar";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";
import { SearchBox } from "./components/SearchBox";
import { views } from "./views";
import { icon } from "./verse/icons";
import { cfg, cfgSetSoon } from "./lib/config";

export const nav = [
  { id: "home", path: "#/", label: "首页", icon: "home" },
  { id: "foryou", path: "#/guess", label: "猜你喜欢", icon: "discover" },
  { id: "daily", path: "#/daily", label: "每日 30 首", icon: "repeat" },
] as const;

export const navMine = [
  { id: "like", path: "#/liked", label: "我喜欢", icon: "heart" },
] as const;

// content = .q-content 主内容区整体；route = 内容区里可被路由替换的部分。
export const state = { content: null as HTMLElement | null, route: null as HTMLElement | null };

export function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = h.split("?");
  return { path: path === "" ? "/" : "/" + path, query: new URLSearchParams(query) };
}

let mountedCleanup: (() => void) | null = null;

// —— 路由栈（标题栏后退/前进按钮）：自维护，不依赖 history.length ——
// hash 赋值走 hashchange = 新导航压栈；按钮的 history.back()/forward() 落在相邻项 → 移动指针。
const routeStack: string[] = [];
let stackPos = -1;
let backBtn: HTMLButtonElement | null = null;
let fwdBtn: HTMLButtonElement | null = null;

function syncRouteStack() {
  const cur = location.hash || "#/";
  if (stackPos >= 0 && routeStack[stackPos] === cur) { /* 同址刷新视图：不动栈 */ }
  else if (stackPos > 0 && routeStack[stackPos - 1] === cur) stackPos--;      // 返回
  else if (stackPos < routeStack.length - 1 && routeStack[stackPos + 1] === cur) stackPos++; // 前进
  else { routeStack.splice(stackPos + 1); routeStack.push(cur); stackPos = routeStack.length - 1; }
  if (backBtn) backBtn.disabled = stackPos <= 0;
  if (fwdBtn) fwdBtn.disabled = stackPos < 0 || stackPos >= routeStack.length - 1;
}

export async function renderRoute() {
  if (!state.route) return;
  const { path, query } = currentRoute();
  syncRouteStack();
  // 导航高亮：主导航按路由；歌单项按 #/playlist?id= 精确匹配
  const cur = location.hash || "#/";
  document.querySelectorAll<HTMLElement>("#mainnav .v-nav__item").forEach((b) => {
    const r = b.dataset.route || "";
    const on = r.startsWith("#/playlist?id=")
      ? cur === r
      : (r === "#/" ? path === "/" : r === `#${path}` || cur.startsWith(r + "?") || cur.startsWith(r + "&"));
    b.classList.toggle("v-nav__item--active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  mountedCleanup?.();
  mountedCleanup = null;

  const view = views[path] ?? views["/"];
  state.route.innerHTML = "";
  state.route.scrollTop = 0;
  try {
    const cleanup = await view(state.route, query);
    if (typeof cleanup === "function") mountedCleanup = cleanup;
  } catch (e) {
    console.error(e);
    state.route.innerHTML = `<div class="body-14" style="color: var(--ink-muted)">页面加载失败：${String((e as Error).message ?? e)}</div>`;
  }
  player.markActive();
}

export function bootShell() {
  if (/^mac/i.test(navigator.platform)) document.body.classList.add("mac"); // macOS：隐藏窗口钮，左侧留 80px 给红绿灯

  const frame = document.createElement("div");
  frame.className = "q-frame";
  frame.innerHTML = `
    <div class="v-titlebar v-drag">
      <span class="v-titlebar__brand">Quaver</span>
      <div class="v-titlebar__nav v-nodrag">
        <button type="button" class="v-iconbtn v-iconbtn--sm" id="nav-back" aria-label="后退" title="后退">${icon("chevronLeft", 16)}</button>
        <button type="button" class="v-iconbtn v-iconbtn--sm" id="nav-fwd" aria-label="前进" title="前进" disabled>${icon("chevronRight", 16)}</button>
      </div>
      <div class="v-titlebar__nav v-nodrag" id="title-search"></div>
      <div class="v-titlebar__spacer"></div>
      <div class="v-titlebar__win v-nodrag" id="winbtns">
        <button type="button" data-win="min" aria-label="最小化" title="最小化">${icon("minimize", 14)}</button>
        <button type="button" data-win="max" aria-label="最大化" title="最大化">${icon("maximize", 13)}</button>
        <button type="button" data-win="close" aria-label="关闭" title="关闭">${icon("close", 14)}</button>
      </div>
    </div>
    <div class="q-body">
      <aside class="q-side">
        <a class="q-user" id="user-header" href="#/login" title="点击登录">
          <span class="q-avatar" id="avatar">${icon("discover", 22)}</span>
          <span class="q-user-meta">
            <span class="q-nick" id="nick">未登录</span>
            <span class="badges" id="badges"></span>
          </span>
        </a>
        <div class="q-side-sep" aria-hidden="true"></div>
        <nav class="v-nav" aria-label="主导航" id="mainnav"></nav>
        <div class="q-playlists" id="playlists"><div class="caption-12" style="padding: 0 12px">登录后可见歌单</div></div>
        <button type="button" class="v-nav__item" id="nav-settings">
          ${icon("settings")} <span class="ellipsis">设置</span>
        </button>
      </aside>
      <div class="q-side-resizer" role="separator" aria-orientation="vertical" title="拖拽调整侧栏宽度（双击恢复默认）"></div>
      <main class="q-content">
        <div class="route" id="route"></div>
      </main>
    </div>
  `;
  document.body.prepend(frame);
  state.content = frame.querySelector<HTMLElement>(".q-content")!;
  state.route = frame.querySelector<HTMLElement>("#route")!;

  // —— 侧栏宽度：拖拽条调节（不随窗口宽度变化），持久化到 quaver.conf 的 Window.SidebarWidth ——
  const SB_MIN = 180, SB_MAX = 400, SB_DEF = 220;
  const clampW = (w: number) => Math.min(SB_MAX, Math.max(SB_MIN, Math.round(w)));
  const setSidebarW = (w: number) => {
    const px = clampW(w);
    document.documentElement.style.setProperty("--sidebar-w", `${px}px`); // 行内覆盖 verse-tokens 的 :root 定义
    cfgSetSoon({ "Window.SidebarWidth": String(px) }); // 拖拽高频：合并落盘
  };
  const savedW = Number(cfg("Window.SidebarWidth", String(SB_DEF)));
  document.documentElement.style.setProperty("--sidebar-w", `${clampW(Number.isFinite(savedW) ? savedW : SB_DEF)}px`);

  const resizer = frame.querySelector<HTMLElement>(".q-side-resizer")!;
  const side = frame.querySelector<HTMLElement>(".q-side")!;
  let drag: { x: number; w: number } | null = null;
  resizer.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, w: side.getBoundingClientRect().width };
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("sidebar-resizing");
  });
  resizer.addEventListener("pointermove", (e) => {
    if (drag) setSidebarW(drag.w + e.clientX - drag.x);
  });
  const endDrag = () => { drag = null; document.body.classList.remove("sidebar-resizing"); };
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);
  resizer.addEventListener("dblclick", () => setSidebarW(SB_DEF));

  // 主导航按钮（bundle SidebarNav 同构：button + aria-current）
  const mainnav = frame.querySelector<HTMLElement>("#mainnav")!;
  const navBtn = (id: string, path: string, label: string, ic: string, count?: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "v-nav__item";
    b.dataset.route = path;
    b.dataset.nid = id;
    b.innerHTML = `${icon(ic as any)}<span class="ellipsis">${label}</span>${count != null ? `<span class="v-nav__count">${count}</span>` : ""}`;
    b.onclick = () => { location.hash = path; };
    return b;
  };
  for (const n of nav) mainnav.append(navBtn(n.id, n.path, n.label, n.icon));
  const mineGroup = document.createElement("div");
  mineGroup.className = "v-nav__group";
  mineGroup.textContent = "我的音乐";
  mainnav.append(mineGroup);
  for (const n of navMine) mainnav.append(navBtn(n.id, n.path, n.label, n.icon));
  frame.querySelector("#nav-settings")!.addEventListener("click", () => { location.hash = "#/settings"; });

  // 全局键鼠（Verse 桌面交互契约）：空格播放/暂停、M 静音、←/→ 快退快进 5 秒。
  // 输入框/下拉/滑块获得焦点时让路（它们的按键语义优先）。
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, select, textarea, [role='slider'], [role='switch'], [role='option'], .v-menu, [role='menu'], .v-sel")) return;
    if (e.key === " " && !t.closest("button, a, [role='button']")) {
      e.preventDefault();
      player.toggle();
    } else if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !t.closest("button, a")) {
      player.toggleMute();
    } else if (e.key === "ArrowLeft" && !t.closest(".v-row, .qp-row")) {
      e.preventDefault();
      if (player.duration) player.seek(player.time - 5);
    } else if (e.key === "ArrowRight" && !t.closest(".v-row, .qp-row")) {
      e.preventDefault();
      if (player.duration) player.seek(player.time + 5);
    }
  });

  frame.querySelector("#title-search")!.append(SearchBox());
  backBtn = frame.querySelector("#nav-back")!;
  fwdBtn = frame.querySelector("#nav-fwd")!;
  backBtn.onclick = () => { if (stackPos > 0) { stackPos--; history.back(); } };
  fwdBtn.onclick = () => { if (stackPos < routeStack.length - 1) { stackPos++; history.forward(); } };

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

  bootSidebar();
  renderRoute();
}

// 侧栏状态（头像/昵称/会员徽章/歌单）
// 歌单分两团：我创建的歌单 + 收藏的歌单（见 lib/favs），后者独立拉取、失败只影响本团。
let sidebarCreated: any[] = [];
let sidebarFavsReady = false;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// 单个歌单条目：v-nav__item 范式 + 封面缩略图（设计无此部件，为真实功能做的范式扩展）
function plItem(x: any, sub = ""): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "v-nav__item q-pl";
  const href = `#/playlist?id=${encodeURIComponent(x.id ?? "")}&name=${encodeURIComponent(x.title ?? "歌单")}`;
  b.dataset.route = href;
  const pic = upPic(x.picurl || x.bigpic_url);
  b.innerHTML = `<span class="q-plthumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
    <span class="q-plmeta"><span class="q-pltitle">${esc(x.title ?? "歌单")}</span>${sub ? `<span class="q-plsub">${esc(sub)}</span>` : ""}</span>`;
  b.title = String(x.title ?? "歌单");
  b.onclick = () => { location.hash = href; };
  return b;
}

function renderSidebarPlaylists(box: HTMLElement) {
  const favs = sidebarFavsReady ? favSonglists() : null; // null = 尚未拉回：不画空态，避免闪一下「暂无」
  box.innerHTML = "";
  if (!sidebarCreated.length && !favs?.length) return; // 无歌单时留空，不写空态文案
  const group = (label: string, list: any[], sub: (x: any) => string) => {
    if (!list.length) return;
    const head = document.createElement("div");
    head.className = "v-nav__group";
    head.innerHTML = `${esc(label)}<span class="v-nav__count">${list.length}</span>`;
    box.append(head);
    for (const x of list) box.append(plItem(x, sub(x)));
  };
  group("我创建的歌单", sidebarCreated, () => "");
  group("收藏的歌单", favs ?? [], (x) => (x.nickname ? `${x.nickname} 创建` : ""));
}

async function bootSidebar() {
  try {
    const st: any = await api("/login/status");
    if (!st?.logged_in) return; // 未登录：保持占位样式
    // 「我喜欢」预载：全站红心态都读它，登录确认后立刻后台拉回，不阻塞首屏
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
      : icon("discover", 22);
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
