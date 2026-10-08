// Quaver — 应用自更新（渲染层编排）：检查 → 提醒（更新日志弹窗）→ 确认 → 下载 → 安装。
//
// 分工：纯逻辑（版本比较/安装包挑选/notes 渲染）在 update-core.ts；执行端（GitHub API 代理/
// 流式下载/AppImage 原位替换/管理器联动）在主进程 electron/update.ts；本文件只串流程。
//
// 渠道口径见 update-core.ts 头注。两种意图分开：
//   - 同渠道升级：目标必须比当前新（自动检查默认开，绝不静默安装 —— 先弹窗展示更新日志，
//     用户点「立即更新」才动文件；「跳过此版本」记进 Update.LastNotified）。
//   - 渠道切换：设置里选的渠道 ≠ 当前构建所属渠道（buildChannel）→ 按「换一份构建」判定，
//     同版号乃至回退都提示，用户点的按钮也从「立即更新」变成「立即切换」。
// 「当前构建所属渠道」由当前构建的版本串判定（打包态版本带短 sha = nightly），不额外落盘，
// 所以换版本/重装都不会失配。
// 边角：手动下载 nightly 覆盖安装、但设置里始终是默认的 Stable 时，启动会被提醒一次
// 「切换到正式版」—— 这是刻意的（「选中的渠道」就是唯一的意图信号，而它说 Stable），
// 点「暂不切换」即记进 Update.LastNotified，不再打扰。
import {
  GITHUB_REPO, buildChannel, decideUpdate, normalizeRelease, parseVersion, pickAsset,
  type AssetKind, type ReleaseAsset, type ReleaseInfo, type UpdateDecision,
} from "./update-core";
import { getAutoCheck, getUpdateChannel, getLastNotified, type UpdateChannel } from "./prefs";
import { showUpdateDialog } from "../components/UpdateDialog";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const bridge = () => (window as any).quaverUpdate;

// ——— 平台档案 ———

export interface PlatformInfo {
  platform: string;
  arch: string;
  appimage: string | null;
  packaged: boolean;
  version: string;
}

export async function getPlatformInfo(): Promise<PlatformInfo | null> {
  const r = await bridge()?.invoke?.({ op: "platform" }).catch(() => null);
  return r?.ok ? (r as PlatformInfo) : null;
}

/** 浏览器 dev（无桥）的兜底识别：够 check 用，下载/安装反正无桥不可用。 */
function guessPlatform(): { platform: string; arch: string } {
  const ua = navigator.userAgent;
  const platform = /Win/.test(ua) ? "win32" : /Mac/.test(ua) ? "darwin" : "linux";
  const arch = /(aarch64|arm64)/i.test(ua) ? "arm64" : "x64";
  return { platform, arch };
}

// ——— 检查 ———

export interface UpdateInfo {
  channel: UpdateChannel;
  /** 当前正在运行的构建所属渠道（由版本串判定，不是设置里选的那个） */
  installedChannel: UpdateChannel;
  /** installedChannel ≠ channel → 本次是「换渠道」而非同渠道升级 */
  switching: boolean;
  /** 当前构建的版本串（打包态取 app.getVersion()，否则 __APP_VERSION__） */
  current: string;
  decision: UpdateDecision;
  release: ReleaseInfo;
  picked: { asset: ReleaseAsset; kind: AssetKind } | null;
  /** 与 Update.LastNotified 一致：自动检查命中时不再弹窗 */
  skipped: boolean;
  /** 当前是 AppImage 运行方式（AppImage 产物可原位替换的前提） */
  canReplaceAppimage: boolean;
  /** 打包态（dev / 浏览器为 false）—— 换渠道提醒只在真装出来的构建上自动弹 */
  packaged: boolean;
}

export type CheckResult =
  | { status: "up-to-date"; channel: UpdateChannel }
  | { status: "available"; channel: UpdateChannel; info: UpdateInfo }
  | { status: "error"; channel: UpdateChannel; error: string };

