// Sparkle — 主题与「默认主题的背景」（设置→外观→背景）的交接策略。
//
// 为什么需要这一层：那层背景由 lib/ambient.ts 铺在主界面底下（当前曲封面 / 用户自定义图，
// 外加模糊强度）。主题一旦自带视觉，这层图就会从主题的底色底下透出来 —— 两边打架。
// 所以归属必须显式声明，而不是靠「谁的特异性高」去抢。
//
// 契约（SDK 的 SparkleTheme.background）：
//   · 不声明 / mode:"off" → off ：主题自带背景，宿主让位（整层不画，设置页「背景」整组禁用并注明原因；
//                                 "off" 是主题的显式声明，设置页文案写「强制关闭」而不是「由主题接管」）
//   · { mode: "host" }    → host：用户那三档 + 模糊强度照常生效
// renderer 两边都能带：host 下锁主页呈现风格，off 下锁歌词页呈现风格（主题自带视觉时
// 歌词页跟着主题口径走，不允许用户在设置里改成别的 —— 两处共用同一份 renderer 声明）。
//
// 本文件是**纯策略**：零 ui 依赖、无副作用（可在 node 里直接 import 做单测）。
// 与 sparkle/theme-tint.ts 是同一套写法的姊妹模块 —— 两个「归谁管」的判定口径必须一致，
// 改一处记得看另一处。
import type { SparkleTheme } from "@quaver/sparkle";

export type SparkBackgroundMode = "off" | "host";
export type SparkBackgroundRenderer = "quaver" | "mesh";

export interface SparkBackgroundPolicy {
  mode: SparkBackgroundMode;
  /** 声明这套策略的主题 id（无主题时为 null） */
  themeId: string | null;
  /** 主题钉死的呈现风格（没声明 renderer / 无主题 = null，跟随用户偏好） */
  renderer: SparkBackgroundRenderer | null;
}

/** renderer 声明的唯一合法值；主题是第三方代码，声明先校验再信。 */
const RENDERERS: readonly SparkBackgroundRenderer[] = ["quaver", "mesh"];

/**
 * 激活主题 → 背景策略。
 * `theme` 为 null（没启用主题 / 主题已从注册表消失）= 宿主的正常三档。
 * 声明得不成形（mode 不认识、字段类型不对）按「不声明」处理 —— 让位是安全侧：
 * 宁可少画一层，也别把用户的自定义壁纸摁在一个自带完整视觉的主题底下。
 */
export function backgroundPolicyOf(theme: SparkleTheme | null | undefined): SparkBackgroundPolicy {
  if (!theme) return { mode: "host", themeId: null, renderer: null };
  const b = theme.background;
  const renderer = RENDERERS.includes(b?.renderer as SparkBackgroundRenderer)
    ? b!.renderer as SparkBackgroundRenderer
    : null;

  if (!b || b.mode !== "host") return { mode: "off", themeId: theme.id, renderer };

  return { mode: "host", themeId: theme.id, renderer };
}

/**
 * 主题声明的呈现风格（`background.renderer`）：quaver = Quaver Design 封面模糊铺底，
 * mesh = AMLL 网格流动渐变。host 下锁主页那层，off 下锁歌词页；不声明 = null（跟随用户偏好）。
 */
export function backgroundRendererOf(theme: SparkleTheme | null | undefined): SparkBackgroundRenderer | null {
  return backgroundPolicyOf(theme).renderer;
}

/** 歌词页呈现风格是否被主题钉死（主题声明了 renderer 就锁，无论背景层归谁）。 */
export function npBackgroundLocked(theme: SparkleTheme | null | undefined): boolean {
  return backgroundPolicyOf(theme).renderer !== null;
}
