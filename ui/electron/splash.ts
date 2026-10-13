// Quaver — 启动闪屏：**盖在主窗口自己身上**的同窗覆盖层（不是独立小窗）。
//
// 为什么需要它：createWindow 要先 spawn sidecar 并等它健康（PyInstaller onefile 首启解包，
// 最长 15s），之后才导航到应用 —— 这段空窗期窗口里一片空白，用户只能脑补"没卡死"。
// 现在窗口一建好就先 load 闪屏页（data: URL，零依赖、秒出画面），sidecar/服务端在后台就绪，
// 闪屏至少演完一遍全程（SPLASH_MIN_MS，含底部署名）后淡出，随即导航到应用。
// 同尺寸、同底色、同窗口：交接是"同一个窗口亮起内容"，没有任何双窗对位/任务栏二重影问题。
//
// 时序真相在 createWindow：loadSplash（建窗后立刻）→ 慢路径 → await dismissSplash → loadURL。
// 模板/图标/常量的纯逻辑在 splash-page.ts（不 import electron，可单测）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { buildSplashHtml, stripSplashIconMarkup, SPLASH_MIN_MS } from "./splash-page.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// 单主窗模型：模块级状态就够（重建窗口走 warmBoot，不再放闪屏）。
let active = false;
let startedAt = 0;

/** 把闪屏页装进（刚建好的）主窗。素材/模板缺失只记日志、返回 false —— 闪屏绝不阻断启动。 */
export function loadSplash(
  win: BrowserWindow,
  opts: { dark: boolean; iconCandidates: string[]; log: (...args: unknown[]) => void },
): boolean {
  let template: string;
  try {
    template = readFileSync(join(HERE, "splash.html"), "utf8");
  } catch (e) {
    opts.log("[quaver] splash: 模板缺失，跳过闪屏:", String(e));
    return false;
  }
  let iconSvg = "";
  for (const p of opts.iconCandidates) {
    try {
      const raw = readFileSync(p, "utf8");
      if (raw.includes("<svg")) { iconSvg = stripSplashIconMarkup(raw); break; }
    } catch {}
  }
  if (!iconSvg) opts.log("[quaver] splash: 图标素材未命中，仅字标降级");
  let html: string;
  try {
    html = buildSplashHtml(template, { iconSvg, dark: opts.dark });
  } catch (e) {
    opts.log("[quaver] splash: 模板拼装失败，跳过闪屏:", String(e));
    return false;
  }
  // data: URL：不经 http 服务、不等 sidecar，建窗即渲染。preload 会照常注入本页（contextIsolation
  // 下只是挂 window 桥，闪屏页不用），无远端代码参与，安全面与应用页同级。
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  active = true;
  startedAt = Date.now();
  opts.log("[quaver] splash loaded");
  return true;
}

/** 收场：压住最短驻留让动画走完（含底部署名），然后页面淡出。淡出与随后的 loadURL 并行。 */
export async function dismissSplash(win: BrowserWindow): Promise<void> {
  if (!active) return;
  active = false;
  const wait = Math.max(0, startedAt + SPLASH_MIN_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  try {
    await win.webContents.executeJavaScript('document.body.classList.add("closing")');
  } catch {} // 页面可能已被导航换掉：淡出没赶上也无妨，导航本身就是收场
}
