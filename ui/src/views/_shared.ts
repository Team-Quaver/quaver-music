// Quaver — 视图共用件（从 views.ts 拆出）：小工具、页面头/粘顶、响应类型。
// 被 src/views/ 下每个按需加载的视图模块引用；本模块自身只随第一个真视图进内存。
import { api, escHtml } from "../lib/api";
import { getMyMusicid, isFavSonglist, loadFavSonglists, onFavSonglistsChange, toggleFavSonglist } from "../lib/favs";
import { icons } from "../lib/icons";
import { player } from "../player";
import type { Song } from "../player";

export const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);

  if (cls) el.className = cls;
  el.innerHTML = html;

  return el;
};

/** catch (e: unknown) 统一取文案：ApiError/Error 取 message，其余原样转串 */

export /** catch (e: unknown) 统一取文案：ApiError/Error 取 message，其余原样转串 */
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 模块级订阅槽：同一时刻只保留最新的一个 player 订阅（见 settingsView 的用法） */

export /** 模块级订阅槽：同一时刻只保留最新的一个 player 订阅（见 settingsView 的用法） */
let backendWatchOff: (() => void) | null = null;

export function watchBackendChange(fn: () => void) {
  backendWatchOff?.();
  backendWatchOff = player.on(fn);
}

// —— 上游响应的最小类型（只声明视图里真正读的字段，上游字段缺失一律可选） ——
/** 歌单详情页的 info（/songlist/:id/detail） */

export // —— 上游响应的最小类型（只声明视图里真正读的字段，上游字段缺失一律可选） ——
/** 歌单详情页的 info（/songlist/:id/detail） */
interface SonglistInfo {
  id?: number | string;
  /** 写接口要 dirid，读详情用 disstid（= id）—— 两者不同源，见 playlistView */
  dirid?: number;
  title?: string;
  picurl?: string;
  desc?: string;
  songnum?: number;
  creator?: { nick?: string; musicid?: number };
}

export interface PlaylistDetailResp { info?: SonglistInfo | null; songs?: Song[]; hasmore?: boolean }
/** 专辑概要：歌手页专辑卡 / 专辑页共用 */

export /** 专辑概要：歌手页专辑卡 / 专辑页共用 */
interface AlbumBrief {
  mid?: string; pmid?: string; name?: string; desc?: string; album_type?: string; time_public?: string;
  singer?: { name?: string }[];
}

export interface AlbumDetailResp { album?: AlbumBrief; singers?: { name?: string }[] }

export interface AlbumSongsResp { song_list?: Song[]; total_num?: number }

/** 后端已按上游 index_album 归一化为专辑曲序；页面只复制数组，不按歌名/歌手等字段重排。 */

export /** 后端已按上游 index_album 归一化为专辑曲序；页面只复制数组，不按歌名/歌手等字段重排。 */
function albumSongsInSourceOrder(list: AlbumSongsResp | null): Song[] {
  return list?.song_list ? [...list.song_list] : [];
}


export interface SingerInfoResp { base_info?: { name?: string; avatar?: string } }

export interface SingerDescResp { name?: string; pic?: string; foreign_name?: string; area?: string; birthday?: string; desc?: string }

export interface SingerSongsResp { song_list?: Song[]; total_num?: number }

export interface SingerAlbumsResp { album_list?: AlbumBrief[]; total?: number }

export interface SonglistCard {
  id?: number | string; title?: string; picurl?: string; desc?: string;
  songnum?: number; listennum?: number; creator_nick?: string;
}

export interface RecommendSonglistResp { songlists?: SonglistCard[] }

/** 榜单分类/期次历史：周榜为 year + sub_period（ISO 周），日/实时榜靠 period 自带日期。 */
export interface ToplistHistory { year?: number[]; sub_period?: number[][] }

/** 首页榜单卡片（/top/category 归一化后的形状）。 */
export interface ToplistCard {
  id?: number | string; title?: string; picurl?: string; desc?: string;
  songnum?: number; listennum?: number; period?: string; update_type?: number;
  update_time?: string; update_tips?: string; title_detail?: string; title_share?: string;
  history?: ToplistHistory; history_supported?: boolean;
}

