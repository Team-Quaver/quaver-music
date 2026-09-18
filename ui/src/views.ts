// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, upPic, coverUrl, getQuality, setQuality, setSessionQuality, getStreamTiers, identityBadges } from "./lib/api";
import { renderSongRows, loadLiked, tableHead, emptyState, type RowHooks } from "./lib/songs";
import { icon } from "./verse/icons";
import { formatTime } from "./verse/format";
import { loadingHtml, loadingInlineHtml } from "./verse/loading";
import { getMyMusicid, isFavSonglist, loadFavSonglists, onFavSonglistsChange, toggleFavSonglist } from "./lib/favs";
import { pushHistory } from "./components/SearchBox";
import { SelectBox, type SelectBoxOption } from "./components/SelectBox";
import { player } from "./player";
import {
  getTheme, setTheme, getDecor, setDecor,
  getUiFontList, setUiFontList, setUiFontPreset,
  getLyricFontList, setLyricFontList, setLyricFontPreset,
  getDecode, getFade, FONT_LABELS, FONT_PRESETS, FONT_CUSTOM, fontKeyOf, normalizeFontList,
  getFallbackSort, setFallbackSort, getCloseAction, setCloseAction,
  type FadePreset,
} from "./lib/prefs";
import { configInfo, revealConfig, resetConfig } from "./lib/config";

const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
};

const escHtml = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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

// 信息头（Likes/Artist 范式：160px 方封面 / 128px 圆头像 + 标题 + 元信息 + 简介 + 行动区）。
// 简介默认两行截断，真溢出时出 ghost「展开」按钮。
function mountHead(root: HTMLElement, opts: {
  artHtml: string; artRound?: boolean; name: string; meta: string; desc: string;
  /** 信息头行动区，挂在简介下方 */
  actions?: HTMLElement | null;
}) {
  const head = h("div", "v-colhead");
  head.innerHTML = `
    <div class="v-colhead__art${opts.artRound ? " v-colhead__art--round" : ""}">${opts.artHtml}</div>
    <div class="v-colhead__main">
      <div><h1 class="display-24">${escHtml(opts.name)}</h1>${opts.meta ? `<p class="v-colhead__count">${escHtml(opts.meta)}</p>` : ""}</div>
      ${opts.desc ? `<p class="v-desc">${escHtml(opts.desc)}</p>` : ""}
    </div>`;
  if (opts.actions) {
    const box = h("div", "v-pagehead__actions");
    box.append(opts.actions);
    head.querySelector<HTMLElement>(".v-colhead__main")!.append(box);
  }
  root.append(head);
  const desc = head.querySelector<HTMLElement>(".v-desc")!;
  if (opts.desc) {
    // 截断检测在下一帧做（-webkit-line-clamp 生效后 scrollHeight 才可比）
    requestAnimationFrame(() => {
      if (desc.scrollHeight - desc.clientHeight <= 2) return; // 两行内放得下：不需要按钮
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "v-btn v-btn--ghost v-btn--sm";
      btn.textContent = "展开";
      btn.onclick = () => {
        const open = desc.classList.toggle("open");
        btn.textContent = open ? "收起" : "展开";
      };
      desc.after(btn);
    });
  }
  return head;
}

// —— 卡片播放（悬停浮出的圆形播放键）：取集合歌曲后直接开播，失败则落到详情页 ——
async function cardPlay(kind: "playlist" | "album" | "singer", id: string, fallbackHash: string) {
  try {
    let songs: any[] = [];
    if (kind === "playlist") {
      const d: any = await api(`/songlist/${id}/detail?page=1&num=100`);
      songs = d?.songs ?? [];
    } else if (kind === "album") {
      const d: any = await api(`/album/${encodeURIComponent(id)}/songs?num=100`);
      songs = d?.song_list ?? [];
    } else {
      const d: any = await api(`/singer/${encodeURIComponent(id)}/songs?num=50&page=1&order=1`);
      songs = d?.song_list ?? [];
    }
    if (!songs.length) throw new Error("empty");
    player.playList(songs, 0);
  } catch {
    location.hash = fallbackHash;
  }
}

// 卡片（v-card）：div[role=button] 导航；悬停播放键取歌开播（歌手卡无播放键——人不是可播集合）。
function navCard(href: string, cover: string, title: string, sub: string, play?: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "v-card";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.innerHTML = `<div class="v-card__art">${cover ? `<img src="${cover}" alt="" loading="lazy"/>` : ""}
      ${play ? `<button type="button" class="v-iconbtn v-iconbtn--play v-card__play" aria-label="播放" title="播放">${icon("play")}</button>` : ""}</div>
    <div class="v-card__title">${escHtml(title)}</div><div class="v-card__sub">${escHtml(sub)}</div>`;
  el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".v-card__play")) return;
    location.hash = href;
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement) === el) { e.preventDefault(); location.hash = href; }
  });
  const pb = el.querySelector(".v-card__play");
  if (pb && play) pb.addEventListener("click", (e) => { e.stopPropagation(); play(); });
  return el;
}

function homeStatus(
  box: HTMLElement,
  title: string,
  note: string,
  retry?: () => void,
) {
  box.innerHTML = "";
  const status = h("div", "home-status", `
    <p class="title-15">${escHtml(title)}</p>
    <p class="body-14">${escHtml(note)}</p>`);
  if (retry) {
    const btn = h("button", "v-btn v-btn--secondary v-btn--sm", "重试") as HTMLButtonElement;
    btn.type = "button";
    btn.onclick = retry;
    status.append(btn);
  }
  box.append(status);
}

