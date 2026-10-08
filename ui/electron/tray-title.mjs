// Quaver — 托盘菜单的「当前曲目」标题行：成型 + 按显示列宽截断（纯逻辑，零 Electron 依赖，可单测）。
//
// 坑不在「标题怎么拼」，在**原生菜单的宽度是随内容走的**：
//   Windows 通知区菜单是 Win32 HMENU、macOS 是 NSMenu，两者都**不折行**——菜单宽度 = 最宽那一项的
//   宽度。托盘菜单第一项就是当前曲目（「歌名 - 歌手」；歌名来自 songTitle()，自带 Studio Live /
//   (Half-acoustic Ver.) 这类版本后缀，歌手按 " / " 全连接），一首中文长歌名 + 三位歌手轻松跑到
//   40 个汉字，菜单被撑成横贯屏幕的一条。Linux 侧看不到这个症状：面板/AppIndicator 的宿主
//   （Plasma、GNOME 扩展）自己会给超长菜单项打省略号——但**别据此只在 win/mac 上截**，三平台同口径
//   才不会出现「同一首歌在三个系统上显示成三样」。
// 所以这里只做一件事：按**显示列宽**截断标题行，超了在尾巴补一个「…」。
//
// 为什么按列宽而不是字符数：菜单宽度是按像素量的，一个汉字 ≈ 两个拉丁字符。只数字符的话
// 「40 个汉字」和「40 个字母」会被同等放行，而前者是后者的两倍宽——本项目的大头恰恰是中文歌名。
// 宽度口径取 East Asian Width 的简化版（Wide/Fullwidth → 2 列，控制字符 → 0 列），**不为 emoji /
// 组合字符做完整 wcwidth**：这个模块只需要「大致不超」，多算一列少算一列肉眼看不出；而追求精确
// 就得把 Unicode 表打进包，收益为零。emoji 落在 1F300–1FAFF，按 2 列算，够了。

/** 标题行的显示列宽上限。40 列 ≈ 13px 字号下约 520px —— 原生菜单的常见上限；
 *  也就是中文标题 20 字 / 拉丁标题 40 字，再长就该省略了（托盘菜单只是瞥一眼的地方）。 */
export const TRAY_TITLE_MAX_COLS = 40;
/** 截断标记：单字符、占一列（用「…」不用「...」，省两列且是中文排版的正确省略号）。 */
export const TRAY_TITLE_ELLIPSIS = "…";
/** 歌名与歌手之间的分隔（与界面同款）。 */
export const TRAY_TRACK_SEP = " - ";
/** 多位歌手之间的连接（与界面同款）。 */
export const TRAY_ARTIST_SEP = " / ";
/** 没有曲目可显示时的占位（渲染层快照缺位，如窗口未起/拆窗间隙）。 */
export const TRAY_IDLE_LABEL = "未在播放";

/**
 * 单个码点的显示列宽。按 wcwidth 的经典区间判 Wide/Fullwidth → 2，其余 1，控制字符 0。
 * @param {string} ch 单个码点（可能是代理对，用 for…of / codePointAt 取）
 * @returns {0|1|2}
 */
export function charCols(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20 || cp === 0x7f) return 0; // 控制字符（oneLine 已清过，这里是兜底）
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||                          // 谚文字母
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK 部首/汉字/假名/谚文兼容（303f 是半角填充符）
      (cp >= 0xac00 && cp <= 0xd7a3) ||       // 谚文音节
      (cp >= 0xf900 && cp <= 0xfaff) ||       // CJK 兼容汉字
      (cp >= 0xfe30 && cp <= 0xfe4f) ||       // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xff60) ||       // 全角 ASCII
      (cp >= 0xffe0 && cp <= 0xffe6) ||       // 全角符号
      (cp >= 0x1f300 && cp <= 0x1faff) ||     // emoji
      (cp >= 0x20000 && cp <= 0x3fffd))       // CJK 扩展 B 及以后
  ) {
    return 2;
  }
  return 1;
}

/** 字符串的显示列宽（汉字/全角/emoji 记 2，其余记 1）。按码点走，不劈开代理对。 */
export function displayCols(text) {
  let n = 0;
  for (const ch of String(text ?? "")) n += charCols(ch);
  return n;
}

/**
 * 按列宽截断，超限时尾巴补「…」（省略号自己占一列，所以正文预算 = maxCols - 1）。
 * 不超限时**原样返回**（不补省略号，也不改内容）。
 * @param {string} text
 * @param {number} [maxCols]
 * @returns {string}
 */
export function clampCols(text, maxCols = TRAY_TITLE_MAX_COLS) {
  const s = String(text ?? "");
  if (maxCols <= 0) return "";
  if (displayCols(s) <= maxCols) return s;
  if (maxCols <= displayCols(TRAY_TITLE_ELLIPSIS)) return TRAY_TITLE_ELLIPSIS;
  const budget = maxCols - displayCols(TRAY_TITLE_ELLIPSIS);
  let used = 0;
  let out = "";
  for (const ch of s) {
    const w = charCols(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  // 断在分隔符中间时留个「名 -…」很难看，把悬空的分隔符/空白一起吃掉
  return out.replace(/[\s\-/]+$/, "") + TRAY_TITLE_ELLIPSIS;
}

/** 压成一行：换行/连续空白（含上游漏出来的 \n、全角空格周围的乱空）统一成一个空格。
 *  菜单标签里的 \n 在 win/mac 上会真的画成两行（菜单变高），顺手一起收掉。 */
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * 托盘菜单标题行：无曲目 → 占位；有曲目 → 「歌名 - 歌手」（无歌手就只有歌名），按列宽截断。
 * @param {{name?: string, artists?: string[]}|null|undefined} track 渲染层快照里的 track
 * @param {number} [maxCols]
 * @returns {string}
 */
export function trayTitleLine(track, maxCols = TRAY_TITLE_MAX_COLS) {
  const name = oneLine(track?.name);
  if (!name) return TRAY_IDLE_LABEL; // 没有曲目（或快照缺位）→ 占位，与从前一致
  const artists = (Array.isArray(track?.artists) ? track.artists : []).map(oneLine).filter(Boolean);
  const full = artists.length ? name + TRAY_TRACK_SEP + artists.join(TRAY_ARTIST_SEP) : name;
  return clampCols(full, maxCols);
}
