// Sparkle — 启动：恢复启用集合 → 官方插件 → 第三方插件逐个 enable。
// 必须在 bootShell() 之后调用（要操作 nav DOM / np 插槽 / views 查表时机）；
// 用 void 不阻塞首帧 —— 插件的视图/侧栏项/设置区在首帧后补挂，属渐进增强。
import { applySparkleTheme, disableSparklePlugin, enableSparklePlugin, sparkEnabledIds } from "./host";
import { listInstalledThirdParty, loadOfficial, loadThirdParty, OFFICIAL_META } from "./loader";

/** 首次运行：启用集合还没落过盘 → 官方插件默认启用 */
const enabledKeySeeded = "quaver.sparkle.seeded.v1";
function seedEnabledOnce() {
  if (localStorage.getItem(enabledKeySeeded)) return;
  const cur = sparkEnabledIds();
  localStorage.setItem("quaver.sparkle.enabled.v1", JSON.stringify([...new Set([...cur, ...OFFICIAL_META.map((m) => m.id)])]));
  localStorage.setItem(enabledKeySeeded, "1");
}

export async function initSparkle(): Promise<void> {
  seedEnabledOnce();
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
