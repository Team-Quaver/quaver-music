// Sparkle — 走带控制（播放条右侧控制簇）的挂载层
//
// 契约见 sdk/types.ts 的 SparkleTransportControl：插件注册「一颗按钮 + 它自己的浮窗」，
// 宿主负责按钮、锚点、开合、点外关闭、Esc、无障碍属性与停用清理；插件只管浮窗内容。
//
// **浮窗挂在 document.body，不挂在播放条里**（2026-11-14 改，踩过坑）：
//   · 播放条整条是拖拽 seek 的热区，浮窗留在里面时非按钮区域的点击会被当成「拖进度」；
//     宿主的豁免名单（button / input / .pb-volpop / .pb-qpop / .pb-lpop）不会为第三方控件
//     无限膨胀，而浮窗内容恰恰大量是文字与自绘卡片。
//   · 播放条会随 np 接管 / 自动隐藏 / 停靠态切换做 opacity/transform 动画，浮窗跟着一起
//     淡出/位移，锚点与内容会分家。
//   · 浮窗高度可达视口七成：留在条内会被条的层叠上下文与 overflow 裁切。
// 所以这里沿用 `.ctx-menu` / `.qtip` / `.nav-more-pop` 那一套「body 挂载 + fixed + 开时量一次
// 按钮矩形」的做法，浮窗与播放条彼此独立，只剩一根看不出、也不需要维护的视觉锚线。
//
// 样式在运行时注入：PlayerBar 在首屏静态闭包里，style.css 的构建预算（verify-bundle 的
// 84KB）只剩几 KB；这套玻璃浮窗只在**真的有插件注册走带控件**时才需要。
import type { SparkleTransportControl, SparkleTransportCtx } from "@quaver/sparkle";
import { onSparkleChange, sparkleTransportControls } from "./registry";
import { sparklePlayerFacade } from "./player-facade";
import { player } from "../player";

const STYLE_ID = "sparkle-transport-css";

const BASE_CSS = `
.pb-plugins { display: flex; align-items: center; gap: 2px; }
.pb-pctrl { position: relative; display: flex; }
.pb-pctrl > .pb-btn.is-on { color: color-mix(in srgb, var(--cvg-accent, var(--cyan)) 48%, var(--ink)); }

/* 浮窗是 body 的直接子元素：fixed 定位，坐标由 JS 在打开时按按钮矩形算一次。
   z-index 与宿主浮层菜单同级（70），压在播放条之上、窗口按钮簇（90）之下。 */
.pb-ppop {
  position: fixed; z-index: 80;
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  overflow: auto; overscroll-behavior: contain;
  padding: 12px; border-radius: 14px;
  background: var(--menu-surface); border: 1px solid var(--menu-line);
  box-shadow: var(--menu-shadow), inset 0 1px 0 var(--menu-edge);
  backdrop-filter: var(--menu-filter);
  color: var(--ink); font-size: 12.5px;
  opacity: 0; pointer-events: none; transition: opacity .16s;
}
.pb-ppop.is-open { opacity: 1; pointer-events: auto; transition: none; }
.pb-ppop.is-open > * { animation: menu-content-in .16s cubic-bezier(.32,.72,.24,1) both; }
@media (prefers-reduced-motion: reduce) {
  .pb-ppop.is-open > * { animation: none; }
}
`;

const FALLBACK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>';

/** 已挂载的全部控件（开合广播与批量重定位要看到全体）。 */
const mountedAll = new Set<MountedControl>();

interface MountedControl {
  key: string;
  control: SparkleTransportControl;
  root: HTMLElement;
  button: HTMLButtonElement;
  pop: HTMLElement;
  ctx: SparkleTransportCtx;
  open: boolean;
  rendered: boolean;
  cleanup: (() => void) | null;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BASE_CSS;
  document.head.append(style);
}

/** 把浮窗摆在按钮正上方：底边贴按钮顶 + 10px，左右按视口夹取，最大高度不超过按钮上方的空间。 */
function place(mounted: MountedControl): void {
  const rect = mounted.button.getBoundingClientRect();
  const wanted = mounted.control.width ?? 320;
  const width = Math.max(240, Math.min(560, wanted, window.innerWidth - 24));
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 10));

  mounted.pop.style.width = `${width}px`;
  mounted.pop.style.left = `${Math.round(left)}px`;
  mounted.pop.style.bottom = `${bottom}px`;
  mounted.pop.style.maxHeight = `${Math.max(180, Math.round(rect.top - 22))}px`;
}

