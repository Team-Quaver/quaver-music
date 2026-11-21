// Quaver — 更新提醒弹窗（模态，body 常驻层）。
//
// 「更新前先提醒」的载体：启动自动检查 / 设置页手动检查发现新版本（或待切换的渠道）后，
// 弹这里展示 GitHub release notes（update-core.renderNotes 渲染），用户点「立即更新」才开始下载。
// 两种意图共用本弹窗，措辞由 info.switching / info.decision.relation 决定：
//   同渠道升级 = 「发现新版本」+「立即更新」；换渠道 = 「切换到 …」+「立即切换」，
//   回退还要多一句版本号会变小的提示（配置/凭证/缓存不受影响）。
// 阶段机：confirm → downloading → installing（deb/rpm/pacman/flatpak 在终端里装）→ done（问是否退出）
//   或 ready（AppImage 重启 / Windows 退出安装 / dmg 已挂载）。安装口径：
//   AppImage = 唯一支持原子更新的形态，原位替换文件后提示重启；
//   Windows = 退出并静默安装；
//   deb/rpm/pacman/flatpak = 下载到「下载」目录后**在用户终端里**跑发行版包管理器
//     （pkexec apt/oma install、pkexec zypper/dnf install、pkexec pacman -U、flatpak install），
//     终端进程退出码 = 成败；成功即自动删掉安装包，然后问用户「现在退出 Quaver 完成更新吗」；
//   dmg = 交给系统挂载。下载由主进程做 sha256 完整性校验，本地已有校验通过的包不会重复下载。
//   商店托管（APM/星火、如意玲珑容器）：不提供应用内下载 —— picked 为空，弹窗只提醒「等待商店推送新版」。
//
// 关闭语义：Esc / 点遮罩 = 「以后再说」，下载中先取消下载（AppImage 临时文件由主进程清理）；
// 安装已开始后关窗只关界面，终端里的安装照常进行（结果由主进程落盘、下次启动仍能看到新版本）。
import "./dialog.css";
import { toast } from "../lib/toast";
import { channelLabel, describeBuild, renderNotes } from "../lib/update-core";
import {
  type UpdateInfo, type DownloadHandle, type InstallDone, type InstallWaiter,
  STORE_NAMES, downloadUpdate, finalizeInstall,
  isPackageKind, quitAndInstallWindows, quitApp, relaunchApp, openReleases, waitInstallDone,
} from "../lib/updater";
import { setLastNotified } from "../lib/prefs";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

let layer: HTMLElement | null = null;
let handle: DownloadHandle | null = null;

/** 包管理器安装的等待句柄（关窗时解除登记；终端里的安装不受影响）。 */
let installWaiter: InstallWaiter | null = null;

