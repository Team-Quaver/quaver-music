// Quaver — 开源软件 / 第三方库引用弹窗（设置 → 通用 → 版本号下方）
//
// 列表只放界面上承诺展示的四项；仓库链接交给主进程 shell.openExternal，
// 因为应用窗口本身禁止新开 BrowserWindow。浏览器 dev 下没有主进程桥，退回 window.open。
import { toast } from "./SongMenu";

type Credit = { repo: string; license: string };

const CREDITS: Credit[] = [
  { repo: "electron/electron", license: "MIT" },
  { repo: "vitejs/vite", license: "MIT" },
  { repo: "amll-dev/applemusic-like-lyrics", license: "AGPL-v3" },
  { repo: "SPlayer-Dev/lyric-kit", license: "AGPL-v3" },
  { repo: "team-quaver/quaver-sparkle", license: "AGPL-v3" },
  { repo: "team-quaver/typhoeus-go", license: "AGPL-v3" },
  { repo: "L-1124/QQMusicApi", license: "GPL-3.0" },
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let layer: HTMLElement | null = null;

/** 打开 Credits 弹窗（已开着则忽略，不叠第二层）。 */
export function showCreditsDialog(): void {
  if (layer) return;

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `<div class="upd-dialog crd-dialog" role="dialog" aria-modal="true" aria-label="开源软件与第三方库引用">
    <div class="upd-head">
      <h3>开源软件与第三方库 <span class="upd-badge">Credits</span></h3>
      <span class="muted upd-meta">Quaver 的成长离不开这些开源项目。点击任一项可在浏览器中打开对应的 GitHub 仓库。</span>
    </div>
    <div class="upd-notes crd-list">
      ${CREDITS.map((c) => `<a class="crd-item" href="https://github.com/${esc(c.repo)}" target="_blank" rel="noopener noreferrer" data-repo="${esc(c.repo)}">
        <span class="crd-repo">${esc(c.repo)}</span>
        <span class="crd-license">${esc(c.license)}</span>
        <span class="crd-arrow" aria-hidden="true">↗</span>
      </a>`).join("")}
    </div>
    <div class="upd-foot crd-foot">
      <span class="muted crd-note">以上项目的版权归各自作者所有。</span>
      <span class="upd-spacer"></span>
      <button class="upd-primary" data-act="close" type="button">关闭</button>
    </div>
  </div>`;

  const close = () => {
    const el = layer;
    window.removeEventListener("keydown", onKey);
    layer = null;
    if (!el) return;
    const fin = () => el.remove();
    el.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    el.classList.add("leaving");
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

  layer.querySelector<HTMLElement>("[data-act=close]")!.onclick = close;
  layer.addEventListener("mousedown", (e) => { if (e.target === layer) close(); });
  layer.querySelectorAll<HTMLAnchorElement>(".crd-item").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const repo = a.dataset.repo ?? "";
      const url = `https://github.com/${repo}`;
      const bridge = window.quaverCredits;
      if (!bridge) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      void bridge.open(url).then((r) => {
        if (!r?.ok) toast(`无法打开 GitHub：${r?.error ?? "未知错误"}`, "err");
      }).catch((e: unknown) => toast(`无法打开 GitHub：${errText(e)}`, "err"));
    };
  });

  document.body.append(layer);
  window.addEventListener("keydown", onKey);
}
