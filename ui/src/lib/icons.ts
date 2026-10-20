// 共享 SVG 图标（18x18 线性图标，风格与侧栏一致）
const svg = (inner: string, size = 18, sw = 1.8) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const icons = {
  play: svg('<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>', 20),
  pause: svg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>', 20),
  prev: svg('<path d="M7 5v14M20 5.5v13L10 12z" fill="currentColor" stroke="currentColor" stroke-width="1.6"/><path d="M20 5.5v13L10 12z" fill="currentColor" stroke="none"/>', 17),
  next: svg('<path d="M17 5v14M4 5.5v13L14 12z" fill="currentColor" stroke="currentColor" stroke-width="1.6"/><path d="M4 5.5v13L14 12z" fill="currentColor" stroke="none"/>', 17),
  loopOff: svg('<path opacity=".45" d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path opacity=".45" d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M4 4l16 16"/>', 18),
  loopAll: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>', 18),
  loopOne: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" font-size="9" fill="currentColor" stroke="none" text-anchor="middle" font-weight="700">1</text>', 18),
  shuffle: svg('<path d="M17 3l4 4-4 4"/><path d="M21 7H7a4 4 0 0 0-4 4v1"/><path d="M17 21l4-4-4-4"/><path d="M3 17h2.5a4 4 0 0 0 3.3-1.8l5.4-8.4A4 4 0 0 1 17.5 5H21"/>', 18),
  heart: svg('<path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/>'),
  heartFill: svg('<path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z" fill="currentColor" stroke="currentColor"/>'),
  radio: svg('<rect x="4" y="9" width="16" height="11" rx="2.5"/><path d="M8 9l8-4"/><circle cx="8.5" cy="14.5" r="2.2"/><path d="M13.5 13h3M13.5 16h2"/>'),
  calendar: svg('<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 10h16"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01M16 17.5h.01"/>'),
  // 无限电台标记：复用应用里已经在用的 ∞ 字形（首页电台卡、电台页品牌标都是它），
  // 不另画路径 —— 放进 svg 只是为了占住与其它图标同尺寸的 18×18 图标位。
  // 基线取 central（em 盒中心），不是 middle：∞ 的墨迹重心在字面上偏上，
  // 用 middle 会让它比同排的首页/日历高出约 1.9px，看起来是「飘在上面」。
  // y=10.7 把墨迹中心压回 24 网格中心（实测与首页/红心/日历的墨迹中心同高）。
  infinity: svg('<text x="12" y="10.7" font-size="24" fill="currentColor" stroke="none" text-anchor="middle" dominant-baseline="central">∞</text>'),
  sparkles: svg('<path d="M11 3l1.7 4.3L17 9l-4.3 1.7L11 15l-1.7-4.3L5 9l4.3-1.7z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>', 18, 1.6),
  queue: svg('<path d="M4 6h11M4 11h11M4 16h7"/><path d="M17 13.5v6l4.5-3z" fill="currentColor" stroke="none"/>'),
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
  chevronUp: svg('<path d="M6 15l6-6 6 6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  disc: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>'),
  // 音量图标：喇叭本体与分级声波要吃掉接近满格的 24×24 视窗。旧版只画到 x=13，
  // 在播放条里比相邻的循环/红心/队列矮一圈，看起来像误用了小号图标。声波保留
  // 1.7 的细描边，喇叭用实心形，整体光学面积与大号线性图标对齐。
  volMute: svg('<path d="M11 4.5 6.5 8H2v8h4.5L11 19.5z" fill="currentColor" stroke="none"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>', 18, 1.7),
  volLow: svg('<path d="M11 4.5 6.5 8H2v8h4.5L11 19.5z" fill="currentColor" stroke="none"/><path d="M14.8 9.2a4.2 4.2 0 0 1 0 5.6"/>', 18, 1.7),
  volMid: svg('<path d="M11 4.5 6.5 8H2v8h4.5L11 19.5z" fill="currentColor" stroke="none"/><path d="M14.8 9.2a4.2 4.2 0 0 1 0 5.6"/><path d="M18 6.8a8 8 0 0 1 0 10.4"/>', 18, 1.7),
  volHigh: svg('<path d="M11 4.5 6.5 8H2v8h4.5L11 19.5z" fill="currentColor" stroke="none"/><path d="M14.8 9.2a4.2 4.2 0 0 1 0 5.6"/><path d="M18 6.8a8 8 0 0 1 0 10.4"/><path d="M21 4.3a12.2 12.2 0 0 1 0 15.4"/>', 18, 1.7),
  pin: svg('<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 20h16"/>', 16),
  spinner: svg('<circle cx="12" cy="12" r="8" opacity=".25"/><path d="M12 4a8 8 0 0 1 8 8"/>', 18, 2.2),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>', 18, 2),
  // 队列面板：拖拽排序把手（六点阵）与清空（垃圾桶）
  grip: `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none"><circle cx="9" cy="5.5" r="1.7"/><circle cx="15" cy="5.5" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18.5" r="1.7"/><circle cx="15" cy="18.5" r="1.7"/></svg>`,
  trash: svg('<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.3 7l.7 11.2A1.8 1.8 0 0 0 8.8 20h6.4a1.8 1.8 0 0 0 1.8-1.8L17.7 7"/><path d="M10 11v5.5M14 11v5.5"/>', 15, 1.7),
  // 竖三点（更多选项）：正在播放页右侧信息列的 ⋮ 按钮
  more: svg('<circle cx="12" cy="5.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor" stroke="none"/>', 18),
  // 画廊模式（播放条开关）：四角括号 = 全屏化正在播放页
  gallery: svg('<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/>', 18),
  // 桌面歌词：屏幕里躺着两行「词」，正是要盖在桌面上的那层
  desktopLyric: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7.5 8.5h9M7.5 12h5.5"/><path d="M9 20.5h6"/>', 18),
  desktopLyricOff: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7.5 8.5h9M7.5 12h5.5"/><path d="M9 20.5h6"/><path d="M4.5 19.5L19.5 4.5"/>', 18),
};
