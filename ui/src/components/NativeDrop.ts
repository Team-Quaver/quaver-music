// Quaver — 自绘下拉与 Tooltip 浮层。
//
// <select> 的弹层画在浏览器原生部件里，宿主 CSS（包括花火主题）完全够不着；title 的
// 提示同样是原生窗口，不受 --menu-* 与模糊开关控制。这里都换成 DOM 自绘：
//  - 下拉：保留触发器 <select> 本身（disabled/value/change 语义与既有视图代码不动），打开时
//    由宿主接管渲染 .ctx-menu 面板。面板沿用歌曲右键菜单那套机制与玻璃令牌，所以 MenuBlur
//    三态 / 花火主题的 --menu-* 覆盖天然生效；也不嵌在任何 backdrop-filter 祖先里（那是
//    浮窗只采到父级底图的病根，见 style.css 顶部的 backdrop 备注）。
//  - Tooltip：事件委托接管整棵文档的 title。所有 title 会在出现/写入时被归一成
//    data-tooltip，原生提示从源头没有素材；悬停只读 data-tooltip 画自绘浮窗。
//    主窗与桌面歌词独立页都调用 bootNativeOverlays()，两扇窗共用同一套命中/延迟/
//    定位逻辑；玻璃样式各随所在页面的 CSS。
export interface DropdownOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

const VIEW_PAD = 8;
const TIP_DELAY_MS = 320;

const finePointer = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

export function dropdownOptions(sel: HTMLSelectElement): DropdownOption[] {
  const out: DropdownOption[] = [];

  for (const opt of sel.querySelectorAll("option")) {
    out.push({
      value: opt.value,
      label: opt.textContent ?? "",
      group: opt.closest("optgroup")?.label ?? undefined,
      disabled: opt.disabled,
    });
  }

  return out;
}

function optionEntries(sel: HTMLSelectElement): (DropdownOption | "sep")[] {
  const out: (DropdownOption | "sep")[] = [];
  let group = "";

  for (const opt of dropdownOptions(sel)) {
    if (opt.group && opt.group !== group) {
      if (group) out.push("sep");
      group = opt.group;
      out.push({ ...opt, label: opt.group, disabled: true });
    }

    out.push(opt);
  }

  return out;
}

let closeDropdown: (() => void) | null = null;

/** 按钮量到的最高层级：从触发 select 往上看 `z-index`，让下拉至少压过它所属的模态/浮层。
 *  普通页面的 select 会得到 80（与右键菜单同层）；EQ(84) / 更新弹窗(85) 内的 select
 *  必须抬到各自模态之上，否则下拉层被遮罩盖住 —— 看得见触发框、却看不到也点不到选项。 */
function overlayZFor(el: HTMLElement): number {
  let z = 80;

  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const value = Number.parseInt(getComputedStyle(node).zIndex, 10);

    if (Number.isFinite(value) && value > z) z = value;
  }

  return z + 1;
}

/** 打开自绘下拉层。返回 false 表示当前环境仍应走浏览器原生行为。 */
export function openDropdown(sel: HTMLSelectElement): boolean {
  if (!finePointer()) return false;

  closeDropdown?.();
  const layer = document.createElement("div");

  layer.className = "ctx-layer dd-layer";
  layer.style.zIndex = String(overlayZFor(sel));

  const panel = document.createElement("div");

  panel.className = "ctx-menu dd-menu";
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-label", sel.getAttribute("aria-label") ?? "");
  layer.append(panel);

  for (const entry of optionEntries(sel)) {
    if (entry === "sep") {
      const hr = document.createElement("hr");

      hr.className = "dd-sep";
      panel.append(hr);
      continue;
    }

    const btn = document.createElement("button");

    btn.type = "button";
    btn.className = "ct-item dd-item";
    btn.setAttribute("role", "option");
    btn.textContent = entry.label;
    btn.disabled = !!entry.disabled;
    btn.dataset.value = entry.value;
    btn.setAttribute("aria-selected", String(sel.value === entry.value));

    if (sel.value === entry.value) btn.classList.add("current");
    btn.addEventListener("click", () => {
      if (sel.disabled || entry.disabled) return;
      close();

      if (sel.value === entry.value) return;
      sel.value = entry.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    panel.append(btn);
  }

  const rect = sel.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;

  panel.style.left = "0px";
  panel.style.top = "0px";
  document.body.append(layer);
  const pr = panel.getBoundingClientRect();

  if (left + pr.width > innerWidth - VIEW_PAD) left = Math.max(VIEW_PAD, rect.right - pr.width);

  if (top + pr.height > innerHeight - VIEW_PAD) top = Math.max(VIEW_PAD, rect.top - pr.height - 6);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;

  const onDown = (e: Event) => {
    if (!(e.target instanceof Node) || !layer.contains(e.target)) close();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };

  const onShift = () => close();

  const close = () => {
    if (!closeDropdown) return;
    closeDropdown = null;
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onShift);
    window.removeEventListener("blur", onShift);
    window.removeEventListener("hashchange", onShift);
    layer.remove();
  };

  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onShift);
  window.addEventListener("blur", onShift);
  window.addEventListener("hashchange", onShift);
  closeDropdown = close;

  return true;
}