function makeControl(bar: HTMLElement, key: string, control: SparkleTransportControl): MountedControl {
  const root = document.createElement("div");
  root.className = "pb-pctrl";
  root.dataset.sparkleControl = key;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pb-btn pb-ghost";
  button.innerHTML = control.iconSvg || FALLBACK_ICON;
  button.title = control.hint ? `${control.label} · ${control.hint}` : control.label;
  button.setAttribute("aria-label", control.label);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");

  const pop = document.createElement("div");
  pop.className = "pb-ppop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", control.label);
  pop.dataset.sparkleControl = key;

  root.append(button);
  document.body.append(pop);

  // ctx 的方法都是**闭包**：真正被调用时 mounted 已经初始化完毕，所以可以在字面量里引用它自己。
  const mounted: MountedControl = {
    key, control, root, button, pop, open: false, rendered: false, cleanup: null,
    ctx: {
      open: () => mounted.open,
      setOpen: (next) => setOpen(mounted, next),
      player: sparklePlayerFacade,
      bar: () => bar,
      expanded: () => player.expanded,
      expand: () => {
        if (player.expanded) return;

        if (!player.current) return; // 与点封面同口径：没歌不开页
        player.expanded = true;
        player.notifyPublic();
      },
      collapse: () => {
        if (!player.expanded) return;
        player.expanded = false;
        player.notifyPublic();
      },
    },
  };

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(mounted, !mounted.open);
  });

  return mounted;
}

/** 浮窗开着这件事对别的插件也有意义（比如它们的自动隐藏要避让），用一个 body 标记广播。 */
function syncBodyFlag(): void {
  document.body.classList.toggle("sparkle-pop-open", [...mountedAll].some((item) => item.open));
}

function setOpen(mounted: MountedControl, next: boolean): void {
  if (mounted.open === next) return;
  mounted.open = next;
  mounted.pop.classList.toggle("is-open", next);
  mounted.button.setAttribute("aria-expanded", String(next));
  syncBodyFlag();

  if (!next) return;

  // 首次打开才 render：插件不必在播放条挂载时就建一堆 DOM，也让「没打开过」的插件零成本。
  if (!mounted.rendered) {
    mounted.rendered = true;

    try {
      mounted.cleanup = mounted.control.render(mounted.pop, mounted.ctx) ?? null;
    } catch (e) {
      console.error(`[sparkle] 走带控件 ${mounted.key} 渲染失败`, e);
      mounted.pop.replaceChildren();
    }
  }

  place(mounted);
}

/**
 * 把已注册的走带控件挂进播放条右侧控制簇。返回拆装函数（播放条生命周期是整页，一般不用调；
 * 留给测试与将来的播放条重建路径）。
 *
 * @param bar  播放条根元素（`#player-bar`，也是 `transport.bar()` 的返回值）
 * @param host 控件容器（`.pb-right` 里的 `.pb-plugins` 槽）
 */
export function mountSparkleTransportControls(bar: HTMLElement, host: HTMLElement): () => void {
  ensureStyle();

  const mounted = new Map<string, MountedControl>();

  const closeAll = () => {
    for (const item of mounted.values()) {
      if (item.open) setOpen(item, false);
    }
  };

  const sync = () => {
    const wanted = sparkleTransportControls();
    const wantedKeys = new Set(wanted.map((e) => `${e.pluginId}:${e.control.id}`));

    // 1) 摘掉不再存在的（插件停用 / 反注册）
    for (const [key, item] of mounted) {
      if (wantedKeys.has(key)) continue;
      item.cleanup?.();
      item.pop.remove();
      item.root.remove();
      mounted.delete(key);
      mountedAll.delete(item);
      item.open = false;
    }

    // 2) 补齐新的，并按 order 重排（同一批里顺序变了就整段按序 append，代价可忽略）
    for (const entry of wanted) {
      const key = `${entry.pluginId}:${entry.control.id}`;

      if (!mounted.has(key)) {
        const item = makeControl(bar, key, entry.control);
        mounted.set(key, item);
        mountedAll.add(item);
        host.append(item.root);
      }
    }

    const ordered = wanted.flatMap((e) => {
      const item = mounted.get(`${e.pluginId}:${e.control.id}`);

      return item ? [item.root] : [];
    });

    for (const node of ordered) host.append(node); // append 已存在的节点 = 按序移动
    syncBodyFlag();
  };

  const offChange = onSparkleChange(sync);

  // 点浮窗外 / Esc 关闭：捕获阶段处理，宿主播放条的拖拽 seek 也在这条路径上，先一步判断。
  // 浮窗与按钮是两棵独立的 DOM（浮窗在 body 上），所以「在不在里面」要分别 contains。
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target instanceof Node ? e.target : null;

    if (!target) return;

    for (const item of mounted.values()) {
      if (item.open && !item.root.contains(target) && !item.pop.contains(target)) setOpen(item, false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeAll();
  };

  // 播放条换形态（停靠/悬浮/窗口缩放）时重新量：浮窗坐标是按钮给的，按钮动了它就得跟。
  const onViewportChange = () => {
    for (const item of mounted.values()) {
      if (item.open) place(item);
    }
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onViewportChange);

  sync();

  return () => {
    offChange();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onViewportChange);

    for (const item of mounted.values()) {
      item.cleanup?.();
      item.pop.remove();
      item.root.remove();
    }

    mounted.clear();
    mountedAll.clear();
    syncBodyFlag();
  };
}