export interface ToplistGroup { id?: number; name?: string; toplists?: ToplistCard[] }

export interface ToplistCategoryResp { groups?: ToplistGroup[] }

/** 榜单详情与歌单详情近似的契约，供同一套信息头/歌曲行复用。 */
export interface ToplistInfo {
  id?: number | string; title?: string; picurl?: string; desc?: string; songnum?: number;
  listennum?: number; period?: string; update_type?: number; update_time?: string;
  update_tips?: string; title_detail?: string; title_share?: string; history?: ToplistHistory;
}

export interface ToplistDetailResp { info?: ToplistInfo | null; songs?: Song[]; total?: number; hasmore?: boolean }

export interface DailyResp { songs?: Song[]; info?: { desc?: string } }

export interface HotkeyResp { vec_hotkey?: { title?: string; query?: string }[] }

export interface SearchSinger { mid?: string; name?: string; pic?: string; song_num?: number }

export interface SearchAlbum { mid?: string; name?: string; pic?: string; singer?: string; time_public?: string }

export interface SearchSonglist { id?: number | string; dirid?: number | string; title?: string; picurl?: string; nickname?: string; songnum?: number }

export interface SearchResp {
  song?: Song[]; singer?: SearchSinger[]; album?: SearchAlbum[]; songlist?: SearchSonglist[];
  total_num?: number; nextpage?: number;
}

export interface UserMeResp {
  base_info?: { name?: string; avatar?: string; encrypted_uin?: string; is_singer?: number | boolean };
}

export type LoginChannel = "mobile" | "qq" | "wx";

export interface QrResp { img?: string; identifier?: string }

export interface QrStatusResp { event?: number; done?: boolean; error?: string }


// 信息头（歌单/专辑/歌手共用）：左图 右「名称/详情/简介」整体上对齐；
// 简介默认两行截断，文本真溢出时出「展开」按钮（点一下显全文，再点收回）。
// 返回按钮不在这里——统一挂在壳层顶带（搜索框旁，见 shell.ts），图标在 lib/icons（首屏壳层
// 不该静态引到本模块：整张 _shared 只随第一个真视图进内存）。

export // 信息头（歌单/专辑/歌手共用）：左图 右「名称/详情/简介」整体上对齐；
// 简介默认两行截断，文本真溢出时出「展开」按钮（点一下显全文，再点收回）。
// 返回按钮不在这里——统一挂在壳层顶带（搜索框旁，见 shell.ts）。
function mountHead(root: HTMLElement, opts: {
  artHtml: string; artRound?: boolean; name: string; meta: string; desc: string;
  /** 信息头行动区（如歌单页的收藏按钮），挂在简介下方 */
  actions?: HTMLElement | null;
}) {
  const head = h("div", "pl-head");
  head.innerHTML = `
    <div class="pl-art${opts.artRound ? " round" : ""}">${opts.artHtml}</div>
    <div class="pl-info">
      <h1 class="pl-name">${escHtml(opts.name)}</h1>
      <div class="pl-meta">${escHtml(opts.meta)}</div>
      <div class="pl-desc muted">${escHtml(opts.desc)}</div>
    </div>`;

  if (opts.actions) {
    const box = h("div", "pl-actions");
    box.append(opts.actions);
    head.querySelector<HTMLElement>(".pl-info")!.append(box);
  }

  root.append(head);
  const desc = head.querySelector<HTMLElement>(".pl-desc")!;

  if (opts.desc) {
    // 截断检测在下一帧做（-webkit-line-clamp 生效后 scrollHeight 才可比）
    requestAnimationFrame(() => {
      if (desc.scrollHeight - desc.clientHeight <= 2) return; // 两行内放得下：不需要按钮
      const btn = h("button", "pl-expand", "展开") as HTMLButtonElement;
      btn.type = "button";
      btn.onclick = () => {
        const open = desc.classList.toggle("open");
        btn.textContent = open ? "收起" : "展开";
      };

      desc.after(btn);
    });
  }

  return head;
}

