// 歌单显示模式的应用端：宿主偏好 + Sparkle 主题策略合流后写 body 状态。
// prefs 只做「配置值 ⇄ 枚举」；主题归属判定在 sparkle/theme-playlist-mode.ts。
// 与 control-bar 的分工一致：设置页写偏好后调 applyPlaylistMode()，主题切换由
// host.applySparkleTheme() 触发同一入口，避免两处写 DOM。
import { applyPlaylistModeKind, getPlaylistMode } from "./prefs";
import { onSparkleChange, sparkleActiveTheme } from "../sparkle/registry";
import { playlistModePolicyOf } from "../sparkle/theme-playlist-mode";

/** 应用当前生效形态：主题接管用主题；否则读用户偏好。 */
export function applyPlaylistMode() {
  const policy = playlistModePolicyOf(sparkleActiveTheme());
  applyPlaylistModeKind(policy.mode === "host" ? getPlaylistMode() : policy.mode);
}

/** 建订阅。由 main.ts 在 bootShell 前调用：壳层一注入就是最终形态，不闪一下。 */
export function bootPlaylistMode() {
  onSparkleChange(applyPlaylistMode);
  applyPlaylistMode();
}
