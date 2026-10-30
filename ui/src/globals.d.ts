// 由 vite.config.ts 的 define 注入（git tag 优先，回退 package.json version）
declare const __APP_VERSION__: string;

// 应用自更新桥（electron/preload.cts 暴露；浏览器 dev 下不存在）。
// 执行端在 ui/electron/update.ts，编排见 src/lib/updater.ts。
type UpdateInvokeMsg =
  | { op: "platform" }
  | { op: "fetch-release"; channel: "stable" | "beta" | "nightly" }
  | { op: "download"; id: string; url: string; mode: "replace-appimage" | "downloads" | "installer" }
  | { op: "cancel-download"; id: string }
  | { op: "apply-appimage"; path: string }
  | { op: "install-windows"; path: string }
  | { op: "open-path"; path: string }
  | { op: "open-releases"; channel: "stable" | "beta" | "nightly" }
  | { op: "relaunch" }
  | { op: "quit" };

interface UpdateProgressPayload {
  id: string;
  received: number;
  total: number;
}

// Sparkle 已安装插件与 Marketplace 索引的最小清单（主进程读盘/读远端 JSON 的原样投影；
// 渲染层只声明宿主真正消费的字段，第三方多余键在运行时被忽略）。
interface SparklePluginManifest {
  id?: string;
  name?: string;
  version?: string;
  minHostVersion?: string;
  allowBeta?: boolean;
  author?: string;
  description?: string;
  category?: string;
  main?: string;
  /** 安装来源：market = Marketplace（可检查更新）；local = 手动安装（不参与自动更新） */
  source?: "market" | "local";
  /** Marketplace 条目的下载地址与 sha256，随安装持久化，更新时兜底使用 */
  download?: string;
  hash?: string;
}

interface SparkleInstalledPlugin {
  id: string;
  dir: string;
  manifest: SparklePluginManifest;
  installedAt: number;
}

interface SparkleMarketPluginEntry {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  minHostVersion?: string;
  allowBeta?: boolean;
  category?: string;
  download: string;
  homepage?: string;
  hash?: string;
}

interface SparkleMarketIndex {
  plugins?: SparkleMarketPluginEntry[];
}

// Sparkle 第三方插件桥（electron/preload.cts 暴露；浏览器 dev 下不存在）。
// 本文件是 ambient 声明文件（无 import/export），Window 直接全局合并。
interface Window {
  // 调试桥（设置 → 通用 → 调试）：开发者控制台开关 + 进程/内存自检。
  // 事实源在主进程（app.getAppMetrics / /proc），渲染层只负责摆出来。
  quaverDebug?: {
    devtools(msg: Record<string, unknown>): Promise<any>;
    metrics(): Promise<any>;
  };

  /** 开源致谢弹窗：只负责把 GitHub 仓库交给系统浏览器打开。 */
  quaverCredits?: {
    open(url: string): Promise<{ ok: boolean; error?: string }>;
  };
  /** 微云音乐授权页：主进程仅放行 weiyun.com 的授权 URL。 */
  quaverWeiyunAuth?: {
    open(url: string): Promise<{ ok: boolean; error?: string }>;
  };

  quaverUpdate?: {
    invoke(msg: UpdateInvokeMsg): Promise<any>;
    onProgress(cb: (p: UpdateProgressPayload) => void): void;
  };
  quaverSparkle?: {
    list(): Promise<{ ok: boolean; plugins?: SparkleInstalledPlugin[] }>;
    install(msg: { url: string; sha256?: string; meta?: SparklePluginManifest }): Promise<{ ok: boolean; id?: string; error?: string }>;
    uninstall(msg: { id: string }): Promise<{ ok: boolean; error?: string }>;
    market(msg: { url: string }): Promise<{ ok: boolean; index?: SparkleMarketIndex; error?: string }>;
    /** 「添加本地插件」第一步：native 文件选择器 + 读文件（base64；用户取消时 canceled=true） */
    pickLocal(): Promise<{ ok: boolean; canceled?: boolean; name?: string; dataBase64?: string; error?: string }>;
    /** 第二步：渲染层校验插件形状后回传本体（base64）与元数据，主进程落盘 */
    installLocal(msg: { dataBase64: string; meta?: SparklePluginManifest }): Promise<{ ok: boolean; id?: string; error?: string }>;
  };
  /** Sparkle 安全模式（QUAVER_REDFLAG=1）：主进程读环境变量后经 preload 下发。
   *  加载策略见 src/sparkle/policy.ts；浏览器 dev 下不存在 → 恒 false。 */
  quaverRedflag?: boolean;
  /** 自定义背景图（设置→外观→背景）：选图与回显。图片本体走同源 /api/bg，不经这里。 */
  quaverBackground?: {
    pick(): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    info(): Promise<{ ok: boolean; path?: string; exists?: boolean; error?: string }>;
  };
  /** 本地/NAS 曲库（「本地音乐」页）：选目录与文件定位。音频/封面/歌词走同源 /api/local/*。 */
  quaverLocal?: {
    pickFolder(): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    reveal(id: string): Promise<{ ok: boolean; error?: string }>;
  };
}