/** 下翻吸顶单行条：信息头滚出视口后，封面/头像 + 标题缩成一行固定在内容区顶部；
 *  右侧槽给页面的常驻控件（歌单页搜索/排序、歌手页分类标签）—— 控件跟着条一起吸顶。
 *  条本身 position:sticky 常驻在信息头与内容之间（占位即原工具条/标签行），布局无跳动；
 *  未吸顶时左侧缩略信息隐藏（不与大信息头重复），吸顶后浮现。 */

export /** 下翻吸顶单行条：信息头滚出视口后，封面/头像 + 标题缩成一行固定在内容区顶部；
 *  右侧槽给页面的常驻控件（歌单页搜索/排序、歌手页分类标签）—— 控件跟着条一起吸顶。
 *  条本身 position:sticky 常驻在信息头与内容之间（占位即原工具条/标签行），布局无跳动；
 *  未吸顶时左侧缩略信息隐藏（不与大信息头重复），吸顶后浮现。 */
function mountStickyBar(root: HTMLElement, opts: { artHtml?: string; round?: boolean; name?: string } = {}) {
  const bar = h("div", "sticky-bar");

  if (opts.name || opts.artHtml) {
    bar.innerHTML = `
      <div class="sticky-bar__lead">
        ${opts.artHtml ? `<div class="sticky-bar__art${opts.round ? " round" : ""}">${opts.artHtml}</div>` : ""}
        <span class="sticky-bar__name">${escHtml(opts.name ?? "")}</span>
      </div>`;
  }

  const right = h("div", "sticky-bar__right");
  bar.append(right);
  root.append(bar);

  return { bar, right, off: trackStuck(bar, routeScroller(root)) };
}

/** 吸顶条最右侧的「播放全部」：整队列替换、从第一首开播。
 *  getVisible() 返回**此刻实际可见**的列表（搜索筛后 / 排序后 / 当前 Tag 面板），
 *  所以按钮天然尊重排序与分类；空列表置灰，调用方在重画后调 sync() 刷新可用态。 */

export /** 吸顶条最右侧的「播放全部」：整队列替换、从第一首开播。
 *  getVisible() 返回**此刻实际可见**的列表（搜索筛后 / 排序后 / 当前 Tag 面板），
 *  所以按钮天然尊重排序与分类；空列表置灰，调用方在重画后调 sync() 刷新可用态。 */
function playAllButton(getVisible: () => Song[]) {
  const btn = h("button", "ghost-btn sticky-playall",
    `<span class="sp-ico" aria-hidden="true">${icons.play}</span>播放全部`) as HTMLButtonElement;

  btn.type = "button";
  const sync = () => { btn.disabled = !getVisible().length; };

  sync();
  btn.addEventListener("click", () => {
    const list = getVisible().filter((s) => s?.mid);

    if (list.length) player.playList(list, 0);
  });

  return { el: btn, sync };
}

/** 视图所在滚动容器（`.route`）；拿不到时退回自身 */

export /** 视图所在滚动容器（`.route`）；拿不到时退回自身 */
const routeScroller = (root: HTMLElement) => root.closest<HTMLElement>(".route") ?? root;

