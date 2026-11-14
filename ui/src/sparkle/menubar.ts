// Sparkle — 菜单栏（侧栏主菜单 + 底部调整区）的插件项挂载层
//
// 契约见 sdk/types.ts 的 SparkleMenuBarItem。这里做三件事：
//   ① 把注册项画进 `.nav`（主菜单列表）或 `.side-foot`（设置/缩回所在的调整区）；
//   ② 维护「用户在设置页逐项显隐」的那份名单（localStorage，按插件 id + 项 id 记）；
//   ③ 插件启停 / 注册表变化时重画，停用即撤。
//
// 为什么复用宿主的类名而不是自带一套样式：
//   · 主菜单项用 `<a class="nav-act">`（.nav a 自带排版/缩态/激活条），折叠侧栏时文字会被
//     同一套 max-width 规则收掉，插件项和内置项不会长得不一样；
//   · 底部调整区用 `<button class="side-btn">`（与设置/缩回同尺寸，缩态自动竖排）。
// 只额外注入一条 `.side-btn.on` 的染色规则（数据无害、体积极小）。
import { onSparkleChange, sparkleMenuBarItems, type MenuBarItemEntry } from "./registry";

const STYLE_ID = "sparkle-menubar-css";

/** 用户在设置页隐藏了哪些插件项：`["<pluginId>:<itemId>", …]` */
const HIDDEN_KEY = "quaver.sparkle.menubar.hidden.v1";

const BASE_CSS = `
.side-btn.on { color: color-mix(in srgb, var(--cvg-accent, var(--cyan)) 60%, var(--ink)); }
.nav-act { cursor: pointer; }
/* 勾选态刻意不用 .active：那是「当前路由」的语言（左侧强调条 + 整行底色），
   选项亮着和页面正在这一页是两回事。这里只染色 + 右缘一颗圆点。 */
.nav-act.is-on { color: color-mix(in srgb, var(--cvg-accent, var(--cyan)) 55%, var(--ink)); }
.nav-act.is-on::after {
  content: ""; position: absolute; right: 10px; top: 50%; width: 6px; height: 6px;
  margin-top: -3px; border-radius: 50%; background: var(--cvg-accent, var(--cyan));
}
`;

const FALLBACK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>';

const itemKey = (entry: MenuBarItemEntry) => `${entry.pluginId}:${entry.item.id}`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BASE_CSS;
  document.head.append(style);
}

function readHidden(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");

    // 只要求「能拼成 key」：非字符串项转成字符串后永远匹配不上合法 key，不必逐项判类型。
    return new Set(Array.isArray(v) ? v.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
}

/** 某一项是否被用户在菜单栏调整区里关掉（设置页与渲染层共用这一份判定）。 */
export const sparkleMenuBarItemHidden = (pluginId: string, id: string): boolean =>
  readHidden().has(`${pluginId}:${id}`);

/** 写显隐并即时重画菜单栏；设置页的开关走这里。 */
export function setSparkleMenuBarItemHidden(pluginId: string, id: string, hidden: boolean): void {
  const next = readHidden();
  const key = `${pluginId}:${id}`;

  if (hidden) next.add(key);
  else next.delete(key);
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
  paintSparkleMenuBar();
}

/** 注册表里当前所有菜单栏项（含隐藏的；设置页调整区按这份列）。 */
export const sparkleMenuBarEntries = (): MenuBarItemEntry[] => sparkleMenuBarItems();

function runItem(entry: MenuBarItemEntry, el: HTMLElement): void {
  try {
    entry.item.run(el);
  } catch (e) {
    console.error(`[sparkle:${entry.pluginId}] 菜单栏项 ${entry.item.id} 执行失败`, e);
  }

  // 勾选态由插件自己决定（checked() 是只读快照）：跑完立刻重读一次，不必等注册表变化。
  if (entry.item.checked) paintSparkleMenuBar();
}

function bindActivate(el: HTMLElement, entry: MenuBarItemEntry): void {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    runItem(entry, el);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    runItem(entry, el);
  });
}