/** 命中点可能落在图标的 <svg>/<path> 上（SVGElement 不是 HTMLElement）；
 *  必须先从任意 Element 向上找宿主，否则同一排按钮会因为指针落在图标上还是留白里
 *  表现成「Tooltip 随机出现」。 */
function tooltipHostOf(el: Element | null): HTMLElement | null {
  const host = el?.closest<HTMLElement>("[data-tooltip]");

  return host && host.dataset.tooltip ? host : null;
}

const tooltipTarget = (e: EventTarget | null): HTMLElement | null =>
  e instanceof Element ? tooltipHostOf(e) : null;

let tip: HTMLElement | null = null;
let tipFor: HTMLElement | null = null;
let tipTimer = 0;
let pointerX = -1;
let pointerY = -1;
let pointerTarget: HTMLElement | null = null;

/** 指针坐标下的几何命中。tip 自身 pointer-events:none，不会挡住命中。
 *  事件目标与几何结果各有用途：pointerover/pointermove 的宿主是「这一指针会话」
 *  最可靠的来源，几何结果负责禁用控件与事件目标失效后的兜底。 */
function pointerAt(): HTMLElement | null {
  if (pointerX < 0 || pointerY < 0) return null;

  const raw = document.elementFromPoint(pointerX, pointerY);

  return tooltipHostOf(raw);
}

/** 禁用按钮的 Tooltip：Chrome 的 disabled 控件不派发指针事件，也不参与 hover，
 *  但「为什么不能点」恰恰最需要提示。沿几何命中（而不是事件路径）找宿主，
 *  再确认它确实是包裹指针的禁用控件。 */
function disabledTooltipAt(): HTMLElement | null {
  if (pointerX < 0 || pointerY < 0) return null;

  const raw = document.elementFromPoint(pointerX, pointerY);
  const host = raw?.closest<HTMLElement>("button:disabled[data-tooltip], [aria-disabled=\"true\"][data-tooltip]");

  return host && host.dataset.tooltip ? host : null;
}

function hideTooltip() {
  window.clearTimeout(tipTimer);
  tipTimer = 0;

  if (tip) {
    const node = tip;

    tip = null;
    node.remove();
  }

  tipFor = null;
}

/** tipTimer 走「目标 + 到期重判」：指向当前仍悬停的元素，到期时再看它是否还是答案。 */
function scheduleTooltip(el: HTMLElement) {
  if (el === tipFor) return;

  hideTooltip();
  tipFor = el;
  tipTimer = window.setTimeout(() => {
    tipTimer = 0;

    // 到期重读悬停目标：延迟期间指针移走/换了目标（快速划过、斜穿按钮边缘）就别再弹。
    // 移动事件的宿主优先：HiDPI/窗口右缘（尤其画廊全屏后）会把指针坐标取整到按钮外
    // 一两像素，纯几何判定会把仍在按钮上的目标误判为已离开 —— 这正是同一排按钮
    // 「有的有、有的没有」的来源。目标已断开或文案变了才放弃。
    const now = pointerTarget?.isConnected && pointerTarget.dataset.tooltip === el.dataset.tooltip
      ? pointerTarget
      : pointerAt();

    if (!now || now.dataset.tooltip !== el.dataset.tooltip) {
      tipFor = null;

      return;
    }

    tipFor = now;
    showTooltip(now);
  }, TIP_DELAY_MS);
}

/** 主窗优先在目标上方；放不下就翻到下方，再不行退到左右。桌面歌词窗很矮，
 *  单靠「上/下」会把提示裁出透明窗体，所以这里按四个方向找完整落点。 */