// —— 首页：精选歌单 + 新歌速递 + 推荐网格。两个数据源并行、独立降级。 ——
async function homeView(root: HTMLElement) {
  const pageHead = h("div", "home-pagehead", `
    <h1 class="display-24">首页</h1>
    <p class="body-14">从一张歌单开始，听见今天的新声音</p>`);

  const lead = h("div", "home-lead");

  const featured = h("section", "home-panel");
  featured.setAttribute("aria-labelledby", "home-featured-title");
  featured.innerHTML = `<div class="v-section__head">
    <h2 class="title-18" id="home-featured-title">今日精选</h2>
    <span class="caption-12">编辑推荐</span>
  </div>`;
  const featureHost = h("div", "home-feature-host", loadingHtml());
  featured.append(featureHost);

  const newest = h("section", "home-panel home-new");
  newest.setAttribute("aria-labelledby", "home-new-title");
  const newHead = h("div", "home-section-head");
  newHead.innerHTML = `<div class="v-section__head">
    <h2 class="title-18" id="home-new-title">新歌速递</h2>
    <span class="caption-12">最新发行</span>
  </div>`;
  const playNew = playAllButton();
  playNew.classList.add("v-btn--sm");
  playNew.disabled = true;
  newHead.append(playNew);
  const newRows = h("div", "v-rows home-new-list", loadingHtml());
  newest.append(newHead, newRows);

  lead.append(featured, newest);

  const recommendations = h("section", "v-section home-recommendations");
  recommendations.setAttribute("aria-labelledby", "home-recommend-title");
  recommendations.innerHTML = `<div class="v-section__head">
    <h2 class="title-18" id="home-recommend-title">推荐歌单</h2>
    <span class="caption-12">为你挑选</span>
  </div>`;
  const grid = h("div", "v-cards home-cards", loadingHtml());
  recommendations.append(grid);

  root.append(pageHead, lead, recommendations);

  const loadPlaylists = async () => {
    featureHost.innerHTML = loadingHtml();
    grid.innerHTML = loadingHtml();
    try {
      const d: any = await api("/recommend/songlist?page=1&num=13");
      const list: any[] = d?.songlists ?? [];
      const first = list[0];
      if (!first) {
        homeStatus(featureHost, "暂时没有今日精选", "稍后回来，这里会出现新的推荐", loadPlaylists);
        grid.innerHTML = `<div class="caption-12">暂无推荐歌单</div>`;
        return;
      }

      const id = String(first.id ?? "");
      const title = String(first.title ?? "歌单");
      const href = `#/playlist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(title)}`;
      const meta = [
        first.creator_nick ? `${first.creator_nick} 制作` : "",
        first.songnum ? `${first.songnum} 首` : "",
        compactCount(first.listennum) ? `${compactCount(first.listennum)}次播放` : "",
      ].filter(Boolean).join(" · ");
      const feature = h("div", "home-feature");
      feature.innerHTML = `
        <div class="home-feature__art">${first.picurl ? `<img src="${escHtml(upPic(String(first.picurl)))}" alt=""/>` : ""}</div>
        <div class="home-feature__main">
          <p class="overline-11">PLAYLIST</p>
          <h3 class="title-18 home-feature__title">${escHtml(title)}</h3>
          ${meta ? `<p class="home-feature__meta time-12">${escHtml(meta)}</p>` : ""}
          ${first.desc ? `<p class="home-feature__desc body-14">${escHtml(plainText(first.desc))}</p>` : ""}
          <div class="home-feature__actions"></div>
        </div>`;
      const actions = feature.querySelector<HTMLElement>(".home-feature__actions")!;
      const play = h("button", "v-btn v-btn--secondary", `${icon("play", 16)}播放歌单`) as HTMLButtonElement;
      play.type = "button";
      play.onclick = () => { void cardPlay("playlist", id, href); };
      const open = h("button", "v-btn v-btn--ghost", "查看详情") as HTMLButtonElement;
      open.type = "button";
      open.onclick = () => { location.hash = href; };
      actions.append(play, open);
      featureHost.replaceChildren(feature);

      grid.innerHTML = "";
      for (const x of list.slice(1, 13)) {
        const cardId = String(x.id ?? "");
        const cardTitle = String(x.title ?? "歌单");
        const cardHref = `#/playlist?id=${encodeURIComponent(cardId)}&name=${encodeURIComponent(cardTitle)}`;
        const listens = compactCount(x.listennum);
        const sub = [x.creator_nick || "", listens ? `${listens}次播放` : ""].filter(Boolean).join(" · ") || "歌单";
        grid.append(navCard(
          cardHref,
          upPic(x.picurl),
          cardTitle,
          sub,
          () => cardPlay("playlist", cardId, cardHref),
        ));
      }
      if (!grid.childElementCount) grid.innerHTML = `<div class="caption-12">暂无更多推荐</div>`;
    } catch (e: any) {
      homeStatus(featureHost, "推荐加载失败", String(e?.message ?? "网络暂时不可用"), loadPlaylists);
      grid.innerHTML = `<div class="caption-12">重新加载后显示推荐歌单</div>`;
    }
  };

  const loadNewSongs = async () => {
    playNew.disabled = true;
    playNew.onclick = null;
    newRows.innerHTML = loadingHtml();
    try {
      const d: any = await api("/recommend/newsong?type=5");
      const songs: any[] = (d?.songs ?? []).slice(0, 6);
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
    } catch (e: any) {
      homeStatus(newRows, "新歌加载失败", String(e?.message ?? "网络暂时不可用"), loadNewSongs);
    }
  };

  await Promise.all([loadPlaylists(), loadNewSongs()]);
}

// —— 歌单页收藏按钮（在线收藏写接口：PlaylistFavWrite Fav/CancelFavPlaylist） ——
// 收藏态取自 lib/favs 的收藏歌单缓存（与侧栏同源，收藏后侧栏同帧出现）；
// 自有歌单不渲染（不能收藏自己的歌单），未登录不渲染（收藏必须带登录态）。
async function favSonglistButton(meta: {
  id: string; title: string; picurl?: string; songnum?: number; creatorMusicid?: number;
}): Promise<HTMLElement | null> {
  const myId = await getMyMusicid();
  if (!myId) return null;
  if (meta.creatorMusicid && Number(meta.creatorMusicid) === myId) return null;
  // 收藏列表没拉到（未登录/上游失败）也照常给按钮：点击时写接口会给出真实错误
  await loadFavSonglists().catch(() => [] as any[]);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "v-btn v-btn--ghost";
  btn.dataset.plid = meta.id;
  const paint = () => {
    const on = isFavSonglist(meta.id);
    // 已收藏 = accent 文字 + 实心爱心（换形 + 换色双信号）
    btn.classList.toggle("is-loved", on);
    btn.innerHTML = `${icon(on ? "heartOn" : "heart", 16)}<span>${on ? "已收藏" : "收藏歌单"}</span>`;
    btn.title = on ? "从我的收藏中移除" : "收藏这首歌单";
  };
  paint();
  btn.onclick = async () => {
    const off = onFavSonglistsChange(() => { if (!btn.dataset.fail) paint(); });
    btn.disabled = true;
    try {
      await toggleFavSonglist({ id: meta.id, title: meta.title, picurl: meta.picurl, songnum: meta.songnum });
    } catch (e: any) {
      console.warn("收藏歌单失败", e);
      btn.dataset.fail = "1";
      btn.setAttribute("title", String(e?.message ?? e));
      btn.innerHTML = `<span>收藏失败</span>`;
      window.setTimeout(() => {
        delete btn.dataset.fail;
        paint();
      }, 2600);
    } finally {
      btn.disabled = false;
      off();
      if (!btn.dataset.fail) paint();
    }
  };
  return btn;
}

