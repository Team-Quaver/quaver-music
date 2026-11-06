// 排行榜的「虚位封面」：用图标 + 榜单专属色代替代理图。
// 色相只负责榜单身份，最终颜色由 CSS 与 --cvg-accent 混合（见 home.css 的 .toplist-art），
// 所以「跟随封面 / 自定义 / 主题接管」换色时封面会一起走，不会出现刺眼的对比色。
//
// 已知榜单走 EXACT 表：每个榜一条专属图标 + 专属色，保证同一分类里不会出现
// 两张一样的封面（上游会给同一主题拆出多个榜，例如「香港地区榜 / 香港TVB劲歌金榜」，
// 只靠关键词规则会把它们压成同一个地球）。EXACT 没命中的新榜才落到通用规则。

const svg = (inner: string, sw = 1.6) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ART = {
  // 趋势线：潮流
  trend: svg('<path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5"/><path d="M15.5 6.5h5v5"/>'),
  // 火箭：飙升
  rocket: svg('<path d="M12 2.8c2.7 1.4 4.3 4 4.3 7.1 0 2-.7 3.8-2 5.1H9.7c-1.3-1.3-2-3.1-2-5.1 0-3.1 1.6-5.7 4.3-7.1Z"/><circle cx="12" cy="9.4" r="1.4"/><path d="M8.2 12.7 5.4 15l.7-3.2M15.8 12.7 18.6 15l-.7-3.2M10.2 18.5c.4 1.3 1 2.2 1.8 2.7.8-.5 1.4-1.4 1.8-2.7"/>'),
  // 火焰：热歌/热度/人气
  flame: svg('<path d="M12 3.2c.7 2.7-.3 4.1-1.5 5.4C9.2 10 8.1 11.5 8.1 13.3a3.9 3.9 0 0 0 7.8.2c0-1.2-.4-2.3-1.2-3.2-.3 1-.8 1.7-1.5 2.2.3-2.6-.3-5.1-1.2-6.6Z"/>'),
  // 实心音符 + 加号：新歌（不用星芒，避免与 AI 星火、动漫榜的五角星撞脸；
  // 音符做成填色剪影，旗子与符干连成一块，避免细长竖线在封面上显得突兀）
  newSong: svg('<ellipse cx="8.6" cy="17.2" rx="3.3" ry="2.4" transform="rotate(-22 8.6 17.2)" fill="currentColor" stroke="none"/><path d="M10.6 16.6V5.4h1.5v1.4c2.6.2 4.4 1.5 5.3 3.7.2.5.2 1 0 1.5-.9-1.7-2.6-2.6-5.3-2.8v7.4h-1.5z" fill="currentColor" stroke="none"/><path d="M20.2 2.8v3.6M18.4 4.6h3.6"/>'),
  // 柱状图：指数榜
  bars: svg('<path d="M4 20V11M9.3 20V4M14.7 20v-6.5M20 20V7.5"/>'),
  // 心电图：音乐指数（与柱状图区分）
  pulse: svg('<path d="M3 12h4l2-6 4.2 12 2.3-6H21"/>'),
  // 分享节点
  share: svg('<circle cx="17.5" cy="5.5" r="2.3"/><circle cx="6.5" cy="12" r="2.3"/><circle cx="17.5" cy="18.5" r="2.3"/><path d="M8.6 10.9l6.8-4.1M8.6 13.1l6.8 4.1"/>'),
  // 铃铛
  bell: svg('<path d="M6.5 9.8a5.5 5.5 0 0 1 11 0c0 4 1.5 5.2 1.7 5.7H4.8c.2-.5 1.7-1.7 1.7-5.7Z"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>'),
  // 麦克风：说唱
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.2a6.5 6.5 0 0 0 13 0M12 17.7V21M8.5 21h7"/>'),
  // 话筒 + 音符：K歌
  micNote: svg('<rect x="7.2" y="2.8" width="6" height="10.4" rx="3"/><path d="M4.2 10.8a6 6 0 0 0 12 0M10.2 16.8V20M6.8 20h6.8"/><path d="M18.2 5.4v6.1"/><circle cx="16.8" cy="13" r="1.4"/>'),
  // 放大镜：听歌识曲（镜片里不再放音符，封面尺寸下只会糊成一团）
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3 21 21"/>'),
  // 对话气泡：评论
  chat: svg('<path d="M4 5.5h16v10.5H12l-4.5 3.5V16H4z"/>'),
  // 奖杯：腾讯音乐榜
  trophy: svg('<path d="M8 4h8v4.2a4 4 0 0 1-8 0z"/><path d="M8 5.2H5v1.6a3 3 0 0 0 3 3M16 5.2h3v1.6a3 3 0 0 1-3 3M12 12.2V17M8.5 21h7M9.5 17h5v4h-5z"/>'),
  // 视频
  video: svg('<rect x="3" y="6" width="12.5" height="12" rx="2.2"/><path d="M15.5 10.2 21 7v10l-5.5-3.2z"/>'),
  // 羽毛笔：原创
  quill: svg('<path d="M4.5 19.5c5.5-.8 9.2-3.8 12.2-9.2l1.8-3.2-3.2 1.6c-5.5 2.8-9 5.6-10.8 10.8Z"/><path d="M4.5 19.5 10 14"/>'),
  // 机器人：AI 原创
  robot: svg('<rect x="4.3" y="7.2" width="15.4" height="11.2" rx="3"/><path d="M12 3.2v4M2.8 11.5h1.5M19.7 11.5h1.5"/><circle cx="9.2" cy="12.3" r="1.2"/><circle cx="14.8" cy="12.3" r="1.2"/><path d="M9.6 15.6h4.8"/>'),
  // 琴弦：国乐
  strings: svg('<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h11"/><circle cx="18.5" cy="17.5" r="2"/>'),
  // 折扇：国风（扇骨收成 5 根并留出扇钉，旧版 6 根挤满扇面像一把锯子）
  fan: svg('<path d="M12 20.5 4.2 9.5a13.5 13.5 0 0 1 15.6 0Z"/><path d="M12 20.5 7.1 7.9M12 20.5V7M12 20.5l4.9-12.6"/><circle cx="12" cy="20.5" r="1.1" fill="currentColor" stroke="none"/>'),
  // 唱片：电音
  disc: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/>'),
  // 耳机：DJ
  headphones: svg('<path d="M4.2 14.2v-2.4a7.8 7.8 0 0 1 15.6 0v2.4"/><rect x="2.8" y="13.6" width="4.2" height="7" rx="2.1"/><rect x="17" y="13.6" width="4.2" height="7" rx="2.1"/>'),
  // 手柄：游戏音乐
  gamepad: svg('<path d="M7.5 7.5h9a5 5 0 0 1 4.6 6.9l-1 2.7a2.4 2.4 0 0 1-4.2.6l-1.3-1.7h-5.2l-1.3 1.7a2.4 2.4 0 0 1-4.2-.6l-1-2.7a5 5 0 0 1 4.6-6.9Z"/><path d="M8.5 11v3M7 12.5h3M15.5 12h.01M17.5 14h.01"/>'),
  // 星星：动漫
  star: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z"/>'),
  // 胶片：影视
  film: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.4"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h17M3.5 14.5h17"/>'),
  // 电视：综艺
  tv: svg('<rect x="3" y="6.5" width="18" height="12" rx="2.2"/><path d="M8 21h8M12 18.5V21M8.5 2.5 12 6l3.5-3.5"/>'),
  // 广播塔：TVB
  antenna: svg('<path d="M12 20.5V9.4M8.7 5.3 12 9.4l3.3-4.1"/><circle cx="12" cy="6.7" r="1"/><path d="M5.2 10.2a9.6 9.6 0 0 0 0 5.6M18.8 10.2a9.6 9.6 0 0 1 0 5.6M8.2 12.1a6 6 0 0 0 0 2.9M15.8 12.1a6 6 0 0 1 0 2.9"/>'),
  // 地球：欧美/地区兜底
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z"/>'),
  // 城市天际线：内地
  landmark: svg('<path d="M3 20.5h18M5.5 20.5V11h3v9.5M8.5 20.5V6h3.2v14.5M11.7 20.5V13h3.1v7.5M14.8 20.5V9h3v11.5"/>'),
  // 紫荆花：香港
  flower: svg('<circle cx="12" cy="12" r="2.1"/><path d="M12 9.9c-1.7-3.2-.9-5.8 1.7-7.1 1.5 1.9 1.4 4.5-.6 7.1M14.1 12c3.2-1.7 5.8-.9 7.1 1.7-1.9 1.5-4.5 1.4-7.1-.6M12 14.1c1.7 3.2.9 5.8-1.7 7.1-1.5-1.9-1.4-4.5.6-7.1M9.9 12c-3.2 1.7-5.8.9-7.1-1.7 1.9-1.5 4.5-1.4 7.1.6"/>'),
  // 海岛棕榈：台湾
  island: svg('<path d="M12 20.5V10.4"/><path d="M12 10.4c-2.2-2.8-4.8-3.5-7.2-2 1.4 2.9 4 4.1 7.2 2ZM12 10.4c2.2-2.8 4.8-3.5 7.2-2-1.4 2.9-4 4.1-7.2 2ZM12 10.4c-.4-2.8.6-4.9 3-6.4 1.4 2.5.8 4.8-3 6.4Z"/><path d="M4 21c2.5-1.2 5.2-1.8 8-1.8s5.5.6 8 1.8"/>'),
  // 太极：韩国
  taegeuk: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a4.25 4.25 0 0 1 0 8.5 4.25 4.25 0 0 0 0 8.5"/><circle cx="12" cy="7.75" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="16.25" r="1.1" fill="currentColor" stroke="none"/>'),
  // 鸟居：日本
  torii: svg('<path d="M4 6h16M5 6l-.8 14.5M19 6l.8 14.5M6.5 10h11M8 20.5h2M14 20.5h2M5.3 3.2h13.4L19.9 6H4.1z"/>'),
  // 皇冠：英国
  crown: svg('<path d="M4.2 18.5h15.6M4.8 15.4 3.2 6.8l4.9 3.1L12 4.6l3.9 5.3 4.9-3.1-1.6 8.6z"/>'),
  // 广告牌：美国公告牌
  billboard: svg('<rect x="3.2" y="4.5" width="17.6" height="9.2" rx="1.6"/><path d="M7.2 8.2h6M7.2 10.6h3.6M8 13.7v6.8M16 13.7v6.8M6 20.5h3.5M14.5 20.5H18"/>'),
  // 播放圆环：JOOX
  playBadge: svg('<circle cx="12" cy="12" r="8.6"/><path d="M10.2 8.6v6.8l5.8-3.4z"/>'),
  // 立方体：KKBOX
  box: svg('<path d="M4 8.2 12 3.7l8 4.5v7.6L12 20.3l-8-4.5z"/><path d="M4 8.2 12 12.7l8-4.5M12 12.7v7.6"/>'),
  // 甜瓜：Melon
  melon: svg('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 6c0-2 1-3.2 2.6-3.8"/><path d="M9 7.2c-1 4.1-1 8.5 0 12.6M12 6.4c-.8 4.6-.8 9.4 0 14.2M15 7.2c1 4.1 1 8.5 0 12.6"/>'),
  // 证书 + 绶带：公信榜
  certificate: svg('<rect x="5" y="3" width="14" height="12" rx="1.6"/><path d="M8.2 6.8h7.6M8.2 10h7.6"/><circle cx="12" cy="16.8" r="2.7"/><path d="M10.4 19.2 9.6 22l2.4-1 2.4 1-.8-2.8"/>'),
  // 信号：网络榜
  wifi: svg('<path d="M4 9.5a12 12 0 0 1 16 0M7 13a7.5 7.5 0 0 1 10 0M10 16.5a3 3 0 0 1 4 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/>'),
  // 红心：收藏
  heart: svg('<path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/>'),
  // 音符：抖音/网络热歌
  music: svg('<path d="M9 18.5V6.2l10-2.2v12.3"/><circle cx="6.2" cy="18.7" r="2.8"/><circle cx="16.2" cy="16.5" r="2.8"/>'),
  // 指南针：未知榜单兜底
  compass: svg('<circle cx="12" cy="12" r="8.5"/><path d="m15.8 8.2-2 5.6-5.6 2 2-5.6z"/>'),
} as const;

