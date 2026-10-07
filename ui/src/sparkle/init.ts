// Sparkle — 启动：恢复启用集合 → 官方插件 → 第三方插件逐个 enable。
// 必须在 bootShell() 之后调用（要操作 nav DOM / np 插槽 / views 查表时机）；
// 用 void 不阻塞首帧 —— 插件的视图/侧栏项/设置区在首帧后补挂，属渐进增强。
import { applySparkleTheme, disableSparklePlugin, enableSparklePlugin, sparkEnabledIds, sparkOfficialOffIds } from "./host";
import { listInstalledThirdParty, loadOfficial, loadThirdParty, OFFICIAL_META } from "./loader";
import { initStyleLayer } from "./style-layer";

/** 官方插件默认启用：启用集合里没有、用户也没显式停用过（official-off 标记）的
 *  官方插件并入启用集合。known 记「见过的官方插件 id」——此后每个新官方插件
 *  （如 amll）发布时，老用户升级即自动默认启用，且不重置已显式停用的插件。 */
const OFFICIAL_KNOWN_KEY = "quaver.sparkle.official-known.v1";
function seedOfficialDefaults() {
  const readIds = (key: string): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const known = new Set(readIds(OFFICIAL_KNOWN_KEY));
  const optedOut = new Set(sparkOfficialOffIds());
  const fresh = OFFICIAL_META.map((m) => m.id).filter((id) => !known.has(id) && !optedOut.has(id));
  if (fresh.length) {
    localStorage.setItem("quaver.sparkle.enabled.v1", JSON.stringify([...new Set([...sparkEnabledIds(), ...fresh])]));
  }
  localStorage.setItem(OFFICIAL_KNOWN_KEY, JSON.stringify([...known, ...OFFICIAL_META.map((m) => m.id)]));
}

export async function initSparkle(): Promise<void> {
  seedOfficialDefaults();
  // 样式层要先于插件启用：否则首个主题包注册时 onSparkleChange 还没订阅上，
  // 那张 style 会一直缺席到下一次注册表变化（表现为「重启后第一张主题没生效」）。
  initStyleLayer();
  const enabled = new Set(sparkEnabledIds());

  // 官方插件：meta 表是展示真相，加载表有对应 loader 才能启
  for (const meta of OFFICIAL_META) {
    if (!enabled.has(meta.id)) continue;
    try {
      await enableSparklePlugin(await loadOfficial(meta.id));
    } catch (e) {
      console.warn(`[sparkle] 官方插件 ${meta.id} 加载失败`, e);
    }
  }

  // 第三方插件：经 quaverSparkle 桥拿安装列表（无桥 = 浏览器 dev，跳过）
  const installed = await listInstalledThirdParty();
  for (const inst of installed) {
    if (!enabled.has(inst.id)) continue;
    try {
      await enableSparklePlugin(await loadThirdParty(inst));
    } catch (e) {
      console.warn(`[sparkle] 第三方插件 ${inst.id} 加载失败`, e);
    }
  }

  applySparkleTheme();
}
