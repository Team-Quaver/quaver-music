// Quaver — SPA 入口：应用持久化偏好（quaver.conf），boot 壳层；路由由 hash 驱动
// 配置在 preload 阶段已同步取好（见 src/lib/config.ts 顶部说明），这里无需等待任何异步。
import { applyTheme, applyFonts, applyDecor, applySidebar, syncCloseAction } from "./lib/prefs";
import { player } from "./player";
import { bootShell } from "./shell";
import { startMprisBridge } from "./mpris";

applyTheme();
applyFonts();
applyDecor();
// 侧栏缩态在 bootShell 之前先挂到 body 上：壳层一注入就是最终形态，不会先展开再收
applySidebar();
syncCloseAction(); // 把「关闭按钮行为」偏好推给 Electron 主进程（tray/quit）

if (!location.hash) location.replace("#/");
bootShell();
startMprisBridge(); // Electron 壳层才有桥；浏览器 dev 下为 no-op

// dev 钩子：e2e/调试可直接驱动播放器状态（生产构建不含）
if (import.meta.env.DEV) (window as any).__player = player;
