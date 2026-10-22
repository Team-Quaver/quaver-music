// Sparkle — 启动：清账 → 内置歌词引擎 → 恢复启用集合 → 官方插件 → 第三方插件逐个 enable。
// 必须在 bootShell() 之后调用（要操作 nav DOM / np 插槽 / views 查表时机）；
// 用 void 不阻塞首帧 —— 插件的视图/侧栏项/设置区在首帧后补挂，属渐进增强。
import { applySparkleTheme, disableSparklePlugin, enableSparklePlugin, sparkEnabledIds, sparkOfficialOffIds, sparkSetEnabledIds, sparkSetOfficialOffIds } from "./host";
import { isSparkleRetired, listInstalledThirdParty, loadOfficial, loadThirdParty, OFFICIAL_META, RETIRED_OFFICIAL_IDS } from "./loader";
import { registerBuiltinLyrics } from "../lyrics/builtin";
import { sparkBlockReason, sparkRedflag } from "./policy";
import { initStyleLayer } from "./style-layer";

const OFFICIAL_KNOWN_KEY = "quaver.sparkle.official-known.v1";

/** localStorage 里那份 string[] 名单的安全读（坏 JSON = 空表，绝不炸启动） */
function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");

    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 官方插件默认启用：启用集合里没有、用户也没显式停用过（official-off 标记）的
 *  官方插件并入启用集合。known 记「见过的官方插件 id」——此后每个新官方插件
 *  发布时，老用户升级即自动默认启用，且不重置已显式停用的插件。 */
function seedOfficialDefaults() {
  const known = new Set(readIds(OFFICIAL_KNOWN_KEY));
  const optedOut = new Set(sparkOfficialOffIds());

  const fresh = OFFICIAL_META.map((m) => m.id)
    .filter((id) => !known.has(id) && !optedOut.has(id));

  if (fresh.length) sparkSetEnabledIds([...sparkEnabledIds(), ...fresh]);
  localStorage.setItem(OFFICIAL_KNOWN_KEY, JSON.stringify([...known, ...OFFICIAL_META.map((m) => m.id)]));
}

/** 撤下的官方插件清账（AMLL 已改成宿主内置功能，不再是插件）：启用集合 / 见过名单 /
 *  显式停用名单都不留幽灵 id。不洗的话，将来出现同名 id 的插件时会莫名其妙
 *  「已被停用」或「不再默认启用」。 */
function pruneRetiredOfficial() {
  if (!RETIRED_OFFICIAL_IDS.length) return;
  const keep = (ids: string[]) => ids.filter((id) => !isSparkleRetired(id));
  const enabled = sparkEnabledIds();
  const off = sparkOfficialOffIds();
  const known = readIds(OFFICIAL_KNOWN_KEY);

  if (keep(enabled).length !== enabled.length) sparkSetEnabledIds(keep(enabled));

  if (keep(off).length !== off.length) sparkSetOfficialOffIds(keep(off));

  if (keep(known).length !== known.length) localStorage.setItem(OFFICIAL_KNOWN_KEY, JSON.stringify(keep(known)));
}

export async function initSparkle(): Promise<void> {
  pruneRetiredOfficial();
  seedOfficialDefaults();
  // 内置歌词引擎（AMLL）：它不是插件，没有开关，是注册表里排在插件之后的**兜底提供器**。
  // 失败只意味着歌词退回宿主行级 DOM，不拦插件启动，也不拦首帧。
  await registerBuiltinLyrics().catch((e) => console.warn("[sparkle] 内置歌词引擎注册失败（歌词回退行级）", e));
  // 样式层要先于插件启用：否则首个主题包注册时 onSparkleChange 还没订阅上，
  // 那张 style 会一直缺席到下一次注册表变化（表现为「重启后第一张主题没生效」）。
  initStyleLayer();
  const enabled = new Set(sparkEnabledIds());
  // 安全模式（QUAVER_REDFLAG=1）：只放行预装插件。第三方插件连磁盘列表都不读 —— 插件
  // 代码一行不 import，坏插件也就没机会把启动搞黄（这就是「干净载入」）。
  // 内置歌词引擎不受这里影响：它是宿主代码，本来就在安全模式该管的范围之外。
  const redflag = sparkRedflag();

  if (redflag) console.warn("[sparkle] 安全模式（QUAVER_REDFLAG=1）：仅加载预装插件，第三方插件全部禁用");

  // 官方插件：meta 表是展示真相，加载表有对应 loader 才能启
  for (const meta of OFFICIAL_META) {
    if (!enabled.has(meta.id)) continue;
    const blocked = sparkBlockReason({ id: meta.id, kind: "official" });

    if (blocked) { console.warn(`[sparkle] 预装插件 ${meta.id} 未加载：${blocked}`); continue; }

    try {
      await enableSparklePlugin(await loadOfficial(meta.id));
    } catch (e) {
      console.warn(`[sparkle] 官方插件 ${meta.id} 加载失败`, e);
    }
  }

  // 第三方插件：经 quaverSparkle 桥拿安装列表（无桥 = 浏览器 dev，跳过）；安全模式直接空表
  const installed = redflag ? [] : await listInstalledThirdParty();

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
