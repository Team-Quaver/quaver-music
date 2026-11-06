// 排行榜的「虚位封面」：用图标 + 榜单专属色代替代理图。
// 色相只负责榜单身份，最终颜色由 CSS 与 --cvg-accent 混合（见 home.css 的 .toplist-art），
// 所以「跟随封面 / 自定义 / 主题接管」换色时封面会一起走，不会出现刺眼的对比色。

const svg = (inner: string, sw = 1.6) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ART = {
  // 趋势线：飙升/潮流
  trend: svg('<path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5"/><path d="M15.5 6.5h5v5"/>'),
  // 火焰：热歌/热度/人气
  flame: svg('<path d="M12 3.2c.7 2.7-.3 4.1-1.5 5.4C9.2 10 8.1 11.5 8.1 13.3a3.9 3.9 0 0 0 7.8.2c0-1.2-.4-2.3-1.2-3.2-.3 1-.8 1.7-1.5 2.2.3-2.6-.3-5.1-1.2-6.6Z"/>'),
  // 星芒：新歌/原创
  sparkle: svg('<path d="M12 3.5l1.8 4.4 4.4 1.8-4.4 1.8L12 15.9l-1.8-4.4L5.8 9.7l4.4-1.8z"/><path d="M18.6 15.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  // 柱状图：指数榜/音乐榜
  bars: svg('<path d="M4 20V11M9.3 20V4M14.7 20v-6.5M20 20V7.5"/>'),
  // 分享节点
  share: svg('<circle cx="17.5" cy="5.5" r="2.3"/><circle cx="6.5" cy="12" r="2.3"/><circle cx="17.5" cy="18.5" r="2.3"/><path d="M8.6 10.9l6.8-4.1M8.6 13.1l6.8 4.1"/>'),
  // 铃铛
  bell: svg('<path d="M6.5 9.8a5.5 5.5 0 0 1 11 0c0 4 1.5 5.2 1.7 5.7H4.8c.2-.5 1.7-1.7 1.7-5.7Z"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>'),
  // 麦克风：说唱/K歌/识曲
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.2a6.5 6.5 0 0 0 13 0M12 17.7V21M8.5 21h7"/>'),
  // 对话气泡：评论
  chat: svg('<path d="M4 5.5h16v10.5H12l-4.5 3.5V16H4z"/>'),
  // 奖杯：腾讯音乐榜
  trophy: svg('<path d="M8 4h8v4.2a4 4 0 0 1-8 0z"/><path d="M8 5.2H5v1.6a3 3 0 0 0 3 3M16 5.2h3v1.6a3 3 0 0 1-3 3M12 12.2V17M8.5 21h7M9.5 17h5v4h-5z"/>'),
  // 视频
  video: svg('<rect x="3" y="6" width="12.5" height="12" rx="2.2"/><path d="M15.5 10.2 21 7v10l-5.5-3.2z"/>'),
  // 羽毛笔：原创
  quill: svg('<path d="M4.5 19.5c5.5-.8 9.2-3.8 12.2-9.2l1.8-3.2-3.2 1.6c-5.5 2.8-9 5.6-10.8 10.8Z"/><path d="M4.5 19.5 10 14"/>'),
  // 琴弦：国风/国乐
  strings: svg('<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h11"/><circle cx="18.5" cy="17.5" r="2"/>'),
  // 闪电：电音/DJ
  bolt: svg('<path d="M13.2 2.5 5 13.5h5.7L10.2 21.5 19 10h-5.8z"/>'),
  // 手柄：游戏音乐
  gamepad: svg('<path d="M7.5 7.5h9a5 5 0 0 1 4.6 6.9l-1 2.7a2.4 2.4 0 0 1-4.2.6l-1.3-1.7h-5.2l-1.3 1.7a2.4 2.4 0 0 1-4.2-.6l-1-2.7a5 5 0 0 1 4.6-6.9Z"/><path d="M8.5 11v3M7 12.5h3M15.5 12h.01M17.5 14h.01"/>'),
  // 星星：动漫/综艺
  star: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z"/>'),
  // 胶片：影视金曲
  film: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.4"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h17M3.5 14.5h17"/>'),
  // 电视：综艺
  tv: svg('<rect x="3" y="6.5" width="18" height="12" rx="2.2"/><path d="M8 21h8M12 18.5V21M8.5 2.5 12 6l3.5-3.5"/>'),
  // 地球：地区/全球榜
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z"/>'),
  // 信号：网络榜
  wifi: svg('<path d="M4 9.5a12 12 0 0 1 16 0M7 13a7.5 7.5 0 0 1 10 0M10 16.5a3 3 0 0 1 4 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/>'),
  // 唱片：舞曲
  disc: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/>'),
  // 红心：收藏人气
  heart: svg('<path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/>'),
  // 音符：网络热歌
  music: svg('<path d="M9 18.5V6.2l10-2.2v12.3"/><circle cx="6.2" cy="18.7" r="2.8"/><circle cx="16.2" cy="16.5" r="2.8"/>'),
} as const;

interface ArtRule {
  match: RegExp;
  color: string;
  icon: string;
}

// 规则按「先具体后笼统」排列：同一个标题命中第一条即停。
// 例：「国风热歌榜」要走国风（琴弦绿）而不是热歌（火焰橙）；「综艺新歌榜」同理。
const RULES: ArtRule[] = [
  { match: /潮流/, color: "#ff6f9d", icon: ART.trend },
  { match: /飙升/, color: "#ff5b4e", icon: ART.trend },
  { match: /视频号/, color: "#ff6a5e", icon: ART.video },
  { match: /抖音/, color: "#ff5f8a", icon: ART.music },
  { match: /国风|国乐/, color: "#2fae86", icon: ART.strings },
  { match: /分享/, color: "#ff9a4d", icon: ART.share },
  { match: /铃声/, color: "#e8b33e", icon: ART.bell },
  { match: /说唱|K歌|翻唱/i, color: "#e6a63a", icon: ART.mic },
  { match: /电音|DJ|舞曲/i, color: "#6f7bff", icon: ART.disc },
  { match: /识曲/, color: "#38b7e8", icon: ART.mic },
  { match: /收藏/, color: "#ef5f7a", icon: ART.heart },
  { match: /评论/, color: "#4f9bff", icon: ART.chat },
  { match: /游戏/, color: "#4aa3ff", icon: ART.gamepad },
  { match: /动漫/, color: "#ff6fa8", icon: ART.star },
  { match: /影视|电影|电视剧/, color: "#ff8a5c", icon: ART.film },
  { match: /综艺/, color: "#ff9c42", icon: ART.tv },
  { match: /原创|新势力/, color: "#4cbf74", icon: ART.quill },
  { match: /新歌/, color: "#3d9cff", icon: ART.sparkle },
  { match: /热歌|热度|人气/, color: "#ff7a3c", icon: ART.flame },
  { match: /腾讯音乐|由你|浪潮/, color: "#f0b23c", icon: ART.trophy },
  { match: /香港/, color: "#e26a9a", icon: ART.globe },
  { match: /台湾/, color: "#3fb6a8", icon: ART.globe },
  { match: /内地/, color: "#e0554e", icon: ART.globe },
  { match: /韩国/, color: "#ff7c93", icon: ART.globe },
  { match: /日本/, color: "#ff9ec4", icon: ART.globe },
  { match: /美国|欧美|英国|公告牌|UK/i, color: "#4d8dff", icon: ART.globe },
  { match: /JOOX|KKBOX|Melon|TVB|全球|地区|公信/i, color: "#6f9df0", icon: ART.globe },
  { match: /网络/, color: "#5bb8e8", icon: ART.wifi },
  { match: /指数|音乐榜/, color: "#9a72ff", icon: ART.bars },
];

const FALLBACK: ArtRule = { match: /$^/, color: "#7a86ff", icon: ART.bars };

const ruleOf = (title: string): ArtRule => RULES.find((r) => r.match.test(title)) ?? FALLBACK;

/** 首页 Top5 特写里的四个主榜（与上游 title 精确对齐，避免「国风热歌榜」误命中「热歌榜」）。 */
const FEATURED_ORDER = ["飙升榜", "热歌榜", "新歌榜", "流行指数榜"];

/** 返回主榜顺序（0..3）；非主榜返回 -1。 */
export function featuredToplistRank(title: string): number {
  return FEATURED_ORDER.indexOf(title.trim());
}

/** 榜单虚位封面的 HTML（图标 + 榜单色）。使用方负责提供尺寸与裁切容器。 */
export function toplistArtHtml(title: string): string {
  const rule = ruleOf(title.trim());

  return `<span class="toplist-art" style="--top-color:${rule.color}" aria-hidden="true"><span class="toplist-art__icon">${rule.icon}</span></span>`;
}
