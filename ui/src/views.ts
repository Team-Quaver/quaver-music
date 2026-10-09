// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, escHtml, getQuality, getStreamTiers, identityBadges, setQuality, setSessionQuality, stripEm, upPic, type Quality } from "./lib/api";
import { renderSongRows, renumberRows, type RowHooks } from "./lib/songs";
import { songListTools } from "./components/ListTools";
import { getMyMusicid, isFavSonglist, loadFavSonglists, onFavSonglistsChange, toggleFavSonglist } from "./lib/favs";
import { getCachedSonglist, loadSonglistDetail, noteSonglistWrite, onSonglistChange, syncSonglistSoon, type SonglistDetail } from "./lib/songlist-detail";
import { pushHistory } from "./components/SearchBox";
import { playNowWithToast, toast } from "./components/SongMenu";
import { player, type Song } from "./player";
import {
  BG_BLUR_MAX,
  BG_BLUR_MIN,
  type BackgroundMode,
  type CloseAction,
  type DecorMode,
  type FadePreset,
  type FallbackSort,
  FONT_CUSTOM,
  FONT_LABELS,
  FONT_PRESETS,
  fontKeyOf,
  getBackgroundBlur,
  getBackgroundImage,
  getBackgroundMode,
  getCloseAction,
  getAutoCheck,
  getDecode,
  getDecor,
  getFade,
  getFallbackSort,
  getInhibitSleep,
  getLyricFontList,
  getMenuBlur,
  getPrevBehavior,
  getTheme,
  getTintColor,
  getTintMode,
  getUiFontList,
  getUpdateChannel,
  normalizeFontList,
  setAutoCheck,
  setBackgroundBlur,
  setBackgroundImage,
  setBackgroundMode,
  setCloseAction,
  setDecor,
  setFallbackSort,
  setInhibitSleep,
  setLyricFontList,
  setLyricFontPreset,
  setMenuBlur,
  setPrevBehavior,
  setTheme,
  setTintColor,
  setTintMode,
  setUiFontList,
  setUiFontPreset,
  setUpdateChannel,
  TINT_DEFAULT_COLOR,
  type PrevBehavior,
  type ThemeMode,
  type TintMode,
  type UpdateChannel,
} from "./lib/prefs";
import { applyBackground } from "./lib/ambient";
import { applyTint } from "./lib/tint";
import { applyMenuGlass } from "./lib/menu-glass";
import { cmyk2rgb, hsl2rgb, parseHex, rgb2cmyk, rgb2hsl, toHex, type RGB } from "./lib/color";
import { checkAndPrompt, getPlatformInfo } from "./lib/updater";
import { buildChannel, describeBuild, parseVersion } from "./lib/update-core";
import { syncInhibit } from "./lib/inhibit";
import {configInfo, resetConfig, revealConfig} from "./lib/config";
import {vipCardHtml} from "./lib/vip";
import {mountSparklePanel} from "./sparkle/settings";
import {onSparkleChange, sparkleActiveTheme, sparkleThemes} from "./sparkle/registry";
import {sparkActivateTheme, sparkActiveThemeId} from "./sparkle/host";
import {sparkSetTintChoice, sparkTintChoice, tintPolicyOf, resolvePresetColor, TINT_PRESET_SYSTEM} from "./sparkle/theme-tint";
import { currentAccent, refreshAccent } from "./lib/accent";
import {backgroundPolicyOf} from "./sparkle/theme-background";
import {menuGlassPolicyOf} from "./sparkle/theme-menus";
import type { SparkleTintPreset } from "@quaver/sparkle";
import {mountHotkeysPanel} from "./components/HotkeySettings";

const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
};

/** catch (e: unknown) 统一取文案：ApiError/Error 取 message，其余原样转串 */
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 模块级订阅槽：同一时刻只保留最新的一个 player 订阅（见 settingsView 的用法） */
let backendWatchOff: (() => void) | null = null;
function watchBackendChange(fn: () => void) {
  backendWatchOff?.();
  backendWatchOff = player.on(fn);
}

// —— 上游响应的最小类型（只声明视图里真正读的字段，上游字段缺失一律可选） ——
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
interface PlaylistDetailResp { info?: SonglistInfo | null; songs?: Song[]; hasmore?: boolean }
/** 专辑概要：歌手页专辑卡 / 专辑页共用 */
interface AlbumBrief {
  mid?: string; pmid?: string; name?: string; desc?: string; album_type?: string; time_public?: string;
  singer?: { name?: string }[];
}
interface AlbumDetailResp { album?: AlbumBrief; singers?: { name?: string }[] }
interface AlbumSongsResp { song_list?: Song[]; total_num?: number }
interface SingerInfoResp { base_info?: { name?: string; avatar?: string } }
interface SingerDescResp { name?: string; pic?: string; foreign_name?: string; area?: string; birthday?: string; desc?: string }
interface SingerSongsResp { song_list?: Song[]; total_num?: number }
interface SingerAlbumsResp { album_list?: AlbumBrief[]; total?: number }
interface SonglistCard {
  id?: number | string; title?: string; picurl?: string; desc?: string;
  songnum?: number; listennum?: number; creator_nick?: string;
}
interface RecommendSonglistResp { songlists?: SonglistCard[] }
interface DailyResp { songs?: Song[]; info?: { desc?: string } }
interface HotkeyResp { vec_hotkey?: { title?: string; query?: string }[] }
interface SearchSinger { mid?: string; name?: string; pic?: string; song_num?: number }
interface SearchAlbum { mid?: string; name?: string; pic?: string; singer?: string; time_public?: string }
interface SearchSonglist { id?: number | string; dirid?: number | string; title?: string; picurl?: string; nickname?: string; songnum?: number }
interface SearchResp {
  song?: Song[]; singer?: SearchSinger[]; album?: SearchAlbum[]; songlist?: SearchSonglist[];
  total_num?: number; nextpage?: number;
}
interface UserMeResp {
  base_info?: { name?: string; avatar?: string; encrypted_uin?: string; is_singer?: number | boolean };
}
type LoginChannel = "mobile" | "qq" | "wx";
interface QrResp { img?: string; identifier?: string }
interface QrStatusResp { event?: number; done?: boolean }

export const BACK_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>`;

// 信息头（歌单/专辑/歌手共用）：左图 右「名称/详情/简介」整体上对齐；
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

// —— 首页：大标题 + 推荐歌单卡片网格（官方推荐 CGI，无需登录态） ——
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

const compactCount = (value: unknown) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const fmt = (v: number) => v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, "");
  if (n >= 100_000_000) return `${fmt(n / 100_000_000)} 亿`;
  if (n >= 10_000) return `${fmt(n / 10_000)} 万`;
  return Math.round(n).toLocaleString("zh-CN");
};

// 卡片播放（悬停浮出的圆形播放键）：取集合歌曲后直接开播，失败则落到详情页
async function cardPlay(kind: "playlist" | "album" | "singer", id: string, fallbackHash: string) {
  try {
    let songs: Song[] = [];
    if (kind === "playlist") {
      songs = (await api<PlaylistDetailResp>(`/songlist/${id}/detail?page=1&num=100`))?.songs ?? [];
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

const PLAY_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>`;

// 区块错误/空态：标题 + 说明 + 可选重试
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

// —— 首页：页头 + 双栏领区（今日精选 / 新歌速递）+ 发丝线分隔的推荐网格 ——
// 两个数据源并行、独立降级：任一失败不影响另一块，各自原地给重试。
async function homeView(root: HTMLElement) {
  root.append(h("div", "home-pagehead", `
    <h1 class="page-title">首页</h1>
    <p class="muted">从歌单和新歌开始，开启今日</p>`));

  const lead = h("div", "home-lead");

  const featured = h("section", "home-panel");
  featured.innerHTML = `<div class="sec-head">
    <h2>今日精选</h2><span class="muted">编辑推荐</span>
  </div>`;
  const featureHost = h("div", "home-feature-host", `<div class="muted">加载中…</div>`);
  featured.append(featureHost);

  const newest = h("section", "home-panel");
  const newHead = h("div", "sec-head sec-head--split");
  newHead.innerHTML = `<div class="sec-head__title"><h2>新歌速递</h2><span class="muted">最新发行</span></div>`;
  const playNew = h("button", "ghost-btn", "播放全部") as HTMLButtonElement;
  playNew.type = "button";
  playNew.disabled = true;
  newHead.append(playNew);
  const newRows = h("div", "rows home-new-list", `<div class="muted">加载中…</div>`);
  newest.append(newHead, newRows);

  lead.append(featured, newest);

  const recommendations = h("section", "home-recommendations");
  recommendations.innerHTML = `<div class="sec-head">
    <h2>推荐歌单</h2><span class="muted">为你挑选</span>
  </div>`;
  const grid = h("div", "grid playlist-grid home-cards", `<div class="muted">加载中…</div>`);
  recommendations.append(grid);

  root.append(lead, recommendations);

  const loadPlaylists = async () => {
    featureHost.innerHTML = `<div class="muted">加载中…</div>`;
    grid.innerHTML = `<div class="muted">加载中…</div>`;
    try {
      const list = (await api<RecommendSonglistResp>("/recommend/songlist?page=1&num=13"))?.songlists ?? [];
      const first = list[0];
      if (!first) {
        homeStatus(featureHost, "暂时没有今日精选", "稍后回来，这里会出现新的推荐", loadPlaylists);
        grid.innerHTML = `<div class="muted">暂无推荐歌单</div>`;
        return;
      }

      const id = String(first.id ?? "");
      const title = String(first.title ?? "歌单");
      const href = `#/playlist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(title)}`;
      const listens = compactCount(first.listennum);
      const meta = [
        first.creator_nick ? `${first.creator_nick} 制作` : "",
        first.songnum ? `${first.songnum} 首` : "",
        listens ? `${listens}次播放` : "",
      ].filter(Boolean).join(" · ");
      const feature = h("div", "home-feature");
      feature.innerHTML = `
        <div class="home-feature__art">${first.picurl ? `<img src="${escHtml(upPic(first.picurl))}" alt=""/>` : ""}</div>
        <div class="home-feature__main">
          <p class="home-feature__overline">PLAYLIST</p>
          <h3 class="home-feature__title">${escHtml(title)}</h3>
          ${meta ? `<p class="muted home-feature__meta">${escHtml(meta)}</p>` : ""}
          ${first.desc ? `<p class="home-feature__desc">${escHtml(plainText(first.desc))}</p>` : ""}
          <div class="home-feature__actions"></div>
        </div>`;
      const actions = feature.querySelector<HTMLElement>(".home-feature__actions")!;
      const play = h("button", "ghost-btn", "播放歌单") as HTMLButtonElement;
      play.type = "button";
      play.onclick = () => { void cardPlay("playlist", id, href); };
      const open = h("button", "ghost-btn ghost-btn--quiet", "查看详情") as HTMLButtonElement;
      open.type = "button";
      open.onclick = () => { location.hash = href; };
      actions.append(play, open);
      featureHost.replaceChildren(feature);

      grid.innerHTML = "";
      for (const x of list.slice(1, 13)) {
        const cardId = String(x.id ?? "");
        const cardTitle = String(x.title ?? "歌单");
        const cardHref = `#/playlist?id=${encodeURIComponent(cardId)}&name=${encodeURIComponent(cardTitle)}`;
        const cardListens = compactCount(x.listennum);
        const sub = [x.creator_nick || "", cardListens ? `${cardListens}次播放` : ""].filter(Boolean).join(" · ") || "歌单";
        grid.append(navCard(cardHref, upPic(x.picurl), cardTitle, sub,
          () => cardPlay("playlist", cardId, cardHref)));
      }
      if (!grid.childElementCount) grid.innerHTML = `<div class="muted">暂无更多推荐</div>`;
    } catch (e) {
      homeStatus(featureHost, "推荐加载失败", errText(e) || "网络暂时不可用", loadPlaylists);
      grid.innerHTML = `<div class="muted">重新加载后显示推荐歌单</div>`;
    }
  };

  const loadNewSongs = async () => {
    playNew.disabled = true;
    playNew.onclick = null;
    newRows.innerHTML = `<div class="muted">加载中…</div>`;
    try {
      const songs = ((await api<{ songs?: Song[] }>("/recommend/newsong?type=5"))?.songs ?? []).slice(0, 6);
      if (!songs.length) {
        homeStatus(newRows, "暂时没有新歌", "稍后回来看看", loadNewSongs);
        return;
      }
      playNew.disabled = false;
      playNew.onclick = () => player.playList(songs, 0);
      renderSongRows(newRows, songs, {
        showAlbum: false,
        onPlay: (_song, index, all) => player.playList(all, index),
      });
    } catch (e) {
      homeStatus(newRows, "新歌加载失败", errText(e) || "网络暂时不可用", loadNewSongs);
    }
  };

  await Promise.all([loadPlaylists(), loadNewSongs()]);
}

