// Verse 图标集（路径数据逐字抄自 design-system/components/bundle.js）。
// 24 格画布、1.6px 描边、圆头圆角；传输控制（play/pause/prev/next）是实心 fill。
// 需要新图标时按同一画布与描边规则追加，不要混入其它风格的字形。
// 唯一例外 `settings`：原 bundle 没有齿轮，本项目按同一语言补画（圆 + 八辐 tick）。

export const STROKE: Record<string, string> = {
  search: "M11 4.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13M16.2 16.2L20.5 20.5",
  shuffle: "M4 7h3.6l9 10H20M4 17h3.6l9-10H20M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5",
  repeat: "M17 3.5l2.8 2.8-2.8 2.8M4.2 12.5v-2a4 4 0 014-4h11.6M7 20.5l-2.8-2.8L7 14.9M19.8 11.5v2a4 4 0 01-4 4H4.2",
  volume: "M11.5 5L7 8.8H3.8v6.4H7l4.5 3.8zM15 9.6a3.4 3.4 0 010 4.8M17.6 7a7 7 0 010 10",
  mute: "M11.5 5L7 8.8H3.8v6.4H7l4.5 3.8zM16 10l4 4M20 10l-4 4",
  heart: "M12 19.6c-1.1-.8-6.6-4.7-6.6-9A3.8 3.8 0 0112 8.4a3.8 3.8 0 016.6 2.2c0 4.3-5.5 8.2-6.6 9z",
  plus: "M12 5.5v13M5.5 12h13",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  list: "M4 7h16M4 12h16M4 17h10",
  download: "M12 4.5v10.5M7.6 10.6L12 15l4.4-4.4M5 19.5h14",
  lyrics: "M4 6.5h13M4 12h16M4 17.5h9",
  home: "M4 10.6L12 4.2l8 6.4V19.8h-5.4v-5.6H9.4v5.6H4z",
  library: "M5 5h3.2v14H5zM10.6 5h3.2v14h-3.2zM16.6 5.6l3 .8-3.2 12.8-3-.8z",
  discover: "M12 3.4a8.6 8.6 0 100 17.2 8.6 8.6 0 000-17.2M15.6 8.4l-2 5.2-5.2 2 2-5.2z",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  minimize: "M5.5 12h13",
  maximize: "M5.5 5.5h13v13h-13z",
  chevronLeft: "M14.5 6.5L9 12l5.5 5.5",
  chevronRight: "M9.5 6.5L15 12l-5.5 5.5",
  chevronDown: "M7 10l5 5 5-5",
  check: "M5.5 12.6l4.4 4.4L18.5 8.4",
  device: "M4.5 5.5h15v10h-15zM9 19h6",
  settings: "M12 8.8a3.2 3.2 0 100 6.4 3.2 3.2 0 000-6.4zM12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.4 5.4l2.1 2.1M16.5 16.5l2.1 2.1M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1",
};

export const FILL: Record<string, string> = {
  play: "M8 5.2l11 6.8-11 6.8z",
  pause: "M8.2 5h2.8v14H8.2zM13 5h2.8v14H13z",
  prev: "M6 6h2.2v12H6zm12.4 0v12L9.6 12z",
  next: "M15.8 6H18v12h-2.2zM5.6 6l8.8 6-8.8 6z",
  heartOn: "M12 19.6c-1.1-.8-6.6-4.7-6.6-9A3.8 3.8 0 0112 8.4a3.8 3.8 0 016.6 2.2c0 4.3-5.5 8.2-6.6 9z",
  dot: "M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7",
};

export type IconName = keyof typeof STROKE | keyof typeof FILL;

/** 与 bundle 里 Icon 组件同构的 SVG 字符串（fill 类图标自动实心）。 */
export function icon(name: IconName, size = 20, strokeWidth = 1.6): string {
  const filled = (FILL as Record<string, string>)[name];
  const d = filled ?? STROKE[name] ?? "";
  return `<svg class="v-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="${d}" fill="${filled ? "currentColor" : "none"}" stroke="${filled ? "none" : "currentColor"}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
