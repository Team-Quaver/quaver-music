// Quaver — 应用自更新（主进程执行端）。
//
// 渲染层（src/lib/updater.ts）负责版本比较与流程编排，这里只提供四类原子能力：
//   1. fetch-release：GitHub Releases 代理（stable=latest release；beta=列表中 tag 含 beta 的 prerelease；
//      nightly=滚动 tag「nightly」），
//      归一化后交给渲染层解析 —— 主进程不认版本号，避免两边逻辑漂移；
//   2. download：流式下载安装包 + 进度推送。AppImage 替换更新必须与本体同目录同文件系统
//      （rename 原子替换跨不了挂载点），落盘位置由 mode 决定；
//   3. 安装收尾：AppImage 原位替换（**文件名保持旧文件原名** —— 桌面项 / 快捷方式的 Exec
//      都指向旧路径，改名即断链）、Windows NSIS 静默安装（装完自动拉起新版）、
//      deb/rpm/mac dmg 交给系统默认应用打开（Linux 走 xdg-open）；
//   4. 平台档案：报告运行方式（$APPIMAGE 在位 = AppImage，否则是发行版包）与架构，渲染层据此挑安装包。
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const GITHUB_REPO = "team-quaver/quaver-music";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

/** 进度推给当前窗口（下载在主进程，渲染层只认 quaver:update-progress 事件）。 */
const sendProgress = (id, received, total) => {
  const win = BrowserWindow.getAllWindows()[0];
  try { win?.webContents?.send("quaver:update-progress", { id, received, total }); } catch { /* 窗口已关 */ }
};

// ——— 下载任务表：id → AbortController（弹窗关闭/取消按钮据此中断） ———
const downloads = new Map();

// ——— 小工具 ———

/** Linux 发行版的原生包类型：读 /etc/os-release 的 ID / ID_LIKE 判 deb / rpm。
 *  认不出来（如 Arch/未知发行版）返回 null —— 渲染层退回旧口径（AppImage 兜底），不硬猜。 */
const DEB_LIKE = new Set(["debian", "ubuntu", "linuxmint", "lmde", "pop", "elementary", "kali", "raspbian", "devuan", "deepin", "uos", "kylin", "neon", "zorin", "mx", "parrot"]);
const RPM_LIKE = new Set(["fedora", "rhel", "centos", "rocky", "almalinux", "ol", "oracle", "amzn", "opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles", "suse", "mageia", "nobara", "bazzite"]);
async function linuxPkgKind(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  let text = "";
  try { text = await readFile("/etc/os-release", "utf8"); } catch { return null; }
  const toks = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim());
    if (!m) continue;
    for (const t of m[2].replace(/["']/g, "").trim().split(/\s+/)) if (t) toks.add(t.toLowerCase());
  }
  if ([...toks].some((t) => DEB_LIKE.has(t))) return "deb";
  if ([...toks].some((t) => RPM_LIKE.has(t))) return "rpm";
  return null;
}

/** Linux：交给系统默认应用打开（xdg-open）—— deb/rpm 走这里，用户在自己的包管理器里确认安装。 */
function xdgOpen(path: string) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (err: unknown) => { if (done) return; done = true; resolve(err ?? null); };
    let child;
    try {
      child = spawn("xdg-open", [path], { detached: true, stdio: "ignore" });
    } catch (e) { finish(e); return; }
    child.once("error", finish);
    child.once("spawn", () => { child.unref(); finish(null); });
  });
}

/** 从下载 URL 取落盘文件名（github assets 的 URL 段就是原始文件名）。 */
function assetBasename(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name.replace(/[\\/]/g, "_") || "quaver-update.bin";
  } catch {
    return "quaver-update.bin";
  }
}