// —— 歌单页：信息头（封面/标题/制作人/描述）+ 歌曲列表（分页拉全） ——
async function playlistView(root: HTMLElement, q: URLSearchParams) {
  const name = q.get("name") || "歌单";
  const id = q.get("id") || "";
  const box = h("div", "v-rows", loadingHtml());
  root.append(box);
  if (!/^\d+$/.test(id)) { box.innerHTML = ""; box.append(emptyState("歌单 id 无效", "检查链接后重试", { label: "回首页", href: "#/" })); return; }

  let info: any = null;
  const songs: any[] = [];
  // 收藏态与自身音乐号跟歌单详情并行取，信息头渲染时按钮已就绪（不等额外往返）
  const favsReady = Promise.all([getMyMusicid(), loadFavSonglists().catch(() => [])]);
  try {
    for (let page = 1; ; page++) {
      const d: any = await api(`/songlist/${id}/detail?page=${page}&num=100`);
      info ??= d?.info;
      songs.push(...(d?.songs ?? []));
      if (!d?.hasmore || (d?.songs ?? []).length === 0) break;
    }
  } catch (e: any) {
    box.innerHTML = "";
    box.append(emptyState("歌单加载失败", String(e.message), { label: "回首页", href: "#/" }));
    return;
  }
  root.innerHTML = "";

  const logo = upPic(info?.picurl || "");
  const metaParts = [info?.creator?.nick ? `${info.creator.nick} 制作` : "", info?.songnum ? `${info.songnum} 首` : ""].filter(Boolean);
  await favsReady.catch(() => {});
  const actions = h("div", "");
  const playAll = playAllButton();
  actions.append(playAll);
  const fav = await favSonglistButton({
    id,
    title: info?.title ?? name,
    picurl: logo,
    songnum: info?.songnum,
    creatorMusicid: info?.creator?.musicid,
  }).catch(() => null);
  if (fav) actions.append(fav);
  mountHead(root, {
    artHtml: logo ? `<img src="${logo}" alt=""/>` : "",
    name: info?.title ?? name,
    meta: metaParts.join(" · "),
    desc: info?.desc || "",
    actions,
  });

  const table = h("div", "");
  table.append(tableHead(true));
  const rows = h("div", "v-rows");
  table.append(rows);
  root.append(table);
  if (!songs.length) {
    rows.append(emptyState("这个歌单是空的", "换个歌单看看", { label: "回首页", href: "#/" }));
    playAll.disabled = true;
    return;
  }
  playAll.onclick = () => player.playList(songs, 0);
  const hooks: RowHooks = { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) };
  renderSongRows(rows, songs, hooks);
}