interface Art {
  color: string;
  icon: string;
}

interface ArtRule extends Art {
  match: RegExp;
}

/**
 * 已知榜单的专属封面。键 = 上游 title（trim 后），逐条给不同的图标与色相：
 * 上游把同一主题拆成多个榜时，关键词会同时命中，只有精确表能拆开。
 */
const EXACT = new Map(Object.entries({
  // —— 巅峰榜 ——
  巅峰潮流榜: { color: "#ff4d8d", icon: ART.trend },
  飙升榜: { color: "#ff5a3c", icon: ART.rocket },
  热歌榜: { color: "#ff8a1e", icon: ART.flame },
  新歌榜: { color: "#2f80ed", icon: ART.newSong },
  流行指数榜: { color: "#8b5cf6", icon: ART.bars },
  分享热度榜: { color: "#16a34a", icon: ART.share },
  音乐指数榜: { color: "#0ea5e9", icon: ART.pulse },
  铃声榜: { color: "#a16207", icon: ART.bell },
  听歌识曲榜: { color: "#06b6d4", icon: ART.search },
  收藏人气榜: { color: "#ef4444", icon: ART.heart },
  评论人气榜: { color: "#6366f1", icon: ART.chat },
  腾讯音乐榜: { color: "#e6a020", icon: ART.trophy },
  // —— 特色榜 ——
  视频号热歌榜: { color: "#ff6a5e", icon: ART.video },
  中国原创榜: { color: "#0f766e", icon: ART.quill },
  Vemus未音AI原创榜: { color: "#a855f7", icon: ART.robot },
  国乐榜: { color: "#2fae86", icon: ART.strings },
  说唱榜: { color: "#c2410c", icon: ART.mic },
  电音榜: { color: "#6f7bff", icon: ART.disc },
  游戏音乐榜: { color: "#2563eb", icon: ART.gamepad },
  动漫音乐榜: { color: "#ff6fa8", icon: ART.star },
  影视金曲榜: { color: "#ff8a5c", icon: ART.film },
  综艺新歌榜: { color: "#ff9c42", icon: ART.tv },
  国风热歌榜: { color: "#b91c1c", icon: ART.fan },
  K歌金曲榜: { color: "#e11d48", icon: ART.micNote },
  DJ舞曲榜: { color: "#7c3aed", icon: ART.headphones },
  // —— 地区榜 ——
  内地榜: { color: "#e0554e", icon: ART.landmark },
  香港地区榜: { color: "#e26a9a", icon: ART.flower },
  JOOX本地热播榜: { color: "#6f9df0", icon: ART.playBadge },
  台湾地区榜: { color: "#3fb6a8", icon: ART.island },
  香港TVB劲歌金榜: { color: "#8e44ad", icon: ART.antenna },
  台湾KKBOX榜: { color: "#cf5c8a", icon: ART.box },
  // —— 全球榜 ——
  美国公告牌榜: { color: "#4d8dff", icon: ART.billboard },
  欧美榜: { color: "#2f8f6b", icon: ART.globe },
  韩国榜: { color: "#ff7c93", icon: ART.taegeuk },
  日本榜: { color: "#ff9ec4", icon: ART.torii },
  英国UK榜: { color: "#f0b23c", icon: ART.crown },
  韩国Melon榜: { color: "#5c6bc0", icon: ART.melon },
  日本公信榜: { color: "#b08968", icon: ART.certificate },
  // —— 网络榜 ——
  网络歌曲榜: { color: "#5bb8e8", icon: ART.wifi },
  抖音热歌榜: { color: "#ff5f8a", icon: ART.music },
}));

