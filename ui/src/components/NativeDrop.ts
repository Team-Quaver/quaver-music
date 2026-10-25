// Quaver — 自绘下拉与 Tooltip 浮层。
//
// <select> 的弹层画在浏览器原生部件里，宿主 CSS（包括花火主题）完全够不着；title 的
// 提示同样是原生窗口，不受 --menu-* 与模糊开关控制。这里都换成 DOM 自绘：
//  - 下拉：保留触发器 <select> 本身（disabled/value/change 语义与既有视图代码不动），打开时
//    由宿主接管渲染 .ctx-menu 面板。面板沿用歌曲右键菜单那套机制与玻璃令牌，所以 MenuBlur
//    三态 / 花火主题的 --menu-* 覆盖天然生效；也不嵌在任何 backdrop-filter 祖先里（那是
//    浮窗只采到父级底图的病根，见 style.css 顶部的 backdrop 备注）。
//  - Tooltip：事件委托接管整棵文档的 title。所有 title 会在出现/写入时被归一成
//    data-tooltip，原生提示从源头没有素材；悬停只读 data-tooltip 画自绘浮窗。桌面歌词
//    窗口是独立页面，不加载本模块，仍保留原生 title。
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

/** 打开自绘下拉层。返回 false 表示当前环境仍应走浏览器原生行为。 */
export function openDropdown(sel: HTMLSelectElement): boolean {
  if (!finePointer()) return false;

  closeDropdown?.();
  const layer = document.createElement("div");

  layer.className = "ctx-layer dd-layer";

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

const tooltipTarget = (e: EventTarget | null): HTMLElement | null => {
  if (!(e instanceof HTMLElement)) return null;

  const el = e.closest<HTMLElement>("[data-tooltip]");

  return el && el.dataset.tooltip ? el : null;
};

let tip: HTMLElement | null = null;
let tipFor: HTMLElement | null = null;
let tipTimer = 0;
let pointerX = -1;
let pointerY = -1;

/** 悬停目标的唯一判定：指针坐标下的几何真相。tip 自身 pointer-events:none，不会挡住命中。 */
function pointerAt(): HTMLElement | null {
  if (pointerX < 0 || pointerY < 0) return null;

  const raw = document.elementFromPoint(pointerX, pointerY);

  return raw instanceof HTMLElement ? raw.closest<HTMLElement>("[data-tooltip]") : null;
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
    const now = pointerAt();

    if (!now || now.dataset.tooltip !== el.dataset.tooltip) {
      tipFor = null;

      return;
    }

    tipFor = now;
    showTooltip(now);
  }, TIP_DELAY_MS);
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
  document.body.append(node);
  tip = node;
  const r = el.getBoundingClientRect();
  let left = r.left + r.width / 2 - node.offsetWidth / 2;

  left = Math.min(Math.max(VIEW_PAD, left), innerWidth - node.offsetWidth - VIEW_PAD);
  let top = r.top - node.offsetHeight - 7;

  if (top < VIEW_PAD) top = r.bottom + 7;
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function onTipOver(e: Event) {
  // 几何命中优先于事件目标：pointerover 会穿透 pointer-events:none 的元素命到下面的可命中
  // 目标，closest 又会向上归并，两边的答案都可能对不上「指针此刻在谁上」。坐标未就绪时
  // （如启动瞬间的合成事件）才退回事件目标。
  const el = pointerAt() ?? tooltipTarget(e.target);

  // 在同一个目标内部移动到子元素也会冒 pointerover；那不是离开，别把提示收掉。
  if (!el) {
    if (tipFor && e.target instanceof Node && tipFor.contains(e.target)) return;
    hideTooltip();

    return;
  }

  if (el === tipFor) {
    // textContent 赋值即使值相同也会替换文本节点，触发 observer 自激。
    if (tip && tip.textContent !== (el.dataset.tooltip ?? "")) tip.textContent = el.dataset.tooltip ?? "";

    return;
  }

  scheduleTooltip(el);
}

/** title 一律归一成 data-tooltip：原生提示没有素材，自绘层只有一个数据源。 */
function normalizeTooltip(el: HTMLElement) {
  const text = el.getAttribute("title");

  if (text === null) return;

  // 空串是「清空提示」的既有写法（设置页背景路径），保留清空语义。
  el.dataset.tooltip = text;
  el.removeAttribute("title");
}

function syncTooltipAtPointer() {
  // 指针尚未动过（程序化触发 Mutation）时只更新已显示文本，不凭空开层。
  const el = pointerX < 0 || pointerY < 0 ? tipFor : pointerAt();

  if (!el || !el.dataset.tooltip) {
    hideTooltip();

    return;
  }

  if (el === tipFor) {
    if (tip && tip.textContent !== el.dataset.tooltip) tip.textContent = el.dataset.tooltip;

    return;
  }

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

    // 快速划过时目标切换可能不派发 pointerover（延迟期间从 A 换到 B 就是这样）；
    // move 路径按几何位置重判并续期定时器，保证「停在谁身上谁出提示」。
    const el = pointerAt();

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

    syncTooltipAtPointer();
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title", "data-tooltip"],
  });
  document.addEventListener("pointerout", (e) => {
    if (tipFor && !(e.relatedTarget instanceof Node && tipFor.contains(e.relatedTarget))) hideTooltip();
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Node) || !tip?.contains(e.target)) hideTooltip();
  }, true);
  document.addEventListener("scroll", () => hideTooltip(), true);
  window.addEventListener("blur", () => hideTooltip(), true);
}
