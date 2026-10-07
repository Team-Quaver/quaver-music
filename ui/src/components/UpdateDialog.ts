// Quaver — 更新提醒弹窗（模态，body 常驻层）。
//
// 「更新前先提醒」的载体：启动自动检查 / 设置页手动检查发现新版本（或待切换的渠道）后，
// 弹这里展示 GitHub release notes（update-core.renderNotes 渲染），用户点「立即更新」才开始下载。
// 两种意图共用本弹窗，措辞由 info.switching / info.decision.relation 决定：
//   同渠道升级 = 「发现新版本」+「立即更新」；换渠道 = 「切换到 …」+「立即切换」，
//   回退还要多一句版本号会变小的提示（配置/凭证/缓存不受影响）。
// 阶段机：confirm → downloading → ready（重启 / 退出安装 / 已打开安装包）；交给
// Gear Lever / AppManager 的路径不走下载（管理器自己拉取），点完给 toast 即收。
//
// 关闭语义：Esc / 点遮罩 = 「以后再说」，下载中先取消下载（AppImage 临时文件由主进程清理）。
import { toast } from "./SongMenu";
import { describeBuild, renderNotes } from "../lib/update-core";
import {
  type UpdateInfo, type DownloadHandle, downloadUpdate, finalizeInstall,
  quitAndInstallWindows, relaunchApp, openReleases, fetchManagers, runManagerUpdate,
} from "../lib/updater";
import { setLastNotified } from "../lib/prefs";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

let layer: HTMLElement | null = null;
let handle: DownloadHandle | null = null;

