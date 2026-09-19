// 右下浮窗（播放列表 / 音质共用）：标题栏 + 可滚动 body，固定在播放条上方右缘。
// 挂 document.body（fixed），主页与全屏播放页同一形态；开关走 hidden（CSS 负责进出动画）。
// 同一时刻只开一个：打开新窗时请旧窗的持有者收回状态（onRequestClose），而不是直接关 DOM。
import { icon } from "../verse/icons";

export interface FloatWindowOpts {
  id: string;
  title: string;
  /** 关闭请求（收起按钮 / 被另一个窗顶掉 / 点窗外）：由持有状态的一方处理并回调 setOpen(false) */
  onRequestClose: () => void;
  /** 触发按钮：同步 aria-expanded / aria-controls */
  trigger?: HTMLElement;
  /** 给出时，点在窗与这些锚点之外即请求关闭 */
  dismissOnOutside?: Element[];
}

export interface FloatWindow {
  el: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  actions: HTMLElement;
  readonly open: boolean;
  setOpen(open: boolean): void;
}

let active: FloatWindow | null = null;
let activeClose: (() => void) | null = null;

export function FloatWindow(opts: FloatWindowOpts): FloatWindow {
  const el = document.createElement("div");
  el.className = "v-float";
  el.id = opts.id;
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", opts.title);
  el.innerHTML = `
    <div class="v-float__head">
      <span class="v-float__title"></span>
      <span class="v-float__actions">
        <button type="button" class="v-iconbtn v-iconbtn--sm" id="${opts.id}-close" title="收起" aria-label="收起">${icon("chevronDown", 16)}</button>
      </span>
    </div>
    <div class="v-float__body"></div>
  `;
  const titleEl = el.querySelector<HTMLElement>(".v-float__title")!;
  titleEl.textContent = opts.title;
  const meta = document.createElement("i");
  meta.className = "v-float__meta";
  titleEl.append(meta);
  const actions = el.querySelector<HTMLElement>(".v-float__actions")!;
  const body = el.querySelector<HTMLElement>(".v-float__body")!;
  el.querySelector<HTMLElement>(`#${opts.id}-close`)!.onclick = () => opts.onRequestClose();
  opts.trigger?.setAttribute("aria-controls", opts.id);
  opts.trigger?.setAttribute("aria-expanded", "false");

  const win: FloatWindow = {
    el, body, meta, actions,
    get open() { return !el.hidden; },
    setOpen(open: boolean) {
      if (open === !el.hidden) return;
      if (open) {
        if (active && active !== win) activeClose?.();
        active = win;
        activeClose = opts.onRequestClose;
      } else if (active === win) {
        active = null;
        activeClose = null;
      }
      el.hidden = !open;
      opts.trigger?.setAttribute("aria-expanded", String(open));
    },
  };

  if (opts.dismissOnOutside) {
    const keep = [el, ...opts.dismissOnOutside];
    document.addEventListener("pointerdown", (e) => {
      if (el.hidden) return;
      const t = e.target as Node;
      if (!keep.some((k) => k.contains(t))) opts.onRequestClose();
    });
  }

  document.body.append(el);
  return win;
}
