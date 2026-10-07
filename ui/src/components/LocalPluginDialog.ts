// Quaver — 本地插件安装警告弹窗（模态，body 常驻层）。
//
// 「添加本地插件」的守门人：Quaver 不审查、不背书手动安装的插件，弹窗给 5 秒强制
// 阅读期（倒计时走完「确认」才解锁），确认后由调用方继续文件选择与安装。红色渐变
// 警示样式与开/闭动画完全复用更新弹窗（.upd-overlay/.upd-dialog + .leaving 门闩）。
//
// 关闭语义：Esc / 点遮罩 / 「取消」= 放弃，不触发任何安装动作。
let layer: HTMLElement | null = null;

/** 打开本地插件警告弹窗；用户点「确认」后回调 onConfirm（弹窗先收起再回调）。
 *  已有弹窗在开时忽略。 */
export function showLocalPluginDialog(onConfirm: () => void): void {
  if (layer) return;

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `
    <div class="upd-dialog danger" role="dialog" aria-modal="true" aria-label="手动安装插件">
      <div class="upd-head">
        <h3>手动安装插件 <span class="upd-badge danger">高风险</span></h3>
        <span class="upd-meta danger-muted">此操作不受 Quaver 保护，后果请自行承担</span>
      </div>
      <div class="local-warn-text">Quaver Music 无法保证 Marketplace 插件的可用性和安全性，与此同时，我们更无法保证，且并不推荐您通过手动安装的方式安装插件，但自由权利能在您手中，请确保安全后点击确认</div>
      <div class="upd-foot">
        <button class="ghost-btn" data-act="cancel" type="button">取消</button>
        <span class="upd-spacer"></span>
        <button class="upd-danger" data-act="confirm" type="button" disabled>确认（5s）</button>
      </div>
    </div>`;

  const confirmBtn = layer.querySelector<HTMLButtonElement>('[data-act="confirm"]')!;

  // 5 秒强制阅读期：倒计时结束才解锁「确认」
  let left = 5;
  const timer = window.setInterval(() => {
    left -= 1;
    if (left <= 0) {
      window.clearInterval(timer);
      confirmBtn.disabled = false;
      confirmBtn.textContent = "确认";
      return;
    }
    confirmBtn.textContent = `确认（${left}s）`;
  }, 1000);

  // 离场动画门闩与 UpdateDialog 同一套：挂 .leaving 等 animationend 摘节点；
  // 动画被禁用（reduced-motion）时 animationend 永不触发，靠超时兜底。
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    window.clearInterval(timer);
    window.removeEventListener("keydown", onKey);
    const el = layer;
    layer = null;
    if (!el) return;
    const fin = () => el.remove();
    el.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    el.classList.add("leaving");
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);
  layer.addEventListener("mousedown", (e) => { if (e.target === layer) close(); });

  layer.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.onclick = close;
  confirmBtn.onclick = () => { close(); onConfirm(); };

  document.body.append(layer);
}