/** 打开更新弹窗。已有弹窗在开时忽略（启动检查与手动检查不会叠加）。 */
export function showUpdateDialog(info: UpdateInfo): void {
  if (layer) return;

  const kind = info.picked?.kind ?? null;
  const asset = info.picked?.asset ?? null;
  const selfInstallable = !!info.picked && (kind !== "appimage" || info.canReplaceAppimage);

  // Nightly 是滚动构建，没有「版本号」可言：标题认渠道，构建时间放 meta 行（stable 同位置是发布时间）
  const dateText = info.release.publishedAt ? new Date(info.release.publishedAt).toLocaleString() : "";
  const nightly = info.channel === "nightly";
  // 换渠道（设置里选的渠道 ≠ 当前构建所属渠道）与同渠道升级是两种事：前者说「切换」，
  // 标题/按钮照此措辞 —— 版本号可能不升反降，别写成「发现新版本」骗人。
  const titleHtml = info.switching
    ? (nightly ? `切换到 <b>Nightly</b> 构建` : `切换到正式版 <b>${esc(info.decision.latestDisplay)}</b>`)
    : (nightly ? `发现新的 <b>Nightly</b> 构建` : `发现新版本 <b>${esc(info.decision.latestDisplay)}</b>`);
  const metaText = `当前 ${esc(describeBuild(info.current))} → ${esc(info.decision.targetLabel)}`
    + (asset ? ` · ${fmtSize(asset.size)}` : "")
    + (dateText ? ` · ${nightly ? "构建于" : "发布于"} ${dateText}` : "");
  // 换渠道的关系说明：回退要说清「版本号会变小」，同版号要说清「只是换一份构建」
  const switchNote = !info.switching ? ""
    : info.decision.relation === "downgrade"
      ? "目标版本比当前更低，切换后版本号会回退；配置、登录凭证与播放缓存都不受影响。"
      : info.decision.relation === "same"
        ? `版本号与当前相同，只是换成 ${nightly ? "Nightly 滚动" : "Stable 正式"}构建。`
        : "";
  const mainLabel = info.switching ? "立即切换" : "立即更新";
  const skipLabel = info.switching ? "暂不切换" : "跳过此版本";
  const dangerNote = info.switching && info.decision.relation === "downgrade";

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `
    <div class="upd-dialog" role="dialog" aria-modal="true" aria-label="${info.switching ? "切换更新渠道" : "发现新版本"}">
      <div class="upd-head">
        <h3>${titleHtml} <span class="upd-badge ${info.channel}">${info.channel === "nightly" ? "Nightly" : "Stable"}</span></h3>
        <span class="muted upd-meta">${metaText}</span>
      </div>
      ${!info.picked ? `<p class="muted upd-warn">未找到适用于当前平台与架构的安装包，请到发布页手动下载。</p>` : ""}
      ${info.picked && kind === "appimage" && !info.canReplaceAppimage
        ? `<p class="muted upd-warn">当前不是 AppImage 运行方式，无法应用内替换更新，请到发布页下载。</p>` : ""}
      ${switchNote ? `<p class="upd-warn upd-switch${dangerNote ? " is-risk" : ""}">${switchNote}</p>` : ""}
      <div class="upd-notes">${renderNotes(info.release.body)}</div>
      <div class="upd-bar" hidden><i></i><span class="muted"></span></div>
      <div class="upd-foot">
        <button class="ghost-btn" data-act="skip" type="button">${skipLabel}</button>
        <button class="ghost-btn" data-act="later" type="button">以后再说</button>
        <span class="upd-managers"></span>
        <span class="upd-spacer"></span>
        <button class="upd-primary" data-act="main" type="button">${mainLabel}</button>
      </div>
    </div>`;

  const notes = layer.querySelector<HTMLElement>(".upd-notes")!;
  const bar = layer.querySelector<HTMLElement>(".upd-bar")!;
  const barFill = bar.querySelector<HTMLElement>("i")!;
  const barText = bar.querySelector<HTMLElement>("span")!;
  const skipBtn = layer.querySelector<HTMLButtonElement>('[data-act="skip"]')!;
  const laterBtn = layer.querySelector<HTMLButtonElement>('[data-act="later"]')!;
  const mainBtn = layer.querySelector<HTMLButtonElement>('[data-act="main"]')!;
  const managersBox = layer.querySelector<HTMLElement>(".upd-managers")!;
  const warnBox = layer.querySelectorAll<HTMLElement>(".upd-warn");

  // 覆盖层与 Esc 都是「以后再说」；下载中先取消下载。
  // 离场动画：加 .leaving 等过渡播完再摘节点；动画被禁用（reduced-motion）时
  // animationend 永不触发，靠超时兜底 —— 跟 views.ts 的 exitMe 同一套门闩。
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    if (handle) { handle.cancel(); handle = null; }
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

  skipBtn.onclick = () => { setLastNotified(info.decision.key); close(); };
  laterBtn.onclick = close;

  // —— 主按钮状态机 ——
  const setMain = (label: string, primary: boolean, onclick: () => void) => {
    mainBtn.textContent = label;
    mainBtn.className = primary ? "upd-primary" : "ghost-btn";
    mainBtn.onclick = () => { onclick(); };
  };

  if (!selfInstallable) {
    setMain("打开发布页", true, () => { void openReleases(info.channel).catch(() => {}); close(); });
  } else {
    setMain(mainLabel, true, startInstall);
  }

  async function startInstall() {
    if (!info.picked) return;
    // 下载阶段：进度条顶上，次要按钮全收（取消=主按钮），主按钮变「取消」
    bar.hidden = false;
    warnBox.forEach((w) => (w.hidden = true));
    skipBtn.hidden = true;
    laterBtn.hidden = true;
    managersBox.hidden = true;
    handle = downloadUpdate(info, (received, total) => {
      const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      barFill.style.setProperty("--w", `${pct}%`);
      barText.textContent = total ? `${pct}%（${fmtSize(received)} / ${fmtSize(total)}）` : fmtSize(received);
    });
    setMain("取消", false, () => { handle?.cancel(); });
    try {
      const { path } = await handle.promise;
      handle = null;
      const step = await finalizeInstall(info, path);
      bar.hidden = true;
      if (step.type === "appimage-replaced") {
        notes.hidden = true;
        laterBtn.hidden = false;
        laterBtn.textContent = "稍后手动重启";
        setMain("立即重启", true, () => { relaunchApp(); close(); });
      } else if (step.type === "installer-ready") {
        notes.hidden = true;
        laterBtn.hidden = false;
        laterBtn.textContent = "稍后";
        setMain("退出并安装", true, () => {
          void quitAndInstallWindows(path).catch((e: unknown) => toast(`更新失败：${errText(e)}`, "err"));
          close();
        });
      } else {
        notes.hidden = true;
        skipBtn.hidden = true;
        laterBtn.hidden = false;
        laterBtn.textContent = "关闭";
        setMain("完成", true, close);
      }
    } catch (e) {
      handle = null;
      // 主动取消是用户操作，不是失败：静默回到确认态
      if (!/已取消/.test(errText(e))) toast(`更新失败：${errText(e)}`, "err");
      // 回到确认态允许重试；notes/进度条复位
      bar.hidden = true;
      notes.hidden = false;
      skipBtn.hidden = false;
      laterBtn.hidden = false;
      laterBtn.textContent = "以后再说";
      warnBox.forEach((w) => (w.hidden = false));
      setMain(selfInstallable ? mainLabel : "打开发布页", true, selfInstallable ? startInstall : () => close());
    }
  }

  // —— 管理器联动（仅 AppImage 可替换场景）：懒检测，可用且已接管才补按钮 ——
  if (kind === "appimage" && info.canReplaceAppimage) {
    void fetchManagers().then((m) => {
      if (!layer || !m) return;
      const entries: Array<["gearlever" | "appmanager", string]> = [
        ["gearlever", "Gear Lever"],
        ["appmanager", "AppManager"],
      ];
      for (const [id, label] of entries) {
        if (!m[id]?.available || !m[id]?.managed) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ghost-btn ghost-btn--quiet";
        btn.textContent = `通过 ${label} 更新`;
        btn.onclick = () => {
          runManagerUpdate(id)
            .then(() => { toast(`已交给 ${label} 更新，完成后重启应用即可`); close(); })
            .catch((e: unknown) => toast(`${label} 更新失败：${errText(e)}`, "err"));
        };
        managersBox.append(btn);
      }
    });
  }

  document.body.append(layer);
}
