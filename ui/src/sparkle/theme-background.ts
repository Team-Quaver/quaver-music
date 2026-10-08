// Sparkle — 主题与「默认主题的背景」（设置→外观→背景）的交接策略。
//
// 为什么需要这一层：那层背景由 lib/ambient.ts 铺在主界面底下（当前曲封面 / 用户自定义图，
// 外加模糊强度）。主题一旦自带视觉，这层图就会从主题的底色底下透出来 —— 两边打架。
// 所以归属必须显式声明，而不是靠「谁的特异性高」去抢。
//
// 契约（SDK 的 SparkleTheme.background）：
//   · 不声明            → off ：主题自带背景，宿主让位（整层不画，设置页「背景」整组禁用并注明原因）
//   · { mode: "host" }  → host：用户那三档 + 模糊强度照常生效
//
// 本文件是**纯策略**：零 ui 依赖、无副作用（可在 node 里直接 import 做单测）。
// 与 sparkle/theme-tint.ts 是同一套写法的姊妹模块 —— 两个「归谁管」的判定口径必须一致，
// 改一处记得看另一处。
import type { SparkleTheme } from "@quaver/sparkle";

export type SparkBackgroundMode = "off" | "host";

export interface SparkBackgroundPolicy {
  mode: SparkBackgroundMode;
  /** 声明这套策略的主题 id（无主题时为 null） */
  themeId: string | null;
}

/**
 * 激活主题 → 背景策略。
 * `theme` 为 null（没启用主题 / 主题已从注册表消失）= 宿主的正常三档。
 * 声明得不成形（mode 不认识、字段类型不对）按「不声明」处理 —— 让位是安全侧：
 * 宁可少画一层，也别把用户的自定义壁纸摁在一个自带完整视觉的主题底下。
 */
export function backgroundPolicyOf(theme: SparkleTheme | null | undefined): SparkBackgroundPolicy {
  if (!theme) return { mode: "host", themeId: null };
  const b = theme.background;
  if (!b || b.mode !== "host") return { mode: "off", themeId: theme.id };
  return { mode: "host", themeId: theme.id };
}
