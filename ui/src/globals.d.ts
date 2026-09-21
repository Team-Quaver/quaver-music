// 由 vite.config.ts 的 define 注入（git tag 优先，回退 package.json version）
declare const __APP_VERSION__: string;

// Sparkle 第三方插件桥（electron/preload.cjs 暴露；浏览器 dev 下不存在）。
// 本文件是 ambient 声明文件（无 import/export），Window 直接全局合并。
interface Window {
  quaverSparkle?: {
    list(): Promise<{ ok: boolean; plugins?: { id: string; dir: string; manifest: Record<string, unknown>; installedAt: number }[] }>;
    install(msg: { url: string; sha256?: string; meta?: Record<string, unknown> }): Promise<{ ok: boolean; id?: string; error?: string }>;
    uninstall(msg: { id: string }): Promise<{ ok: boolean; error?: string }>;
    market(msg: { url: string }): Promise<{ ok: boolean; index?: unknown; error?: string }>;
  };
}