function positionTooltip(node: HTMLElement, r: DOMRect) {
  const gap = 7;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  const spots = [
    { left: cx - w / 2, top: r.top - h - gap },
    { left: cx - w / 2, top: r.bottom + gap },
    { left: r.right + gap, top: cy - h / 2 },
    { left: r.left - w - gap, top: cy - h / 2 },
  ];

  const inside = (p: { left: number; top: number }) =>
    p.left >= VIEW_PAD && p.top >= VIEW_PAD
    && p.left + w <= innerWidth - VIEW_PAD && p.top + h <= innerHeight - VIEW_PAD;

  // 先按优先级挑方向，再夹进视口。不能拿「夹取位移最小」挑：目标贴底时
  // 上方那条几乎不用夹，下方那条会被推回来 —— 最终仍会盖住目标。
  const pick = spots.find(inside) ?? spots[0]!;
  const left = Math.min(Math.max(VIEW_PAD, pick.left), Math.max(VIEW_PAD, innerWidth - w - VIEW_PAD));
  const top = Math.min(Math.max(VIEW_PAD, pick.top), Math.max(VIEW_PAD, innerHeight - h - VIEW_PAD));

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function showTooltip(el: HTMLElement) {
  // 进入 show 前先清定时器但不走 hide()：hide 会把 tipFor 清空，而这个函数
  // 随后就要把它设为目标；更重要的是不能再次触发 observer 造成的同步重入。
  window.clearTimeout(tipTimer);
  tipTimer = 0;
  tip?.remove();
  tipFor = el;

  const node = document.createElement("div");

  node.className = "qtip";
  node.setAttribute("role", "tooltip");
  node.textContent = el.dataset.tooltip ?? "";
  // 先藏在离屏首帧再落位；直接 append 会从左上角闪到目标旁。
  node.style.visibility = "hidden";
  node.style.left = "0px";
  node.style.top = "0px";
  document.body.append(node);
  tip = node;
  positionTooltip(node, el.getBoundingClientRect());
  node.style.visibility = "";
}

function onTipOver(e: Event) {
  // 事件目标优先：它来自浏览器同一指针会话，不受 HiDPI/全屏后坐标取整的影响
  // （窗口右缘 50px 内尤其明显）。事件目标不存在时再按几何位置兜底。
  const el = tooltipTarget(e.target) ?? pointerAt();

  // 在同一个目标内部移动到子元素也会冒 pointerover；那不是离开，别把提示收掉。
  if (!el) {
    if (tipFor && e.target instanceof Node && tipFor.contains(e.target)) return;
    hideTooltip();

    return;
  }

  if (el === tipFor) {
    // textContent 赋值即使值相同也会替换文本节点，触发 observer 自激。
    const text = el.dataset.tooltip ?? "";

    if (tip && tip.textContent !== text) {
      tip.textContent = text;
      positionTooltip(tip, el.getBoundingClientRect());
    }

    return;
  }

  // 到达的元素与「已显示/待显示」的目标不同，说明指针真正换了宿主；
  // 先收旧层，避免同一时刻叠两个 .qtip。
  if (tip || tipFor) hideTooltip();
  scheduleTooltip(el);
}

/** title 一律归一成 data-tooltip：原生提示没有素材，自绘层只有一个数据源。 */
function normalizeTooltip(el: HTMLElement) {
  const text = el.getAttribute("title");

  if (text === null) return;

  // 空串是「清空提示」的既有写法（设置页背景路径），保留清空语义。
  // 页面/视图代码若已直接写 data-tooltip（推荐写法），它是唯一真相：此时 title
  // 可能只是遗留的无障碍文本，不能被旧值反向覆盖。
  if (!el.hasAttribute("data-tooltip")) el.dataset.tooltip = text;
  el.removeAttribute("title");
}

function syncTooltipAtPointer() {
  // 指针尚未动过（程序化触发 Mutation）时只更新已显示文本，不凭空开层。
  const el = pointerX < 0 || pointerY < 0 ? tipFor : pointerTarget?.isConnected ? pointerTarget : pointerAt();

  if (!el || !el.dataset.tooltip) {
    hideTooltip();

    return;
  }

  if (el === tipFor) {
    if (tip && tip.textContent !== el.dataset.tooltip) {
      tip.textContent = el.dataset.tooltip;
      positionTooltip(tip, el.getBoundingClientRect());
    }

    return;
  }

  if (tip || tipFor) hideTooltip();
  scheduleTooltip(el);
}

/** 全局启动（main.ts 一次）。既有 DOM 与后续视图动态插入的 select/title 都会被接管。 */
export function bootNativeOverlays() {
  document.querySelectorAll<HTMLElement>("[title]").forEach(normalizeTooltip);
  // 有元素正在悬停时启动（如 HMR 重建后）：先把当前目标收掉，避免引用旧 DOM。
  hideTooltip();
  document.addEventListener("pointermove", (e) => {
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerTarget = tooltipTarget(e.target);

    // pointerover 在「目标元素自身被重写/重插」时可能不补发；移动事件是同一指针
    // 会话的高频真相，悬停目标消失时在这里立即收掉 pending 定时器。
    if (!pointerTarget && tipFor && !tipFor.isConnected) hideTooltip();

    // 快速划过时目标切换可能不派发 pointerover（延迟期间从 A 换到 B 就是这样）；
    // move 路径按几何位置重判并续期定时器，保证「停在谁身上谁出提示」。
    const el = pointerTarget ?? pointerAt();

    if (!el) {
      // 悬停目标已消失：连 pending 的定时器一起收，否则回到同一目标时会被
      // scheduleTooltip 的「同目标早退」挡住，提示永远弹不出来。
      if (tip || tipFor) hideTooltip();

      return;
    }

    if (tipFor !== el) scheduleTooltip(el);
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (!(e.target instanceof HTMLElement)) return;

    const sel = e.target.closest("select");

    if (!sel || e.button !== 0 || sel.disabled || !openDropdown(sel)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener("pointerover", onTipOver, true);
  document.addEventListener("pointermove", () => {
    // 禁用控件在 Chrome 里既不冒 pointerover，也不稳定冒 pointerout；指针停在它上面时
    // 由上面的几何路径兜住。这里只做「指针在禁用控件内的持续确认」，不重复计时。
    const host = disabledTooltipAt();

    if (!host) {
      if (!pointerTarget && (tip || tipFor)) hideTooltip();

      return;
    }

    if (tipFor !== host) {
      hideTooltip();
      scheduleTooltip(host);
    }

    if (tip) positionTooltip(tip, host.getBoundingClientRect());
  }, true);
  // 运行时/视图代码写 title 时立刻归一成 data-tooltip，原生提示没有素材；
  // 已悬停目标的 data-tooltip 变化则同步自绘层文本。
  new MutationObserver((mutations) => {
    // 浮层自身的文本/定位变更不需要再同步浮层，否则会形成自激循环。
    if (mutations.every(m => m.target === tip || (tip instanceof Node && tip.contains(m.target)))) return;

    for (const m of mutations) {
      // 归一会移除 title；自写删除触发的那条记录里 title 已不存在，天然被跳过，
      // 后续视图代码再写 title 时属性仍在，仍会正常归一。
      if (m.attributeName === "title" && m.target instanceof HTMLElement && m.target.hasAttribute("title")) normalizeTooltip(m.target);

      // 视图常在进 DOM 前就把 title 写好（attributeFilter 看不到），插入后扫一次子树。
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        normalizeTooltip(node);
        node.querySelectorAll<HTMLElement>("[title]").forEach(normalizeTooltip);
      }
    }

    // data-tooltip 的运行时改写（播放态/队列/画廊按钮）也走这里：
    // 已显示的提示换文案并重排，未显示的按新目标重新计时。
    syncTooltipAtPointer();
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title", "data-tooltip"],
  });
  document.addEventListener("pointerout", (e) => {
    if (!(e.target instanceof Element)) return;

    if (tipFor && !(e.relatedTarget instanceof Node && tipFor.contains(e.relatedTarget))) hideTooltip();
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && tooltipHostOf(e.target)) return;
    if (!(e.target instanceof Node) || !tip?.contains(e.target)) hideTooltip();
  }, true);
  document.addEventListener("scroll", () => hideTooltip(), true);
  // 画廊/全屏会改视口高度，播放条也可能随布局动画换位：已显示的提示跟着锚点重排，
  // 锚点已被重建则直接收起，避免浮层停在旧坐标上。
  window.addEventListener("resize", () => {
    if (!tip && !tipFor) return;

    if (!tip || !tipFor?.isConnected) {
      hideTooltip();

      return;
    }

    positionTooltip(tip, tipFor.getBoundingClientRect());
  });
  document.addEventListener("fullscreenchange", () => hideTooltip());
  window.addEventListener("blur", () => hideTooltip(), true);
}
