// 播放控制条停靠形态的应用端：宿主偏好 + Sparkle 主题策略合流后写 body 状态。
// prefs 只做「配置值 ⇄ 枚举」；主题归属判定在 sparkle/theme-control-bar.ts。
// 与 menu-glass 的分工一致：设置页写偏好后调 applyControlBar()，主题切换由
// host.applySparkleTheme() 触发同一入口，避免两处写 DOM。
import { applyControlBarMode, getControlBarMode } from "./prefs";
import { onSparkleChange, sparkleActiveTheme } from "../sparkle/registry";
import { controlBarPolicyOf } from "../sparkle/theme-control-bar";

/** 应用当前生效形态：主题接管用主题；否则读用户偏好。 */
export function applyControlBar() {
  const policy = controlBarPolicyOf(sparkleActiveTheme());
  applyControlBarMode(policy.mode === "host" ? getControlBarMode() : policy.mode);
}

/** 建订阅。由 main.ts 在 bootShell 前调用：壳层一注入就是最终形态，不闪一下。 */
export function bootControlBar() {
  onSparkleChange(applyControlBar);
  applyControlBar();
}
