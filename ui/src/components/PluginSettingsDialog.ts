// Quaver — 插件设置弹窗（模态，body 常驻层）。
//
// 「已装插件/主题/扩展」行内齿轮按钮的落点：插件设置区不再常驻设置页（分类 tab 只管
// 启停/卸载），点齿轮就地弹窗渲染该插件的 SparkleSettingsSection。层与开闭动画复用
// 更新弹窗（.upd-overlay/.upd-dialog + .leaving 门闩），观感与更新/本地插件弹窗一致。
//
// 关闭语义：Esc / 点遮罩 / 「关闭」= 收起并调用 render 返回的清理函数。
let layer: HTMLElement | null = null;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 打开插件设置弹窗。render 在弹窗 body 内挂设置区（无可配置时调用方自己渲染空态），
 *  返回的清理函数在弹窗关闭（含 Esc/遮罩）时调用。已有弹窗在开时忽略。 */
export function showPluginSettingsDialog(opts: { name: string; render: (box: HTMLElement) => (() => void) | void }): void {
  if (layer) return;

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `
    <div class="upd-dialog sparkle-settings-dialog" role="dialog" aria-modal="true" aria-label="插件设置">
      <div class="upd-head">
        <h3>${esc(opts.name)} <span class="upd-badge">插件设置</span></h3>
      </div>
      <div class="sparkle-settings-body"></div>
      <div class="upd-foot">
        <span class="upd-spacer"></span>
        <button class="ghost-btn" data-act="close" type="button">关闭</button>
      </div>
    </div>`;

  const body = layer.querySelector<HTMLElement>(".sparkle-settings-body")!;
  let cleanup: (() => void) | void | null = null;
  try {
    cleanup = opts.render(body);
  } catch (e) {
    body.innerHTML = `<div class="sparkle-empty">设置区渲染失败（见控制台）</div>`;
    console.warn("[sparkle] 插件设置弹窗渲染失败", e);
  }

  const close = () => {
    const el = layer;
    layer = null;
    if (!el) return;
    window.removeEventListener("keydown", onKey);
    try { cleanup?.(); } catch (e) { console.warn("[sparkle] 插件设置清理失败", e); }
    cleanup = null;
    // 离场动画门闩与 UpdateDialog 同一套：.leaving 挂上后 animationend 摘节点，
    // 动画被禁用（reduced-motion）时靠超时兜底。
    const fin = () => el.remove();
    el.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    el.classList.add("leaving");
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);
  layer.addEventListener("mousedown", (e) => { if (e.target === layer) close(); });
  layer.querySelector<HTMLButtonElement>('[data-act="close"]')!.onclick = close;

  document.body.append(layer);
}
