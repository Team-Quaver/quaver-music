// Sparkle — 插件加载器：官方插件静态表 + 第三方（磁盘 ESM）动态 import
//
// 官方插件随宿主打包（vite 代码分割成独立 chunk，启用才加载）；
// 第三方插件装在 quaver 配置目录 plugins/<id>/main.js，经 /api/sparkle/plugin/... 
// 以同源 URL 动态 import（@vite-ignore：构建期不分析运行时 URL）。
import type { SparklePlugin } from "@quaver/sparkle";

export interface OfficialPluginMeta {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
}

export const OFFICIAL_META: OfficialPluginMeta[] = [
  {
    id: "die-for-you",
    name: "Die For You 歌词",
    version: "1.0.0",
    author: "quaver",
    description: "在设置页随机展示一句《Die For You》（VALORANT Champions 2022 主题曲）歌词",
  },
];

/** 官方插件模块加载表（vite 静态分析这些路径，各自成 chunk） */
const OFFICIAL_LOADERS: Record<string, () => Promise<{ default: SparklePlugin }>> = {
  "die-for-you": () => import("@quaver/sparkle/plugins/die-for-you"),
};

export interface InstalledPlugin {
  id: string;
  dir: string;
  manifest: { id?: string; name?: string; version?: string; author?: string; description?: string; main?: string };
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

export async function loadThirdParty(inst: InstalledPlugin): Promise<SparklePlugin> {
  const main = inst.manifest?.main || "main.js";
  const url = `/api/sparkle/plugin/${encodeURIComponent(inst.id)}/${main}?v=${encodeURIComponent(String(inst.installedAt ?? 0))}`;
  const mod = await import(/* @vite-ignore */ url);
  const plugin = validatePlugin(mod?.default ?? mod?.plugin, inst.id);
  if (!plugin) throw new Error(`第三方插件 ${inst.id} 形状不合法（default export 需为 SparklePlugin）`);
  plugin.kind = "third-party";
  return plugin;
}