// 专辑卡网格（歌手页「专辑」标签 / 歌手全部专辑页共用同一套卡面）
function albumCards(albums: any[]): HTMLElement[] {
  return albums.map((x) => {
    const pm: string = x.pmid || x.mid || "";
    const cover = pm ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pm.split("_")[0]}.jpg` : "";
    const sub = [x.album_type, x.time_public].filter(Boolean).join(" · ");
    const href = `#/album?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(x.name || "专辑")}`;
    return navCard(href, cover, x.name || "专辑", sub || "专辑",
      () => cardPlay("album", String(x.mid ?? ""), href));
  });
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
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("div", "v-rows", loadingHtml()));
  if (!mid) { root.innerHTML = ""; root.append(emptyState("缺少歌手信息", "检查链接后重试", { label: "回首页", href: "#/" })); return; }
  // 五路并拉（热门/最新两种排序各拉一份）；简介/专辑失败不阻塞主内容（各 .catch 归 null）
  const [homeInfo, detail, songData, newSongData, albumData] = await Promise.all([
    api<any>(`/singer/${encodeURIComponent(mid)}/info`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/desc`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/songs?num=50&page=1&order=1`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/songs?num=30&page=1&order=2`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/albums?num=30`).catch(() => null),
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
  const head = mountHead(root, {
    artHtml: `<img src="${avatar}" alt=""/>`,
    artRound: true,
    name: displayName,
    meta,
    desc: detail?.desc || "",
  });

  const songs: any[] = songData?.song_list ?? [];
  const hotKeys = new Set(songs.map((s) => s.mid));
  // 最新发布（order=2 按发行时间倒序）：与热门同列风格，去掉与热门完全重合的条目
  const newSongs: any[] = ((newSongData?.song_list ?? []) as any[]).filter((s) => !hotKeys.has(s.mid));
  const albums: any[] = albumData?.album_list ?? [];

  // 播放热门（secondary；收藏歌手无上游接口，不画死按钮）
  const playHot = playAllButton("播放热门");
  playHot.disabled = !songs.length;
  playHot.onclick = () => player.playList(songs, 0);
  head.querySelector(".v-colhead__main")!.append(
    (() => { const a = h("div", "v-pagehead__actions"); a.append(playHot); return a; })(),
  );

  // 标签栏 + 面板组：三块常驻 DOM，select() 只切 hidden
  const tabs = h("div", "v-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.innerHTML = SINGER_TABS.map(
    (t) => `<button class="v-tabs__item" role="tab" type="button" data-tab="${t.key}" aria-selected="${t.key === "hot"}">${t.label}</button>`,
  ).join("");
  const body = h("div", "");
  root.append(tabs, body);

  const songPanel = (list: any[], empty: string) => {
    const p = h("div", "");
    if (!list.length) { p.append(emptyState("这里没有歌曲", empty, { label: "回首页", href: "#/" })); return p; }
    p.append(tableHead(true));
    const rows = h("div", "v-rows");
    p.append(rows);
    renderSongRows(rows, list, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
    return p;
  };

  const hotPanel = songPanel(songs, "没有取到热门歌曲");
  const newPanel = songPanel(newSongs, "暂无新歌");
  const albumPanel = h("div", "");
  if (albums.length) {
    const more = h("div", "sec-row");
    more.style.marginTop = "0";
    more.innerHTML = `<span class="caption-12">共 ${albumData?.total ?? albums.length} 张</span>
      <a class="sec-more" href="#/singer-albums?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(displayName)}">查看全部 ›</a>`;
    const grid = h("div", "v-cards");
    for (const c of albumCards(albums)) grid.append(c);
    albumPanel.append(more, grid);
  } else {
    albumPanel.append(emptyState("暂无专辑", "这位歌手还没有专辑信息", { label: "回首页", href: "#/" }));
  }
  const panels = [hotPanel, newPanel, albumPanel];
  body.append(...panels);

  const select = (key: string) => {
    panels.forEach((p, i) => (p.hidden = SINGER_TABS[i].key !== key));
    tabs.querySelectorAll<HTMLElement>(".v-tabs__item").forEach((b) => {
      const on = b.dataset.tab === key;
      b.classList.toggle("v-tabs__item--active", on);
      b.setAttribute("aria-selected", String(on));
    });
  };
  tabs.querySelectorAll<HTMLElement>(".v-tabs__item").forEach((b) => (b.onclick = () => select(b.dataset.tab!)));
  select("hot");
}

// —— 歌手全部专辑页：信息头复用歌手页样式 + 全部分页拉取专辑网格 ——
async function singerAlbumsView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("div", "v-rows", loadingHtml()));
  if (!mid) { root.innerHTML = ""; root.append(emptyState("缺少歌手信息", "检查链接后重试", { label: "回首页", href: "#/" })); return; }
  // 分页拉全：上游单页封顶 30（num 再大也只回 30），循环条件按 total + 空批兜底
  const albums: any[] = [];
  let total = 0;
  try {
    for (let page = 1; ; page++) {
      const d: any = await api<any>(`/singer/${encodeURIComponent(mid)}/albums?num=30&page=${page}`);
      const batch: any[] = d?.album_list ?? [];
      albums.push(...batch);
      total = d?.total ?? 0;
      if (!batch.length || albums.length >= total) break;
    }
  } catch (e: any) {
    if (!albums.length) { root.innerHTML = ""; root.append(emptyState("专辑加载失败", String(e.message), { label: "回首页", href: "#/" })); return; }
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
  if (!albums.length) { root.append(emptyState("暂无专辑", "这位歌手还没有专辑信息", { label: "回首页", href: "#/" })); return; }
  const grid = h("div", "v-cards");
  for (const c of albumCards(albums)) grid.append(c);
  root.append(grid);
}

// —— 专辑页（点击行内专辑跳转的落点）：detail + songs 两个端点 ——
async function albumView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  root.append(h("div", "v-rows", loadingHtml()));
  if (!mid) { root.innerHTML = ""; root.append(emptyState("缺少专辑信息", "检查链接后重试", { label: "回首页", href: "#/" })); return; }
  try {
    const [detail, list] = await Promise.all([
      api<any>(`/album/${encodeURIComponent(mid)}/detail`).catch(() => null),
      api<any>(`/album/${encodeURIComponent(mid)}/songs?num=100`),
    ]);
    const alb = detail?.album ?? {};
    const songs: any[] = list?.song_list ?? [];
    root.innerHTML = "";
    const picMid = alb.pmid || alb.mid || mid;
    const singers: string = (alb.singer?.length ? alb.singer : detail?.singers ?? []).map((x: any) => x.name).join(" / ");
    const metaParts = [
      singers,
      alb.time_public,
      list?.total_num ? `${list.total_num} 首` : "",
    ].filter(Boolean);
    const actions = h("div", "");
    const playAll = playAllButton();
    playAll.disabled = !songs.length;
    playAll.onclick = () => player.playList(songs, 0);
    actions.append(playAll);
    mountHead(root, {
      artHtml: picMid ? `<img src="https://y.gtimg.cn/music/photo_new/T002R300x300M000${picMid.split("_")[0]}.jpg" alt=""/>` : "",
      name: alb.name ?? "专辑",
      meta: metaParts.join(" · "),
      desc: alb.desc || "",
      actions,
    });
    const table = h("div", "");
    table.append(tableHead(false));
    const box = h("div", "v-rows");
    table.append(box);
    root.append(table);
    if (!songs.length) { box.append(emptyState("这张专辑没有歌曲", "换张专辑看看", { label: "回首页", href: "#/" })); return; }
    renderSongRows(box, songs, { showArtist: true, showAlbum: false, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    root.innerHTML = ""; root.append(emptyState("专辑加载失败", String(e.message), { label: "回首页", href: "#/" }));
  }
}

// —— 列表页公共壳（ForYou 范式：标题区 + 表头 + 行） ——
// actions 里的页面级「播放全部」一律 secondary（描边），不许实心 primary。
function playAllButton(label = "播放全部"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "v-btn v-btn--secondary";
  b.innerHTML = `${icon("play", 16)}${label}`;
  return b;
}

function listPage(root: HTMLElement, title: string, note?: string, actions?: HTMLElement) {
  const head = h("div", "v-pagehead");
  head.innerHTML = `<div class="v-pagehead__main"><h1 class="display-24">${escHtml(title)}</h1>${note ? `<p class="body-14" style="margin: 0; color: var(--ink-muted)">${escHtml(note)}</p>` : ""}</div>`;
  if (actions) {
    const box = h("div", "v-pagehead__actions");
    box.append(actions);
    head.append(box);
  }
  const table = h("div", "");
  table.append(tableHead(true));
  const rows = h("div", "v-rows", loadingHtml());
  table.append(rows);
  root.append(head, table);
  return rows;
}

async function guessView(root: HTMLElement) {
  const playAll = playAllButton();
  const box = listPage(root, "猜你喜欢", "根据收藏与近期播放推荐", playAll);
  try {
    const d: any = await api("/recommend/guess");
    const songs: any[] = d?.songs ?? [];
    if (!songs.length) {
      box.innerHTML = "";
      box.append(emptyState("还没有猜你喜欢", "登录后多听歌，这里会按口味更新", { label: "去看看我喜欢", href: "#/liked" }));
      playAll.disabled = true;
      return;
    }
    playAll.onclick = () => player.playList(songs, 0);
    renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="caption-12">加载失败：${escHtml(e.message)} — 需要先登录</div>`;
    playAll.disabled = true;
  }
}

async function dailyView(root: HTMLElement) {
  // 当日稳定种子：mulberry32(date) —— 同一天刷新顺序不变，隔天换一批
  let t = (Math.floor(Date.now() / 86400000) * 2654435761) >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  // 先探池：无歌 = Daily 空状态屏（占位 + 陈述 + 后果 + 出口），不画列表壳
  let pool: any[];
  try {
    pool = await loadLiked(h("div", ""), {}, 500);
  } catch {
    pool = [];
  }
  if (!pool.length) {
    root.append(h("h1", "display-24", "每日 30 首"));
    root.append(emptyState(
      "今天还没有每日推荐",
      "以我喜欢为基础，每天稳定随机取 30 首。先登录并收藏一些歌",
      { label: "去登录", href: "#/login" },
    ));
    return;
  }
  const picked: any[] = [];
  const idx = pool.map((_, i) => i);
  while (picked.length < 30 && idx.length) {
    const j = Math.floor(rnd() * idx.length);
    picked.push(pool[idx.splice(j, 1)[0]]);
  }
  const playAll = playAllButton();
  const box = listPage(root, "每日 30 首", "每天按日期稳定随机取 30 首", playAll);
  playAll.onclick = () => player.playList(picked, 0);
  renderSongRows(box, picked, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
}

/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */
const sameMids = (a: any[], b: any[]) => a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);

async function likedView(root: HTMLElement) {
  // Likes 头部：160px 封面占位 + 标题 + 等宽计数 + 播放全部（secondary）
  const head = h("div", "v-colhead");
  head.innerHTML = `<div class="v-colhead__art" id="liked-art"></div>
    <div class="v-colhead__main">
      <div><h1 class="display-24">我喜欢</h1><p class="v-colhead__count" id="liked-count"></p></div>
      <p class="body-14" style="margin: 0; color: var(--ink-muted)">在任何列表里按下爱心，歌就会进这里</p>
      <div class="v-pagehead__actions" id="liked-actions"></div>
    </div>`;
  const table = h("div", "");
  table.append(tableHead(true));
  const box = h("div", "v-rows", loadingHtml());
  table.append(box);
  root.append(head, table);
  const art = head.querySelector<HTMLElement>("#liked-art")!;
  const cnt = head.querySelector<HTMLElement>("#liked-count")!;
  const playAll = playAllButton();
  playAll.disabled = true;
  head.querySelector("#liked-actions")!.append(playAll);

  let songs: any[] = [];
  let shown = 0;
  const paintHead = () => {
    shown = Math.max(songs.length, player.likedTotal);
    const total = songs.reduce((a, s) => a + (Number(s.interval) || 0), 0);
    cnt.textContent = shown ? `${shown} 首${total ? ` · ${formatTime(total)}` : ""}` : "";
    const pic = songs.length ? coverUrl(songs[0], 300) : "";
    art.innerHTML = pic ? `<img src="${pic}" alt="" loading="lazy"/>` : "";
  };
  // 取消收藏：行淡出后移出本页 + 计数 -1。只在写接口确认后调用——失败已在 player 侧回滚，不会触发
  const dropRow = (song: any) => {
    const key = String(song._key ?? song.mid ?? "");
    const row = key ? box.querySelector<HTMLElement>(`.v-row[data-songkey="${CSS.escape(key)}"]`) : null;
    if (!row || row.classList.contains("leaving")) return;
    row.classList.add("leaving");
    songs = songs.filter((x) => x !== song);
    setTimeout(() => { row.remove(); paintHead(); }, 220);
  };
  const paint = (list: any[]) => {
    songs = list;
    paintHead();
    playAll.disabled = !songs.length;
    playAll.onclick = () => player.playList(songs, 0);
    renderSongRows(box, songs, {
      showAlbum: true,
      onPlay: (s, i, all) => player.playList(all, i),
      onLove: (song, on) => { if (!on) dropRow(song); }, // 取消红心 = 取消单曲收藏 + 移出本页
    });
  };

  // 预载命中（开机已拉回）：首帧直接出，红心默认全部点亮；随后按 TTL 后台对账，内容变了才重画
  const cached = player.likedCache as any[] | null;
  if (cached) paint(cached);
  const ok = await player.loadLoved();
  if (!ok) {
    if (!cached) {
      box.innerHTML = "";
      box.append(emptyState("还没有收藏的歌曲", "在任何列表里按下爱心，歌就会进这里", { label: "去发现页看看", href: "#/" }));
    }
    return;
  }
  const fresh: any[] = player.likedCache ?? [];
  if (!cached || !sameMids(cached, fresh)) paint(fresh);
}

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
async function settingsView(root: HTMLElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const fontOptions: SelectBoxOption[] = Object.entries(FONT_LABELS).map(([value, label]) => ({ value, label }));
  fontOptions.push({ value: FONT_CUSTOM, label: "自定义" });

  root.append(h("h1", "display-24", "设置"));
  const tabs = h("div", "v-tabs set-tabs", `
    <button class="v-tabs__item v-tabs__item--active" data-tab="appearance" type="button">外观</button>
    <button class="v-tabs__item" data-tab="playback" type="button">播放</button>
    <button class="v-tabs__item" data-tab="general" type="button">通用</button>`);
  root.append(tabs);
  const wrap = h("div", "set-view");
  wrap.innerHTML = `
    <section class="set-panel" data-panel="appearance">
      <div class="set-group">
        <div class="set-label">外观模式</div>
        <div class="set-chips" id="theme-chips">
          <button class="set-chip" data-opt="system" type="button"><span class="set-dot set-dot--system"></span>跟随系统</button>
          <button class="set-chip" data-opt="light" type="button"><span class="set-dot set-dot--light"></span>明镜白</button>
          <button class="set-chip" data-opt="dark" type="button"><span class="set-dot set-dot--dark"></span>玄幻黑</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">窗口装饰 <span class="set-note-inline">仅桌面端生效，切换后自动重建窗口</span></div>
        <div class="set-chips" id="decor-chips">
          <button class="set-chip" data-opt="csd" type="button">自绘标题栏（CSD）</button>
          <button class="set-chip" data-opt="ssd" type="button">系统标题栏（SSD）</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">关闭按钮行为 <span class="set-note-inline">点窗口右上角 ✕ 时（CSD/SSD 通用）</span></div>
        <div class="set-chips" id="close-chips">
          <button class="set-chip" data-opt="tray" type="button">缩放到托盘</button>
          <button class="set-chip" data-opt="quit" type="button">退出程序</button>
        </div>
        <p class="set-hint">缩放到托盘：窗口隐藏，播放与系统托盘图标继续，托盘菜单「退出」才结束程序。</p>
      </div>

      <div class="set-group">
        <div class="set-label">字体设置</div>
        <div class="set-row"><span class="set-row__label">界面字体</span>
          <div class="set-row__ctrl font-row">
            <span id="font-ui"></span>
            <input id="font-ui-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="界面字体 font-family 列表"
              placeholder="留空，如 Source Han Sans, system-ui, sans-serif" />
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">歌词字体</span>
          <div class="set-row__ctrl font-row">
            <span id="font-lyric"></span>
            <input id="font-lyric-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="歌词字体 font-family 列表" placeholder="" />
          </div>
        </div>
        <p class="set-hint">选一个预设字体即可，立即生效，不用自己填。想用自己的字体，选「自定义」，在框里写字体名——多个名字用逗号隔开，靠前的优先，没装就自动用后面的。留空则用默认字体。</p>
      </div>
    </section>

    <section class="set-panel" data-panel="playback" hidden>
      <div class="set-group" id="backend-device"${isMac ? " hidden" : ""}>
        <div class="set-label">音频输出设备</div>
        <div class="set-row"><span class="set-row__label">输出设备</span>
          <div class="set-row__ctrl"><span id="audio-backend"></span></div>
        </div>
        <p class="set-hint" id="audio-device-hint">MPV 引擎下可直选输出设备（PipeWire/Pulse/ALSA…），切换即时生效；浏览器后端跟随系统。</p>
      </div>

      <div class="set-group">
        <div class="set-label">播放引擎 <span class="set-note-inline" id="engine-note">- 默认 MPV，可选浏览器</span></div>
        <div class="set-chips" id="decode-chips">
          <button class="set-chip" data-opt="MPV" type="button">MPV（原生引擎）</button>
          <button class="set-chip" data-opt="Blink" type="button">浏览器 &lt;audio&gt;</button>
        </div>
        <p class="set-hint" id="engine-hint">MPV：主进程原生播放，带内存滑动窗口缓存与设备直选，MPRIS/媒体键体验最完整；浏览器：渲染层 &lt;audio&gt; 兜底。切换即时生效，当前曲目换轨续播。</p>
      </div>

      <div class="set-group">
        <div class="set-label">淡入淡出 <span class="set-note-inline">仅 MPV 引擎生效</span></div>
        <div class="set-chips" id="fade-chips">
          <button class="set-chip" data-opt="off" type="button">关闭</button>
          <button class="set-chip" data-opt="short" type="button">短（0.15s）</button>
          <button class="set-chip" data-opt="normal" type="button">标准（0.4s）</button>
          <button class="set-chip" data-opt="long" type="button">长（0.8s）</button>
        </div>
        <p class="set-hint">起播从静音升到当前音量；暂停 / 切歌 / 停止时先降下来再停（切歌时淡出与下一首的淡入自然衔接）。浏览器 &lt;audio&gt; 后端不生效。</p>
      </div>

      <div class="set-group">
        <div class="set-label">默认音质 <span class="set-note-inline" id="q-member-note"></span></div>
        <div class="set-chips" id="quality-chips">
          <button class="set-chip" data-q="auto" type="button">自动</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">Fallback 排序 <span class="set-note-inline">高档不可用时的降档顺序</span></div>
        <div class="set-chips" id="qfallback-chips">
          <button class="set-chip" data-opt="no-atmos" type="button">不优先全景声</button>
          <button class="set-chip" data-opt="rank" type="button">按标准排序</button>
        </div>
        <p class="set-hint">自动/降档时优先取到「臻品母带」，跳过「臻品全景声」（显式点选全景声不受影响）；「按标准排序」则回退链保持 rank 降序原样。</p>
        <p class="set-hint">档位即时生效（下一首起按新音质协商取链）。臻品母带/全景声等高档位仅限会员；本后端只流播明文档，不提供加密档（QMC）解密。</p>
      </div>
    </section>

    <section class="set-panel" data-panel="general" hidden>
      <div class="set-group">
        <div class="set-label">配置文件</div>
        <p class="set-hint">以下设置全部持久化在系统标准配置目录的 <code>quaver.conf</code>（INI）里，可以直接手改；登录凭证在同一目录，不进浏览器。</p>
        <div class="set-row"><span class="set-row__label">路径</span>
          <div class="set-row__ctrl"><input id="conf-path" readonly /></div>
        </div>
        <div class="set-actions">
          <button class="v-btn v-btn--secondary" id="open-conf" type="button">在文件管理器中显示</button>
          <button class="v-btn v-btn--ghost" id="reset-conf" type="button">恢复默认设置</button>
        </div>
        <p class="set-hint" id="conf-hint"></p>
      </div>

      <div class="set-group">
        <div class="set-label">调试</div>
        <div class="set-actions"><button class="v-btn v-btn--ghost" id="open-log" type="button">打开日志页面</button></div>
      </div>

      <div class="set-group set-about">
        <div class="about-img">
          <img class="ic-dark" src="/quaver-icon-dark.svg" width="60" alt="Quaver Icon">
          <img class="ic-light" src="/quaver-icon.svg" width="60" alt="Quaver Icon">
        </div>
        <h2 class="title-18">Quaver Music</h2>
        <p class="body-14 set-about-sub">又一个基于 Electron + Vite 前端 + TS/Py 混合后端的 QQ 音乐第三方客户端</p>
        <p class="time-12">Version: ${__APP_VERSION__}</p>
      </div>
    </section>`;

  root.append(wrap);

  // 分区 tabs：切换只显隐面板，不重渲染（各面板绑定一次，常驻有效）
  tabs.querySelectorAll<HTMLButtonElement>(".v-tabs__item").forEach((t) => {
    t.onclick = () => {
      tabs.querySelectorAll(".v-tabs__item").forEach((x) => x.classList.toggle("v-tabs__item--active", x === t));
      wrap.querySelectorAll<HTMLElement>(".set-panel").forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    };
  });

  const syncSel = (box: HTMLElement, attr: "opt" | "q", active: string) =>
    box.querySelectorAll<HTMLElement>("[data-" + attr + "]").forEach((b) => b.classList.toggle("sel", b.dataset[attr] === active));

  // 外观模式：跟随系统 / 明镜白 / 玄幻黑（prefs 写 html[data-theme]，style.css 响应）
  const themeBox = wrap.querySelector<HTMLElement>("#theme-chips")!;
  const syncTheme = () => syncSel(themeBox, "opt", getTheme());
  themeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setTheme(b.dataset.opt as any); syncTheme(); }; });
  syncTheme();

  // 窗口装饰：CSD（右上角自绘按钮簇）/ SSD（系统标题栏）。Electron 桥重建窗口；浏览器仅隐藏按钮簇。
  const decorBox = wrap.querySelector<HTMLElement>("#decor-chips")!;
  const syncDecor = () => syncSel(decorBox, "opt", getDecor());
  decorBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setDecor(b.dataset.opt as any); syncDecor(); }; });
  syncDecor();

  // 关闭按钮行为：缩放到托盘 / 退出程序（Electron 桥同步主进程；浏览器 dev 无效果）
  const closeBox = wrap.querySelector<HTMLElement>("#close-chips")!;
  const syncClose = () => syncSel(closeBox, "opt", getCloseAction());
  closeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setCloseAction(b.dataset.opt as any); syncClose(); }; });
  syncClose();

  // Fallback 排序：默认「不优先全景声」（母带优先，atmos51 压链尾兜底）；改动自下一首协商起生效
  const fbBox = wrap.querySelector<HTMLElement>("#qfallback-chips")!;
  const syncFb = () => syncSel(fbBox, "opt", getFallbackSort());
  fbBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setFallbackSort(b.dataset.opt as any); syncFb(); }; });
  syncFb();

  // 淡入淡出预设：持久化 + 立即下发时长（引擎侧做振幅包络；Blink 后端无此项）
  const fadeBox = wrap.querySelector<HTMLElement>("#fade-chips")!;
  const syncFade = () => syncSel(fadeBox, "opt", getFade());
  fadeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => { void player.setFadePreset(b.dataset.opt as FadePreset); syncFade(); };
  });
  syncFade();

  // 字体：下拉给预设，选「自定义」时才出现右侧输入框，可直接编辑 CSS font-family 列表
  // （不必再去手改配置文件）。两边互相同步：选预设 → 填进输入框；输入框改成非预设值 →
  // 下拉自动切到「自定义」。输入即时生效。
  const bindFont = (
    sel: SelectBox,
    input: HTMLInputElement,
    applyList: (css: string) => void,
    pickPreset: (key: string) => void,
    current: string,
  ) => {
    const syncVis = () => { input.hidden = sel.value !== FONT_CUSTOM; };
    input.value = current;
    sel.value = fontKeyOf(current);
    syncVis();
    sel.onchange = () => {
      if (sel.value === FONT_CUSTOM) { syncVis(); input.focus(); return; } // 「自定义」= 保持输入框现有内容，不动配置
      const css = FONT_PRESETS[sel.value]?.css ?? "";
      input.value = css;
      pickPreset(sel.value);
      syncVis();
    };
    input.oninput = () => { applyList(input.value); sel.value = fontKeyOf(input.value); };
    // 失焦时把输入框回写成规范化结果，跟落进配置的值保持一致（多余空格、半截分号都在这里清掉）
    input.onchange = () => {
      const norm = normalizeFontList(input.value);
      if (norm !== input.value) input.value = norm;
      applyList(norm);
      sel.value = fontKeyOf(norm);
      syncVis();
    };
  };
  const mountSel = (mountId: string, ariaLabel: string, value: string) => {
    const box = SelectBox({ ariaLabel, options: fontOptions, value });
    wrap.querySelector<HTMLElement>(mountId)!.replaceWith(box.el);
    return box;
  };
  bindFont(
    mountSel("#font-ui", "界面字体预设", fontKeyOf(getUiFontList())),
    wrap.querySelector<HTMLInputElement>("#font-ui-list")!,
    setUiFontList, setUiFontPreset, getUiFontList(),
  );
  bindFont(
    mountSel("#font-lyric", "歌词字体预设", fontKeyOf(getLyricFontList())),
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
      : "注意：配置目录不可写，本次改动只在本进程内生效。";
  } else {
    confPath.value = "（浏览器模式：设置在 localStorage）";
    confHint.textContent = "当前跑在浏览器里，改动只存在本机浏览器存储；用 Electron 壳层启动才会落到 quaver.conf。";
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
  const engineBox = wrap.querySelector<HTMLElement>("#decode-chips")!;
  const engineChips = engineBox.querySelectorAll<HTMLButtonElement>("[data-opt]");
  const devSel = SelectBox({ ariaLabel: "输出设备", options: [{ value: "auto", label: "系统默认" }], disabled: true });
  wrap.querySelector<HTMLElement>("#audio-backend")!.replaceWith(devSel.el);
  const devHint = wrap.querySelector<HTMLElement>("#audio-device-hint")!;
  const engNote = wrap.querySelector<HTMLElement>("#engine-note")!;

  /** mpv 来源标签：随包运行时 / 系统 mpv / QUAVER_MPV 指定（排障时一眼看出跑的哪一份） */
  const MPV_SOURCE_LABEL: Record<string, string> = { bundled: "随包运行时", path: "系统 mpv", env: "QUAVER_MPV 指定" };

  async function paintBackend() {
    const st = await player.probeEngine();
    engineChips.forEach((b) => {
      b.disabled = b.dataset.opt === "MPV" && !st.available;
      b.onclick = () => { if (!b.disabled) void player.setBackend(b.dataset.opt as "MPV" | "Blink").then(paintAll); };
    });
    syncSel(engineBox, "opt", getDecode());
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
      devSel.setOptions([{ value: "auto", label: "系统默认" }]);
      devHint.textContent = "浏览器 <audio> 后端：跟随系统输出设备；切换到 MPV 引擎后可在此直选设备。";
      return;
    }
    const cur = r.devices.some((d) => d.id === r.current) ? r.current : "auto";
    devSel.setOptions(
      [{ value: "auto", label: "系统默认" }, ...r.devices.map((d) => ({ value: d.id, label: d.desc }))],
      cur,
    );
    devSel.disabled = false;
    devHint.textContent = "切换即时生效，无需重启。";
    devSel.onchange = () => { void player.selectAudioDevice(devSel.value); };
  }

  async function paintAll() { await paintBackend(); await paintDevices(); }
  void paintAll();
  // 引擎传输热切换（启动探测/设置页切换）后刷新设备列表——只在后端真正变化时，别跟着 4Hz notify 空转
  let lastBackend = player.backend;
  player.on(() => {
    if (player.backend !== lastBackend) {
      lastBackend = player.backend;
      void paintBackend();
      void paintDevices();
    }
  });

  // 默认音质：档位由后端按会员等级下发（/stream/tiers）；locked 档画锁标不可选。
  const qBox = wrap.querySelector<HTMLElement>("#quality-chips")!;
  const qNote = wrap.querySelector<HTMLElement>("#q-member-note")!;
  const syncQ = () => syncSel(qBox, "q", getQuality());
  const bindQ = () => {
    qBox.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => {
      if (!b.disabled) b.onclick = () => {
        setQuality(b.dataset.q as any);
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
      btn.className = "set-chip";
      btn.dataset.q = tier.id;
      btn.type = "button";
      btn.innerHTML = `<span>${tier.label}</span>` + (tier.hi_res ? ' <span class="v-tag">Hi-Res</span>' : "")
        + (tier.locked ? ' <span class="v-tag v-tag--outline">会员</span>' : "");
      if (tier.locked) btn.disabled = true;
      qBox.append(btn);
    }
    bindQ(); syncQ();
  }).catch(() => { qNote.textContent = "（音质服务不可用）"; });

  // 调试：日志页面（壳层把 ui/electron-dev.log 经 /api/log 尾部暴露为纯文本，见 relay.ts）
  wrap.querySelector<HTMLElement>("#open-log")!.onclick = () => (location.hash = "#/log");
}

// —— 调试：日志页面（壳层 electron-dev.log 尾部；由 relay.ts /api/log 提供） ——
async function logView(root: HTMLElement) {
  const bar = h("div", "log-bar");
  const pre = h("pre", "log-pre", loadingHtml());
  const back = h("button", "v-btn v-btn--ghost", "返回设置");
  const refresh = h("button", "v-btn v-btn--ghost", "刷新");
  const meta = h("span", "muted");
  bar.append(back, refresh, meta);
  root.append(bar, pre);
  back.onclick = () => (location.hash = "#/settings");
  async function load() {
    meta.innerHTML = loadingInlineHtml("读取中");
    try {
      const r = await fetch("/api/log?tail=800");
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.msg || `HTTP ${r.status}`);
      pre.textContent = await r.text();
      meta.textContent = "来源 ui/electron-dev.log（尾部 800 行）";
      pre.scrollTop = pre.scrollHeight;
    } catch (e: any) {
      pre.innerHTML = "";
      pre.append(h("span", "muted", `读不到日志：${e.message}（Electron 壳层未运行时属正常）`));
      meta.textContent = "";
    }
  }
  refresh.onclick = load;
  await load();
}

async function userView(root: HTMLElement) {
  const wrap = h("div", "me");
  root.append(wrap);
  try {
    const [home, vip] = await Promise.all([
      api<any>("/user/me"),
      api<any>("/user/vip").catch(() => null),
    ]);
    const base = home?.base_info;
    if (!base?.name) { location.hash = "#/login"; return; }
    wrap.innerHTML = `
      <div class="avatar-big">${base.avatar ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>` : ""}</div>
      <h2 class="display-24" style="margin:12px 0 4px">${base.name}</h2>
      <div class="badges" style="justify-content:center">${identityBadges(home, vip)}</div>
      <p class="v-colhead__count">UID: ${base.encrypted_uin ?? ""}</p>
      <button id="logout" class="v-btn v-btn--danger">退出登录</button>`;
    wrap.querySelector<HTMLElement>("#logout")!.onclick = async () => {
      await api("/login/logout", { method: "POST" }).catch(() => {});
      location.href = "/login.html"; // 登录态变化走整页，重置侧栏
    };
  } catch {
    location.hash = "#/login";
  }
}

// —— 登录页（扫码），内容区视图 ——
async function loginView(root: HTMLElement) {
  root.innerHTML = `
    <div class="login">
      <div class="login__main">
        <h2 class="display-24">扫码登录</h2>
        <p class="body-14 login__lead">用手机 QQ 音乐 App、手机 QQ 或微信扫码，在手机上确认即可登录。</p>
        <ol class="body-14 login__steps">
          <li>选择登录通道</li>
          <li>用手机扫右侧二维码</li>
          <li>在手机上确认登录</li>
        </ol>
      </div>
      <div class="login__side">
        <div id="qr" class="login__qr">${loadingHtml("正在生成二维码")}</div>
        <p id="lstate" class="caption-12 login__state" aria-live="polite"></p>
        <div class="login__actions">
          <span id="channel"></span>
          <button id="refresh" class="v-btn v-btn--secondary" type="button">重新生成</button>
        </div>
      </div>
    </div>`;
  const qr = root.querySelector<HTMLElement>("#qr")!;
  const lstate = root.querySelector<HTMLElement>("#lstate")!;
  const setState = (msg: string, isErr = false) => {
    lstate.textContent = msg;
    lstate.classList.toggle("is-err", isErr);
  };
  const channel = SelectBox({
    ariaLabel: "登录通道",
    options: [
      { value: "mobile", label: "QQ 音乐 App" },
      { value: "qq", label: "手机 QQ" },
      { value: "wx", label: "微信" },
    ],
  });
  root.querySelector<HTMLElement>("#channel")!.replaceWith(channel.el);
  let timer: number | undefined;
  let stopped = false;

  async function start() {
    window.clearInterval(timer);
    qr.classList.remove("is-expired");
    qr.innerHTML = loadingHtml("生成中");
    setState("");
    let d: any;
    try {
      d = await api<any>(`/login/qrcode/${channel.value}`);
    } catch (e: any) {
      const msg = /429|backoff|频繁/.test(e.message) ? "操作太快，等 60-90s 再重试" : e.message;
      qr.innerHTML = `<div class="muted">生成失败</div>`;
      setState(msg, true);
      return;
    }
    if (stopped) return;
    qr.innerHTML = `<img src="${d.img}" alt="登录二维码"/>`;
    setState("等待扫码…");

    timer = window.setInterval(async () => {
      if (stopped) { window.clearInterval(timer); return; }
      try {
        const c: any = await api(`/login/qrcode/${channel.value}/status?identifier=${encodeURIComponent(d.identifier)}`);
        if (c.event === 1) return; // SCAN
        if (c.event === 2) { setState("已扫码，请在手机上确认"); return; }
        if (c.event === 3) {
          window.clearInterval(timer);
          setState("二维码已过期，点「重新生成」", true);
          qr.classList.add("is-expired");
          if (!qr.querySelector(".login__qr-retry")) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "v-btn v-btn--primary login__qr-retry";
            retry.textContent = "重新生成";
            retry.onclick = start;
            qr.append(retry);
          }
          return;
        }
        if (c.event === 4) { window.clearInterval(timer); setState("已拒绝登录", true); return; }
        if (c.event === 0 && c.done) {
          window.clearInterval(timer);
          setState("登录成功，正在返回…");
          setTimeout(() => (location.href = "/index.html"), 800);
        }
      } catch { /* 瞬时网络抖动，下一轮再试 */ }
    }, 2000);
  }

  root.querySelector<HTMLElement>("#refresh")!.onclick = start;
  channel.onchange = start;
  start();

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
  const head = h("div", "v-pagehead");
  head.innerHTML = `<div class="v-pagehead__main"><h1 class="display-24">${kw ? `“${kw.replace(/</g, "&lt;")}”的搜索结果` : "搜索"}</h1></div>`;
  const tabs = h("div", "v-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.style.marginBottom = "var(--space-4)";
  tabs.innerHTML = SEARCH_TABS.map(
    (t) => `<button class="v-tabs__item${t.type === tab.type ? " v-tabs__item--active" : ""}" role="tab" aria-selected="${t.type === tab.type}" data-type="${t.type}" type="button">${t.label}</button>`,
  ).join("");
  const box = h("div", "", loadingHtml("搜索中"));
  root.append(head, tabs, box);
  tabs.querySelectorAll<HTMLElement>(".v-tabs__item").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.type === tab.type) return;
      location.hash = `#/search?keyword=${encodeURIComponent(kw)}&type=${b.dataset.type}`;
    };
  });
  if (!kw) {
    // 空关键词：展示热搜词，点一个即搜
    box.innerHTML = "";
    try {
      const d: any = await api("/search/hotkey");
      const keys: string[] = (d?.vec_hotkey ?? []).map((x: any) => x.title || x.query).filter(Boolean);
      if (!keys.length) { box.append(emptyState("输入关键词后回车即可搜索", "或在上方搜索框输入")); return; }
      const chips = h("div", "v-chips");
      for (const k of keys) {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "v-tag";
        c.textContent = k;
        c.onclick = () => {
          pushHistory(k);
          location.hash = `#/search?keyword=${encodeURIComponent(k)}`;
        };
        chips.append(c);
      }
      box.append(chips);
    } catch (e: any) {
      box.innerHTML = `<div class="caption-12">${escHtml(e.message)}</div>`;
    }
    return;
  }
  const go = (page: number) => {
    location.hash = `#/search?keyword=${encodeURIComponent(kw)}&type=${tab.type}&page=${page}`;
  };
  const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
  try {
    const d: any = await api(`/search?keyword=${encodeURIComponent(kw)}&type=${tab.type}&page=${page}&num=30`);
    box.innerHTML = "";
    // 注意：响应各分类字段恒在（其余类为空数组），必须按当前 tab 显式取，不能用 ?? 链
    const list: any[] = (tab.type === "0" ? d?.song : tab.type === "1" ? d?.singer : tab.type === "2" ? d?.album : d?.songlist) ?? [];
    if (!list.length) { box.append(emptyState("没有找到相关内容", "换个关键词试试")); return; }
    const noEm = (s: string) => String(s ?? "").replace(/<\/?em>/gi, "");
    if (tab.type === "0") {
      // 高亮标签兜底剥离：后端 highlight=true，name 里可能带 <em>
      for (const s of list) {
        s.name = noEm(s.name);
        for (const g of s.singer ?? []) g.name = noEm(g.name);
        if (s.album) s.album.name = noEm(s.album.name);
      }
      const table = h("div", "");
      table.append(tableHead(true));
      const rows = h("div", "v-rows");
      table.append(rows);
      box.append(table);
      renderSongRows(rows, list, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
    } else if (tab.type === "1") {
      const grid = h("div", "v-cards");
      for (const x of list) {
        const nm = noEm(x.name) || "歌手";
        // 歌手卡无播放键：人不是可播集合，点进主页再播热门
        grid.append(navCard(
          `#/singer?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(nm)}`,
          x.pic ? upPic(x.pic) : "",
          nm,
          x.song_num ? `歌手 · ${x.song_num} 首` : "歌手",
        ));
      }
      box.append(grid);
    } else if (tab.type === "2") {
      const grid = h("div", "v-cards");
      for (const x of list) {
        const href = `#/album?mid=${encodeURIComponent(x.mid ?? "")}`;
        grid.append(navCard(
          href,
          x.pic ? upPic(x.pic) : "",
          noEm(x.name) || "专辑",
          [noEm(x.singer), x.time_public].filter(Boolean).join(" · ") || "专辑",
          () => cardPlay("album", String(x.mid ?? ""), href),
        ));
      }
      box.append(grid);
    } else {
      const grid = h("div", "v-cards");
      for (const x of list) {
        const href = `#/playlist?id=${encodeURIComponent(x.id ?? x.dirid ?? "")}&name=${encodeURIComponent(noEm(x.title) || "歌单")}`;
        const sub = [x.nickname ? `${noEm(x.nickname)} 创建` : "", x.songnum ? `${x.songnum} 首` : ""].filter(Boolean).join(" · ");
        grid.append(navCard(
          href,
          x.picurl ? upPic(x.picurl) : "",
          noEm(x.title) || "歌单",
          `歌单${sub ? ` · ${sub}` : ""}`,
          () => cardPlay("playlist", String(x.id ?? x.dirid ?? ""), href),
        ));
      }
      box.append(grid);
    }
    const total: number = d?.total_num ?? 0;
    if (d?.nextpage && d.nextpage !== -1) {
      const more = h("div", "v-more");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "v-btn v-btn--ghost";
      btn.textContent = `加载更多（共 ${total || "?"} 条）`;
      btn.onclick = () => go(page + 1);
      more.append(btn);
      box.append(more);
    }
  } catch (e: any) {
    box.innerHTML = `<div class="caption-12">搜索失败：${escHtml(e.message)}</div>`;
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
