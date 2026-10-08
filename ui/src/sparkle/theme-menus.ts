// Sparkle — 主题与「浮层菜单的外观」（设置→外观→菜单毛玻璃）的交接策略。
//
// 为什么需要这一层：菜单的玻璃观感由宿主的一组令牌统一给（--menu-filter / --menu-surface /
// --menu-line / --menu-shadow / --menu-edge，定义在 style.css 顶部），开关则由
// lib/menu-glass.ts 写在 <html data-menu-glass> 上。主题一旦自带一套菜单外观（比如把右键
// 菜单做成不透明的大圆角卡片），用户那棵开关就在跟它打架 —— 所以归属必须显式声明。
//
// 契约（SDK 的 SparkleTheme.menus）：
//   · 不声明           → off ：主题自带菜单外观，宿主让位 —— 不写 on/off，设置页
//                              「菜单毛玻璃」整组禁用并注明由谁接管。
//                              主题只要在自己的 css 里覆盖 --menu-* 那几个令牌即可
//                              （html[data-sparkle-theme="<id>"] 的特异性本来就压过 :root）。
//   · { mode: "host" } → host：用户那棵开关照常生效（开 = 玻璃底 + 模糊，关 = 实底不模糊）。
//
// 与 sparkle/theme-tint.ts、sparkle/theme-background.ts 是同一套写法的姊妹模块：
// 三个「归谁管」的判定口径必须一致，改一处记得看另两处。
//
// 本文件是**纯策略**：零 ui 依赖、无副作用（可在 node 里直接 import 做单测）。
import type { SparkleTheme } from "@quaver/sparkle";

export type SparkMenuMode = "off" | "host";

export interface SparkMenuPolicy {
  mode: SparkMenuMode;
  /** 声明这套策略的主题 id（无主题时为 null） */
  themeId: string | null;
}

/**
 * 激活主题 → 浮层菜单外观策略。
 * `theme` 为 null（没启用主题 / 主题已从注册表消失）= 宿主的正常开关。
 * 声明得不成形（mode 不认识、字段类型不对）按「不声明」处理 —— 让位是安全侧：
 * 宁可让主题按自己的样子画菜单，也别拿宿主那套玻璃去压一个自带完整视觉的主题。
 */
export function menuGlassPolicyOf(theme: SparkleTheme | null | undefined): SparkMenuPolicy {
  if (!theme) return { mode: "host", themeId: null };
  const m = theme.menus;
  if (!m || m.mode !== "host") return { mode: "off", themeId: theme.id };
  return { mode: "host", themeId: theme.id };
}
