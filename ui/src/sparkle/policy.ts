// Sparkle — 加载策略：安全模式（QUAVER_REDFLAG=1）与 [Sparkle] Blacklist 黑名单。
//
// 两个开关都只回答同一个问题：这个插件这次准不准加载。判定集中在这里，**启动路径**
// （init.ts 的逐个 enable）与**运行期开关**（host.ts 的 enableSparklePlugin，设置页手动打开）
// 查同一份 —— 只在启动时拦、设置页却还能手动打开的「安全模式」是假的。
//
// 零 ui 依赖，也不碰 Electron：安全模式的开关由主进程读 QUAVER_REDFLAG 后经 preload 下发
// （window.quaverRedflag），黑名单读 quaver.conf（见 src/lib/prefs.ts）。
import type { SparklePlugin } from "@quaver/sparkle";
import { getSparkleBlacklist } from "../lib/prefs";

/** 安全模式（干净载入）：主进程按 QUAVER_REDFLAG=1 钉住，经 preload 的 quaverRedflag 下发。
 *  浏览器 dev / 未开时恒为 false。 */
export const sparkRedflag = (): boolean =>
  window.quaverRedflag === true;

/** 插件 id 是否在 [Sparkle] Blacklist 里（预装插件与第三方一视同仁）。 */
export const sparkIdBlacklisted = (id: string): boolean => getSparkleBlacklist().includes(id);

/** 这个插件这次为什么不准加载；null = 放行。
 *  安全模式只拦外置（kind === "third-party"）—— 预装插件随宿主打包，不受影响。 */
export function sparkBlockReason(plugin: Pick<SparklePlugin, "id" | "kind">): string | null {
  if (plugin.kind === "third-party" && sparkRedflag()) return "安全模式（QUAVER_REDFLAG=1）已禁用全部第三方插件";

  if (sparkIdBlacklisted(plugin.id)) return `插件 ${plugin.id} 在 [Sparkle] Blacklist 黑名单里`;

  return null;
}