// —— 歌单页收藏按钮（在线收藏写接口：PlaylistFavWrite Fav/CancelFavPlaylist） ——
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
async function playlistView(root: HTMLElement, q: URLSearchParams) {
  const name = q.get("name") || "歌单";
  const id = q.get("id") || "";
  // 收藏按钮的 favs 订阅退订登记：视图被替换/打断丢弃时由 renderRoute 调用（见 favSonglistButton）
  const cleanups: (() => void)[] = [];
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);
  if (!/^\d+$/.test(id)) { box.innerHTML = `<div class="muted">歌单 id 无效</div>`; return; }

  // 详情缓存命中：首帧直接上屏（整单分页很贵），未命中/过期才整单回源；随后增量窗口对账
  const cached = getCachedSonglist(id);
  let info: SonglistInfo | null = cached?.info ?? null;
  let all: Song[] = cached ? cached.songs : []; // 原序 = 服务端顺序（orderlist），工具条只读它
  // 收藏态与自身音乐号跟歌单详情并行取，信息头渲染时按钮已就绪（不等额外往返）
  const favsReady = Promise.all([getMyMusicid(), loadFavSonglists().catch(() => [])]);
  let detail: SonglistDetail | null = null;
  try {
    detail = await loadSonglistDetail(id); // TTL 内吃缓存（不发请求），过期才分页拉全
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${errText(e)}</div>`;
    return;
  }
  if (detail && detail !== cached) { info = detail.info; all = detail.songs; }
  root.innerHTML = "";

  const logo = upPic(info?.picurl || "");
  const creator = info?.creator?.nick ? `${info.creator.nick} 制作` : "";
  let songCount = Number(info?.songnum ?? all.length) || all.length;
  await favsReady.catch(() => {});
  const head = mountHead(root, {
    artHtml: logo ? `<img src="${logo}" alt=""/>` : "",
    name: info?.title ?? name,
    meta: [creator, `${songCount} 首`].filter(Boolean).join(" · "),
    desc: info?.desc || "",
    actions: await favSonglistButton({
      id,
      title: info?.title ?? name,
      picurl: logo,
      songnum: info?.songnum,
      creatorMusicid: info?.creator?.musicid,
    }, cleanups).catch(() => null),
  });

  const rows = h("div", "rows");
  if (!all.length) {
    root.append(rows);
    rows.innerHTML = `<div class="muted">歌单为空或不可见</div>`;
    return () => cleanups.forEach((f) => f());
  }
  // 工具条（本地搜索 + 排序）：控件靠右，计数在左。实现见 components/ListTools.ts
  // all 恒为服务端原序（orderlist = 加入歌单的时间），工具条只读它，排序作用在副本上。
  const tools = songListTools({
    source: () => all,
    hint: "在歌单内搜索",
    paint: (list) => {
      painted = list; // 记下真正上屏的序列（筛排副本），列表级重画据此去重
      if (!list.length) { rows.innerHTML = `<div class="muted">没有匹配的歌曲</div>`; return; }
      renderSongRows(rows, list, hooksFor());
      player.markActive(); // 重排后当前曲可能换了行位置
    },
  });
  root.append(tools.el, rows);
  // 右键菜单的「从歌单删除」只给自有歌单（写接口要 dirid，读详情用 disstid —— 两者不同源）
  const metaEl = head.querySelector<HTMLElement>(".pl-meta");
  const myId = await getMyMusicid().catch(() => null);
  const own = !!myId && Number(info?.creator?.musicid) === myId && Number(info?.dirid) > 0;

  // —— 打开中的本页跟着数据走（与 likedView 同一套） ——
  let painted: Song[] = []; // 最近一次上屏的序列（筛排后的副本）：列表级重画只在与缓存不一致时发生
  const keyOf = (s: Song) => String(s._key ?? s.mid ?? "");
  const paintMeta = () => {
    if (metaEl) metaEl.textContent = [creator, `${songCount} 首`].filter(Boolean).join(" · ");
  };
  const adopt = (songs: Song[], total?: number) => {
    all = songs;
    if (typeof total === "number" && total > 0) songCount = total;
    paintMeta();
    tools.repaint();
  };
  const dropRow = (song: Song) => {
    const key = keyOf(song);
    const row = key ? rows.querySelector<HTMLElement>(`.row[data-songkey="${CSS.escape(key)}"]`) : null;
    if (row?.classList.contains("leaving")) return; // 已在淡出：别把计数扣两次
    const byKey = (x: Song) => keyOf(x) === key;
    const at = all.findIndex(byKey);
    if (at >= 0) all.splice(at, 1);
    const pat = painted.findIndex(byKey);
    if (pat >= 0) painted.splice(pat, 1);
    if (row) {
      row.classList.add("leaving");
      setTimeout(() => { row.remove(); renumberRows(rows); }, 220);
    }
    if (songCount > 0) songCount--;
    paintMeta();
    tools.refreshCount();
  };
  // 写后增量回源/别处增删（songlist-detail 侧）落定 → 打开中的本页即时跟进。
  // 延一拍再动手：行内删除的淡出在同任务里先落地，多数变更到这里已自洽。
  // 仍不一致时：纯移除逐行淡出补齐，其余整表重画；有行在淡出则先跳过。
  const offFollow = onSonglistChange(id, () => {
    const cur = getCachedSonglist(id);
    if (!cur || sameMids(painted, cur.songs)) return;
    setTimeout(() => {
      const now = getCachedSonglist(id);
      if (!now || sameMids(painted, now.songs) || rows.querySelector(".row.leaving")) return;
      const nowKeys = new Set(now.songs.map(keyOf));
      const paintKeys = new Set(painted.map(keyOf));
      const gone = painted.filter((s) => !nowKeys.has(keyOf(s)));
      const added = [...nowKeys].filter((k) => !paintKeys.has(k));
      if (!added.length && gone.length) { for (const s of gone) dropRow(s); return; }
      adopt(now.songs, now.total);
    }, 0);
  });

  function hooksFor(): RowHooks {
    return {
      showAlbum: true,
      // 双击播的是**当前看到的那一列**（排过序/筛过），不是服务端原序 —— 与眼睛一致
      onPlay: (_s, i, all2) => player.playList(all2, i),
      playlist: {
        dirid: Number(info?.dirid ?? 0),
        tid: Number(info?.id ?? 0),
        title: info?.title ?? name,
        removable: own,
      },
      onRemoved: (song) => {
        // 从原序里也去掉，否则下次重排/筛选会把它放回来（行的淡出由 songs.ts 负责，这里不重画）
        const at = all.indexOf(song);
        if (at >= 0) all.splice(at, 1);
        const pat = painted.indexOf(song); // 上屏序列同步摘掉：跟进逻辑据此判定已自洽，不再触发重画
        if (pat >= 0) painted.splice(pat, 1);
        // 庇护名单 + 增量回源（缓存由它摘行并广播；love-song-reload 同款，防旧读数把删行放回来）
        noteSonglistWrite(id, String(song.mid ?? ""), false, song);
        if (songCount > 0) songCount--;
        if (metaEl) metaEl.textContent = [creator, `${songCount} 首`].filter(Boolean).join(" · ");
        tools.refreshCount();
      },
    };
  }
  tools.repaint();
  // 进页吃的是缓存时顺带一次小窗对账（整单刚回源过就不必再打）；TTL 内不整单重载也能纠漂移
  if (detail === cached) syncSonglistSoon(id);
  cleanups.push(offFollow); // 退订交给视图 cleanup（cleanups 数组，路由切换不留死监听）
  return () => cleanups.forEach((f) => f());
}

// 专辑卡网格（歌手页「专辑」标签 / 歌手全部专辑页共用同一套卡面）
function albumCardsHtml(albums: AlbumBrief[]): string {
  return albums.map((x) => {
    const pm: string = x.pmid || x.mid || "";
    const cover = pm ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pm.split("_")[0]}.jpg` : "";
    const sub = [x.album_type, x.time_public].filter(Boolean).join(" · ");
    return `<a class="card" href="#/album?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(x.name || "专辑")}">
      <div class="art">${cover ? `<img src="${cover}" alt="" loading="lazy"/>` : ""}</div>
      <div class="name">${escHtml(x.name || "专辑")}</div><div class="sub">${escHtml(sub)}</div></a>`;
  }).join("");
}

// —— 歌手页（点击行内歌手跳转的落点）：信息头 + 分类标签（热歌 / 新歌 / 专辑） ——
// 三块内容一次性并拉，标签只决定「显示哪一块」：切换不重新请求、不重置 .route 滚动位置。
// 默认落在「热歌」。信息头仍与歌单/专辑页同一套（左图右文、上对齐）。
const SINGER_TABS = [
  { key: "hot", label: "热歌" },
  { key: "new", label: "新歌" },
  { key: "album", label: "专辑" },
] as const;

async function singerView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  // URLSearchParams.get 已解码过：不要再 decodeURIComponent（名字里带 % 会抛 URIError）
  const name = q.get("name") || "歌手";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { root.querySelector<HTMLElement>(".rows")!.innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
  // 五路并拉（热门/最新两种排序各拉一份）；简介/专辑失败不阻塞主内容（各 .catch 归 null）
  const [homeInfo, detail, songData, newSongData, albumData] = await Promise.all([
    api<SingerInfoResp>(`/singer/${encodeURIComponent(mid)}/info`).catch(() => null),
    api<SingerDescResp>(`/singer/${encodeURIComponent(mid)}/desc`).catch(() => null),
    api<SingerSongsResp>(`/singer/${encodeURIComponent(mid)}/songs?num=50&page=1&order=1`).catch(() => null),
    api<SingerSongsResp>(`/singer/${encodeURIComponent(mid)}/songs?num=30&page=1&order=2`).catch(() => null),
    api<SingerAlbumsResp>(`/singer/${encodeURIComponent(mid)}/albums?num=30`).catch(() => null),
  ]);
  root.innerHTML = "";

  const base = homeInfo?.base_info ?? {};
  const displayName = base.name || detail?.name || name;
  const avatar = upPic(base.avatar || detail?.pic) ||
    `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg`;
  const meta = [
    detail?.foreign_name && detail.foreign_name !== displayName ? detail.foreign_name : "",
    detail?.area, detail?.birthday,
    songData?.total_num ? `歌曲 ${songData.total_num}` : "",
    albumData?.total ? `专辑 ${albumData.total}` : "",
  ].filter(Boolean).join(" · ");
  mountHead(root, {
    artHtml: `<img src="${avatar}" alt=""/>`,
    artRound: true,
    name: displayName,
    meta,
    desc: detail?.desc || "",
  });

  const songs: Song[] = songData?.song_list ?? [];
  const hotKeys = new Set(songs.map((s) => s.mid));
  // 最新发布（order=2 按发行时间倒序）：与热门同列风格，去掉与热门完全重合的条目
  const newSongs: Song[] = (newSongData?.song_list ?? []).filter((s) => !hotKeys.has(s.mid));
  const albums: AlbumBrief[] = albumData?.album_list ?? [];

  // 标签栏 + 面板组：三块常驻 DOM，select() 只切 hidden
  const tabs = h("div", "tag-tabs");
  tabs.innerHTML = SINGER_TABS.map(
    (t) => `<button class="tag" type="button" data-tab="${t.key}">${t.label}</button>`,
  ).join("");
  const body = h("div", "tag-body");
  root.append(tabs, body);

  const songPanel = (list: Song[], empty: string) => {
    const p = h("div", "tag-panel");
    if (!list.length) { p.innerHTML = `<div class="rows muted">${empty}</div>`; return p; }
    const rows = h("div", "rows");
    p.append(rows);
    renderSongRows(rows, list, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
    return p;
  };

  const hotPanel = songPanel(songs, "没有取到热门歌曲");
  const newPanel = songPanel(newSongs, "暂无新歌");
  const albumPanel = h("div", "tag-panel");
  if (albums.length) {
    const more = h("div", "sec-row");
    more.style.marginTop = "0";
    more.innerHTML = `<span class="muted">共 ${albumData?.total ?? albums.length} 张</span>
      <a class="sec-more" href="#/singer-albums?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(displayName)}">查看全部 ›</a>`;
    const grid = h("div", "grid");
    grid.innerHTML = albumCardsHtml(albums);
    albumPanel.append(more, grid);
  } else {
    albumPanel.innerHTML = `<div class="rows muted">暂无专辑</div>`;
  }
  const panels = [hotPanel, newPanel, albumPanel];
  body.append(...panels);

  const select = (key: string) => {
    panels.forEach((p, i) => (p.hidden = SINGER_TABS[i].key !== key));
    tabs.querySelectorAll<HTMLElement>(".tag").forEach((b) => b.classList.toggle("sel", b.dataset.tab === key));
  };
  // 切换动画门闩（.tab-anim 见 style.css）：首次点击才挂上，首屏入场交给 .route>.entering；
  // 重复点当前标签直接返回，否则会把已显示的面板重播一次、看着像闪了一下。
  tabs.querySelectorAll<HTMLElement>(".tag").forEach((b) => (b.onclick = () => {
    if (b.classList.contains("sel")) return;
    body.classList.add("tab-anim");
    select(b.dataset.tab!);
  }));
  select("hot");
}

// —— 歌手全部专辑页：信息头复用歌手页样式 + 全部分页拉取专辑网格 ——
async function singerAlbumsView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  const name = q.get("name") || "歌手";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { root.querySelector<HTMLElement>(".rows")!.innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
  // 分页拉全：上游单页封顶 30（num 再大也只回 30），循环条件按 total + 空批兜底
  const albums: AlbumBrief[] = [];
  let total = 0;
  try {
    for (let page = 1; ; page++) {
      const d = (await api<SingerAlbumsResp>(`/singer/${encodeURIComponent(mid)}/albums?num=30&page=${page}`)) ?? {};
      const batch = d.album_list ?? [];
      albums.push(...batch);
      total = d.total ?? 0;
      if (!batch.length || albums.length >= total) break;
    }
  } catch (e) {
    if (!albums.length) { root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${errText(e)}`)); return; }
  }
  root.innerHTML = "";
  const avatar = `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg`;
  mountHead(root, {
    artHtml: `<img src="${avatar}" alt=""/>`,
    artRound: true,
    name: `${name}的专辑`,
    meta: total ? `共 ${total} 张` : "",
    desc: "",
  });
  if (!albums.length) { root.append(h("div", "rows muted", "暂无专辑")); return; }
  const grid = h("div", "grid");
  grid.innerHTML = albumCardsHtml(albums);
  root.append(grid);
}

// —— 专辑页（点击行内专辑跳转的落点）：detail + songs 两个端点 ——
async function albumView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { root.querySelector<HTMLElement>(".rows")!.innerHTML = `<div class="muted">缺少专辑 mid</div>`; return; }
  try {
    const [detail, list] = await Promise.all([
      api<AlbumDetailResp>(`/album/${encodeURIComponent(mid)}/detail`).catch(() => null),
      api<AlbumSongsResp>(`/album/${encodeURIComponent(mid)}/songs?num=100`),
    ]);
    const alb = detail?.album ?? {};
    const songs: Song[] = list?.song_list ?? [];
    root.innerHTML = "";
    const picMid = alb.pmid || alb.mid || mid;
    const singers: string = (alb.singer?.length ? alb.singer : detail?.singers ?? []).map((x) => x.name ?? "").join(" / ");
    const metaParts = [
      singers,
      alb.time_public,
      list?.total_num ? `${list.total_num} 首` : "",
    ].filter(Boolean);
    mountHead(root, {
      artHtml: picMid ? `<img src="https://y.gtimg.cn/music/photo_new/T002R300x300M000${picMid.split("_")[0]}.jpg" alt=""/>` : "",
      name: alb.name ?? "专辑",
      meta: metaParts.join(" · "),
      desc: alb.desc || "",
    });
    const box = h("div", "rows");
    root.append(box);
    if (!songs.length) { box.innerHTML = `<div class="muted">没有取到歌曲</div>`; return; }
    renderSongRows(box, songs, { showArtist: true, showAlbum: false, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e) {
    root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${errText(e)}`));
  }
}

