// Quaver — `@quaver/sparkle` 在 **scripts 工程**里的类型替身。
//
// 为什么需要：SDK（vendor/Sparkle）内部用 bundler 风格的无扩展名导入，而本工程
// （含 tsconfig.node/scripts）走 `moduleResolution: nodenext` —— 解析不动，`import type`
// 那一行就成了 TS2307。渲染层自己的 tsconfig.json 里 paths + bundler 解析是通的，真实类型
// 该看的工程照看；脚本只把 src/ 里的纯策略模块当函数用，不需要复刻 SDK 的类型面。
//
// 只登记类型：src/ 对 @quaver/sparkle 的引用清一色是 `import type`（运行时整条擦除），
// 所以这里给 anything 就够，且不会影响任何运行时行为。
declare module "@quaver/sparkle" {
  export type SparkleContext = any;
  export type SparkleKaraokeLine = any;
  export type SparkleKaraokeProvider = any;
  export type SparkleKaraokeRenderCtx = any;
  export type SparkleMenuBarItem = any;
  export type SparkleMenuItem = any;
  export type SparkleNavItem = any;
  export type SparkleNpMenuCtx = any;
  export type SparkleNpSpectrumMode = any;
  export type SparkleNpSpectrumRenderCtx = any;
  export type SparkleNpView = any;
  export type SparkleNpViewCtx = any;
  export type SparkleNpWidget = any;
  export type SparklePlayerFacade = any;
  export type SparklePlugin = any;
  export type SparklePlaylistMenuCtx = any;
  export type SparkleQualityTier = any;
  export type SparkleSettingsSection = any;
  export type SparkleSongSnapshot = any;
  export type SparkleSongMenuCtx = any;
  export type SparkleSonglistGroup = any;
  export type SparkleSpectrumFrame = any;
  export type SparkleSpectrumStatus = any;
  export type SparkleStyleLayer = any;
  export type SparkleStyleState = any;
  export type SparkleStreamSource = any;
  export type SparkleTheme = any;
  export type SparkleThemePack = any;
  export type SparkleThemeTransparent = any;
  export type SparkleTintPreset = any;
  export type SparkleTransportControl = any;
  export type SparkleTransportCtx = any;
  export type SparkleView = any;
}
