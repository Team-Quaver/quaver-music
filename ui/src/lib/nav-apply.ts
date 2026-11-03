// Quaver — 侧栏主菜单的自定义布局（顺序 / 隐藏项）与「更多」浮窗。
//
// 整块按需加载：默认布局由 shell 直接写出，只有用户改过 [Style] NavOrder / NavHidden
// 时壳层才 import 本模块套用；设置页编辑时也走这里。这样默认用户的 200KiB 首屏预算
// 不被这套低频功能占掉（verify:bundle 是硬线）。
//
// 数据：顺序/隐藏 = 逗号分隔的内置导航 id。合法 id 清单与图标在 nav-items.ts；
// 「歌单」在高效模式下另有 CSS 自动隐藏，与这里的用户显隐正交。
import { cfg, cfgSet } from "./config";
import { NAV_DEFAULT_ORDER, NAV_IDS, NAV_MORE_ICON, navItemOf, type NavItem } from "./nav-items";

const NAV_ID_SET = new Set(NAV_IDS);

const parse = (raw: string): string[] =>
  String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** 配置值 → 完整顺序：未知 id 丢弃、重复只留第一次、缺项按声明顺序补到末尾。 */
export function normalizeNavOrder(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const id of parse(raw)) {
    if (!NAV_ID_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  for (const id of NAV_IDS) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

/** 配置值 → 隐藏集合：只保留合法且不重复的 id。 */
export function normalizeNavHidden(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const id of parse(raw)) {
    if (!NAV_ID_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

export function getNavOrder(): string[] {
  return normalizeNavOrder(cfg("Style.NavOrder", NAV_DEFAULT_ORDER));
}

export function getNavHidden(): string[] {
  return normalizeNavHidden(cfg("Style.NavHidden"));
}

/** 用户是否改过默认布局（壳层据此决定要不要加载本模块）。 */
export function navLayoutIsCustomized(): boolean {
  return getNavHidden().length > 0 || getNavOrder().join(",") !== NAV_DEFAULT_ORDER;
}

const navPathOf = (item: NavItem) => item.path.slice(1) || "/";

const currentPath = () => {
  const h = location.hash.replace(/^#\/?/, "");
  const [path] = h.split("?");

  return path === "" ? "/" : "/" + path;
};

let navMoreBtn: HTMLButtonElement | null = null;
let navMorePop: HTMLElement | null = null;
let listenersBound = false;

function makeNavAnchor(item: NavItem, hidden: boolean): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = item.path;
  a.dataset.route = navPathOf(item);
  a.dataset.navId = item.id;
  a.title = item.label;
  a.innerHTML = `${item.iconSvg}<span></span>`;
  a.querySelector("span")!.textContent = item.label;
  a.hidden = hidden;

  return a;
}

function closeNavMore() {
  if (!navMorePop || navMorePop.hidden) return;
  navMorePop.hidden = true;
  navMoreBtn?.classList.remove("is-open");
  navMoreBtn?.setAttribute("aria-expanded", "false");
}

function ensureNavMorePop(): HTMLElement {
  if (navMorePop) return navMorePop;

  const pop = document.createElement("div");
  pop.className = "nav-more-pop";
  pop.hidden = true;
  pop.setAttribute("role", "menu");
  document.body.append(pop);
  navMorePop = pop;

  document.addEventListener("pointerdown", (e) => {
    const t = e.target instanceof Node ? e.target : null;

    if (!pop.hidden && t && !pop.contains(t) && !navMoreBtn?.contains(t)) closeNavMore();
  }, true);

  return pop;
}

function fillNavMore(ids: string[]) {
  const pop = ensureNavMorePop();
  const current = currentPath();

  pop.replaceChildren();

  for (const id of ids) {
    const item = navItemOf(id);

    if (!item) continue;

    const a = document.createElement("a");
    a.className = "nav-pop-item";
    a.href = item.path;
    a.setAttribute("role", "menuitem");
    a.title = item.label;
    a.innerHTML = `<span class="nav-pop-ico">${item.iconSvg}</span><span class="nav-pop-tx"></span>`;
    a.querySelector(".nav-pop-tx")!.textContent = item.label;
    a.classList.toggle("active", navPathOf(item) === current);
    a.addEventListener("click", closeNavMore);
    pop.append(a);
  }
}

function positionNavMore() {
  if (!navMorePop || !navMoreBtn) return;

  const r = navMoreBtn.getBoundingClientRect();
  const w = navMorePop.offsetWidth;
  const h = navMorePop.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right + 10));
  // 浮窗底边对齐按钮底边（按钮通常靠近栏底），再夹进视口 —— 菜单永远完整可见。
  const top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top + r.height - h));

  navMorePop.style.left = `${Math.round(left)}px`;
  navMorePop.style.top = `${Math.round(top)}px`;
}