// —— 列表页公共壳 ——
function listPage(root: HTMLElement, title: string, note?: string) {
  root.append(h("h1", "page-title", title));
  if (note) root.append(h("p", "muted page-note", note));
  const rows = h("div", "rows", `<div class="muted">加载中…</div>`);
  rows.id = "rows";
  root.append(rows);
  return rows;
}

/**
 * 猜你喜欢：上游 `get_radio_track` **一次只给 5 首**（num 加大被忽略、回灌 song_ids 续拿报 22006），
 * 好在每轮内容随机 —— 所以后端靠「串行多调几轮 + 按 mid 去重」凑量（并发会被上游 700000 拒）。
 * 代价是**轮数 × 单轮耗时 ≈ 6s**：一口气等完就是 6 秒白屏。这里分两段取：
 *   ① rounds=2（10 首，~2.4s）立刻出画面；② 再 rounds=4 补齐到 ~30 首后重画。
 * 「换一批」走同一条链路：上游池子很大（实测 6 轮 30 首**零重复**），所以两批之间基本撞不上，
 * 不需要把上一批的 mid 排除掉 —— 何况上游也不吃排除参数（`song_ids` 续拿就是 22006）。
 * 取新批次**先攒在临时数组里、成了才整体换上**：换批失败时手上这批还在，不会一片空白。
 */
async function guessView(root: HTMLElement) {
  const box = listPage(root, "猜你喜欢", "你的品味，懂你意思");
  // 换一批：页头下方、右侧对齐（与列表工具条同一版式语言）
  const bar = h("div", "guess-bar");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost-btn ghost-btn--quiet";
  btn.textContent = "换一批";
  bar.append(btn);
  root.insertBefore(bar, box);

  let songs: Song[] = [];
  let busy = false;

  const paint = () => {
    if (!songs.length) { box.innerHTML = `<div class="muted">暂无推荐，登录后可得</div>`; return; }
    // 双击播的是**当前看到的这一列**（补齐后列表会变长，指针以重画后的为准）
    renderSongRows(box, songs, { onPlay: (s, i, all) => player.playList(all, i) });
    player.markActive(); // 重画后当前曲可能换了行位置
  };

  async function load() {
    if (busy) return;               // 按钮已禁用；这里防的是键盘/程序重复触发
    busy = true;
    btn.disabled = true;
    btn.textContent = "取歌中…";
    const fresh: Song[] = [];       // 先攒在临时数组：失败时手上这批不动
    const seen = new Set<string>();
    const take = (more: Song[]) => {
      for (const s of more ?? []) {
        const k = String(s?.mid ?? "");
        if (!k || seen.has(k)) continue; // 多轮之间会撞歌
        seen.add(k);
        fresh.push(s);
      }
    };
    try {
      take((await api<{ songs?: Song[] }>("/recommend/guess?rounds=2"))?.songs ?? []);
      if (fresh.length) { songs = fresh; paint(); }  // 首批立刻换上画面
      take((await api<{ songs?: Song[] }>("/recommend/guess?rounds=4"))?.songs ?? []);
      if (fresh.length) { songs = fresh; paint(); }  // 补齐（同一个引用随之变长）
      else if (!songs.length) paint();               // 一首都没拿到 → 空态
    } catch (e) {
      // 第二批失败不算失败：保住首批（上游这条链路偶发节流，宁可少几首也别整页报错）
      if (!songs.length) box.innerHTML = `<div class="muted">${errText(e)}</div>`;
      else toast("换一批没成功，先留着当前这批", "err");
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = "换一批";
    }
  }

  btn.addEventListener("click", () => void load());
  await load();
}

async function dailyView(root: HTMLElement) {
  // 真的「每日30首」：它是**系统虚拟歌单**（dirid 固定 202，与「我喜欢」201 同一族），
  // 每天由服务端重生成 30 首，disstid 每天都变 —— 所以后端按 dirid 取（见 /recommend/daily），
  // 前端只管拿详情，结构与普通歌单完全一致（info/songs/total/hasmore）。
  // 以前这页是假的：拿「我喜欢」按日期种子随机凑 30 首（官方接口未开放时的占位），现已接真接口。
  const box = listPage(root, "每日 30 首", "QQ 音乐「每日30首」：每天按你的口味重算 30 首");
  const note = root.querySelector<HTMLElement>(".page-note");
  try {
    const d = (await api<DailyResp>("/recommend/daily?page=1&num=100")) ?? {}; // 30 首一把拿全，不用翻页
    const songs: Song[] = d.songs ?? [];
    // 服务端那句编辑语（「甄选私人好品味：今日份的 X、Y、Z…」）比我们自己编的说明好看
    if (note && d.info?.desc) note.textContent = d.info.desc;
    if (!songs.length) {
      box.innerHTML = `<div class="muted">今天的 30 首还没生成，稍后再来（也确认下是否已登录）</div>`;
      return;
    }
    box.innerHTML = "";
    renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e) {
    box.innerHTML = `<div class="muted">${errText(e)} — 需要先登录</div>`;
  }
}

/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */
const sameMids = (a: Song[], b: Song[]) => a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);