function makeMainItem(entry: MenuBarItemEntry): HTMLElement {
  const a = document.createElement("a");
  a.className = "nav-act";
  a.dataset.sparkleMenubar = itemKey(entry);
  a.setAttribute("role", "button");
  a.tabIndex = 0;
  a.title = entry.item.hint ? `${entry.item.label} · ${entry.item.hint}` : entry.item.label;
  a.innerHTML = `${entry.item.iconSvg || FALLBACK_ICON}<span></span>`;
  a.querySelector("span")!.textContent = entry.item.label;
  bindActivate(a, entry);

  const checked = entry.item.checked?.() ?? false;
  a.classList.toggle("is-on", checked);

  if (entry.item.checked) {
    a.setAttribute("aria-pressed", String(checked));
    // 勾选态是插件自己的状态（比如控制浮窗里改的设置），宿主收不到通知：
    // 指针落上去 / 键盘聚焦时现读一次，别让菜单栏停在旧状态上（不重建 DOM，只改样式）。

    const sync = () => {
      const now = entry.item.checked?.() ?? false;

      a.classList.toggle("is-on", now);
      a.setAttribute("aria-pressed", String(now));
    };

    a.addEventListener("pointerenter", sync);
    a.addEventListener("focus", sync);
  }

  return a;
}

function makeFootItem(entry: MenuBarItemEntry): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "side-btn";
  b.dataset.sparkleMenubar = itemKey(entry);
  b.innerHTML = entry.item.iconSvg || FALLBACK_ICON;
  b.title = entry.item.hint ? `${entry.item.label} · ${entry.item.hint}` : entry.item.label;
  b.setAttribute("aria-label", entry.item.label);

  const checked = entry.item.checked?.() ?? false;
  b.classList.toggle("on", checked);

  if (entry.item.checked) {
    b.setAttribute("aria-pressed", String(checked));

    const sync = () => {
      const now = entry.item.checked?.() ?? false;

      b.classList.toggle("on", now);
      b.setAttribute("aria-pressed", String(now));
    };

    b.addEventListener("pointerenter", sync);
    b.addEventListener("focus", sync);
  }

  bindActivate(b, entry);

  return b;
}

/** 全量重画插件项（幂等；内置项/插件路由项都不碰）。 */
export function paintSparkleMenuBar(): void {
  ensureStyle();

  const hidden = readHidden();
  const entries = sparkleMenuBarItems().filter((e) => !hidden.has(itemKey(e)));
  const nav = document.querySelector<HTMLElement>(".nav");
  const foot = document.querySelector<HTMLElement>(".side-foot");

  nav?.querySelectorAll("[data-sparkle-menubar]").forEach((el) => el.remove());
  foot?.querySelectorAll("[data-sparkle-menubar]").forEach((el) => el.remove());

  if (!nav && !foot) return;

  for (const entry of entries) {
    if ((entry.item.slot ?? "main") === "foot") {
      if (foot) foot.insertBefore(makeFootItem(entry), foot.firstChild);
    } else if (nav) {
      // 主菜单列表：排在内置项与插件路由项之后、「更多」之前（用户隐藏的项仍收进「更多」）。
      const more = nav.querySelector<HTMLElement>(".nav-more");

      if (more) nav.insertBefore(makeMainItem(entry), more);
      else nav.append(makeMainItem(entry));
    }
  }
}

/** 订阅注册表变化；`bootShell` 在侧栏 DOM 就位后调一次（插件随后 enable 即可见）。 */
export function initSparkleMenuBar(): void {
  onSparkleChange(paintSparkleMenuBar);
  // 自定义导航布局重画（nav-apply）后，内置项会插到第一个非内置锚点之前 —— 我们的项
  // 留在原位即可，但「更多」按钮可能被重建，重画一次最稳（低频，代价可忽略）。
  window.addEventListener("quaver:nav-repaint", paintSparkleMenuBar);
  paintSparkleMenuBar();
}