function toggleNavMore() {
  const hidden = new Set(getNavHidden());
  const ids = getNavOrder().filter((id) => hidden.has(id));

  if (ids.length === 0) return;

  const pop = ensureNavMorePop();

  if (!pop.hidden) { closeNavMore(); return; }

  fillNavMore(ids);
  pop.hidden = false;
  navMoreBtn?.classList.add("is-open");
  navMoreBtn?.setAttribute("aria-expanded", "true");
  positionNavMore();
}

/** 隐藏项全为空时按钮不存在；有隐藏项时恒在 .nav 末尾（插件项插在它前面）。 */
function syncNavMore(hiddenIds: string[]) {
  const root = document.querySelector<HTMLElement>(".nav");

  if (!root) return;

  if (hiddenIds.length === 0) {
    closeNavMore();
    navMoreBtn?.remove();
    navMoreBtn = null;

    return;
  }

  if (!navMoreBtn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-more";
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.innerHTML = `${NAV_MORE_ICON}<span>更多</span>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleNavMore();
    });
    navMoreBtn = b;
  }

  root.append(navMoreBtn); // append 同时负责「恒在最后」
  navMoreBtn.title = `更多（${hiddenIds.length} 项）`;
}

function syncNavMoreActive() {
  if (!navMoreBtn) return;

  const current = currentPath();
  const hidden = new Set(getNavHidden());
  navMoreBtn.classList.toggle("active", hidden.size > 0
    && [...hidden].some((id) => {
      const item = navItemOf(id);

      return item ? navPathOf(item) === current : false;
    }));
}

/** 按用户布局重画内置项（插件项保留在原位）。 */
export function applyNavLayout() {
  const root = document.querySelector<HTMLElement>(".nav");

  if (!root) return;

  root.querySelectorAll<HTMLElement>("a[data-nav-id]").forEach((a) => a.remove());

  const hidden = new Set(getNavHidden());
  const order = getNavOrder();
  // 内置项插在第一个插件项之前；没有插件项时插在「更多」之前（再没有就 append）。
  const before = root.querySelector<HTMLElement>("a:not([data-nav-id])") ?? navMoreBtn;

  for (const id of order) {
    const item = navItemOf(id);

    if (!item) continue;

    root.insertBefore(makeNavAnchor(item, hidden.has(id)), before);
  }

  syncNavMore(order.filter((id) => hidden.has(id)));
  syncNavMoreActive();

  if (!listenersBound) {
    listenersBound = true;
    window.addEventListener("hashchange", () => {
      closeNavMore();
      syncNavMoreActive();
    });
    window.addEventListener("resize", closeNavMore);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNavMore(); });
  }
}

/** 一次写入顺序 + 隐藏项（设置页拖拽/开关共用），写盘并即时套用。 */
export function setNavLayout(order: string[], hidden: string[]) {
  cfgSet({
    "Style.NavOrder": normalizeNavOrder(order.join(",")).join(","),
    "Style.NavHidden": normalizeNavHidden(hidden.join(",")).join(","),
  });
  applyNavLayout();
}