/**
 * 吸顶状态跟踪，两件事：
 *   ① 贴住滚动容器顶缘 → 元素加 `.stuck`（缩略封面/名字据此浮现）；
 *   ② 把吸顶区高度写进 `.content` 的 `--stuck-h` —— 吸顶底就是 .content::before 那一层
 *      从 CSD 顶带一路淡下来的全宽渐变，它的高度按 `46px + --stuck-h` 撑到吸顶区下缘，
 *      于是「高页头」（首页 = 标题 + 副题）也在渐变覆盖内，且渐变一路到内容卡右缘，
 *      不会像画在吸顶节点自己身上那样被 10px 滚动条槽裁掉一条边。
 *      未吸顶/无吸顶区时写 0，交给 CSS 的 min-height 兜底（普通页的 112px 顶带渐隐）。
 * 判定基准必须是**滚动容器顶缘**：`.route` 的顶不在视口 0。早期写成 `rect.top <= 0`
 * 导致 `.stuck` 永不生效（缩略信息永不出现）。
 * 注意不能只看几何 diff：吸顶头负 margin 让它回顶后 diff=0、与吸顶位重合，
 * 必须叠加 `scrollTop > 0` 才能区分「原位」与「吸住」(见 sync 内注释)。
 * 吸顶状态同时写进 host 的 `.has-stuck`：吸顶底实底只在真正吸顶时启用，
 * 未吸顶时 .content::before 保持温和渐隐 —— 否则我喜欢/设置这种不吸顶的大标题
 * 会被常驻的实底压成鬼影（--stuck-h 本身无论吸没吸顶都写值，供过渡参考）。
 * 返回退订函数（路由切换时由 renderRoute 调）。
 */

export /**
 * 吸顶状态跟踪，两件事：
 *   ① 贴住滚动容器顶缘 → 元素加 `.stuck`（缩略封面/名字据此浮现）；
 *   ② 把吸顶区高度写进 `.content` 的 `--stuck-h` —— 吸顶底就是 .content::before 那一层
 *      从 CSD 顶带一路淡下来的全宽渐变，它的高度按 `46px + --stuck-h` 撑到吸顶区下缘，
 *      于是「高页头」（首页 = 标题 + 副题）也在渐变覆盖内，且渐变一路到内容卡右缘，
 *      不会像画在吸顶节点自己身上那样被 10px 滚动条槽裁掉一条边。
 *      未吸顶/无吸顶区时写 0，交给 CSS 的 min-height 兜底（普通页的 112px 顶带渐隐）。
 * 判定基准必须是**滚动容器顶缘**：`.route` 的顶不在视口 0。早期写成 `rect.top <= 0`
 * 导致 `.stuck` 永不生效（缩略信息永不出现）。
 * 注意不能只看几何 diff：吸顶头负 margin 让它回顶后 diff=0、与吸顶位重合，
 * 必须叠加 `scrollTop > 0` 才能区分「原位」与「吸住」(见 sync 内注释)。
 * 吸顶状态同时写进 host 的 `.has-stuck`：吸顶底实底只在真正吸顶时启用，
 * 未吸顶时 .content::before 保持温和渐隐 —— 否则我喜欢/设置这种不吸顶的大标题
 * 会被常驻的实底压成鬼影（--stuck-h 本身无论吸没吸顶都写值，供过渡参考）。
 * 返回退订函数（路由切换时由 renderRoute 调）。
 */
function trackStuck(el: HTMLElement, scroller: HTMLElement) {
  const host = el.closest<HTMLElement>(".content") ?? el;
  let raf = 0;

  const sync = () => {
    raf = 0;

    // 吸顶 = 「已离开顶部滚动」且「几何上贴住停靠位」。只有后者不够：
    // 吸顶头自带 margin-top: -6px（抵消 route 顶内边距），回到顶部时 diff 恰为 0，
    // 与吸顶位重合 —— 只看 diff 会把「回到顶部」误判成仍在吸顶，实底永远摘不掉。
    // scrollTop > 0 排除顶端原位；diff <= 0 覆盖停靠 top 为 -6px 的贴住状态
    // （滚动 0-6px 之间元素还在随内容上移，提前判吸顶 6px，视觉无差）。
    const stuck = scroller.scrollTop > 0
      && el.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= 0;

    el.classList.toggle("stuck", stuck);
    host.classList.toggle("has-stuck", stuck);
    host.style.setProperty("--stuck-h", `${Math.round(el.getBoundingClientRect().height)}px`);
  };

  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(sync);
  };

  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  sync();

  return () => {
    scroller.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);

    if (raf) cancelAnimationFrame(raf);
    el.classList.remove("stuck");
    host.classList.remove("has-stuck");
    host.style.removeProperty("--stuck-h");
  };
}

