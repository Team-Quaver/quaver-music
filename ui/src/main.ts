// Quaver — SPA 入口：应用持久化偏好（quaver.conf），boot 壳层；路由由 hash 驱动
// 配置在 preload 阶段已同步取好（见 src/lib/config.ts 顶部说明），这里无需等待任何异步。
import { applyTheme, applyFonts, applyDecor, applySidebar, syncCloseAction } from "./lib/prefs";
import { player } from "./player";
import { bootShell } from "./shell";
import { startMprisBridge } from "./mpris";
import { startInhibitBridge } from "./lib/inhibit";
import { startHotkeysBridge } from "./lib/hotkeys";
import { initSparkle } from "./sparkle/init";

applyTheme();
applyFonts();
applyDecor();
// 侧栏缩态在 bootShell 之前先挂到 body 上：壳层一注入就是最终形态，不会先展开再收
applySidebar();
syncCloseAction(); // 把「关闭按钮行为」偏好推给 Electron 主进程（tray/quit）

// 关闭「Tab 键遍历」（浏览器默认的焦点循环）：桌面音乐客户端用不上，
// Tab/Shift+Tab 不再把焦点移到卡片/按钮/输入框之间（捕获阶段拦下，登录页等所有视图一并生效）
window.addEventListener(
  "keydown",
  (e) => { if (e.key === "Tab") e.preventDefault(); },
  { capture: true },
);

// —— 全局输入治理（桌面客户端口径）——
// ① 中键不许「跳转/打开新窗口」：点在链接上，浏览器（含 Electron webview）缺省会开
//    新窗口/新标签跳走，这不是预期行为。mousedown 阶段拦掉自动滚动起点，auxclick 阶段
//    拦掉「新窗口打开」这个缺省动作 —— Electron 主进程另有 setWindowOpenHandler 兜底，
//    浏览器 dev 态没有主进程，全靠这里。不碰输入框（Linux 中键粘贴仍可用）。
// ② 鼠标左键按下按钮类元素不转移焦点：点按钮偷焦点是浏览器缺省行为，而空格键会被那个
//    还带着焦点的按钮吞掉 —— 将来空格=暂停、回车=导航确认的键盘操作都要靠焦点不落在
//    随手点过的按钮上。只拦左键（其它键无焦点语义）；输入类控件不拦（点搜索框要能打字，
//    音量条等原生控件也依赖焦点）。焦点只留给未来的键盘导航系统显式落焦。
const interactive = (t: EventTarget | null) =>
  t instanceof Element && t.closest("button, [role=\"button\"], a");
const linkish = (t: EventTarget | null) =>
  t instanceof Element && t.closest("a[href]");
window.addEventListener(
  "mousedown",
  (e) => {
    if (e.button === 1 && linkish(e.target)) e.preventDefault();
    else if (e.button === 0 && interactive(e.target)) e.preventDefault();
  },
  { capture: true },
);
window.addEventListener(
  "auxclick",
  (e) => { if (e.button === 1 && linkish(e.target)) e.preventDefault(); },
  { capture: true },
);

if (!location.hash) location.replace("#/");
bootShell();
// Sparkle 插件系统：必须在 bootShell 之后（要操作 nav DOM / np 插槽 / views 查表）；
// void 不阻塞首帧 —— 插件视图/侧栏项在首帧后补挂，属渐进增强
void initSparkle();
startMprisBridge(); // Electron 壳层才有桥；浏览器 dev 下为 no-op
startHotkeysBridge(); // 全局热键回程 + 焦点内热键 keydown（后者浏览器 dev 也生效）
startInhibitBridge(); // 播放音频时睡眠禁止（[Playing] InhibitSleep；播放态 → sidecar /api/inhibit）

// dev 钩子：e2e/调试可直接驱动播放器状态（生产构建不含）
if (import.meta.env.DEV) (window as any).__player = player;