async function likedView(root: HTMLElement) {
  root.append(h("h1", "page-title", "我喜欢 "));
  const cnt = h("span", "muted cnt");
  root.querySelector("h1")!.append(cnt);
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);

  let items: Song[] = []; // 原序 = 收藏顺序（服务端返回的顺序），工具条只读它
  let painted: Song[] = []; // 最近一次上屏的序列（筛排后的副本）：列表级重画只在与缓存不一致时发生
  let shown = 0; // 标题计数（服务端 total 优先：超预载上限时也报真实总数）
  const setCount = (n: number) => { shown = Math.max(0, n); cnt.textContent = shown ? `· ${shown} 首` : ""; };
  const keyOf = (s: Song) => String(s._key ?? s.mid ?? "");
  // 取消收藏：行淡出后移出本页 + 计数 -1。只在写接口确认后调用——失败已在 player 侧回滚，不会触发
  const dropRow = (song: Song) => {
    const key = keyOf(song);
    const row = key ? box.querySelector<HTMLElement>(`.row[data-songkey="${CSS.escape(key)}"]`) : null;
    if (row?.classList.contains("leaving")) return; // 已在淡出：别把计数扣两次
    // 从原序与上屏序列里都摘掉：player.likedCache 是**换新数组**（filter），这里的 items/painted
    // 还指着旧数组，不摘的话下次重排/筛选会把这行放回来（或触发一次无谓的整表重画）。
    const byKey = (x: Song) => keyOf(x) === key;
    const at = items.findIndex(byKey);
    if (at >= 0) items.splice(at, 1);
    const pat = painted.findIndex(byKey);
    if (pat >= 0) painted.splice(pat, 1);
    if (row) {
      row.classList.add("leaving");
      setTimeout(() => { row.remove(); renumberRows(box); }, 220);
    }
    setCount(shown - 1);
    tools.refreshCount();
  };

  // 工具条（本地搜索 + 排序；与歌单页共用 components/ListTools.ts）
  const tools = songListTools({
    source: () => items,
    hint: "在我喜欢内搜索",
    paint: (songs, st) => {
      painted = songs; // 记下真正上屏的序列（筛排副本），列表级重画据此去重
      if (!songs.length) {
        box.innerHTML = `<div class="muted">${st.filtering ? "没有匹配的歌曲" : "还没有收藏的歌曲"}</div>`;
        return;
      }
      setCount(Math.max(items.length, player.likedTotal));
      renderSongRows(box, songs, {
        onPlay: (_s, i, all) => player.playList(all, i),
        onLove: (song, on) => { if (!on) dropRow(song); }, // 取消红心 = 取消单曲收藏 + 移出本页
      });
      player.markActive(); // 重排后当前曲可能换了行位置
    },
  });
  root.append(tools.el, box);
  const adopt = (songs: Song[]) => { items = songs; tools.repaint(); };

  // 写后增量回源/别处收藏（player 侧）落定 → 打开中的本页即时跟进。
  // 延一拍再动手：行内取消红心的 dropRow（含淡出）在同任务里先落地，多数变更到这里已自洽。
  // 仍不一致时：纯移除逐行淡出补齐（兜住播放条等别处的取消），其余整表重画；有行在淡出则先跳过。
  const offList = player.onLovedListChange(() => {
    const cur = player.likedCache;
    if (!cur || sameMids(painted, cur)) return;
    setTimeout(() => {
      const now = player.likedCache;
      if (!now || sameMids(painted, now) || box.querySelector(".row.leaving")) return;
      const nowKeys = new Set(now.map(keyOf));
      const paintKeys = new Set(painted.map(keyOf));
      const gone = painted.filter((s) => !nowKeys.has(keyOf(s)));
      const added = [...nowKeys].filter((k) => !paintKeys.has(k));
      if (!added.length && gone.length) { for (const s of gone) dropRow(s); return; }
      adopt(now);
    }, 0);
  });

  // 预载命中（开机已拉回）：首帧直接出，红心默认全部点亮；随后按 TTL 后台对账，内容变了才重画
  const cached = player.likedCache;
  if (cached) adopt(cached);
  const ok = await player.loadLoved();
  if (!ok) {
    offList();
    if (!cached) {
      tools.el.remove(); // 拉不到就别摆一排没用的控件
      box.innerHTML = `<div class="muted">加载失败 — 需要先登录</div>`;
    }
    return;
  }
  const fresh: Song[] = player.likedCache ?? [];
  if (!sameMids(painted, fresh)) adopt(fresh);
  player.syncLovedSoon(); // 进页顺带一次小窗对账：TTL 内不整单重载也能纠漂移
  return () => offList();
}

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
async function settingsView(root: HTMLElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const fontOptions = Object.entries(FONT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")
    + `<option value="${FONT_CUSTOM}">个性化</option>`;
  const decodeRow = (name: string, label: string, disabled = false) =>
    `<label><input type="radio" name="decode" value="${name}"${disabled ? " disabled" : ""}/>${label}${disabled ? ` <span class="muted soon">敬请期待</span>` : ""}</label>`;

  root.append(h("h1", "page-title", "设置"));
  // 分区标签：只切显隐，不重渲染（各面板绑定一次常驻有效）
  const tabs = h("div", "set-tabs", `
    <button class="set-tab is-active" data-tab="appearance" type="button">外观</button>
    <button class="set-tab" data-tab="playback" type="button">播放</button>
    <button class="set-tab" data-tab="hotkeys" type="button">热键</button>
    <button class="set-tab" data-tab="general" type="button">通用</button>
    <button class="set-tab" data-tab="plugins" type="button">Sparkle</button>`);
  root.append(tabs);
  const wrap = h("div", "set-view");
  wrap.innerHTML = `
    <section class="set-panel" data-panel="appearance">
      <div class="set-group">
        <div class="set-label">外观模式</div>
        <div class="opt-cards" id="theme-cards">
          <button class="opt-card" data-opt="system" type="button"><span class="sw sw-system"></span>跟随系统</button>
          <button class="opt-card" data-opt="light" type="button"><span class="sw sw-light"></span>明镜白</button>
          <button class="opt-card" data-opt="dark" type="button"><span class="sw sw-dark"></span>玄幻黑</button>
        </div>
      </div>

      <!-- 背景（默认主题的环境色层）：三档 + 自定义图片 + 模糊强度，绑定见下方 paintBg* -->
      <div class="set-group">
        <div class="set-label">背景 <span class="set-note-inline">默认主题的环境色层；插件主题自带背景时不受此项影响</span></div>
        <div class="opt-cards" id="bg-cards">
          <button class="opt-card" data-opt="off" type="button">关闭背景</button>
          <button class="opt-card" data-opt="cover" type="button">专辑封面</button>
          <button class="opt-card" data-opt="custom" type="button">自定义图片</button>
          <!-- 「选择图片…」紧挨着「自定义图片」：只在选中它时才出现（paintBgMode 控 hidden），
               虚边框 + 次级文字色 = 它是动作不是第四个档位 -->
          <button class="opt-card action" id="bg-pick" type="button" hidden>选择图片…</button>
          <span class="bg-file" id="bg-file" hidden></span>
        </div>
        <div class="set-row" id="bg-blur-row">
          <span class="set-row__label">模糊强度</span>
          <div class="set-row__ctrl">
            <input class="set-blur" id="bg-blur" type="range" min="${BG_BLUR_MIN}" max="${BG_BLUR_MAX}" step="5"
              aria-label="背景模糊强度" />
            <span class="bg-blur-val" id="bg-blur-val"></span>
          </div>
        </div>
        <p class="muted set-hint" id="bg-hint"></p>
      </div>

      <!-- 高亮颜色（tint）：三档来源 + 自定义色的颜色选择器（HSL / CMYK / RGB + HEX），
           绑定见下方 paintTint* 那一段 -->
      <div class="set-group">
        <div class="set-label">高亮颜色 <span class="set-note-inline">进度条 / 选中态 / 激活描边用的强调色系</span></div>
        <div class="opt-cards" id="tint-cards">
          <button class="opt-card" data-opt="default" type="button">青色（默认）</button>
          <button class="opt-card" data-opt="cover" type="button">跟随封面</button>
          <button class="opt-card" data-opt="system" type="button"><span class="sw sw-accent"></span>系统强调色</button>
          <div class="tint-slot" id="tint-slot">
            <button class="opt-card" data-opt="custom" type="button">自定义颜色</button>
            <!-- 当前自定义色的色块：动作按钮样式（虚边框）+ 点它展开/收起旁边的选择器；只在自定义档出现 -->
            <button class="opt-card action tint-chip" id="tint-chip" type="button" hidden
              aria-label="展开或收起颜色选择器" aria-expanded="false"></button>
            <div class="tint-pop" id="tint-pop" hidden>
              <div class="tint-pop__head">
                <span class="tint-pop__title">颜色选择器</span>
                <button class="tint-pop__fold" id="tint-fold" type="button">收起</button>
              </div>
              <div class="tint-preview">
                <span class="tint-preview__sw" id="tint-swatch"></span>
                <code class="tint-preview__hex" id="tint-code"></code>
              </div>
              <input class="tint-hue" id="tint-hue" type="range" min="0" max="359" step="1" aria-label="色相" />
              <div class="tint-modes" id="tint-modes" role="tablist">
                <button class="tint-mode" data-mode="hsl" type="button" role="tab">HSL</button>
                <button class="tint-mode" data-mode="cmyk" type="button" role="tab">CMYK</button>
                <button class="tint-mode" data-mode="rgb" type="button" role="tab">RGB</button>
              </div>
              <div class="tint-fields" id="tint-fields"></div>
              <div class="tint-hex-row">
                <span class="tint-field__label">HEX</span>
                <input id="tint-hex" type="text" spellcheck="false" autocomplete="off" maxlength="7"
                  placeholder="#19c2d8" aria-label="颜色十六进制值" />
              </div>
            </div>
          </div>
        </div>
        <!-- 主题自带的高亮方案（SDK: SparkleTheme.tint.mode="presets"）动态填充；
             主题接管高亮色（tint 缺省）时这组与上面的三档都不出现，只留一行说明 -->
        <div class="opt-cards" id="tint-spark-cards" hidden></div>
        <p class="muted set-hint" id="tint-hint"></p>
      </div>

      <!-- 浮层菜单的毛玻璃：一棵总开关（右键菜单 / 音质·播放模式·音量浮窗 / 正在播放页 ⋮ /
           音频流信息浮窗），绑定见下方 paintMenuGlass*。令牌与七处消费点全在 style.css 顶部。 -->
      <div class="set-group">
        <div class="set-label">菜单毛玻璃 <span class="set-note-inline">右键菜单 / 音质与播放模式浮窗 / 正在播放页「更多操作」</span></div>
        <div class="opt-cards" id="menu-glass-cards">
          <button class="opt-card" data-opt="on" type="button">开启</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint" id="menu-glass-hint"></p>
      </div>

      <!-- Sparkle 主题：卡片由下方 renderSparkleThemes 动态填充（无插件主题时整组隐藏） -->
      <div class="set-group" id="sparkle-theme-group" hidden>
        <div class="set-label">Sparkle 主题 <span class="set-note-inline">来自插件；覆盖在上方模式之上，未覆盖的变量跟随明暗</span></div>
        <div class="opt-cards" id="sparkle-theme-cards"></div>
      </div>

      <div class="set-group">
        <div class="set-label">窗口装饰模式 <span class="set-note-inline">点击切换后立即重启</span></div>
        <div class="opt-cards" id="decor-cards">
          <button class="opt-card" data-opt="csd" type="button">使用 Quaver Design</button>
          <button class="opt-card" data-opt="ssd" type="button">使用系统原生标题栏</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">关闭按钮行为 <span class="set-note-inline"></span></div>
        <div class="opt-cards" id="close-cards">
          <button class="opt-card" data-opt="tray" type="button">缩回托盘</button>
          <button class="opt-card" data-opt="quit" type="button">退出</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">字体设置</div>
        <div class="set-row"><span class="set-row__label">界面字体</span>
          <div class="set-row__ctrl font-row">
            <select id="font-ui" aria-label="界面字体预设">${fontOptions}</select>
            <input id="font-ui-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="字体家族列表"
              placeholder="留空代表使用默认字体" />
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">歌词字体</span>
          <div class="set-row__ctrl font-row">
            <select id="font-lyric" aria-label="歌词字体预设">${fontOptions}</select>
            <input id="font-lyric-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="字体家族列表"
              placeholder="留空代表使用默认字体" />
          </div>
        </div>
        <p class="muted set-hint">按优先级排序，使用半角逗号排序</p>
      </div>

    </section>

    <section class="set-panel" data-panel="playback" hidden>
      <div class="set-group" id="backend-device"${isMac ? " hidden" : ""}>
        <div class="set-label">音频设备</div>
        <div class="set-row"><span class="set-row__label">输出设备</span>
          <div class="set-row__ctrl"><select id="audio-backend" disabled><option>系统默认</option></select></div>
        </div>
        <p class="muted set-hint" id="audio-device-hint">原生播放引擎下，</p>
      </div>

      <div class="set-group">
        <div class="set-label">播放引擎 <span class="set-note-inline" id="engine-note">- 默认 MPV，可选浏览器</span></div>
        <div class="opt-radios" id="decode-radios">
          ${decodeRow("MPV", "原生引擎")}${decodeRow("Blink", "浏览器")}
        </div>
        <p class="muted set-hint" id="engine-hint">原生引擎基于 MPV 实现，可带来无与伦比的视听体验；浏览器：使用渲染层播放，仅用于 Fallback 使用</p>
      </div>

      <div class="set-group">
        <div class="set-label">淡入淡出 <span class="set-note-inline">仅原生引擎生效</span></div>
        <div class="opt-cards" id="fade-cards">
          <button class="opt-card" data-opt="off" type="button">0s</button>
          <button class="opt-card" data-opt="short" type="button">0.15s</button>
          <button class="opt-card" data-opt="normal" type="button">0.4s</button>
          <button class="opt-card" data-opt="long" type="button">0.8s</button>
        </div>
        <!-- <p class="muted set-hint">起播从静音升到当前音量；暂停 / 切歌 / 停止时先降下来再停（切歌时淡出与下一首的淡入自然衔接）。浏览器 &lt;audio&gt; 后端不生效。</p> -->
      </div>

      <div class="set-group">
        <div class="set-label">上一首按钮行为</div>
        <div class="opt-cards" id="prev-behavior-cards">
          <button class="opt-card" data-opt="replay" type="button">重放当前曲</button>
          <button class="opt-card" data-opt="previous" type="button">跳到上一首</button>
        </div>
        <p class="muted set-hint">「重放当前曲」：单击把当前曲从头再放、双击跳到队列里的上一首（默认）；「跳到上一首」：单击直接切到队列里的上一首（连按逐首回退）。即时生效；媒体键/热键同逻辑，快速连按两次等同双击。</p>
      </div>

      <div class="set-group">
        <div class="set-label">播放音频时睡眠禁止 <span class="set-note-inline">默认开启</span></div>
        <div class="opt-cards" id="inhibit-sleep-cards">
          <button class="opt-card" data-opt="on" type="button">开启</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint">播放音频期间阻止系统进入睡眠/待机；屏幕的熄灭与锁屏照常生效，暂停或停止即恢复原睡眠策略。</p>
      </div>

      <div class="set-group">
        <div class="set-label">默认音质 <span class="set-note-inline" id="q-member-note"></span></div>
        <div class="opt-cards" id="quality-grid">
          <button class="opt-card q" data-q="auto" type="button">自动</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">是否启用回退臻品全景声<span class="set-note-inline">臻品全景声可能会影响部分歌曲视听体验，故默认关闭</span></div>
        <div class="opt-cards" id="atmos-fallback-cards">
          <button class="opt-card" data-opt="no-atmos" type="button">关闭</button>
          <button class="opt-card" data-opt="rank" type="button">开启</button>
        </div>
        <p class="muted set-hint">自动优先「臻品母带」，若音源无该音质则跳过「臻品全景声」；「开启」则保留全景声模式。</p>
        <p class="muted set-hint">仅限 QQ 音乐超级会员生效。</p>
      </div>
    </section>
    <!-- 热键面板：内容由 ui/src/components/HotkeySettings.ts 填充（全局/焦点内两组绑定） -->
    <section class="set-panel" data-panel="hotkeys" hidden></section>
    <section class="set-panel" data-panel="general" hidden>
      <div class="set-group">
        <div class="set-label">应用更新 <span class="set-note-inline">更新前会先提醒并展示更新日志</span></div>
        <div class="opt-cards" id="upd-auto-cards">
          <button class="opt-card" data-opt="on" type="button">自动检查</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint">启动后自动检查新版本（默认开启）；发现更新先弹窗展示 GitHub 更新日志，经你确认才开始下载安装，绝不静默更新。关闭后仍可在此手动检查。</p>
      </div>

      <div class="set-group">
        <div class="set-label">更新渠道</div>
        <div class="opt-cards" id="upd-channel-cards">
          <button class="opt-card" data-opt="stable" type="button">Stable</button>
          <button class="opt-card" data-opt="nightly" type="button">Nightly</button>
        </div>
        <p class="muted set-hint">Stable：正式发布版；Nightly：main 分支的每夜滚动构建，功能更新但可能不稳定。两个渠道可以互相切换：选完会自动检查一次，即使版本号相同也会提示换上对应渠道的构建。</p>
        <p class="muted set-hint" id="upd-channel-note"></p>
        <div class="set-debug">
          <button class="ghost-btn" id="check-update" type="button">检查更新</button>
          <span class="muted set-hint" id="upd-status"></span>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">配置文件</div>
        <p class="muted set-hint">以下设置全部持久化在系统标准配置目录的 <code>quaver.conf</code>里，可自定义</p>
        <div class="set-row"><span class="set-row__label">路径</span>
          <div class="set-row__ctrl"><input id="conf-path" readonly /></div>
        </div>
        <div class="set-debug">
          <button class="ghost-btn" id="open-conf" type="button">在文件管理器中显示</button>
          <button class="ghost-btn" id="reset-conf" type="button">恢复默认设置</button>
        </div>
        <p class="muted set-hint" id="conf-hint"></p>
      </div>

      <div class="set-group">
        <div class="set-label">调试</div>
        <div class="set-debug"><button class="ghost-btn" id="open-log" type="button">打开日志页面</button></div>
      </div>

      <div class="set-group set-about">
        <div class="about-img"><img class="ic-dark" src="/quaver-icon-dark.svg" width=60 alt="Quaver Icon"><img class="ic-light" src="/quaver-icon.svg" width=60 alt="Quaver Icon">
        <h3> Quaver Music </h3>
        <h4> 现代、流畅、百变的第三方 QQ 音乐客户端，基于 Electron + Vite + Golang </h4>
        <small> Version: ${__APP_VERSION__} </small>
      </div>
    </section>
    
    <!-- Sparkle 面板：内容由 ui/src/sparkle/settings.ts 填充（插件列表/插件设置区/Marketplace） -->
    <section class="set-panel" data-panel="plugins" hidden></section>`;

  root.append(wrap);

  // 与歌手页同一套切换动画（.set-view.tab-anim > .set-panel，见 style.css）：门闩首次点击才挂，
  // 首屏交给 .route.entering；重复点当前标签直接返回，避免重播。
  tabs.querySelectorAll<HTMLButtonElement>(".set-tab").forEach((t) => {
    t.onclick = () => {
      if (t.classList.contains("is-active")) return;
      wrap.classList.add("tab-anim");
      tabs.querySelectorAll(".set-tab").forEach((x) => x.classList.toggle("is-active", x === t));
      wrap.querySelectorAll<HTMLElement>(".set-panel").forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    };
  });

  // preset 是「Sparkle 主题自带的高亮方案」那组（见 #tint-spark-cards）
  const syncSel = (box: HTMLElement, attr: "opt" | "q" | "preset", active: string) =>
    box.querySelectorAll<HTMLElement>("[data-" + attr + "]").forEach((b) => b.classList.toggle("sel", b.dataset[attr] === active));

  /** 通用「卡片选项组」绑定：点击写偏好 + 原地同步选中态（外观/装饰/关闭行为/Fallback/淡入淡出共用） */
  function bindOptCards<K extends string>(box: HTMLElement, get: () => K, set: (v: K) => void) {
    const sync = () => syncSel(box, "opt", get());
    box.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
      b.onclick = () => { set(b.dataset.opt as K); sync(); };
    });
    sync();
  }

  // 外观模式：跟随系统 / 明镜白 / 玄幻黑（prefs 写 html[data-theme]，style.css 响应）
  bindOptCards<ThemeMode>(wrap.querySelector<HTMLElement>("#theme-cards")!, getTheme, setTheme);

  // —— 背景（默认主题的环境色层）：关闭背景 / 专辑封面 / 自定义图片 + 模糊强度 ——
  // 选图走主进程的原生对话框（路径落进 quaver.conf，图片本体由同源 /api/bg 端点交给界面，
  // 见 lib/ambient.ts）；浏览器 dev 下没有这个桥，只能看不能换。
  const BG_HINT = "关闭背景（默认）：只留主题底色；专辑封面：当前曲封面模糊铺底；自定义图片：用你自己的图，建议把模糊强度调小。";
  const bgCards = wrap.querySelector<HTMLElement>("#bg-cards")!;
  const bgFile = wrap.querySelector<HTMLElement>("#bg-file")!;
  const bgPick = wrap.querySelector<HTMLButtonElement>("#bg-pick")!;
  const bgBlur = wrap.querySelector<HTMLInputElement>("#bg-blur")!;
  const bgBlurVal = wrap.querySelector<HTMLElement>("#bg-blur-val")!;
  const bgHint = wrap.querySelector<HTMLElement>("#bg-hint")!;
  const bgBridge = window.quaverBackground;
  /** 当前激活的 Sparkle 主题（含它的 background 声明）；没启用主题 / 主题已消失 = null。 */
  const bgPolicy = () => backgroundPolicyOf(sparkleActiveTheme());

  const paintBlur = () => {
    const px = getBackgroundBlur();
    bgBlur.value = String(px);
    // 已滑过的一段染色：值换算成百分比写 --v（与播放条音量滑块同一口径）
    bgBlur.style.setProperty("--v", `${Math.round(((px - BG_BLUR_MIN) / (BG_BLUR_MAX - BG_BLUR_MIN)) * 100)}%`);
    bgBlurVal.textContent = px === 0 ? "不模糊" : `${px}px`;
  };
  /** 图片一行：文件名 + 文件还在不在（被挪走/删掉要提示重选，不静默当没事）。 */
  const paintBgFile = (info?: { path?: string; exists?: boolean; error?: string }) => {
    const path = info?.path ?? getBackgroundImage();
    if (!path) { bgFile.textContent = "尚未选择图片"; bgFile.title = ""; bgFile.classList.remove("bad"); return; }
    const name = path.split(/[\\/]/).pop() || path;
    const bad = info?.exists === false;
    bgFile.textContent = bad ? `${name}（${info?.error ?? "不可用"}）` : name;
    bgFile.title = path; // 完整路径挂 title：行内只放文件名，长路径不撑破布局
    bgFile.classList.toggle("bad", bad);
  };
  const paintBgMode = () => {
    const mode = getBackgroundMode();
    const locked = bgPolicy().mode === "off"; // 主题接管背景：这一组整体不可调（见 paintBgPolicy）
    syncSel(bgCards, "opt", mode);
    // 「选择图片…」与文件名只在自定义档出现（就在那张卡片旁边）：不占别的档位的版面；
    // 主题接管时也不给换图/换文件
    const isCustom = mode === "custom" && !locked;
    bgPick.hidden = !isCustom;
    bgFile.hidden = !isCustom;
    bgBlur.disabled = locked || mode === "off"; // 背景都关了（或不由宿主管），模糊强度无从谈起
  };
  /** 原生选图：成功（路径已落盘 + 界面重画）返回 true；取消/失败返回 false。 */
  const pickBgImage = async (): Promise<boolean> => {
    if (!bgBridge?.pick) return false;
    bgPick.disabled = true;
    try {
      const r = await bgBridge.pick();
      if (!r?.ok) { paintBgFile({ path: getBackgroundImage(), exists: false, error: r?.error ?? "选择失败" }); return false; }
      if (r.canceled) return false;
      // 主进程已经写盘；这里同步渲染层的内存快照（值相同，落盘侧是一次幂等重写）
      setBackgroundImage(r.path ?? "");
      applyBackground();
      paintBgFile({ path: getBackgroundImage(), exists: true });
      return true;
    } catch (e) {
      paintBgFile({ path: getBackgroundImage(), exists: false, error: errText(e) });
      return false;
    } finally {
      bgPick.disabled = false;
    }
  };

  bgCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = async () => {
      const next = b.dataset.opt as BackgroundMode;
      // 选「自定义」但还没有图：这一档点下去的意图就是去选图，直接弹对话框；
      // 取消就停在原来的档位（不切到一个「自定义但没有图」的空状态）
      if (next === "custom" && !getBackgroundImage() && !(await pickBgImage())) { paintBgMode(); return; }
      setBackgroundMode(next);
      applyBackground();
      paintBgMode();
    };
  });
  bgPick.onclick = async () => {
    if (!(await pickBgImage())) return;
    setBackgroundMode("custom"); // 「选择图片」本身就意味着要用这张图 → 顺手切到自定义档
    applyBackground();
    paintBgMode();
  };
  bgBlur.addEventListener("input", () => {
    setBackgroundBlur(Number(bgBlur.value));
    paintBlur();
    applyBackground();
  });

  /** 组内说明（没被主题接管时的那份；接管时换成让位说明）。 */
  const bgHintBase = bgBridge?.pick ? BG_HINT : `${BG_HINT} 浏览器里没法选本地图片，请在桌面端设置。`;
  /** 整组的主刷新：主题接管背景时三档留在原位但禁用并写明原因（整组消失会让人找不到）。
   *  面板初次挂载 / 切换主题 / 插件启停都要重跑一遍。 */
  const paintBgPolicy = () => {
    const locked = bgPolicy().mode === "off";
    bgCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    bgHint.textContent = locked
      ? `当前 Sparkle 主题「${sparkleActiveTheme()?.name ?? ""}」自带背景，已接管；切到「默认」主题，或让主题声明 background 才可调。`
      : bgHintBase;
    paintBgMode(); // 顺带把按钮显隐与滑块可用性收口（那里也要叠加 locked）
  };

  paintBlur();
  paintBgPolicy();
  paintBgFile();
  // 文件还在不在要问主进程（渲染层看不到磁盘）：不在就提示重选
  if (bgBridge?.info) void bgBridge.info().then((r) => { if (r?.ok) paintBgFile(r); }).catch(() => {});

  // —— 高亮颜色（tint）：三档来源 + 自定义色的颜色选择器（HSL / CMYK / RGB + HEX） ——
  // 颜色真相只有一个 RGB：三个模式与 HEX 都只是它的不同表示，表示之间的换算走 lib/color.ts 的
  // 纯函数。落盘的永远是 HEX（prefs.setTintColor），样式侧由 lib/tint.ts 写 --cvg-accent/--cvg-glow。
  const TINT_HINT = "青色：固定强调色，不随歌曲变化（默认）；跟随封面：取当前曲封面主色（换曲平滑过渡）；"
    + "系统强调色：跟随桌面配色（Noctalia / matugen 模板、KDE / GNOME / Windows / macOS 的系统强调色，"
    + "读不到时先用默认青色）；自定义颜色：自己挑，点色块展开颜色选择器，支持 HSL / CMYK / RGB 与 HEX。";
  const tintCards = wrap.querySelector<HTMLElement>("#tint-cards")!;
  const tintChip = wrap.querySelector<HTMLButtonElement>("#tint-chip")!;
  const tintPop = wrap.querySelector<HTMLElement>("#tint-pop")!;
  const tintFold = wrap.querySelector<HTMLButtonElement>("#tint-fold")!;
  const tintSwatch = wrap.querySelector<HTMLElement>("#tint-swatch")!;
  const tintCode = wrap.querySelector<HTMLElement>("#tint-code")!;
  const tintHue = wrap.querySelector<HTMLInputElement>("#tint-hue")!;
  const tintModes = wrap.querySelector<HTMLElement>("#tint-modes")!;
  const tintFields = wrap.querySelector<HTMLElement>("#tint-fields")!;
  const tintHex = wrap.querySelector<HTMLInputElement>("#tint-hex")!;
  const tintHint = wrap.querySelector<HTMLElement>("#tint-hint")!;
  const chipSw = h("span", "tint-chip__sw");
  tintChip.append(chipSw);

  type ColorMode = "hsl" | "cmyk" | "rgb";
  /** 每个模式的通道定义：k 用于读写输入框，label + suffix 只影响显示。 */
  const CHANNELS: Record<ColorMode, { k: string; label: string; min: number; max: number; suffix: string }[]> = {
    hsl: [
      { k: "h", label: "H", min: 0, max: 359, suffix: "°" },
      { k: "s", label: "S", min: 0, max: 100, suffix: "%" },
      { k: "l", label: "L", min: 0, max: 100, suffix: "%" },
    ],
    cmyk: [
      { k: "c", label: "C", min: 0, max: 100, suffix: "%" },
      { k: "m", label: "M", min: 0, max: 100, suffix: "%" },
      { k: "y", label: "Y", min: 0, max: 100, suffix: "%" },
      { k: "k", label: "K", min: 0, max: 100, suffix: "%" },
    ],
    rgb: [
      { k: "r", label: "R", min: 0, max: 255, suffix: "" },
      { k: "g", label: "G", min: 0, max: 255, suffix: "" },
      { k: "b", label: "B", min: 0, max: 255, suffix: "" },
    ],
  };

  let colorMode: ColorMode = "hsl";
  let popOpen = false; // 选择器是否展开（只对自定义档有意义）
  // 选择器编辑的永远是自定义色的值；进来时以配置为准（配置里的才是真相）
  let tintRgb: RGB = parseHex(getTintColor()) ?? parseHex(TINT_DEFAULT_COLOR) ?? { r: 25, g: 194, b: 216 };

  const unit01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const pctInt = (n: number) => Math.round(unit01(n) * 100);

  /** 当前色在某个模式下的通道取值（整数，直接进输入框）。 */
  const channelValues = (m: ColorMode): number[] => {
    if (m === "rgb") return [tintRgb.r, tintRgb.g, tintRgb.b];
    if (m === "hsl") {
      const { h, s, l } = rgb2hsl(tintRgb);
      return [Math.round(h), pctInt(s), pctInt(l)];
    }
    const { c, m: mg, y, k } = rgb2cmyk(tintRgb);
    return [pctInt(c), pctInt(mg), pctInt(y), pctInt(k)];
  };
  /** 把某模式的通道值组装回 RGB。 */
  const rgbFromChannels = (m: ColorMode, v: number[]): RGB => {
    if (m === "rgb") return { r: v[0], g: v[1], b: v[2] };
    if (m === "hsl") return hsl2rgb(v[0], unit01(v[1] / 100), unit01(v[2] / 100));
    return cmyk2rgb({ c: unit01(v[0] / 100), m: unit01(v[1] / 100), y: unit01(v[2] / 100), k: unit01(v[3] / 100) });
  };
  const fieldOf = (k: string) => tintFields.querySelector<HTMLInputElement>(`[data-k="${k}"]`);

  /** 各显示位（色块 / HEX 码 / 色相条 / HEX 框）跟着真相走。 */
  const paintColor = (hueOverride?: number) => {
    const hex = toHex(tintRgb);
    tintSwatch.style.background = hex;
    chipSw.style.background = hex;
    tintCode.textContent = hex;
    tintHue.value = String(Math.round(hueOverride ?? rgb2hsl(tintRgb).h));
    if (document.activeElement !== tintHex) tintHex.value = hex;
  };
  /** 通道输入框回填：正在编辑的那个不动（否则会打断输入 / 把半截值抹掉）。 */
  const refreshFields = () => {
    const vals = channelValues(colorMode);
    CHANNELS[colorMode].forEach((ch, i) => {
      const el = fieldOf(ch.k);
      if (el && document.activeElement !== el) el.value = String(vals[i]);
    });
  };
  /** 写色：真相 → 落盘 + 即时生效（写 CSS 变量）→ 刷新显示位。 */
  const commitColor = (next: RGB) => {
    tintRgb = { r: Math.round(next.r), g: Math.round(next.g), b: Math.round(next.b) };
    setTintColor(toHex(tintRgb));
    applyTint();
    paintColor();
    refreshFields();
  };
  /** 重建当前模式的通道输入行（只在切模式时调；输入过程中不重建，免得丢焦点）。 */
  const renderFields = () => {
    const vals = channelValues(colorMode);
    tintFields.innerHTML = CHANNELS[colorMode].map((ch, i) =>
      `<label class="tint-field"><span class="tint-field__label">${ch.label}${ch.suffix}</span>`
      + `<input type="number" inputmode="numeric" data-k="${ch.k}" min="${ch.min}" max="${ch.max}" step="1"`
      + ` value="${vals[i]}" aria-label="${ch.label}" /></label>`,
    ).join("");
    tintModes.querySelectorAll<HTMLElement>("[data-mode]")
      .forEach((b) => b.classList.toggle("sel", b.dataset.mode === colorMode));
  };

  tintModes.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => {
    b.onclick = () => { colorMode = b.dataset.mode as ColorMode; renderFields(); };
  });
  tintFields.addEventListener("input", () => {
    const cur = channelValues(colorMode);
    const vals = CHANNELS[colorMode].map((ch, i) => {
      const raw = (fieldOf(ch.k)?.value ?? "").trim();
      if (raw === "") return cur[i]; // 清空中的框按原值算，不瞬间掉到下限
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(ch.min, Math.min(ch.max, Math.round(n))) : cur[i];
    });
    commitColor(rgbFromChannels(colorMode, vals));
  });
  // 离开输入框时校正越界值（R 里敲 300 会被夹到 255，但框里还显示着 300）
  tintFields.addEventListener("blur", refreshFields, true);
  tintHue.addEventListener("input", () => {
    const hue = Number(tintHue.value);
    const { s, l } = rgb2hsl(tintRgb);
    // 无彩度（灰/黑白）时给一个看得出颜色的 S/L，否则拖色相条毫无反馈
    const base = s < 0.02 ? { s: 0.75, l: 0.5 } : { s, l };
    commitColor(hsl2rgb(hue, base.s, base.l));
    paintColor(hue); // 用拖动值回填滑块，免得 hsl→rgb→hsl 往返把圆点抖回去
  });
  tintHex.addEventListener("input", () => {
    const c = parseHex(tintHex.value);
    if (c) commitColor(c); // 半截输入（如 "#19"）不是合法字面量，先不改色
  });

  // —— 与 Sparkle 主题的交接（SDK 的 SparkleTheme.tint；策略解析见 sparkle/theme-tint.ts）——
  // 主题不声明 tint = 它自带强调色：宿主让位（lib/tint.ts 清掉内联变量、回落 --acc/--cyan），
  // 这里把整组禁用并写明原因。主题声明 presets = 用它给的那几套方案，三档卡退场换方案卡。
  const tintSparkCards = wrap.querySelector<HTMLElement>("#tint-spark-cards")!;
  /** 当前激活的 Sparkle 主题（含它的 tint / background 声明）；没启用主题 / 主题已消失 = null。
   *  解析走 sparkle/registry（读 host 维护的 <html data-sparkle-theme>）—— 背景那一组也用它。 */
  const activeSparkTheme = sparkleActiveTheme;
  const tintPolicy = () => tintPolicyOf(activeSparkTheme());

  /** 系统强调色还没读到时补拉一次（回来后重画一次当前态）。
   *  accentProbed 防自旋：拉不到也只拉一次 —— 「重画 → 又拉 → 又重画」会把设置页变成请求风暴；
   *  后续的跟随由 lib/accent.ts 的轮询（哨兵方案/系统档激活时才开）负责。 */
  let accentProbed = false;
  const probeAccentOnce = () => {
    if (accentProbed || currentAccent()?.color) return;
    accentProbed = true;
    void refreshAccent().then(() => paintTintPolicy());
  };

  /** 主题给的高亮方案卡：一张卡 = 色块 + 名字。色值已过 validPresets 校验（十六进制字面量或
   *  "system" 哨兵）。哨兵那档的色块 = 当前读到的系统强调色（还没读到就用「系统」斜纹占位）。 */
  const renderSparkTintCards = (presets: readonly SparkleTintPreset[], themeId: string) => {
    tintSparkCards.innerHTML = "";
    for (const p of presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-card";
      b.dataset.preset = p.id;
      const hex = resolvePresetColor(p.color, currentAccent()?.color ?? null);
      const sw = p.color === TINT_PRESET_SYSTEM
        ? (hex ? `<span class="sw" style="background:${hex}"></span>` : `<span class="sw sw-accent"></span>`)
        : `<span class="sw" style="background:${p.color}"></span>`;
      b.innerHTML = `${sw}${escHtml(p.label)}`;
      b.onclick = () => {
        sparkSetTintChoice(themeId, p.id);
        applyTint();       // 换了方案立刻重写 CSS 变量
        paintTintPolicy(); // 同步选中态
      };
      tintSparkCards.append(b);
    }
  };

  /** 展开/收起选择器。非自定义档不给开，高亮色被主题接管时也不给开 —— 面板编的就是自定义色。 */
  const setPopOpen = (open: boolean) => {
    popOpen = open && tintPolicy().mode === "host" && getTintMode() === "custom";
    tintPop.hidden = !popOpen;
    tintChip.setAttribute("aria-expanded", String(popOpen));
  };
  const paintTintMode = () => {
    const mode = getTintMode();
    syncSel(tintCards, "opt", mode);
    // 色块只在「宿主管高亮色 + 自定义档」出现；离开该档时选择器一并收起
    tintChip.hidden = tintPolicy().mode !== "host" || mode !== "custom";
    setPopOpen(popOpen);
    // 「系统强调色」档：把读到的来源/色值直接说给用户听（读不到也说明白为什么 + 怎么办）。
    if (mode === "system" && tintPolicy().mode === "host") {
      const a = currentAccent();
      tintHint.textContent = a?.color
        ? `系统强调色：已读到${a.label ? ` ${a.label} 的` : ""} ${a.color}，换桌面配色后自动跟随。`
        : "系统强调色：暂时没读到（先用默认青色）。在 Noctalia / matugen 的模板里把颜色写到"
          + " <配置目录>/system-theme.json，或在系统设置里挑一个强调色。";
      probeAccentOnce(); // 值是异步来的：还没读到就先刷一次，回来重画（accentProbed 防自旋）
    }
  };

  /** 整组的主刷新：决定三档卡、主题方案卡、说明文案各自出现与否（主题切换 / 插件启停都要重跑）。 */
  const paintTintPolicy = () => {
    const policy = tintPolicy();
    const themeName = activeSparkTheme()?.name ?? "";
    const locked = policy.mode === "off";   // 主题自带配色：三档留在原位但禁用（整组消失会让人找不到）
    const presets = policy.mode === "presets";

    tintCards.hidden = presets;             // 有替代方案时三档直接退场
    tintSparkCards.hidden = !presets;
    tintCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    if (presets) {
      renderSparkTintCards(policy.presets, policy.themeId ?? "");
      syncSel(tintSparkCards, "preset", sparkTintChoice(policy.themeId) ?? policy.presets[0]?.id ?? "");
      // 方案里有哨兵（color:"system"）且系统强调色还没到：补拉一次，回来重画方案卡的色块
      if (policy.presets.some((p) => p.color === TINT_PRESET_SYSTEM)) probeAccentOnce();
    }
    tintHint.textContent = locked
      ? `当前 Sparkle 主题「${themeName}」自带配色，已接管高亮色；切到「默认」主题或让主题声明 tint 才可调。`
      : presets
        ? `高亮色由 Sparkle 主题「${themeName}」提供，从上面挑一套。`
        : TINT_HINT;
    paintTintMode(); // 顺带把 chip / 选择器的可用性收口
  };

  tintCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.opt as TintMode;
      setTintMode(next);
      applyTint(); // 档位换了要立刻重写 CSS 变量（封面档还会去取当前曲封面）
      if (next === "custom") popOpen = true; // 点「自定义颜色」→ 就地弹出选择器
      paintTintMode();
    };
  });
  tintChip.onclick = () => { setPopOpen(!popOpen); };
  tintFold.onclick = () => { setPopOpen(false); };

  renderFields();
  paintColor();
  paintTintPolicy();

  // —— 菜单毛玻璃（[Style] MenuBlur）：浮层菜单的玻璃底 + 背景模糊开不开 ——
  // 真相是 <html data-menu-glass>（由 lib/menu-glass.ts 写，on/off/theme 三态），CSS 侧一组
  // --menu-* 令牌据此取值；这里只管这棵开关的呈现。主题自带菜单外观时整组留在原位但禁用。
  const MENU_GLASS_HINT = "开启：半透明玻璃底 + backdrop 模糊（默认）；关闭：改成实底、完全不糊，"
    + "省一层 GPU 合成且文字最清晰。玻璃感来自透出来的背景色 —— 看不出模糊时，先把上面的「背景」打开。";
  const menuGlassCards = wrap.querySelector<HTMLElement>("#menu-glass-cards")!;
  const menuGlassHint = wrap.querySelector<HTMLElement>("#menu-glass-hint")!;
  const menuGlassPolicy = () => menuGlassPolicyOf(activeSparkTheme());
  const paintMenuGlass = () => {
    syncSel(menuGlassCards, "opt", getMenuBlur() ? "on" : "off");
    menuGlassHint.textContent = menuGlassPolicy().mode === "off"
      ? `当前 Sparkle 主题「${activeSparkTheme()?.name ?? ""}」自带菜单外观，已接管；切到「默认」主题或让主题声明 menus 才可调。`
      : MENU_GLASS_HINT;
  };
  /** 整组的主刷新：主题接管时这组留在原位但禁用（整组消失会让人找不到）。 */
  const paintMenuGlassPolicy = () => {
    const locked = menuGlassPolicy().mode === "off";
    menuGlassCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    paintMenuGlass();
  };
  menuGlassCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      setMenuBlur(b.dataset.opt === "on");
      applyMenuGlass(); // 立刻生效：样式按属性取值，这里只换那个属性
      paintMenuGlass();
    };
  });
  paintMenuGlassPolicy();

  // Sparkle 主题：插件注册的自定义主题（覆盖在上方外观模式之上的变量层）。
  // 列表随注册表动态变化（插件异步启用/停用），onSparkleChange 重画整组；
  // 激活经 host 持久化并即时生效，停用激活主题所属插件时 host 自动回落默认。
  const sparkleThemeGroup = wrap.querySelector<HTMLElement>("#sparkle-theme-group")!;
  const sparkleThemeCards = wrap.querySelector<HTMLElement>("#sparkle-theme-cards")!;
  const syncSparkleThemeSel = () => {
    const activeId = sparkActiveThemeId();
    // 持久化的 id 可能指向已消失的主题（如插件被禁用后残留）：UI 只认仍注册着的
    const active = sparkleThemes().some((t) => t.id === activeId) ? (activeId ?? "") : "";
    syncSel(sparkleThemeCards, "opt", active);
  };
  const renderSparkleThemes = () => {
    const themes = sparkleThemes();
    sparkleThemeGroup.hidden = themes.length === 0;
    sparkleThemeCards.innerHTML = "";
    const mkCard = (id: string, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-card";
      b.dataset.opt = id;
      b.textContent = label;
      b.onclick = () => {
        sparkActivateTheme(id || null);
        syncSparkleThemeSel();
        paintTintPolicy(); // 主题决定高亮色归谁：切完要把上面那组重新收口
        paintBgPolicy();   // 背景归谁同理
        paintMenuGlassPolicy(); // 浮层菜单的外观归谁同理
      };
      return b;
    };
    sparkleThemeCards.append(mkCard("", "默认"));
    for (const t of themes) sparkleThemeCards.append(mkCard(t.id, t.name));
    syncSparkleThemeSel();
    paintTintPolicy(); // 主题列表变了（插件启停）→ 高亮色那组的可用性也要跟着重算
    paintBgPolicy();   // 背景那组同理
    paintMenuGlassPolicy(); // 菜单外观那组同理
  };
  renderSparkleThemes();
  const offSparkleThemes = onSparkleChange(renderSparkleThemes);
  // 窗口装饰：CSD（右上角自绘按钮簇）/ SSD（系统标题栏）。Electron 桥重建窗口；浏览器仅隐藏按钮簇。
  bindOptCards<DecorMode>(wrap.querySelector<HTMLElement>("#decor-cards")!, getDecor, setDecor);
  // 关闭按钮行为：缩放到托盘 / 退出程序（Electron 桥同步主进程；浏览器 dev 无效果）
  bindOptCards<CloseAction>(wrap.querySelector<HTMLElement>("#close-cards")!, getCloseAction, setCloseAction);
  // Fallback 排序：默认「不优先全景声」（母带优先，atmos51 压链尾兜底）；改动自下一首协商起生效
  bindOptCards<FallbackSort>(wrap.querySelector<HTMLElement>("#atmos-fallback-cards")!, getFallbackSort, setFallbackSort);
  // 上一首按钮行为：重放当前曲（默认）/ 直接跳到队列里的上一首（播放条按钮与媒体键共用，即时生效）
  bindOptCards<PrevBehavior>(wrap.querySelector<HTMLElement>("#prev-behavior-cards")!, getPrevBehavior, setPrevBehavior);
  // 播放音频时睡眠禁止（[Playing] InhibitSleep，默认开）：开关即时对齐 sidecar 持有态
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#inhibit-sleep-cards")!,
    () => (getInhibitSleep() ? "on" : "off"),
    (v) => { setInhibitSleep(v === "on"); syncInhibit(); },
  );
  // 应用更新：自动检查开关（[Update] AutoCheck，默认开）
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#upd-auto-cards")!,
    () => (getAutoCheck() ? "on" : "off"),
    (v) => setAutoCheck(v === "on"),
  );
  // 更新渠道（[Update] Channel）：stable=latest release ｜ nightly=滚动 Release「nightly」。
  // 两个渠道可以互相切换 —— 判定不靠「谁版本号更大」，而靠「设置里的渠道 ≠ 当前构建所属渠道」
  // （buildChannel 认版本串里的短 commit id），所以同版号甚至回退都要能提示，否则切到 nightly
  // 就再也回不来（正式版不会为了某份 nightly 抬高版本号）。
  let buildVer = __APP_VERSION__;
  const channelCards = wrap.querySelector<HTMLElement>("#upd-channel-cards")!;
  const channelNote = wrap.querySelector<HTMLElement>("#upd-channel-note")!;
  const syncChannel = () => {
    const sel = getUpdateChannel();
    const built = buildChannel(buildVer);
    syncSel(channelCards, "opt", sel);
    channelNote.classList.toggle("is-switch", sel !== built);
    channelNote.textContent = sel === built
      ? `当前运行 ${describeBuild(buildVer)}`
      : `当前运行 ${describeBuild(buildVer)} · 已选 ${sel === "nightly" ? "Nightly" : "Stable"}，点下方「检查更新」完成切换`;
  };
  channelCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.opt as UpdateChannel;
      const was = getUpdateChannel();
      setUpdateChannel(next);
      syncChannel();
      // 明确点了「另一个渠道」= 要换一份构建：立刻查一次并按切换语义弹提醒
      // （失败也不打扰 —— 状态行与渠道说明都在，用户可再点「检查更新」）
      if (next !== was && next !== buildChannel(buildVer)) {
        void checkAndPrompt(next).catch(() => { /* 网络失败：状态行会显示检查失败 */ });
      }
    };
  });
  syncChannel();
  // 手动检查：状态行就地回报；发现更新 / 待切换（含已跳过、已暂不切换的）都弹提醒弹窗
  const checkBtn = wrap.querySelector<HTMLButtonElement>("#check-update")!;
  const updStatus = wrap.querySelector<HTMLElement>("#upd-status")!;
  updStatus.textContent = `当前 ${describeBuild(buildVer)}`;
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    updStatus.textContent = "检查中…";
    try {
      const r = await checkAndPrompt(getUpdateChannel());
      if (r.status === "error") updStatus.textContent = `检查失败：${r.error}`;
      else if (r.status === "up-to-date") updStatus.textContent = `${r.channel === "nightly" ? "Nightly" : "Stable"} 渠道已是最新`;
      else if (r.info.switching) updStatus.textContent = `可切换到 ${r.info.decision.targetLabel}${r.info.skipped ? "（你已暂不切换）" : ""}`;
      else if (r.info.channel === "nightly") updStatus.textContent = `发现新的 Nightly 构建${r.info.skipped ? "（你已跳过此构建）" : ""}`;
      else updStatus.textContent = `发现新版本 ${r.info.decision.latestDisplay}${r.info.skipped ? "（你已跳过此版本）" : ""}`;
    } catch (e) {
      updStatus.textContent = `检查失败：${errText(e)}`;
    } finally {
      checkBtn.disabled = false;
    }
  };
  // 当前构建版本以打包态的 app.getVersion() 为准（构建期注入的 __APP_VERSION__ 在 dev 下
  // 落在 git tag 上，不是「正在跑的这份」）。拿到后刷新渠道说明；状态行正忙就让位给检查结果。
  void getPlatformInfo().then((pf) => {
    if (!pf?.version || !parseVersion(pf.version)) return;
    buildVer = pf.version;
    syncChannel();
    if (!checkBtn.disabled) updStatus.textContent = `当前 ${describeBuild(buildVer)}`;
  });
  // 淡入淡出预设：持久化 + 立即下发时长（引擎侧做振幅包络；Blink 后端无此项）
  bindOptCards<FadePreset>(
    wrap.querySelector<HTMLElement>("#fade-cards")!,
    getFade,
    (p) => { void player.setFadePreset(p); },
  );

  // 字体：下拉给预设，右侧输入框可直接编辑 CSS font-family 列表（不必再去手改配置文件）。
  // 两边互相同步：选预设 → 填进输入框；输入框改成非预设值 → 下拉自动切到「自定义」。输入即时生效。
  const bindFont = (
    sel: HTMLSelectElement,
    input: HTMLInputElement,
    applyList: (css: string) => void,
    pickPreset: (key: string) => void,
    current: string,
  ) => {
    input.value = current;
    sel.value = fontKeyOf(current);
    sel.onchange = () => {
      if (sel.value === FONT_CUSTOM) return; // 「自定义」= 保持输入框现有内容，不动配置
      input.value = FONT_PRESETS[sel.value]?.css ?? "";
      pickPreset(sel.value);
    };
    input.oninput = () => { applyList(input.value); sel.value = fontKeyOf(input.value); };
    // 失焦时把输入框回写成规范化结果，跟落进配置的值保持一致（多余空格、半截分号都在这里清掉）
    input.onchange = () => {
      const norm = normalizeFontList(input.value);
      if (norm !== input.value) input.value = norm;
      applyList(norm);
      sel.value = fontKeyOf(norm);
    };
  };
  bindFont(
    wrap.querySelector<HTMLSelectElement>("#font-ui")!,
    wrap.querySelector<HTMLInputElement>("#font-ui-list")!,
    setUiFontList, setUiFontPreset, getUiFontList(),
  );
  bindFont(
    wrap.querySelector<HTMLSelectElement>("#font-lyric")!,
    wrap.querySelector<HTMLInputElement>("#font-lyric-list")!,
    setLyricFontList, setLyricFontPreset, getLyricFontList(),
  );

  // 配置文件：展示磁盘路径 + 一键定位 / 重置（浏览器 dev 下没有文件，只提示真相在哪）
  const conf = configInfo();
  const confPath = wrap.querySelector<HTMLInputElement>("#conf-path")!;
  const confHint = wrap.querySelector<HTMLElement>("#conf-hint")!;
  const openBtn = wrap.querySelector<HTMLButtonElement>("#open-conf")!;
  const resetBtn = wrap.querySelector<HTMLButtonElement>("#reset-conf")!;
  if (conf.bridged) {
    confPath.value = conf.path;
    confHint.textContent = conf.writable
      ? "手改后重启应用生效（改坏的值会自动回落默认，不影响启动）。"
      : "⚠️ 配置目录不可写，本次改动只在本进程内生效。";
  } else {
    confPath.value = "Fermata Mode 不写入 Config 文件";
    confHint.textContent = "当前为开发模式，改动仅存在本机浏览器，请使用生产模式";
    openBtn.disabled = true;
    resetBtn.disabled = true;
  }
  openBtn.onclick = () => { void revealConfig(); };
  resetBtn.onclick = async () => {
    if (!confirm("用模板重建 quaver.conf？主题 / 字体 / 播放 / 音质等设置会回到默认值，登录凭证不受影响。")) return;
    await resetConfig();
    location.reload(); // 重置后整页重来，省得逐项刷 UI 状态
  };

  // —— 播放引擎：MPV（默认，原生）/ Blink（浏览器 <audio>）。热切换当前曲目换轨续播。
  const radios = wrap.querySelectorAll<HTMLInputElement>("#decode-radios input");
  const devSel = wrap.querySelector<HTMLSelectElement>("#audio-backend")!;
  const devHint = wrap.querySelector<HTMLElement>("#audio-device-hint")!;
  const engNote = wrap.querySelector<HTMLElement>("#engine-note")!;

  /** mpv 来源标签：随包运行时 / 系统 mpv / QUAVER_MPV 指定（排障时一眼看出跑的哪一份） */
  const MPV_SOURCE_LABEL: Record<string, string> = { bundled: "随包运行时", path: "系统 mpv", env: "QUAVER_MPV 指定" };

  async function paintBackend() {
    const st = await player.probeEngine();
    radios.forEach((r) => {
      r.disabled = r.value === "MPV" && !st.available;
      r.checked = r.value === getDecode();
      r.onchange = () => { if (r.checked) void player.setBackend(r.value as "MPV" | "Blink").then(paintAll); };
    });
    const src = MPV_SOURCE_LABEL[st.source] ?? "";
    engNote.textContent = player.backend === "mpv"
      ? `- MPV 运行中${src ? "（" + src + "）" : ""}`
      : st.available ? `- 默认 MPV（${src}），当前浏览器兜底` : "- " + (st.reason || "mpv 不可用，已回退浏览器音频");
  }

  async function paintDevices() {
    devSel.disabled = true;
    devSel.onchange = null;
    const r = await player.listAudioDevices();
    if (!r) {
      devSel.innerHTML = `<option>系统默认</option>`;
      devHint.textContent = "浏览器 <audio> 后端：跟随系统输出设备；切换到 MPV 引擎后可在此直选设备。";
      return;
    }
    devSel.innerHTML = `<option value="auto">系统默认</option>`
      + r.devices.map((d) => `<option value="${escHtml(d.id)}">${escHtml(d.desc)}</option>`).join("");
    devSel.disabled = false;
    devHint.textContent = "切换即时生效，无需重启。";
    devSel.onchange = () => { void player.selectAudioDevice(devSel.value); };
  }

  async function paintAll() { await paintBackend(); await paintDevices(); }
  void paintAll();
  // 引擎传输热切换（启动探测/设置页切换）后刷新设备列表——只在后端真正变化时，别跟着 4Hz notify 空转。
  // 订阅只留最新一份（watchBackendChange 会退订上一份）：设置页可反复进出，旧订阅若不退订，
  // 会连着整棵已拆卸的设置页 DOM 一直滞留在内存里（每次访问泄漏一整页）。
  let lastBackend = player.backend;
  watchBackendChange(() => {
    if (player.backend !== lastBackend) {
      lastBackend = player.backend;
      void paintBackend();
      void paintDevices();
    }
  });

  // 默认音质：档位由后端按会员等级下发（/stream/tiers）；locked 档画锁标不可选。
  const qBox = wrap.querySelector<HTMLElement>("#quality-grid")!;
  const qNote = wrap.querySelector<HTMLElement>("#q-member-note")!;
  const syncQ = () => syncSel(qBox, "q", getQuality());
  const bindQ = () => {
    qBox.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => {
      if (!b.disabled) b.onclick = () => {
        setQuality(b.dataset.q as Quality | "auto");
        setSessionQuality(null); // 播放条会话覆盖让位给新的默认档（新档自下一首起生效）
        syncQ();
        player.notifyPublic();
      };
    });
  };
  bindQ(); syncQ();
  getStreamTiers(true).then((t) => {
    qNote.textContent = `（当前：${t.membership_label}${t.membership ? "" : "，高档位需会员"}）`;
    for (const tier of t.all_tiers) {
      const btn = document.createElement("button");
      btn.className = "opt-card q";
      btn.dataset.q = tier.id;
      btn.type = "button";
      btn.innerHTML = tier.label + (tier.hi_res ? ' <span class="muted soon">Hi-Res</span>' : "")
        + (tier.locked ? ' <span class="q-lock">🔒会员</span>' : "");
      if (tier.locked) btn.disabled = true;
      qBox.append(btn);
    }
    bindQ(); syncQ();
  }).catch(() => { qNote.textContent = "（音质服务不可用）"; });

  // 调试：日志页面（壳层把 ui/electron-dev.log 经 /api/log 尾部暴露为纯文本，见 relay.ts）
  wrap.querySelector<HTMLElement>("#open-log")!.onclick = () => (location.hash = "#/log");

  // Sparkle 面板：切路由时清理插件设置区的订阅与 render 清理函数
  const sparklePanel = wrap.querySelector<HTMLElement>('[data-panel="plugins"]')!;
  const offSparkle = mountSparklePanel(sparklePanel);
  // 热键面板：录制态残留监听由其 cleanup 收尾
  const hotkeysPanel = wrap.querySelector<HTMLElement>('[data-panel="hotkeys"]')!;
  const offHotkeys = mountHotkeysPanel(hotkeysPanel);
  return () => { offSparkle(); offSparkleThemes(); offHotkeys(); };
}