// 未知榜单的通用规则，按「先具体后笼统」排列：同一个标题命中第一条即停。
// 已知榜单先查 EXACT，所以这里的图标/颜色只需保证新榜不至于全撞在一起。
const RULES: ArtRule[] = [
  { match: /潮流/, color: "#ff6f9d", icon: ART.trend },
  { match: /飙升/, color: "#ff5b4e", icon: ART.rocket },
  { match: /视频号/, color: "#ff6a5e", icon: ART.video },
  { match: /抖音/, color: "#ff5f8a", icon: ART.music },
  { match: /国风/, color: "#b91c1c", icon: ART.fan },
  { match: /国乐/, color: "#2fae86", icon: ART.strings },
  { match: /分享/, color: "#16a34a", icon: ART.share },
  { match: /铃声/, color: "#a16207", icon: ART.bell },
  { match: /说唱/i, color: "#c2410c", icon: ART.mic },
  { match: /K歌|翻唱/i, color: "#e11d48", icon: ART.micNote },
  { match: /电音/i, color: "#6f7bff", icon: ART.disc },
  { match: /DJ|舞曲/i, color: "#7c3aed", icon: ART.headphones },
  { match: /识曲/, color: "#06b6d4", icon: ART.search },
  { match: /收藏/, color: "#ef4444", icon: ART.heart },
  { match: /评论/, color: "#6366f1", icon: ART.chat },
  { match: /游戏/, color: "#2563eb", icon: ART.gamepad },
  { match: /动漫/, color: "#ff6fa8", icon: ART.star },
  { match: /影视|电影|电视剧/, color: "#ff8a5c", icon: ART.film },
  { match: /综艺/, color: "#ff9c42", icon: ART.tv },
  { match: /AI|未音/i, color: "#a855f7", icon: ART.robot },
  { match: /原创|新势力/, color: "#0f766e", icon: ART.quill },
  { match: /新歌/, color: "#2f80ed", icon: ART.newSong },
  { match: /热歌|热度|人气/, color: "#ff8a1e", icon: ART.flame },
  { match: /腾讯音乐|由你|浪潮/, color: "#e6a020", icon: ART.trophy },
  { match: /香港/, color: "#e26a9a", icon: ART.flower },
  { match: /台湾/, color: "#3fb6a8", icon: ART.island },
  { match: /内地/, color: "#e0554e", icon: ART.landmark },
  { match: /韩国/, color: "#ff7c93", icon: ART.taegeuk },
  { match: /日本/, color: "#ff9ec4", icon: ART.torii },
  { match: /美国|公告牌/i, color: "#4d8dff", icon: ART.billboard },
  { match: /英国|UK/i, color: "#f0b23c", icon: ART.crown },
  { match: /欧美/, color: "#2f8f6b", icon: ART.globe },
  { match: /JOOX/i, color: "#6f9df0", icon: ART.playBadge },
  { match: /KKBOX/i, color: "#cf5c8a", icon: ART.box },
  { match: /Melon/i, color: "#5c6bc0", icon: ART.melon },
  { match: /TVB/, color: "#8e44ad", icon: ART.antenna },
  { match: /公信/, color: "#b08968", icon: ART.certificate },
  { match: /全球|地区/, color: "#6f9df0", icon: ART.globe },
  { match: /网络/, color: "#5bb8e8", icon: ART.wifi },
  { match: /音乐指数/, color: "#0ea5e9", icon: ART.pulse },
  { match: /指数|音乐榜/, color: "#8b5cf6", icon: ART.bars },
];

const FALLBACK: ArtRule = { match: /$^/, color: "#7a86ff", icon: ART.compass };

const ruleOf = (title: string): Art => {
  const key = title.trim();

  return EXACT.get(key) ?? RULES.find((r) => r.match.test(key)) ?? FALLBACK;
};

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