/** 打开更新弹窗。已有弹窗在开时忽略（启动检查与手动检查不会叠加）。 */
export function showUpdateDialog(info: UpdateInfo): void {
  if (layer) return;

  const kind = info.picked?.kind ?? null;
  const asset = info.picked?.asset ?? null;
  const selfInstallable = !!info.picked && (kind !== "appimage" || info.canReplaceAppimage);
  // 商店托管：这份应用由商店分发（picked 恒空），弹窗降级为「等商店推送」的纯提醒
  const store = info.store;
  const storeName = store ? STORE_NAMES[store] : "";

  const storeNote = store
    ? `本应用通过${esc(storeName)}${store === "spark" ? "（APM 琥珀容器）" : "（玲珑容器）"}安装，更新走商店审核链路，应用内下载/安装不适用于这种运行方式。请等待${esc(storeName)}推送 ${esc(info.decision.targetLabel)}。`
    : "";

  // Nightly 是滚动构建，没有「版本号」可言：标题认渠道，构建时间放 meta 行（stable/beta 同位置是发布时间）
  const dateText = info.release.publishedAt ? new Date(info.release.publishedAt).toLocaleString() : "";
  const nightly = info.channel === "nightly";
  const beta = info.channel === "beta";
  const channelName = channelLabel(info.channel);

  // 换渠道（设置里选的渠道 ≠ 当前构建所属渠道）与同渠道升级是两种事：前者说「切换」，
  // 标题/按钮照此措辞 —— 版本号可能不升反降，别写成「发现新版本」骗人。
  // Beta 有版本号（v1.5.0-beta.1），措辞跟 Stable 走、只换「Beta 版」字样；Nightly 没有版本号，认渠道。
  const titleHtml = info.switching
    ? (nightly ? `切换到 <b>Nightly</b> 构建` : `切换到${beta ? " Beta 版" : "正式版"} <b>${esc(info.decision.latestDisplay)}</b>`)
    : (nightly ? `发现新的 <b>Nightly</b> 构建` : `发现新版本 <b>${esc(info.decision.latestDisplay)}</b>`);

  const metaText = `当前 ${esc(describeBuild(info.current))} → ${esc(info.decision.targetLabel)}`
    + (asset ? ` · ${fmtSize(asset.size)}` : "")
    + (dateText ? ` · ${nightly ? "构建于" : "发布于"} ${dateText}` : "");

  // 换渠道的关系说明：回退要说清「版本号会变小」，同版号要说清「只是换一份构建」
  const switchNote = !info.switching ? ""
    : info.decision.relation === "downgrade"
      ? "目标版本比当前更低，切换后版本号会回退；配置、登录凭证与播放缓存都不受影响。"
      : info.decision.relation === "same"
        ? `版本号与当前相同，只是换成 ${nightly ? "Nightly 滚动" : beta ? "Beta 测试" : "Stable 正式"}构建。`
        : "";

  const mainLabel = info.switching ? "立即切换" : "立即更新";
  const skipLabel = info.switching ? "暂不切换" : "跳过此版本";
  const dangerNote = info.switching && info.decision.relation === "downgrade";

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `
    <div class="upd-dialog" role="dialog" aria-modal="true" aria-label="${info.switching ? "切换更新渠道" : "发现新版本"}">
      <div class="upd-head">
        <h3>${titleHtml} <span class="upd-badge ${info.channel}">${channelName}</span></h3>
        <span class="muted upd-meta">${metaText}</span>
      </div>
      ${store ? `<p class="upd-warn">${storeNote}</p>`
        : !info.picked ? `<p class="muted upd-warn">未找到适用于当前平台与架构的安装包，请到发布页手动下载。</p>` : ""}
      ${info.picked && kind === "appimage" && !info.canReplaceAppimage
        ? `<p class="muted upd-warn">当前不是 AppImage 运行方式，无法应用内替换更新，请到发布页下载。</p>` : ""}
      ${switchNote ? `<p class="upd-warn upd-switch${dangerNote ? " is-risk" : ""}">${switchNote}</p>` : ""}
      <div class="upd-notes">${renderNotes(info.release.body)}</div>
      <div class="upd-bar" hidden><i></i><span class="muted"></span></div>
      <div class="upd-foot">
        <button class="ghost-btn" data-act="skip" type="button">${skipLabel}</button>
        <button class="ghost-btn" data-act="later" type="button">以后再说</button>
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
  const warnBox = layer.querySelectorAll<HTMLElement>(".upd-warn");

  // 覆盖层与 Esc 都是「以后再说」；下载中先取消下载。
  // 离场动画：加 .leaving 等过渡播完再摘节点；动画被禁用（reduced-motion）时
  // animationend 永不触发，靠超时兜底 —— 跟 views/_shared.ts 的 exitMe 同一套门闩。
  let closing = false;

  const close = () => {
    if (closing) return;
    closing = true;

    if (handle) { handle.cancel(); handle = null; }

    if (installWaiter) { installWaiter.cancel(); installWaiter = null; }

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
    mainBtn.disabled = false;
    mainBtn.onclick = () => { onclick(); };
  };

  if (store) {
    // 只提醒不下载：「知道了」与「以后再说」同样离场，「跳过此版本」仍会记住 key 不再打扰
    setMain("知道了", true, close);
  } else if (!selfInstallable) {
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
    handle = downloadUpdate(info, (received, total) => {
      const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      barFill.style.setProperty("--w", `${pct}%`);
      barText.textContent = total ? `${pct}%（${fmtSize(received)} / ${fmtSize(total)}）` : fmtSize(received);
    });
    setMain("取消", false, () => { handle?.cancel(); });

    try {
      const h = handle;
      const { path } = await h.promise;
      handle = null;

      // 包管理器安装的结果事件可能来得很快（命令秒退）—— 必须在起安装**之前**登记等待
      if (kind && isPackageKind(kind)) installWaiter = waitInstallDone(h.id);

      const step = await finalizeInstall(info, path, h.id);
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
      } else if (step.type === "package-installing") {
        showInstalling(step.path, step.command);
      } else if (step.type === "package-manual") {
        // 起不了终端（极简 WM / 无候选程序 / Flatpak 沙箱里没有 flatpak CLI）：把命令原样交给用户
        installWaiter?.cancel();
        installWaiter = null;
        notes.hidden = false;
        notes.innerHTML = `<p class="muted">安装包已下载并通过校验，但没能在这里自动安装。请在终端执行：</p>
          <pre><code>${esc(step.command)}</code></pre>
          <p class="muted">${kind === "flatpak"
            ? "Flatpak 沙箱里不能执行 flatpak install —— 请在<strong>宿主机的终端</strong>里跑上面这条命令，"
            : "装完后手动删掉安装包，"}然后退出应用重新打开即可使用新版本。</p>`;
        skipBtn.hidden = true;
        laterBtn.hidden = false;
        laterBtn.textContent = "稍后";
        setMain("知道了", true, close);
      } else {
        // dmg：主进程已交给系统挂载
        notes.hidden = false;
        notes.innerHTML = `<p class="muted">已打开安装包，请在系统界面中完成安装。</p>`;
        skipBtn.hidden = true;
        laterBtn.hidden = true;
        setMain("关闭", true, close);
      }
    } catch (e) {
      handle = null;
      installWaiter?.cancel();
      installWaiter = null;

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

  /** 安装中态：终端里在跑包管理器，弹窗只留「在后台继续」+ 命令回显。结果来了再换按钮。 */
  function showInstalling(path: string, command: string) {
    const dir = path.replace(/[\\/][^\\/]*$/, "");

    notes.hidden = false;
    notes.innerHTML = `<p class="muted">已打开终端，正在执行：</p>
      <pre><code>${esc(command)}</code></pre>
      <p class="muted">按终端里的提示操作（可能需要输入管理员密码）。安装成功后会删除安装包 <code>${esc(path)}</code>，并在此询问是否退出应用。</p>`;
    skipBtn.hidden = true;
    laterBtn.hidden = false;
    laterBtn.textContent = "在后台继续";
    setMain("安装中…", false, () => close());
    mainBtn.disabled = true;

    const waiter = installWaiter!;

    void waiter.promise.then((r: InstallDone) => {
      if (layer == null) return;   // 弹窗已关：不打扰
      installWaiter = null;
      bar.hidden = true;
      mainBtn.disabled = false;

      if (r.ok) {
        // 装完了：主进程已删包 → 问是否现在退出（用户装的是发行版包，退出后重开即新版）
        notes.innerHTML = `<p class="muted">安装成功，安装包已自动删除（<code>${esc(path)}</code>）。</p>
          <p class="muted">现在退出 Quaver Music 完成更新吗？重新打开即可使用新版本。</p>`;
        skipBtn.hidden = true;
        laterBtn.hidden = false;
        laterBtn.textContent = "稍后自己退出";
        laterBtn.onclick = close;
        setMain("退出应用", true, () => { void quitApp(); });
        mainBtn.focus();

        return;
      }

      // 失败 / 用户关了终端：包留着（可能是权限失败、依赖冲突），指出去向与手动命令
      notes.innerHTML = `<p class="muted">${r.completed
        ? `安装没有成功（${esc(r.error)}）。安装包仍在 <code>${esc(dir)}</code>，可在终端手动执行下面的命令重试：`
        : `没有等到安装结束（${esc(r.error)}）。安装包仍在 <code>${esc(dir)}</code>；如需重试，在终端执行：`}</p>
        <pre><code>${esc(command)}</code></pre>`;
      skipBtn.hidden = true;
      laterBtn.hidden = false;
      laterBtn.textContent = "稍后";
      laterBtn.onclick = close;
      setMain("知道了", true, close);
    });
  }

  document.body.append(layer);
}
