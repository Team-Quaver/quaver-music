// 自绘下拉框：替代原生 <select>（原生下拉的 <option> 弹层不吃 CSS，主题字体全失效）。
// 复用 v-menu 浮层（同搜索建议 / 音质菜单 / 右键菜单）与 verse-app.css 的 .v-sel 触发按钮。
// 交互：点按钮开关；点窗外/Escape 关闭；↑↓ 移动高亮，Enter/Space 选中。
// API 模仿 HTMLSelectElement（value / onchange / disabled），方便现有绑定逻辑原样迁移。
import { icon } from "../verse/icons";

export interface SelectBoxOption {
  value: string;
  label: string;
}

export interface SelectBoxOpts {
  ariaLabel?: string;
  options: SelectBoxOption[];
  value?: string; // 初始值，缺省取 options[0]
  disabled?: boolean;
}

export interface SelectBox {
  el: HTMLElement;
  value: string; // get/set；set 只同步界面，不触发 onchange
  disabled: boolean;
  onchange: (() => void) | null;
  /** 整组替换选项（输出设备探测完成后回填）；value 缺省保留当前值（不在新组里则回落首项） */
  setOptions(list: SelectBoxOption[], value?: string): void;
}

export function SelectBox(opts: SelectBoxOpts): SelectBox {
  let options = opts.options;
  let value = opts.value ?? options[0]?.value ?? "";
  let open = false;

  const el = document.createElement("div");
  el.className = "v-sel";
  el.innerHTML = `
    <button type="button" class="v-sel__btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="v-sel__label"></span>
      ${icon("chevronDown", 16)}
    </button>
    <div class="v-menu v-sel__drop" role="listbox" hidden></div>`;
  const btn = el.querySelector<HTMLButtonElement>(".v-sel__btn")!;
  const label = el.querySelector<HTMLElement>(".v-sel__label")!;
  const drop = el.querySelector<HTMLElement>(".v-sel__drop")!;

  if (opts.ariaLabel) {
    btn.setAttribute("aria-label", opts.ariaLabel);
    drop.setAttribute("aria-label", opts.ariaLabel);
  }

  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;

  const paintBtn = () => {
    label.textContent = labelOf(value);
    btn.setAttribute("aria-expanded", String(open));
  };

  const checkIcon = icon("check", 14).replace('class="v-icon"', 'class="v-icon v-menu__check"');

  function paintDrop() {
    drop.innerHTML = options
      .map((o) => {
        const on = o.value === value;
        return `<button class="v-menu__item${on ? " sel" : ""}" type="button" role="option"
          aria-selected="${on}" data-v="${o.value.replace(/"/g, "&quot;")}"><span class="ellipsis">${o.label.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</span>${on ? checkIcon : ""}</button>`;
      })
      .join("");
    drop.querySelectorAll<HTMLButtonElement>(".v-menu__item").forEach((b) => {
      b.addEventListener("click", () => pick(b.dataset.v!));
    });
  }

  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    drop.hidden = !open;
    paintBtn();
    if (open) {
      paintDrop();
      const sel = drop.querySelector<HTMLElement>(".v-menu__item.sel") ?? drop.querySelector<HTMLElement>(".v-menu__item");
      sel?.focus();
    } else {
      btn.focus(); // 关闭后焦点还给触发按钮，键盘流不断
    }
  }

  function pick(v: string) {
    if (value !== v) {
      value = v;
      paintBtn();
      box.onchange?.();
    }
    setOpen(false);
  }

  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    setOpen(!open);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  });
  drop.addEventListener("keydown", (e) => {
    const items = [...drop.querySelectorAll<HTMLElement>(".v-menu__item")];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const cur = document.activeElement as HTMLElement | null;
      if (cur?.classList.contains("v-menu__item")) pick(cur.dataset.v!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false); // 别拦截，让 Tab 自然走出组件
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    if (!el.contains(e.target as Node)) setOpen(false);
  });

  const box: SelectBox = {
    el,
    get value() { return value; },
    set value(v: string) {
      value = v;
      paintBtn();
      if (open) paintDrop();
    },
    get disabled() { return btn.disabled; },
    set disabled(b: boolean) {
      btn.disabled = b;
      if (b && open) setOpen(false);
    },
    onchange: null,
    setOptions(list, v) {
      options = list;
      value = v ?? (list.some((o) => o.value === value) ? value : list[0]?.value ?? "");
      paintBtn();
      if (open) paintDrop();
    },
  };

  if (opts.disabled) box.disabled = true;
  paintBtn();
  return box;
}
