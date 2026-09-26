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
  heart: svg('<path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/>'),
  heartFill: svg('<path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z" fill="#e8465a" stroke="#e8465a"/>'),
  queue: svg('<path d="M4 6h11M4 11h11M4 16h7"/><path d="M17 13.5v6l4.5-3z" fill="currentColor" stroke="none"/>'),
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
  chevronUp: svg('<path d="M6 15l6-6 6 6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  disc: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>'),
  volMute: svg('<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>', 18, 1.6),
  volLow: svg('<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/>', 18),
  volMid: svg('<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16 9a4.5 4.5 0 0 1 0 6"/>', 18),
  volHigh: svg('<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16 9a4.5 4.5 0 0 1 0 6"/><path d="M18.6 6.4a8 8 0 0 1 0 11.2"/>', 18),
  pin: svg('<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 20h16"/>', 16),
  spinner: svg('<circle cx="12" cy="12" r="8" opacity=".25"/><path d="M12 4a8 8 0 0 1 8 8"/>', 18, 2.2),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>', 18, 2),
  // 队列面板：拖拽排序把手（六点阵）与清空（垃圾桶）
  grip: `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none"><circle cx="9" cy="5.5" r="1.7"/><circle cx="15" cy="5.5" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18.5" r="1.7"/><circle cx="15" cy="18.5" r="1.7"/></svg>`,
  trash: svg('<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.3 7l.7 11.2A1.8 1.8 0 0 0 8.8 20h6.4a1.8 1.8 0 0 0 1.8-1.8L17.7 7"/><path d="M10 11v5.5M14 11v5.5"/>', 15, 1.7),
  // 竖三点（更多选项）：正在播放页右侧信息列的 ⋮ 按钮
  more: svg('<circle cx="12" cy="5.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor" stroke="none"/>', 18),
};
