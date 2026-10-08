// Quaver — 托盘图标：选哪一份、按多大出图（纯逻辑，零 Electron 依赖，可单测）。
//
// 托盘图标的坑不在「图从哪来」，在两个口径上，两条都踩过：
//  1) 尺寸：macOS 把 Tray 的 NSImage 按「点」原样画 —— 直塞一张 512² 的 PNG 进去就是 512pt 的
//     巨图。Linux 面板 / Windows 通知区会自己缩，所以只有 mac 露馅。这里统一钉一个逻辑尺寸，
//     三平台都按它 resize，另附 @2x 位图（高 DPI 下不糊）。
//  2) 明暗：托盘挂在**外壳**（Linux 面板 / macOS 菜单栏 / Windows 任务栏）上，不是挂在应用窗口里。
//     外壳底色跟应用自己选的深浅色是两回事，所以判据在主进程（systheme / nativeTheme 的系统档，
//     见 main.ts 的 trayAppearance），本模块只负责「外观 → 素材」这一层映射，免得两边各写一份 if。
//
// 素材（仓库根 img/，单一真相）与产物：
//   img/tray-icon.svg        浅色图标（#cccccc）→ 深色外壳上用
//   img/tray-icon-dark.svg   深色图标（#000000）→ 浅色外壳上用
//   ui/build-res/tray/*.png  上两份的光栅化产物：nativeImage 只认 PNG/JPEG(+ICO/ICNS)，
//                            读不了 SVG（见 Electron nativeImage 文档「Supported Formats」），
//                            所以 SVG 是设计源、PNG 才是随包被加载的那份。
// 改过 SVG 之后重新生成（两个都要重出）：
//   ui/scripts/gen-tray-icons.sh
// 那个脚本不是「原样导出」——设计稿在 512 的 viewBox 里留了约 22%/边的空白，直出会让图形只占画布
// ~56%，塞进 16pt 的盒子实形只剩 ~9px（报过「小了一点点」）；脚本按 alpha 裁到图形再补 6%/边余量，
// 图形占画布 ~88%。verify-icon 会核对（PNG 主色/形状 vs SVG、以及图形包围盒必须 ≥82%）。
//
// 明暗判据在调用方（main.ts trayAppearance）：托盘挂在**外壳**上，判据必须是「系统给外壳的颜色」——
// Linux 探测桌面配色、macOS 读 AppleInterfaceStyle、Windows 用 shouldUseDarkColorsForSystemIntegratedUI。
// 千万别拿 nativeTheme.shouldUseDarkColors 当判据：它跟着应用自己的 themeSource 走，而本应用默认
// 主题是 dark → 永远判成深色外壳（系统切浅色后菜单栏变浅、图标还是浅色那份，直接看不见）。

/** 托盘逻辑尺寸（pt/px）。16 = macOS 菜单栏 / Windows 通知区 / Linux SNI 的通用档位。 */
export const TRAY_ICON_PT = 16;

/** 外壳外观 → 素材（相对 build-res 的路径）。「深色外壳配浅色图标」是这个映射的全部要点。 */
export const TRAY_ICON_FILES = {
  dark: "tray/tray-icon.png",        // 浅色图标，配深色面板/菜单栏
  light: "tray/tray-icon-dark.png",  // 深色图标，配浅色面板/菜单栏
};

/**
 * 挑素材。
 * @param {"dark"|"light"|null|undefined} appearance 外壳外观
 * @returns {string} build-res 相对路径
 */
export function trayIconFile(appearance: string | null | undefined): string {
  // 判不出来（探测全落空）时按深色处理：Linux 面板与 mac 菜单栏默认偏深底，
  // 浅色图标在两种底色上都还能看（深色图标在深底上直接消失）—— 也是托盘图从前的口径。
  return appearance === "light" ? TRAY_ICON_FILES.light : TRAY_ICON_FILES.dark;
}
