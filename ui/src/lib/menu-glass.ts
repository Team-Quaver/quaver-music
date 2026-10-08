// Quaver — 浮层菜单的毛玻璃（[Style] MenuBlur，设置→外观→菜单毛玻璃）。
//
// 三态写在 <html data-menu-glass> 上，CSS 侧（style.css 顶部那组 --menu-* 令牌 + 那条共享
// 的「浮层菜单的玻璃」规则）据此取值：
//   on    用户开着：半透明玻璃底 + backdrop 模糊（**默认**）
//   off   用户关掉：实底 + 完全不模糊（省 GPU，文字最清晰）
//   theme 宿主**让位**：启用的 Sparkle 主题自带菜单外观（契约见 sparkle/theme-menus.ts）。
//         本模块不写 on/off —— 那些令牌回落到 style.css 的默认值，主题覆盖它们即可。
//
// 为什么要有这个开关：菜单原来各写一份 backdrop-filter + 各自不同不透明度的底片（0.78~0.85），
// 模糊被实色底片吃掉，视觉上跟实心菜单没区别（「看着没有模糊」的真正原因）。收敛成一组令牌后
// 底片能压薄、玻璃感才成立；但 glass 有代价（每层浮层一次 backdrop 采样 + 一层 GPU 合成），
// 精简党 / 低配机需要一条退路，所以给用户一棵总开关。
//
// 消费的七个菜单：.ctx-menu（侧栏歌单 / 歌曲右键菜单）、.pb-qpop（音质）、.pb-lpop（播放模式）、
// .pb-volpop（音量）、.np-menu（正在播放页「更多操作」）、.np-qinfo（音频流信息）、
// .tint-pop（设置页颜色选择器）。
//
// 分工：本模块只管这一个属性。令牌定义与消费点全在 style.css / 各组件；
// 「布尔 ⇄ 配置取值」在 lib/prefs.ts；主题归属策略在 sparkle/theme-menus.ts。
// 与 lib/ambient.ts、lib/tint.ts 是同一套写法（改完各自 apply 一次 + 订阅插件启停）。
// shell.ts 只调 bootMenuGlass()。
import { getMenuBlur } from "./prefs";
import { onSparkleChange, sparkleActiveTheme } from "../sparkle/registry";
import { menuGlassPolicyOf } from "../sparkle/theme-menus";

/** 应用当前偏好。设置页改完立刻调一次即生效；换主题 / 插件启停由 bootMenuGlass 注册的监听驱动。 */
export function applyMenuGlass() {
  const root = document.documentElement;
  // 主题接管菜单外观：让位 —— 不写 on/off，令牌回到 style.css 的默认值（主题在自己的
  // html[data-sparkle-theme="<id>"] 段里覆盖 --menu-* 就赢，那边特异性本来就更高）。
  if (menuGlassPolicyOf(sparkleActiveTheme()).mode === "off") {
    root.dataset.menuGlass = "theme";
    return;
  }
  root.dataset.menuGlass = getMenuBlur() ? "on" : "off";
}

/** 建订阅。由 shell.ts 在 bootShell 时调用一次（必须早于第一次路由渲染）。 */
export function bootMenuGlass() {
  // 插件启停 / 主题注册变化都会改归属（主题接管与否决定本模块写不写 on/off），跟着重算一次
  onSparkleChange(applyMenuGlass);
  applyMenuGlass();
}
