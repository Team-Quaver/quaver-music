// 由 vite.config.ts 的 define 注入（git tag 优先，回退 package.json version）
declare const __APP_VERSION__: string;

// 应用自更新桥（electron/preload.cjs 暴露；浏览器 dev 下不存在）。
// 执行端在 ui/electron/update.mjs，编排见 src/lib/updater.ts。
type UpdateInvokeMsg =
  | { op: "platform" }
  | { op: "fetch-release"; channel: "stable" | "nightly" }
  | { op: "download"; id: string; url: string; mode: "replace-appimage" | "installer" }
  | { op: "cancel-download"; id: string }
  | { op: "apply-appimage"; path: string }
  | { op: "install-windows"; path: string }
  | { op: "open-path"; path: string }
  | { op: "open-releases"; channel: "stable" | "nightly" }
  | { op: "appimage-managers" }
  | { op: "run-manager-update"; manager: "gearlever" | "appmanager" }
  | { op: "relaunch" }
  | { op: "quit" };

interface UpdateProgressPayload {
  id: string;
  received: number;
  total: number;
}

// Sparkle 第三方插件桥（electron/preload.cjs 暴露；浏览器 dev 下不存在）。
// 本文件是 ambient 声明文件（无 import/export），Window 直接全局合并。
interface Window {
  quaverUpdate?: {
    invoke(msg: UpdateInvokeMsg): Promise<any>;
    onProgress(cb: (p: UpdateProgressPayload) => void): void;
  };
  quaverSparkle?: {
    list(): Promise<{ ok: boolean; plugins?: { id: string; dir: string; manifest: Record<string, unknown>; installedAt: number }[] }>;
    install(msg: { url: string; sha256?: string; meta?: Record<string, unknown> }): Promise<{ ok: boolean; id?: string; error?: string }>;
    uninstall(msg: { id: string }): Promise<{ ok: boolean; error?: string }>;
    market(msg: { url: string }): Promise<{ ok: boolean; index?: unknown; error?: string }>;
    /** 「添加本地插件」第一步：native 文件选择器 + 读文件（base64；用户取消时 canceled=true） */
    pickLocal(): Promise<{ ok: boolean; canceled?: boolean; name?: string; dataBase64?: string; error?: string }>;
    /** 第二步：渲染层校验插件形状后回传本体（base64）与元数据，主进程落盘 */
    installLocal(msg: { dataBase64: string; meta?: Record<string, unknown> }): Promise<{ ok: boolean; id?: string; error?: string }>;
  };
}