export async function checkUpdate(channel: UpdateChannel = getUpdateChannel()): Promise<CheckResult> {
  try {
    const b = bridge();
    // 平台档案与 release 请求互不依赖，并发发出去（平台档案还要定「当前构建渠道」）
    const pfP: Promise<PlatformInfo | null> = b?.invoke ? getPlatformInfo() : Promise.resolve(null);
    let raw: any;
    if (b?.invoke) {
      const r = await b.invoke({ op: "fetch-release", channel });
      if (!r?.ok) return { status: "error", channel, error: r?.error ?? "GitHub API 请求失败" };
      raw = r.release;
    } else {
      // 浏览器 dev：api.github.com 允许跨域，检查这一步仍然能跑（下载/安装需壳层）
      const path = channel === "nightly" ? "releases/tags/nightly" : "releases/latest";
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/${path}`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return { status: "error", channel, error: channel === "nightly" ? "Nightly 渠道还没有构建" : "还没有正式发布版" };
      if (!res.ok) return { status: "error", channel, error: `GitHub API HTTP ${res.status}` };
      raw = await res.json();
    }

    const pf = await pfP;
    const { platform, arch } = pf ?? guessPlatform();
    // 版本真相优先取打包态的 app.getVersion()（CI 用 extraMetadata 写进去的就是同一个版本号）：
    // __APP_VERSION__ 是构建期注入的，dev 下落在 git tag 上，两者都可能不是「正在跑的这份」。
    const current = pf?.version && parseVersion(pf.version) ? pf.version : __APP_VERSION__;
    const installedChannel = buildChannel(current);
    const switching = channel !== installedChannel;

    const release = normalizeRelease(raw);
    const decision = decideUpdate(current, channel, release, { switch: switching });
    if ("error" in decision) return { status: "error", channel, error: decision.error };

    return {
      status: decision.available ? "available" : "up-to-date",
      channel,
      info: {
        channel,
        installedChannel,
        switching,
        current,
        decision,
        release,
        picked: decision.available ? pickAsset(platform, arch, release.assets) : null,
        skipped: decision.key === getLastNotified(),
        canReplaceAppimage: !!pf?.appimage,
        packaged: !!pf?.packaged,
      },
    };
  } catch (e) {
    return { status: "error", channel, error: errText(e) };
  }
}

// ——— 下载 / 安装 ———

/** 进度按整百分比从主进程推上来，这里按下载 id 分发给当前订阅者（弹窗）。 */
const progressCbs = new Map<string, (received: number, total: number) => void>();
if (typeof window !== "undefined") {
  window.quaverUpdate?.onProgress((p) => progressCbs.get(p.id)?.(p.received, p.total));
}

export interface DownloadHandle {
  id: string;
  promise: Promise<{ path: string }>;
  cancel: () => void;
}

/**
 * 下载更新包。AppImage 原位替换场景落 $APPIMAGE 同目录（rename 原子替换不可跨文件系统），
 * 其余落系统临时目录。resolve 的是落盘路径（不是「安装完成」）。
 */
export function downloadUpdate(info: UpdateInfo, onProgress: (received: number, total: number) => void): DownloadHandle {
  const id = `upd-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const promise = (async () => {
    try {
      if (!bridge()?.invoke) throw new Error("下载更新需要在桌面端运行");
      progressCbs.set(id, onProgress);
      const pf = await getPlatformInfo();
      const mode = info.picked!.kind === "appimage" && pf?.appimage ? "replace-appimage" : "installer";
      const r = await bridge().invoke({ op: "download", id, url: info.picked!.asset.url, mode });
      if (!r?.ok) throw new Error(r?.error ?? "下载失败");
      return { path: String(r.path) };
    } finally {
      progressCbs.delete(id);
    }
  })();
  return {
    id,
    promise,
    cancel: () => { void bridge()?.invoke?.({ op: "cancel-download", id }); },
  };
}

export type InstallStep =
  | { type: "appimage-replaced" }
  | { type: "installer-ready"; path: string }
  | { type: "installer-opened" };

/** 下载完成后的收尾：AppImage 原位替换；exe 等用户点「退出并安装」；dmg/deb 交给系统打开。 */
export async function finalizeInstall(info: UpdateInfo, path: string): Promise<InstallStep> {
  const kind = info.picked!.kind;
  if (kind === "appimage") {
    const r = await bridge().invoke({ op: "apply-appimage", path });
    if (!r?.ok) throw new Error(r?.error ?? "AppImage 替换失败");
    return { type: "appimage-replaced" };
  }
  if (kind === "exe") return { type: "installer-ready", path };
  const r = await bridge().invoke({ op: "open-path", path });
  if (!r?.ok) throw new Error(r?.error ?? "无法打开安装包");
  return { type: "installer-opened" };
}

/** Windows：拉起 NSIS 静默安装并退出应用（安装器装完会自行启动新版）。 */
export async function quitAndInstallWindows(path: string): Promise<void> {
  const r = await bridge().invoke({ op: "install-windows", path });
  if (!r?.ok) throw new Error(r?.error ?? "无法启动安装程序");
  await bridge().invoke({ op: "quit" });
}

export function relaunchApp(): void {
  void bridge()?.invoke?.({ op: "relaunch" });
}

/** 打开发布页（找不到对应平台安装包 / 不支持应用内更新时的出口）。 */
export async function openReleases(channel: UpdateChannel): Promise<void> {
  if (bridge()?.invoke) {
    await bridge().invoke({ op: "open-releases", channel });
    return;
  }
  window.open(channel === "nightly"
    ? `https://github.com/${GITHUB_REPO}/releases`
    : `https://github.com/${GITHUB_REPO}/releases/latest`, "_blank");
}

// ——— Gear Lever / AppManager（AppImage 管理器）联动 ———

export interface ManagersInfo {
  gearlever: { available: boolean; managed: boolean };
  appmanager: { available: boolean; managed: boolean };
}

export async function fetchManagers(): Promise<ManagersInfo | null> {
  const r = await bridge()?.invoke?.({ op: "appimage-managers" }).catch(() => null);
  return r?.ok ? (r.managers as ManagersInfo) : null;
}

/** 把更新交给管理器（它们各自负责下载/替换/桌面项；完成后的重启由用户自行操作）。 */
export async function runManagerUpdate(manager: "gearlever" | "appmanager"): Promise<void> {
  const r = await bridge().invoke({ op: "run-manager-update", manager });
  if (!r?.ok) throw new Error(r?.error ?? "无法交给管理器更新");
}

// ——— 启动自动检查 ———

/**
 * 检查并提醒：发现新版本 / 待切换的渠道就弹弹窗（「更新前先提醒」的统一入口）。
 * auto=true（启动自动检查）= 尊重「跳过此版本」，且**换渠道的提醒只在打包态弹** ——
 * dev / 浏览器里「当前构建属于哪个渠道」没有意义（版本串是 git tag 或包里的 0.0.x），
 * 不该在启动时弹一个切换提示；手动检查（设置页按钮 / 点渠道卡片）不带 auto，一律弹。
 */
export async function checkAndPrompt(
  channel: UpdateChannel = getUpdateChannel(),
  opts?: { auto?: boolean },
): Promise<CheckResult> {
  const r = await checkUpdate(channel);
  if (r.status !== "available") return r;
  if (opts?.auto && (r.info.skipped || (r.info.switching && !r.info.packaged))) return r;
  showUpdateDialog(r.info);
  return r;
}

/** 启动延迟检查（默认开，可在设置关闭）：只提醒、绝不静默安装。
 *  dev / 浏览器模式同样生效 —— 无壳层时直连 GitHub API（提醒能弹，「下载安装」那步才需要桥）。 */
export function startAutoUpdateCheck(): void {
  window.setTimeout(() => {
    if (!getAutoCheck()) return;
    void checkAndPrompt(undefined, { auto: true }).catch(() => { /* 检查失败不打扰启动 */ });
  }, 3000);
}