/** 流式下载：进度按整百分比推送（事件风暴会让渲染层卡顿）。 */
async function downloadTo(id, url, dest, log) {
  const ctl = new AbortController();
  downloads.set(id, ctl);
  const ws = createWriteStream(dest, { mode: 0o755 });
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    let received = 0;
    let lastPct = -1;
    await pipeline(
      Readable.fromWeb(res.body),
      new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          const pct = total ? Math.floor((received / total) * 100) : -1;
          if (pct !== lastPct) {
            lastPct = pct;
            sendProgress(id, received, total);
          }
          cb(null, chunk);
        },
      }),
      ws,
    );
    log(`[quaver] update: downloaded ${dest} (${received} bytes)`);
    return { ok: true, path: dest, size: received };
  } catch (e) {
    await rmQuiet(dest);
    const canceled = ctl.signal.aborted;
    return { ok: false, canceled, error: canceled ? "下载已取消" : String(e?.message ?? e) };
  } finally {
    downloads.delete(id);
  }
}

async function rmQuiet(path) {
  try { await rm(path, { force: true }); } catch { /* 尽力而为 */ }
}

// ——— IPC 注册 ———

export function setupUpdaterIPC({ log }) {
  ipcMain.handle("quaver:update", async (_e, msg) => {
    const op = msg?.op;
    try {
      // 平台档案：渲染层据此选安装包（arch）与安装方式。
      // appimage = $APPIMAGE 在位（应用内原位替换）；pkg = 发行版原生包偏好（deb / rpm），
      // 两者都缺省时渲染层退回 AppImage 优先的旧口径。pkg 探测只在 Linux 跑（读 /etc/os-release）。
      if (op === "platform") {
        return {
          ok: true,
          platform: process.platform,
          arch: process.arch,
          appimage: process.env.APPIMAGE ?? null,
          pkg: await linuxPkgKind(),
          packaged: app.isPackaged,
          version: app.getVersion(),
        };
      }

      // GitHub Releases 代理：404=渠道还没有版本；403 多为匿名 API 限流。
      // beta 没有「latest prerelease」接口，取 releases 列表原样交给渲染层（主进程不认版本号，
      // 由 update-core.pickBetaRelease 按「tag 含 beta 且 prerelease=true」挑最新那份）。
      if (op === "fetch-release") {
        const channel = msg?.channel === "nightly" ? "nightly" : msg?.channel === "beta" ? "beta" : "stable";
        const url = channel === "nightly" ? `${GITHUB_API}/tags/nightly`
          : channel === "beta" ? `${GITHUB_API}?per_page=100`
          : `${GITHUB_API}/latest`;
        const res = await fetch(url, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "quaver-updater" },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 404) {
          const why = channel === "nightly" ? "Nightly 渠道还没有构建" : channel === "beta" ? "Beta 渠道还没有预发布版本" : "还没有正式发布版";
          return { ok: false, error: why };
        }
        if (res.status === 403) return { ok: false, error: (await res.json().catch(() => null))?.message || "GitHub API 请求被限流，请稍后再试" };
        if (!res.ok) return { ok: false, error: `GitHub API HTTP ${res.status}` };
        const data = await res.json();
        if (channel === "beta") return { ok: true, releases: Array.isArray(data) ? data : [] };
        return { ok: true, release: data };
      }

      // 下载。mode=replace-appimage：落 $APPIMAGE 同目录的隐藏临时文件（rename 才能原子替换）；
      // mode=installer：落系统临时目录，交给系统安装器
      if (op === "download") {
        const url = String(msg?.url ?? "");
        if (!/^https:\/\//.test(url)) return { ok: false, error: "下载地址必须是 https" };
        const id = String(msg?.id ?? "");
        if (!id || downloads.has(id)) return { ok: false, error: "下载任务标识不合法或已在进行中" };
        let dest;
        if (msg?.mode === "replace-appimage") {
          const appimage = process.env.APPIMAGE;
          if (!appimage) return { ok: false, error: "当前不是 AppImage 运行方式，无法原位替换" };
          dest = join(dirname(appimage), `.${basename(appimage)}.update-${process.pid}`);
        } else {
          dest = join(tmpdir(), `quaver-update-${id}-${assetBasename(url)}`);
        }
        log(`[quaver] update: download → ${dest}`);
        return await downloadTo(id, url, dest, log);
      }

      if (op === "cancel-download") {
        const ctl = downloads.get(String(msg?.id ?? ""));
        if (ctl) ctl.abort();
        return { ok: true };
      }

      // AppImage 原位替换：同目录临时文件已就位 → chmod + rename（原子）。
      // 文件名不变：桌面项（Exec=$APPIMAGE）与快捷方式都继续有效。
      if (op === "apply-appimage") {
        const appimage = process.env.APPIMAGE;
        if (!appimage) return { ok: false, error: "当前不是 AppImage 运行方式" };
        const path = String(msg?.path ?? "");
        if (!path.startsWith(dirname(appimage))) return { ok: false, error: "临时文件不在 AppImage 同目录，拒绝替换" };
        await chmod(path, 0o755);
        await rename(path, appimage);
        log(`[quaver] update: AppImage replaced in place: ${appimage}`);
        return { ok: true };
      }

      // Windows：NSIS 静默安装（electron-builder oneClick 包认 /S）。
      // 关键：oneClick 安装器默认只在**非静默**时 runAfterFinish（installSection.nsh：
      // `${ifNot} ${Silent} ${orIf} ${isForceRun}` → StartApp）。更新走 /S 静默，不加 --force-run
      // 就等于装完什么都不启动 —— 应用自己退出后再没人拉起新版。--force-run 让静默安装同样
      // 拉起 quaver（更新时安装器会带 --updated 参数），首装与更新都落在这一条指令上。
      if (op === "install-windows") {
        const path = String(msg?.path ?? "");
        if (!/\.exe$/i.test(path)) return { ok: false, error: "不是安装程序" };
        spawn(path, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
        log(`[quaver] update: NSIS installer launched (silent, force-run)`);
        return { ok: true };
      }

      // Linux deb/rpm → xdg-open（默认应用，通常是发行版的图形包安装器）；
      // macOS dmg → shell.openPath 交给系统挂载。用户在自己的界面里确认安装。
      if (op === "open-path") {
        const path = String(msg?.path ?? "");
        if (process.platform === "linux") {
          const err = await xdgOpen(path);
          return err ? { ok: false, error: String(err?.message ?? err) } : { ok: true };
        }
        const err = await shell.openPath(path);
        return err ? { ok: false, error: err } : { ok: true };
      }

      if (op === "open-releases") {
        const channel = msg?.channel === "nightly" ? "nightly" : msg?.channel === "beta" ? "beta" : "stable";
        await shell.openExternal(channel === "stable"
          ? `https://github.com/${GITHUB_REPO}/releases/latest`
          : `https://github.com/${GITHUB_REPO}/releases`);
        return { ok: true };
      }

      // 重启。AppImage 原位替换后**不能**直接 app.relaunch()：默认重启的是 process.execPath，
      // 而 AppImage 里它指向只读挂载点（/tmp/.mount_*/quaver）——旧镜像随宿主退出即卸载，重启
      // 要么重跑旧构建、要么因挂载点消失压根起不来（这正是「替换更新看着没生效」的根因）。
      // 把 execPath 指到 $APPIMAGE 本体，让运行时重新挂载刚替换好的新镜像。其余平台沿用默认。
      if (op === "relaunch") {
        const appimage = process.env.APPIMAGE;
        if (process.platform === "linux" && appimage) {
          app.relaunch({ execPath: appimage });
          log(`[quaver] update: relaunch via AppImage ${appimage}`);
        } else {
          app.relaunch();
        }
        app.exit(0);
        return { ok: true };
      }

      if (op === "quit") {
        app.quit();
        return { ok: true };
      }

      return { ok: false, error: `未知 op: ${op}` };
    } catch (e) {
      log(`[quaver] update op ${op} failed:`, String(e?.stack || e));
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}
