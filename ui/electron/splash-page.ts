// Quaver — 启动闪屏的纯逻辑（模板拼装 / 图标瘦身 / 时序常量）。
// 本模块**不 import electron**（惯例同 keyring.ts）：verify-splash.ts 用裸 node 直接单测这里。
// 装载与收场（data: URL 进主窗、最短驻留、淡出）在同目录 splash.ts。

// ——— 时序 ———
// MIN：闪屏最短驻留。动画四段（图标淡入 → 左移 → 字标浮现 → 底部「Built by Team Quaver」
//   署名）约 2.0s 走完；快机器上后端一秒就绪，不压住底速的话署名还没露头就被应用换掉，
//   闪屏沦为「闪一下」。收场是淡出 + 导航，闪屏永不挡住已就绪的应用超过这个下限。
// FADE：退场淡出时长，与 splash.html 的 body.closing transition 对齐（320ms + 余量）。
export const SPLASH_MIN_MS = 2300;
export const SPLASH_FADE_MS = 360;

// 窗口底色与 splash.html 的 --bg **同源**（verify-splash 逐字核对）：闪屏、主窗、渲染层
// 三者底色一致，交接时才是一条不断的底色。值即 style.css 的 --bg 明暗两档。
export const SPLASH_BG_DARK = "#131417";
export const SPLASH_BG_LIGHT = "#f7f7f8";

export const splashBackgroundColor = (dark: boolean) => (dark ? SPLASH_BG_DARK : SPLASH_BG_LIGHT);

/**
 * 图标素材瘦身：设计源 SVG（quaver-icon-dark.svg，35KB）里有一大块 C2PA 授权元数据
 * （base64 manifest）与导出器残留的命名空间，进闪屏全是无用字节。只留绘图本体。
 * 逐段剥：XML 声明 → DOCTYPE → 注释 → <metadata>（C2PA/rdf 在其中）→ <title>/<desc>
 * → 根节点上的 id/role/aria/多余 xmlns。绘图 path/rect 的 style 填充一律不动。
 */
export function stripSplashIconMarkup(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, "")
    .replace(/<(title|desc)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, "")
    .replace(/<c2pa:manifest[\s\S]*?<\/c2pa:manifest>/gi, "")
    .replace(/\s(?:id|role|aria-labelledby)="[^"]*"/g, "")
    .replace(/\sxmlns:(?:svg|rdf|cc|dc|c2pa)="[^"]*"/g, "")
    .trim();
}

/**
 * 模板拼装：splash.html 里的 __ICON__ / __THEME__ 两个占位换成实际内容。
 * iconSvg 允许为空串（素材缺失的降级：只有字标与署名，闪屏不许成为启动阻断项）。
 */
export function buildSplashHtml(
  template: string,
  opts: { iconSvg: string; dark: boolean },
): string {
  // 先验占位再替换：缺哪一个都要炸在装配点，而不是把 __ICON__ 原文当图标渲染出去
  if (!template.includes("__THEME__") || !template.includes("__ICON__")) {
    throw new Error("splash.html 缺占位符（__ICON__ / __THEME__）");
  }
  return template
    .replace("__THEME__", opts.dark ? "dark" : "light")
    .replace("__ICON__", opts.iconSvg);
}