// —— 首页：大标题 + 推荐歌单卡片网格（官方推荐 CGI，无需登录态） ——
// 上游歌单简介夹带 <br> 等展示标记；首页精选只取纯文本，避免把接口 HTML 带进页面。

export // —— 首页：大标题 + 推荐歌单卡片网格（官方推荐 CGI，无需登录态） ——
// 上游歌单简介夹带 <br> 等展示标记；首页精选只取纯文本，避免把接口 HTML 带进页面。
const plainText = (s: unknown) => String(s ?? "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/\s+/g, " ")
  .trim();


export const compactCount = (value: unknown) => {
  const n = Number(value ?? 0);

  if (!Number.isFinite(n) || n <= 0) return "";
  const fmt = (v: number) => v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, "");

  if (n >= 100_000_000) return `${fmt(n / 100_000_000)} 亿`;

  if (n >= 10_000) return `${fmt(n / 10_000)} 万`;

  return Math.round(n).toLocaleString("zh-CN");
};

// 卡片播放（悬停浮出的圆形播放键）：取集合歌曲后直接开播，失败则落到详情页

export // 卡片播放（悬停浮出的圆形播放键）：取集合歌曲后直接开播，失败则落到详情页
async function cardPlay(kind: "playlist" | "album" | "singer" | "toplist", id: string, fallbackHash: string) {
  try {
    let songs: Song[] = [];

    if (kind === "playlist") {
      songs = (await api<PlaylistDetailResp>(`/songlist/${id}/detail?page=1&num=100`))?.songs ?? [];
    } else if (kind === "toplist") {
      songs = (await api<ToplistDetailResp>(`/top/${id}/detail?page=1&num=100`))?.songs ?? [];
    } else if (kind === "album") {
      songs = (await api<AlbumSongsResp>(`/album/${encodeURIComponent(id)}/songs?num=100`))?.song_list ?? [];
    } else {
      songs = (await api<SingerSongsResp>(`/singer/${encodeURIComponent(id)}/songs?num=50&page=1&order=1`))?.song_list ?? [];
    }

    if (!songs.length) throw new Error("empty");
    player.playList(songs, 0);
  } catch {
    location.hash = fallbackHash;
  }
}

// 卡片：div[role=button] 导航；悬停播放键取歌开播（歌手卡无播放键——人不是可播集合）。
// 沿用本地既有卡面类名（.card/.art/.name/.sub），只改外层容器为可网格拉伸的自适应卡。

export // 卡片：div[role=button] 导航；悬停播放键取歌开播（歌手卡无播放键——人不是可播集合）。
// 沿用本地既有卡面类名（.card/.art/.name/.sub），只改外层容器为可网格拉伸的自适应卡。
function navCard(href: string, cover: string, title: string, sub: string, play?: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "card";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.innerHTML = `<div class="art">${cover ? `<img src="${cover}" alt="" loading="lazy"/>` : ""}
      ${play ? `<button type="button" class="card-play" aria-label="播放" title="播放">${PLAY_SVG}</button>` : ""}</div>
    <div class="name">${escHtml(title)}</div><div class="sub">${escHtml(sub)}</div>`;
  el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".card-play")) return;
    location.hash = href;
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement) === el) { e.preventDefault(); location.hash = href; }
  });
  const pb = el.querySelector(".card-play");

  if (pb && play) pb.addEventListener("click", (e) => { e.stopPropagation(); play(); });

  return el;
}


