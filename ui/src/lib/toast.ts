// Quaver — 全局提示条。
//
// 独立成模块的原因：宿主启动链路（Sparkle host / 热键）只需要这一个反馈函数，
// 不能为了它把整份歌曲右键菜单钉进首屏静态闭包。
let toastEl: HTMLElement | null = null;
let toastTimer = 0;

export function toast(msg: string, kind: "ok" | "err" = "ok") {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.append(toastEl);
  }

  toastEl.textContent = msg;
  toastEl.classList.toggle("err", kind === "err");
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), kind === "err" ? 3600 : 2000);
}
