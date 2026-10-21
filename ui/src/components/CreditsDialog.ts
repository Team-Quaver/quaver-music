// Quaver — 开源软件 / 第三方库引用弹窗（设置 → 通用 → 版本号下方）
//
// 列表项可展开查看用途；仓库链接交给主进程 shell.openExternal，
// 因为应用窗口本身禁止新开 BrowserWindow。浏览器 dev 下没有主进程桥，退回 window.open。
import { toast } from "./SongMenu";

type Credit = { repo: string; license: string; purpose: string };

const CREDITS: Credit[] = [
  { repo: "electron/electron", license: "MIT", purpose: "本应用的主渲染引擎" },
  { repo: "vitejs/vite", license: "MIT", purpose: "本应用的前端构建工具" },
  { repo: "amll-dev/applemusic-like-lyrics", license: "AGPL-v3", purpose: "本应用的歌词主解析/渲染引擎" },
  { repo: "SPlayer-Dev/lyric-kit", license: "AGPL-v3", purpose: "本应用的歌词附加解析引擎（仅 QRC Kana）" },
  { repo: "team-quaver/quaver-sparkle", license: "AGPL-v3", purpose: "本应用的插件 SDK，与插件供应商" },
  { repo: "team-quaver/typhoeus-go", license: "AGPL-v3", purpose: "本应用的后端，提供系统集成，流媒体 API 接入等功能" },
  { repo: "dbusjs/mpris-service", license: "MIT", purpose: "Linux MPRIS 2.0 D-Bus 接口" },
  { repo: "L-1124/QQMusicApi", license: "GPL-3.0", purpose: "本应用曾经的后端" },
  { repo: "BYVoid/OpenCC", license: "Apache-2.0", purpose: "为本应用提供繁简转换功能" },
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
      <span class="muted upd-meta">Quaver 的成长离不开这些开源项目。展开查看用途，或前往对应仓库。</span>
    </div>
    <div class="upd-notes crd-list">
      ${CREDITS.map((c) => `<details class="crd-item">
        <summary class="crd-summary">
          <span class="crd-repo">${esc(c.repo)}</span>
          <span class="crd-license">${esc(c.license)}</span>
          <span class="crd-arrow" aria-hidden="true">⌄</span>
        </summary>
        <div class="crd-panel">
          <p class="crd-purpose">${esc(c.purpose)}</p>
          <button class="ghost-btn crd-link" type="button" data-repo="${esc(c.repo)}">前往 GitHub <span aria-hidden="true">↗</span></button>
        </div>
      </details>`).join("")}
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
  const items = layer.querySelectorAll<HTMLDetailsElement>(".crd-item");
  items.forEach((item) => {
    item.querySelector("summary")?.addEventListener("click", () => {
      // 关闭态点击 = 即将展开：先收起其他项（同步执行，避免两段同时撑开）。
      if (item.open) return;
      items.forEach((other) => { if (other !== item) other.open = false; });
    });
  });
  layer.querySelectorAll<HTMLButtonElement>(".crd-link").forEach((btn) => {
    btn.onclick = () => {
      const repo = btn.dataset.repo ?? "";
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
