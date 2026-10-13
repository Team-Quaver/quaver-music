// Sparkle — 插件加载器：官方插件静态表 + 第三方（磁盘 ESM）动态 import
//
// 官方插件随宿主打包（vite 代码分割成独立 chunk，启用才加载）；
// 第三方插件装在 quaver 配置目录 plugins/<id>/main.js，经 /api/sparkle/plugin/... 
// 以同源 URL 动态 import（@vite-ignore：构建期不分析运行时 URL）。
import type { SparklePlugin } from "@quaver/sparkle";
import { getSparkleHostVersionError, isSparkleVersionValid } from "../../electron/sparkle-version.ts";

export interface OfficialPluginMeta {
  id: string;
  name: string;
  version: string;
  author?: string;
  license?: string;
  description?: string;
  /** true = 内置核心插件，**不可停用**：宿主启动强启、设置页开关锁死（见 init/host/settings）。
   *  用于「宿主已没有它就没有可用实现」的插件（如 AMLL = 唯一歌词渲染器）。 */
  required?: boolean;
}

export const OFFICIAL_META: OfficialPluginMeta[] = [
  {
    id: "die-for-you",
    name: "Die For You - Demo Plugins",
    version: "1.0.0",
    author: "Team Quaver",
    license: "AGPL - v3",
    description: "在设置页随机展示一句《Die For You》（《无畏契约》 2021 柏林冠军赛主题曲）歌词",
  },
  {
    id: "amll",
    name: "Apple Music-like Lyrics",
    version: "1.3.0",
    author: "Team Quaver",
    license: "AGPL - v3",
    description: "正在播放页的歌词渲染器：逐字（QRC/TTML）与行级（LRC）都由 AMLL 渲染；内置且不可停用",
    required: true,
  },
];

/** 内置必装（不可停用）的官方插件 id —— 唯一事实源，init/host/settings 都读这份 */
export const SPARKLE_REQUIRED_IDS: readonly string[] = OFFICIAL_META.filter((m) => m.required).map((m) => m.id);
export const isSparkleRequired = (id: string): boolean => SPARKLE_REQUIRED_IDS.includes(id);

/** 官方插件模块加载表（vite 静态分析这些路径，各自成 chunk） */
const OFFICIAL_LOADERS: Record<string, () => Promise<{ default: SparklePlugin }>> = {
  "die-for-you": () => import("@quaver/sparkle/plugins/die-for-you"),
  "amll": () => import("@quaver/sparkle/plugins/amll"),
};

export interface InstalledPlugin {
  id: string;
  dir: string;
  manifest: { id?: string; name?: string; version?: string; minHostVersion?: string; allowBeta?: boolean; author?: string; description?: string; category?: string; main?: string };
  installedAt: number;
}

/** 主进程侧已安装的第三方插件（quaverSparkle 桥；浏览器 dev 无桥 → 空） */
export async function listInstalledThirdParty(): Promise<InstalledPlugin[]> {
  const bridge = (window as unknown as { quaverSparkle?: { list(): Promise<{ ok: boolean; plugins?: InstalledPlugin[] }> } }).quaverSparkle;
  if (!bridge) return [];
  try {
    const r = await bridge.list();
    return r?.ok ? (r.plugins ?? []) : [];
  } catch (e) {
    console.warn("[sparkle] 第三方插件列表读取失败", e);
    return [];
  }
}

/** 形状校验：像插件的东西才准进 setup（第三方目录名必须与 id 一致） */
export function validatePlugin(p: unknown, expectId?: string): SparklePlugin | null {
  const v = p as SparklePlugin | null;
  if (!v || typeof v !== "object") return null;
  if (typeof v.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) return null;
  if (typeof v.name !== "string" || typeof v.version !== "string") return null;
  if (v.minHostVersion !== undefined && !isSparkleVersionValid(v.minHostVersion)) return null;
  if (v.allowBeta !== undefined && typeof v.allowBeta !== "boolean") return null;
  if (v.kind !== "official" && v.kind !== "third-party") return null;
  if (typeof v.setup !== "function") return null;
  if (expectId && v.id !== expectId) return null;
  return v;
}

export async function loadOfficial(id: string): Promise<SparklePlugin> {
  const loader = OFFICIAL_LOADERS[id];
  if (!loader) throw new Error(`未知官方插件: ${id}`);
  const mod = await loader();
  const plugin = validatePlugin(mod?.default, id);
  if (!plugin) throw new Error(`官方插件 ${id} 形状不合法`);
  plugin.kind = "official";
  return plugin;
}

/**
 * 动态 import 的 cache-bust 计数。
 *
 * 为什么需要（热重载）：`?v=` 原本只跟 installedAt 走，而停用→启用时 installedAt
 * **不变** → 浏览器 ES 模块缓存命中 → 拿到的是**上一次的模块实例**。于是「停用再
 * 启用」等于什么都没发生：插件顶层代码不重跑，setup 拿到的还是旧闭包（旧 DOM 引用、
 * 旧设置快照），表现为「重载了但功能失常」。
 *
 * 每次真正加载第三方插件都 +1，URL 必变 → 强制重新取模块。官方插件走 vite 静态
 * import（开发期 HMR 自带），不走这条。
 */
let loadSeq = 0;

export async function loadThirdParty(inst: InstalledPlugin): Promise<SparklePlugin> {
  const main = inst.manifest?.main || "main.js";
  // v = 安装时刻 + 加载序号：前者覆盖「重装同版本」，后者覆盖「停用后重启用同一份文件」
  const v = `${inst.installedAt ?? 0}-${++loadSeq}`;
  const url = `/api/sparkle/plugin/${encodeURIComponent(inst.id)}/${main}?v=${encodeURIComponent(v)}`;
  const mod = await import(/* @vite-ignore */ url);
  const plugin = validatePlugin(mod?.default ?? mod?.plugin, inst.id);
  if (!plugin) throw new Error(`第三方插件 ${inst.id} 形状不合法（default export 需为 SparklePlugin）`);
  const hostVersionError = getSparkleHostVersionError(__APP_VERSION__, plugin.minHostVersion, plugin.allowBeta);
  if (hostVersionError) throw new Error(hostVersionError);
  plugin.kind = "third-party";
  return plugin;
}
