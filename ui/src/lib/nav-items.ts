// Quaver — 侧栏主菜单项的元数据与顺序/显隐配置的纯逻辑。
//
// 为什么单独成文件：同一份清单要被三处消费 —— 壳层渲染侧栏（shell.ts）、设置页的
// 「菜单栏编辑」列表（views/settings.ts）、以及配置默认值（electron/config.ts 的 schema
// 只能写字面量，所以那边的合法 id 表是这一份的镜像）。放在 lib 里是零 DOM 依赖的纯数据，
// 可以被 verify 脚本直接 import 做单测，也不会让设置页为了拿标签去 import 整个壳层。
//
// 持久化只存两个逗号分隔的 id 列表（[Style] NavOrder / NavHidden），顺序与显隐分开：
//   NavOrder  = 用户拖出来的完整顺序；缺项/坏项由 normalizeNavOrder 补齐，永远覆盖全部内置项
//   NavHidden = 用户关闭的项；收进侧栏底部的「更多」浮窗，不是删掉
// 「歌单」项在高效模式（menu）下由 CSS 自动隐藏（歌单已在侧栏列出），与这里的用户显隐正交。
import { icons as sharedIcons } from "./icons";

export interface NavItem {
  id: string;
  path: string;
  label: string;
  /** 内联 SVG（24 网格，currentColor 描边），由调用方直接塞进锚点/设置列表。 */
  iconSvg: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "home",
    path: "#/",
    label: "首页",
    iconSvg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>',
  },
  {
    id: "guess",
    path: "#/guess",
    label: "猜你喜欢",
    // 猜你喜欢 = 无限电台：复用共享图标里的 ∞ 标记（首页电台卡同一符号）。
    iconSvg: sharedIcons.infinity,
  },
  {
    id: "daily",
    path: "#/daily",
    label: "每日 30 首",
    // 每日 30 首：复用共享图标里的日历（首页快捷入口同一枚）。
    iconSvg: sharedIcons.calendar,
  },
  {
    id: "liked",
    path: "#/liked",
    label: "我喜欢",
    iconSvg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/></svg>',
  },
  {
    id: "playlists",
    path: "#/playlists",
    label: "歌单",
    // 歌单：堆叠的曲目行（三条带前置圆点的水平线），与「本地音乐」的容器形区分开。
    iconSvg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>',
  },
  {
    id: "all",
    path: "#/all",
    label: "所有歌曲",
    // 所有歌曲：CD 碟面（外圈 + 反光弧 + 中心轴孔），与「本地音乐」的文件夹容器形区分开。
    iconSvg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="5.2" opacity=".48"/><circle cx="12" cy="12" r="1.55" fill="currentColor" stroke="none"/><path d="M7.5 7.1a6.4 6.4 0 0 1 3.1-1.35" opacity=".72"/></svg>',
  },
  {
    id: "local",
    path: "#/local",
    label: "本地音乐",
    // 本地音乐：文件夹（带 NAS 语境的通用容器形）。同一套 24 网格 / currentColor 描边。
    iconSvg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h4L12 7h6.5A1.5 1.5 0 0 1 20 8.5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/><circle cx="12" cy="12.6" r="2.2" fill="currentColor" stroke="none"/></svg>',
  },
  {
    id: "cloud",
    path: "#/cloud",
    label: "微云网盘",
    iconSvg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5h10.2a4.3 4.3 0 0 0 .7-8.5 6 6 0 0 0-11.5 1.2A3.7 3.7 0 0 0 7 18.5z"/><path d="M9.5 13.2h5M12 10.8v6.4" opacity=".55"/></svg>',
  },
];

/** 默认顺序 = 声明顺序；也是「用户是否自定义过布局」的比对基准。 */
export const NAV_IDS: readonly string[] = NAV_ITEMS.map((n) => n.id);
export const NAV_DEFAULT_ORDER = NAV_IDS.join(",");

/** 「更多」按钮的竖三点（与正在播放页 ⋮ 同一枚）。 */
export const NAV_MORE_ICON = sharedIcons.more;

export function navItemOf(id: string): NavItem | undefined {
  return NAV_ITEMS.find((n) => n.id === id);
}
