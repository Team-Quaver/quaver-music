// 「关闭全局导航」主进程侧行为探针：用与 electron/main.mjs 相同的守卫语义，
// 在隐藏 BrowserWindow 里实证三条路径（需 dev server 在 5173）：
//   1. 同 origin 整页跳转放行 —— 登录流程 location.href='/login.html' 的活路；
//   2. 跨 origin 顶层导航拦下（will-navigate preventDefault）；
//   3. window.open / 新窗口一律拒绝（setWindowOpenHandler deny，中键开新窗走同一条路）。
//
// 用法：先起 dev server，再
//   ./node_modules/.bin/electron scripts/probe-electron-nav.mjs
import { app, BrowserWindow } from "electron";

const BASE = process.env.PROBE_BASE ?? "http://[::1]:5173";
const appOrigin = new URL(BASE).origin;

let fails = 0;
const ok = (name, cond, note = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${note ? " — " + note : ""}`);
  if (!cond) fails++;
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const wc = win.webContents;
  let newWindows = 0;
  app.on("browser-window-created", () => newWindows++);

  // —— 与 main.mjs 逐字相同的守卫 ——
  wc.setWindowOpenHandler(({ url }) => {
    console.log("[probe] 已拒绝新窗口请求:", url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, navUrl) => {
    try { if (new URL(navUrl).origin === appOrigin) return; } catch {}
    e.preventDefault();
    console.log("[probe] 已拦截页面跳转:", navUrl);
  });

  await win.loadURL(`${BASE}/index.html#/`);
  await settle(600);

  // 1. 同 origin 整页跳转放行：login.html 的薄跳转层会再 replace 到 index.html#/login
  await wc.executeJavaScript("location.href = '/login.html'", true).catch(() => {});
  await settle(1500);
  ok("同 origin 整页跳转放行（登录流程活路）", wc.getURL().includes("/index.html#/login"), wc.getURL());

  // 2. 跨 origin 顶层导航拦下
  await wc.executeJavaScript("location.href = 'https://example.com/'", true).catch(() => {});
  await settle(1500);
  ok("跨 origin 顶层导航被拦下", !wc.getURL().includes("example.com"), wc.getURL());

  // 3. window.open 一律拒绝（不返回窗口句柄、不产生新 BrowserWindow）
  const opened = await wc.executeJavaScript(
    "window.open('https://example.com/') !== null", true,
  ).catch(() => null);
  await settle(800);
  ok("window.open 被拒绝（返回 null）", opened === false);
  ok("没有产生新 BrowserWindow（中键开新窗走同一条路）", newWindows === 0, `created=${newWindows}`);

  // 4. hash 路由不受影响（应用内导航的正路）
  await wc.executeJavaScript("location.hash = '#/settings'", true).catch(() => {});
  await settle(600);
  ok("应用内 hash 路由不受影响", wc.getURL().includes("#/settings"), wc.getURL());

  app.exit(fails ? 1 : 0);
});
