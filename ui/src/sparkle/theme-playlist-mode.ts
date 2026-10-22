// Sparkle — 主题与「歌单显示模式」（设置→外观→歌单）的交接策略。
//
// 与 tint / background / menus / control-bar 的姊妹策略同一套口径：
//   · 不声明（theme.playlistMode 缺省）→ host：宿主偏好照常生效；
//   · { mode: "menu" | "collection" } → 主题是最终态，宿主让位；
//   · { mode: "host" } → 显式把呈现权还给宿主偏好。
//
// 本文件是**纯策略**：零 ui 依赖、无副作用。
import type { SparkleTheme } from "@quaver/sparkle";

export type SparkPlaylistMode = "host" | "menu" | "collection";

export interface SparkPlaylistModePolicy {
  mode: SparkPlaylistMode;
  /** 声明这套策略的主题 id（无主题 / 未接管时为 null） */
  themeId: string | null;
}

export function playlistModePolicyOf(theme: SparkleTheme | null | undefined): SparkPlaylistModePolicy {
  if (!theme) return { mode: "host", themeId: null };
  const m = theme.playlistMode;

  return m?.mode === "menu" || m?.mode === "collection"
    ? { mode: m.mode, themeId: theme.id }
    : { mode: "host", themeId: null };
}