// —— 调试：日志页面（壳层 electron-dev.log 尾部；由 relay.ts /api/log 提供） ——
async function logView(root: HTMLElement) {
  const bar = h("div", "log-bar");
  const pre = h("pre", "log-pre", `<span class="muted">加载中…</span>`);
  const back = h("button", "ghost-btn", "返回设置");
  const refresh = h("button", "ghost-btn", "刷新");
  const meta = h("span", "muted");
  bar.append(back, refresh, meta);
  root.append(bar, pre);
  back.onclick = () => (location.hash = "#/settings");
  async function load() {
    meta.textContent = "读取中…";
    try {
      const r = await fetch("/api/log?tail=800");
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(j?.msg || `HTTP ${r.status}`);
      }
      pre.textContent = await r.text();
      meta.textContent = "来源 ui/electron-dev.log（尾部 800 行）";
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      pre.innerHTML = "";
      pre.append(h("span", "muted", `读不到日志：${errText(e)}（Electron 壳层未运行时属正常）`));
      meta.textContent = "";
    }
  }
  refresh.onclick = load;
  await load();
}

// —— 我的页（点侧栏头像的落点；退出登录按钮长在这里）——
//
// 进场：整页交给 CSS 的 `.me > *` 分级淡入（style.css「我的」段），容器让位不叠动画。
// 离场：退出登录先播 `.leaving`（整页淡出上移）再跳登录页 —— 登录态变化必须走整页
// （location.href）才能重置侧栏与播放器，所以这里只能「先把界面收掉再跳」。
const ME_OUT_MS = 180; // 与 .me.leaving 的动画时长对齐

const reduceMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 我的页离场：加 .leaving 等动画结束。动画只是观感，**绝不能挡住跳转** —— 
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
const settleIn = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

async function userView(root: HTMLElement) {
  const wrap = h("div", "me");
  root.append(wrap);
  try {
    const [home, vip] = await Promise.all([
      api<UserMeResp>("/user/me"),
      api<unknown>("/user/vip").catch(() => null),
    ]);
    const base = home?.base_info;
    if (!base?.name) { location.hash = "#/login"; return; }
    // 会员权益卡（到期时间 + 档位明细 + 续费指路）由 lib/vip.ts 生成：字段口径与上游模型对齐，
    // 这里只负责挂进页面。vip 为 null（上游没响应）时卡片自己说明读不到。
    wrap.innerHTML = `
      <div class="avatar-big">${base.avatar ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>` : ""}</div>
      <h2 style="margin:12px 0 4px">${escHtml(base.name)}</h2>
      <div class="badges" style="justify-content:center">${identityBadges(home, vip)}</div>
      <p class="muted">UID: ${escHtml(base.encrypted_uin ?? "")}</p>
      ${vipCardHtml(vip)}
      <button id="logout" class="ghost-btn danger">退出登录</button>`;
    const btn = wrap.querySelector<HTMLButtonElement>("#logout")!;
    let leaving = false;
    btn.onclick = async () => {
      if (leaving) return; // 连点：只开一趟登出
      leaving = true;
      btn.disabled = true;
      btn.textContent = "正在退出…";
      // 离场动画与登出请求并行：动画短、请求可能慢，两个都不许把跳转卡住
      await Promise.all([exitMe(wrap), settleIn(api("/login/logout", { method: "POST" }), 1500)]);
      location.href = "/login.html";
    };
  } catch {
    location.hash = "#/login";
  }
}

// —— 登录页（扫码），内容区视图 ——
async function loginView(root: HTMLElement) {
  root.innerHTML = `
    <div class="login-wrap">
      <h2>扫码登录</h2>
      <p class="muted">用手机 QQ 音乐 App 或微信扫码。凭证由本机加密保存（KWallet / 钥匙串 / 凭据管理器等系统密钥管理器），磁盘上不留明文，也不进浏览器。</p>
      <!-- 登录方式用标签区分（不是下拉）：复用搜索页/歌手页那套 .tag 组件，三档一眼看全，
           data-ch 的取值必须与 sidecar 的 QR_TYPES（qq/wx/mobile）对齐，写错是 422 不是静默失败 -->
      <div class="tag-tabs" id="channel" role="tablist" aria-label="登录方式">
        <button class="tag sel" type="button" role="tab" aria-selected="true" data-ch="mobile">QQ 音乐 App</button>
        <button class="tag" type="button" role="tab" aria-selected="false" data-ch="qq">手机 QQ</button>
        <button class="tag" type="button" role="tab" aria-selected="false" data-ch="wx">微信</button>
      </div>
      <div class="qr-box">
        <div id="qr" class="qr"><div class="muted">正在生成二维码…</div></div>
        <div id="lstate" class="muted"></div>
        <div class="row-btn">
          <button id="refresh" type="button">重新生成</button>
        </div>
      </div>
    </div>`;
  const qr = root.querySelector<HTMLElement>("#qr")!;
  const lstate = root.querySelector<HTMLElement>("#lstate")!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("#channel .tag")];
  let channel = (tabs[0]?.dataset.ch ?? "mobile") as LoginChannel;
  let timer: number | undefined;
  let stopped = false;

  async function start() {
    window.clearInterval(timer);
    qr.innerHTML = `<div class="muted">生成中…</div>`;
    lstate.textContent = "";
    let d: QrResp;
    try {
      d = await api<QrResp>(`/login/qrcode/${channel}`);
    } catch (e) {
      qr.innerHTML = `<div class="muted">${/429|backoff|频繁/.test(errText(e)) ? "操作太快，等 60-90s 再重试" : errText(e)}</div>`;
      return;
    }
    if (stopped) return;
    qr.innerHTML = `<img src="${d.img}" alt="登录二维码"/>`;
    lstate.textContent = "等待扫码…";

    timer = window.setInterval(async () => {
      if (stopped) { window.clearInterval(timer); return; }
      try {
        const c = await api<QrStatusResp>(`/login/qrcode/${channel}/status?identifier=${encodeURIComponent(d.identifier ?? "")}`);
        if (c.event === 1) return; // SCAN
        if (c.event === 2) { lstate.textContent = "已扫码，请在手机上确认"; return; }
        if (c.event === 3) { lstate.textContent = "二维码已过期，点「重新生成」"; window.clearInterval(timer); return; }
        if (c.event === 4) { lstate.textContent = "已拒绝登录"; window.clearInterval(timer); return; }
        if (c.event === 0 && c.done) {
          window.clearInterval(timer);
          lstate.textContent = "✅ 登录成功，正在返回…";
          setTimeout(() => (location.href = "/index.html"), 800);
        }
      } catch { /* 瞬时网络抖动，下一轮再试 */ }
    }, 2000);
  }

  // 换标签 = 换通道：立刻重开一张二维码（旧轮询在 start 里 clearInterval 掉，不会串台）
  for (const b of tabs) {
    b.addEventListener("click", () => {
      const ch = b.dataset.ch as LoginChannel;
      if (ch === channel) return; // 重复点当前档不重开
      channel = ch;
      for (const x of tabs) {
        const on = x === b;
        x.classList.toggle("sel", on);
        x.setAttribute("aria-selected", String(on));
      }
      void start();
    });
  }
  root.querySelector<HTMLElement>("#refresh")!.onclick = () => void start();
  void start();

  return () => { stopped = true; window.clearInterval(timer); };
}

// —— 搜索页（顶部常驻搜索框的落点视图）：热搜词 + 分类标签（歌曲/歌手/专辑/歌单） ——
const SEARCH_TABS = [
  { type: "0", label: "歌曲" },
  { type: "1", label: "歌手" },
  { type: "2", label: "专辑" },
  { type: "3", label: "歌单" },
] as const;

async function searchView(root: HTMLElement, q: URLSearchParams) {
  const kw = (q.get("keyword") || "").trim();
  const tab = SEARCH_TABS.find((t) => t.type === (q.get("type") ?? "0")) ?? SEARCH_TABS[0];
  const head = h("div", "search-head");
  head.innerHTML = `<h1 class="page-title" style="margin:6px 0 4px">${kw ? `“${kw.replace(/</g, "&lt;")}”的搜索结果` : "搜索"}</h1>
    <div class="search-tabs">${SEARCH_TABS.map(
      (t) => `<button class="stab${t.type === tab.type ? " sel" : ""}" data-type="${t.type}" type="button">${t.label}</button>`,
    ).join("")}</div>`;
  const box = h("div", "search-body", `<div class="muted">搜索中…</div>`);
  root.append(head, box);
  head.querySelectorAll<HTMLElement>(".stab").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.type === tab.type) return;
      location.hash = `#/search?keyword=${encodeURIComponent(kw)}&type=${b.dataset.type}`;
    };
  });
  if (!kw) {
    // 空关键词：展示热搜词，点一个即搜
    box.innerHTML = "";
    try {
      const keys = ((await api<HotkeyResp>("/search/hotkey"))?.vec_hotkey ?? [])
        .map((x) => x.title || x.query).filter((k): k is string => !!k);
      box.innerHTML = keys.length
        ? `<div class="hot-chips">${keys.map((k) => `<button class="chip" type="button">${escHtml(k)}</button>`).join("")}</div>`
        : `<div class="muted">输入关键词后回车即可搜索</div>`;
      box.querySelectorAll<HTMLElement>(".chip").forEach((c) => {
        c.onclick = () => {
          pushHistory(c.textContent || "");
          location.hash = `#/search?keyword=${encodeURIComponent(c.textContent || "")}`;
        };
      });
    } catch (e) {
      box.innerHTML = `<div class="muted">${errText(e)}</div>`;
    }
    return;
  }
  const go = (page: number) => {
    location.hash = `#/search?keyword=${encodeURIComponent(kw)}&type=${tab.type}&page=${page}`;
  };
  const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
  try {
    const d = (await api<SearchResp>(`/search?keyword=${encodeURIComponent(kw)}&type=${tab.type}&page=${page}&num=30`)) ?? {};
    box.innerHTML = "";
    // 注意：响应各分类字段恒在（其余类为空数组），必须按当前 tab 显式取，不能用 ?? 链
    if (tab.type === "0") {
      const list = (d.song ?? []) as (Song & { album?: { name?: string } })[];
      if (!list.length) { box.innerHTML = `<div class="muted">没有找到相关内容</div>`; return; }
      // 高亮标签兜底剥离：后端 highlight=true，name 里可能带 <em>
      for (const s of list) {
        s.name = stripEm(s.name);
        for (const g of s.singer ?? []) g.name = stripEm(g.name);
        if (s.album) s.album.name = stripEm(s.album.name);
      }
      // 双击 = 立即插队播放：马上切过去播这一首（只带这一首进队列，其余搜索结果不入列）
      renderSongRows(box, list, { showAlbum: true, onPlay: (s) => playNowWithToast(s) });
    } else {
      const list: SearchSinger[] | SearchAlbum[] | SearchSonglist[] =
        tab.type === "1" ? d.singer ?? [] : tab.type === "2" ? d.album ?? [] : d.songlist ?? [];
      if (!list.length) { box.innerHTML = `<div class="muted">没有找到相关内容</div>`; return; }
      if (tab.type === "1") {
        box.classList.add("grid");
        box.innerHTML = (list as SearchSinger[]).map((x) => `<a class="card" href="#/singer?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(stripEm(x.name) || "歌手")}">
          <div class="art round">${x.pic ? `<img src="${upPic(x.pic)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${stripEm(x.name) || "歌手"}</div><div class="sub">${x.song_num ? `${x.song_num} 首` : ""}</div></a>`).join("");
      } else if (tab.type === "2") {
        box.classList.add("grid");
        box.innerHTML = (list as SearchAlbum[]).map((x) => `<a class="card" href="#/album?mid=${encodeURIComponent(x.mid ?? "")}">
          <div class="art">${x.pic ? `<img src="${upPic(x.pic)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${stripEm(x.name) || "专辑"}</div>
          <div class="sub">${stripEm(x.singer)}${x.time_public ? ` · ${x.time_public}` : ""}</div></a>`).join("");
      } else {
        box.className = "grid playlist-grid";
        box.innerHTML = (list as SearchSonglist[]).map((x) => `<a class="card" href="#/playlist?id=${encodeURIComponent(x.id ?? x.dirid ?? "")}&name=${encodeURIComponent(stripEm(x.title) || "歌单")}">
          <div class="art">${x.picurl ? `<img src="${upPic(x.picurl)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${stripEm(x.title) || "歌单"}</div>
          <div class="sub">${x.nickname ? stripEm(x.nickname) + " 创建" : ""}${x.songnum ? ` · ${x.songnum} 首` : ""}</div></a>`).join("");
      }
    }
    const total: number = d.total_num ?? 0;
    if (d.nextpage && d.nextpage !== -1) {
      const more = h("div", "more-bar");
      const btn = h("button", "ghost-btn", `加载更多（共 ${total || "?"} 条）`);
      btn.onclick = () => go(page + 1);
      more.append(btn);
      box.append(more);
    }
  } catch (e) {
    box.innerHTML = `<div class="muted">搜索失败：${errText(e)}</div>`;
  }
}

export const views: Record<string, (root: HTMLElement, q: URLSearchParams) => Promise<(() => void) | void>> = {
  "/": homeView,
  "/search": searchView,
  "/guess": guessView,
  "/daily": dailyView,
  "/liked": likedView,
  "/playlist": playlistView,
  "/singer": singerView,
  "/singer-albums": singerAlbumsView,
  "/album": albumView,
  "/settings": settingsView,
  "/log": logView,
  "/user": userView,
  "/login": loginView,
};