export const PLAY_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>`;

// 区块错误/空态：标题 + 说明 + 可选重试

export // 区块错误/空态：标题 + 说明 + 可选重试
function homeStatus(box: HTMLElement, title: string, note: string, retry?: () => void) {
  box.innerHTML = "";

  const status = h("div", "home-status", `
    <p class="home-status__title">${escHtml(title)}</p>
    <p class="muted">${escHtml(note)}</p>`);

  if (retry) {
    const btn = h("button", "ghost-btn", "重试") as HTMLButtonElement;
    btn.type = "button";
    btn.onclick = retry;
    status.append(btn);
  }

  box.append(status);
}

// —— 首页：页头 + 双栏领区（快速开始 / 新歌速递）+ 发丝线分隔的推荐网格 ——
// 两个数据源并行、独立降级：任一失败不影响另一块，各自原地给重试。

export // —— 歌单页收藏按钮（在线收藏写接口：PlaylistFavWrite Fav/CancelFavPlaylist） ——
// 收藏态取自 lib/favs 的收藏歌单缓存（与侧栏同源，收藏后侧栏同帧出现）；
// 自有歌单不渲染（不能收藏自己的歌单），未登录不渲染（收藏必须带登录态）。
// cleanups：视图销毁时的退订登记（playlistView 交给 renderRoute 调用）。
async function favSonglistButton(meta: {
  id: string; title: string; picurl?: string; songnum?: number; creatorMusicid?: number;
}, cleanups: (() => void)[]): Promise<HTMLElement | null> {
  const myId = await getMyMusicid();

  if (!myId) return null;

  if (meta.creatorMusicid && Number(meta.creatorMusicid) === myId) return null;
  // 收藏列表没拉到（未登录/上游失败）也照常给按钮：点击时写接口会给出真实错误
  await loadFavSonglists().catch(() => []);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fav-btn";
  btn.dataset.plid = meta.id;

  const paint = () => {
    const on = isFavSonglist(meta.id);
    btn.classList.toggle("on", on);
    btn.innerHTML = `<span class="fb-ic">${on ? "♥" : "♡"}</span><span>${on ? "已收藏" : "收藏"}</span>`;
    btn.title = on ? "从我的收藏中移除" : "收藏这首歌单";
  };

  paint();
  // 订阅挂**按钮的一生**（曾经只挂在点击期间）：侧栏右键「取消收藏」等别处的收藏变更
  // 必须同帧反映到这里 —— 否则按钮停在旧态，下一次点击按旧态取反，做出与显示相反的动作。
  // 退订交给 playlistView 的视图 cleanup（cleanups 数组），路由切换不留死监听。
  const off = onFavSonglistsChange(() => { if (!btn.dataset.fail) paint(); });
  cleanups.push(off);
  btn.onclick = async () => {
    btn.disabled = true;

    try {
      await toggleFavSonglist({ id: meta.id, title: meta.title, picurl: meta.picurl, songnum: meta.songnum });
    } catch (e) {
      console.warn("收藏歌单失败", e);
      btn.dataset.fail = "1";
      btn.classList.add("failed");
      btn.setAttribute("title", errText(e));
      btn.innerHTML = `<span class="fb-ic">!</span><span>收藏失败</span>`;
      window.setTimeout(() => {
        delete btn.dataset.fail;
        btn.classList.remove("failed");
        paint();
      }, 2600);
    } finally {
      btn.disabled = false;

      if (!btn.dataset.fail) paint();
    }
  };

  return btn;
}

// —— 歌单页：信息头（封面/标题/制作人/描述）+ 歌曲列表（缓存秒开 / 整单回源 / 写后增量对账） ——

export // 专辑卡网格（歌手页「专辑」标签 / 歌手全部专辑页共用同一套卡面）
function albumCardsHtml(albums: AlbumBrief[]): string {
  const orderedAlbums = albums
    .map((album, index) => ({ album, index, releaseTime: Date.parse(album.time_public?.trim() || "") }))
    .sort((a, b) => {
      const aTime = Number.isNaN(a.releaseTime) ? Number.NEGATIVE_INFINITY : a.releaseTime;
      const bTime = Number.isNaN(b.releaseTime) ? Number.NEGATIVE_INFINITY : b.releaseTime;

      return bTime - aTime || a.index - b.index;
    })
    .map(({ album }) => album);

  return orderedAlbums.map((x) => {
    const pm: string = x.pmid || x.mid || "";
    const cover = pm ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pm.split("_")[0]}.jpg` : "";
    const sub = [x.album_type, x.time_public].filter(Boolean).join(" · ");

    return `<a class="card" href="#/album?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(x.name || "专辑")}">
      <div class="art">${cover ? `<img src="${cover}" alt="" loading="lazy"/>` : ""}</div>
      <div class="name">${escHtml(x.name || "专辑")}</div><div class="sub">${escHtml(sub)}</div></a>`;
  }).join("");
}

