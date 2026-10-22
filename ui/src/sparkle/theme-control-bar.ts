// Sparkle — 主题与「播放控制条停靠形态」（设置→外观→播放控制条）的交接策略。
//
// 与 tint / background / menus 的姊妹策略同一套口径：
//   · 不声明（theme.controlBar 缺省）→ host：宿主偏好照常生效；
//   · { mode: "floating" | "bottom" } → 主题是最终态，宿主让位；
//   · { mode: "host" } → 显式把停靠权还给宿主。
//
// 本文件是**纯策略**：零 ui 依赖、无副作用。
import type { SparkleTheme } from "@quaver/sparkle";

export type SparkControlBarMode = "host" | "bottom" | "floating";

export interface SparkControlBarPolicy {
  mode: SparkControlBarMode;
  /** 声明这套策略的主题 id（无主题 / 未接管时为 null） */
  themeId: string | null;
}

export function controlBarPolicyOf(theme: SparkleTheme | null | undefined): SparkControlBarPolicy {
  if (!theme) return { mode: "host", themeId: null };
  const m = theme.controlBar;

  return m?.mode === "floating" || m?.mode === "bottom"
    ? { mode: m.mode, themeId: theme.id }
    : { mode: "host", themeId: null };
}