// 歌手专辑接口的返回顺序不是发行时间顺序，且单页最多返回 30 张；必须分页拉全后再排序。

export // 歌手专辑接口的返回顺序不是发行时间顺序，且单页最多返回 30 张；必须分页拉全后再排序。
async function fetchSingerAlbums(mid: string, pageSize = 30): Promise<SingerAlbumsResp | null> {
  const albums: AlbumBrief[] = [];
  let total = 0;

  try {
    for (let page = 1; ; page++) {
      const d = (await api<SingerAlbumsResp>(`/singer/${encodeURIComponent(mid)}/albums?num=${pageSize}&page=${page}`)) ?? {};
      const batch = d.album_list ?? [];
      albums.push(...batch);

      if (typeof d.total === "number") total = d.total;

      // total 缺失或为 0 时继续请求，直到接口返回空页，避免漏掉后续专辑。
      if (!batch.length || (total > 0 && albums.length >= total)) break;
    }
  } catch {
    if (!albums.length) return null;
  }

  return { album_list: albums, total: total || albums.length };
}

// —— 歌手页（点击行内歌手跳转的落点）：信息头 + 分类标签（热歌 / 新歌 / 专辑） ——
// 三块内容一次性并拉，标签只决定「显示哪一块」：切换不重新请求、不重置 .route 滚动位置。
// 默认落在「热歌」。信息头仍与歌单/专辑页同一套（左图右文、上对齐）。

export // —— 列表页公共壳 ——
function listPage(root: HTMLElement, title: string, note?: string) {
  const head = h("div", "sticky-head"); // 标题（+副题）吸顶：下翻时固定在内容区顶部
  head.append(h("h1", "page-title", title));

  if (note) head.append(h("p", "muted page-note", note));
  root.append(head);
  const offHead = trackStuck(head, routeScroller(root));
  const rows = h("div", "rows", `<div class="muted">加载中…</div>`);
  rows.id = "rows";
  root.append(rows);

  return { rows, off: offHead };
}

export // —— 我的页（点侧栏头像的落点；退出登录按钮长在这里）——
//
// 进场：整页交给 CSS 的 `.me > *` 分级淡入（style.css「我的」段），容器让位不叠动画。
// 离场：退出登录先播 `.leaving`（整页淡出上移）再跳登录页 —— 登录态变化必须走整页
// （location.href）才能重置侧栏与播放器，所以这里只能「先把界面收掉再跳」。
const ME_OUT_MS = 180; // 与 .me.leaving 的动画时长对齐


export const reduceMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 我的页离场：加 .leaving 等动画结束。动画只是观感，**绝不能挡住跳转** —— 
 *  用户关了动效（动画被媒体查询去掉、animationend 永不触发）或事件丢失时按超时兜底。 */

export /** 我的页离场：加 .leaving 等动画结束。动画只是观感，**绝不能挡住跳转** —— 
 *  用户关了动效（动画被媒体查询去掉、animationend 永不触发）或事件丢失时按超时兜底。 */
function exitMe(el: HTMLElement): Promise<void> {
  if (reduceMotion()) return Promise.resolve();

  return new Promise<void>((done) => {
    let timer = 0;
    const fin = () => { window.clearTimeout(timer); done(); };

    el.addEventListener("animationend", fin, { once: true });
    timer = window.setTimeout(fin, ME_OUT_MS + 120);
    el.classList.add("leaving");
  });
}

/** 登出请求不许拖住离场：上游不回就在 ms 后放行（凭证清理本来就允许失败） */

export /** 登出请求不许拖住离场：上游不回就在 ms 后放行（凭证清理本来就允许失败） */
const settleIn = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

/** mid 序列是否同一张表（我喜欢页与播放条高亮共用判据；与 player 里的同名私有助手同义） */
export const sameMids = (a: Song[], b: Song[]) => a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);
