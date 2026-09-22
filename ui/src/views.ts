// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, upPic, getQuality, setQuality, setSessionQuality, getStreamTiers, identityBadges } from "./lib/api";
import { renderSongRows, type RowHooks } from "./lib/songs";
import { songListTools } from "./components/ListTools";
import { getMyMusicid, isFavSonglist, loadFavSonglists, onFavSonglistsChange, toggleFavSonglist } from "./lib/favs";
import { pushHistory } from "./components/SearchBox";
import { enqueueNextWithToast, toast } from "./components/SongMenu";
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
import { vipCardHtml } from "./lib/vip";

const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
};

const escHtml = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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
    <p class="muted">从一张歌单开始，听见今天的新声音</p>`));

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
      const d: any = await api("/recommend/songlist?page=1&num=13");
      const list: any[] = d?.songlists ?? [];
      const first = list[0];
      if (!first) {
        homeStatus(featureHost, "暂时没有今日精选", "稍后回来，这里会出现新的推荐", loadPlaylists);
        grid.innerHTML = `<div class="muted">暂无推荐歌单</div>`;
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
        const listens = compactCount(x.listennum);
        const sub = [x.creator_nick || "", listens ? `${listens}次播放` : ""].filter(Boolean).join(" · ") || "歌单";
        grid.append(navCard(cardHref, upPic(x.picurl), cardTitle, sub,
          () => cardPlay("playlist", cardId, cardHref)));
      }
      if (!grid.childElementCount) grid.innerHTML = `<div class="muted">暂无更多推荐</div>`;
    } catch (e: any) {
      homeStatus(featureHost, "推荐加载失败", String(e?.message ?? "网络暂时不可用"), loadPlaylists);
      grid.innerHTML = `<div class="muted">重新加载后显示推荐歌单</div>`;
    }
  };

  const loadNewSongs = async () => {
    playNew.disabled = true;
    playNew.onclick = null;
    newRows.innerHTML = `<div class="muted">加载中…</div>`;
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
  btn.className = "fav-btn";
  btn.dataset.plid = meta.id;
  const paint = () => {
    const on = isFavSonglist(meta.id);
    btn.classList.toggle("on", on);
    btn.innerHTML = `<span class="fb-ic">${on ? "♥" : "♡"}</span><span>${on ? "已收藏" : "收藏"}</span>`;
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
      btn.classList.add("failed");
      btn.setAttribute("title", String(e?.message ?? e));
      btn.innerHTML = `<span class="fb-ic">!</span><span>收藏失败</span>`;
      window.setTimeout(() => {
        delete btn.dataset.fail;
        btn.classList.remove("failed");
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
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);
  if (!/^\d+$/.test(id)) { box.innerHTML = `<div class="muted">歌单 id 无效</div>`; return; }

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
    box.innerHTML = `<div class="muted">加载失败：${e.message}</div>`;
    return;
  }
  root.innerHTML = "";

  const logo = upPic(info?.picurl || "");
  const creator = info?.creator?.nick ? `${info.creator.nick} 制作` : "";
  let songCount = Number(info?.songnum ?? songs.length) || songs.length;
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
    }).catch(() => null),
  });

  const rows = h("div", "rows");
  if (!songs.length) {
    root.append(rows);
    rows.innerHTML = `<div class="muted">歌单为空或不可见</div>`;
    return;
  }
  // 工具条（本地搜索 + 排序）：控件靠右，计数在左。实现见 components/ListTools.ts
  // all 恒为服务端原序（orderlist = 加入歌单的时间），工具条只读它，排序作用在副本上。
  const all = songs;
  const tools = songListTools({
    source: () => all,
    hint: "在歌单内搜索",
    paint: (list) => {
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
        if (songCount > 0) songCount--;
        if (metaEl) metaEl.textContent = [creator, `${songCount} 首`].filter(Boolean).join(" · ");
        tools.refreshCount();
      },
    };
  }
  tools.repaint();
}

// 专辑卡网格（歌手页「专辑」标签 / 歌手全部专辑页共用同一套卡面）
function albumCardsHtml(albums: any[]): string {
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
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
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
  mountHead(root, {
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

  // 标签栏 + 面板组：三块常驻 DOM，select() 只切 hidden
  const tabs = h("div", "tag-tabs");
  tabs.innerHTML = SINGER_TABS.map(
    (t) => `<button class="tag" type="button" data-tab="${t.key}">${t.label}</button>`,
  ).join("");
  const body = h("div", "tag-body");
  root.append(tabs, body);

  const songPanel = (list: any[], empty: string) => {
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
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
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
    if (!albums.length) { root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${e.message}`)); return; }
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
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少专辑 mid</div>`; return; }
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
  } catch (e: any) {
    root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${e.message}`));
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
  const box = listPage(root, "猜你喜欢", "无限电台一次只给 5 首，这里连取多轮去重凑成一批（先出 10 首，再补齐）");
  // 换一批：页头下方、右侧对齐（与列表工具条同一版式语言）
  const bar = h("div", "guess-bar");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost-btn ghost-btn--quiet";
  btn.textContent = "换一批";
  btn.title = "重新向无限电台要一批（每批内容随机）";
  bar.append(btn);
  root.insertBefore(bar, box);

  let songs: any[] = [];
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
    const fresh: any[] = [];        // 先攒在临时数组：失败时手上这批不动
    const seen = new Set<string>();
    const take = (more: any[]) => {
      for (const s of more ?? []) {
        const k = String(s?.mid ?? "");
        if (!k || seen.has(k)) continue; // 多轮之间会撞歌
        seen.add(k);
        fresh.push(s);
      }
    };
    try {
      take(((await api<any>("/recommend/guess?rounds=2"))?.songs ?? []) as any[]);
      if (fresh.length) { songs = fresh; paint(); }  // 首批立刻换上画面
      take(((await api<any>("/recommend/guess?rounds=4"))?.songs ?? []) as any[]);
      if (fresh.length) { songs = fresh; paint(); }  // 补齐（同一个引用随之变长）
      else if (!songs.length) paint();               // 一首都没拿到 → 空态
    } catch (e: any) {
      // 第二批失败不算失败：保住首批（上游这条链路偶发节流，宁可少几首也别整页报错）
      if (!songs.length) box.innerHTML = `<div class="muted">${e.message}</div>`;
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
    const d: any = await api("/recommend/daily?page=1&num=100"); // 30 首一把拿全，不用翻页
    const songs: any[] = d?.songs ?? [];
    // 服务端那句编辑语（「甄选私人好品味：今日份的 X、Y、Z…」）比我们自己编的说明好看
    if (note && d?.info?.desc) note.textContent = d.info.desc;
    if (!songs.length) {
      box.innerHTML = `<div class="muted">今天的 30 首还没生成，稍后再来（也确认下是否已登录）</div>`;
      return;
    }
    box.innerHTML = "";
    renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="muted">${e.message} — 需要先登录</div>`;
  }
}

/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */
const sameMids = (a: any[], b: any[]) => a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);

async function likedView(root: HTMLElement) {
  root.append(h("h1", "page-title", "我喜欢 "));
  const cnt = h("span", "muted cnt");
  root.querySelector("h1")!.append(cnt);
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);

  let items: any[] = []; // 原序 = 收藏顺序（服务端返回的顺序），工具条只读它
  let shown = 0; // 标题计数（服务端 total 优先：超预载上限时也报真实总数）
  const setCount = (n: number) => { shown = Math.max(0, n); cnt.textContent = shown ? `· ${shown} 首` : ""; };
  // 取消收藏：行淡出后移出本页 + 计数 -1。只在写接口确认后调用——失败已在 player 侧回滚，不会触发
  const dropRow = (song: any) => {
    // 从原序里也摘掉：player.likedCache 是**换新数组**（filter），这里的 items 还指着旧数组，
    // 不摘的话下次重排/筛选会把这行放回来。
    const at = items.indexOf(song);
    if (at >= 0) items.splice(at, 1);
    const key = String(song._key ?? song.mid ?? "");
    const row = key ? box.querySelector<HTMLElement>(`.row[data-songkey="${CSS.escape(key)}"]`) : null;
    if (row && !row.classList.contains("leaving")) {
      row.classList.add("leaving");
      setTimeout(() => row.remove(), 220);
    }
    setCount(shown - 1);
    tools.refreshCount();
  };

  // 工具条（本地搜索 + 排序；与歌单页共用 components/ListTools.ts）
  const tools = songListTools({
    source: () => items,
    hint: "在我喜欢内搜索",
    paint: (songs, st) => {
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
  const adopt = (songs: any[]) => { items = songs; tools.repaint(); };

  // 预载命中（开机已拉回）：首帧直接出，红心默认全部点亮；随后按 TTL 后台对账，内容变了才重画
  const cached = player.likedCache as any[] | null;
  if (cached) adopt(cached);
  const ok = await player.loadLoved();
  if (!ok) {
    if (!cached) {
      tools.el.remove(); // 拉不到就别摆一排没用的控件
      box.innerHTML = `<div class="muted">加载失败 — 需要先登录</div>`;
    }
    return;
  }
  const fresh: any[] = player.likedCache ?? [];
  if (!cached || !sameMids(cached, fresh)) adopt(fresh);
}

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
async function settingsView(root: HTMLElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const fontOptions = Object.entries(FONT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")
    + `<option value="${FONT_CUSTOM}">自定义</option>`;
  const decodeRow = (name: string, label: string, disabled = false) =>
    `<label><input type="radio" name="decode" value="${name}"${disabled ? " disabled" : ""}/>${label}${disabled ? ` <span class="muted soon">敬请期待</span>` : ""}</label>`;

  root.append(h("h1", "page-title", "设置"));
  // 分区标签：只切显隐，不重渲染（各面板绑定一次常驻有效）
  const tabs = h("div", "set-tabs", `
    <button class="set-tab is-active" data-tab="appearance" type="button">外观</button>
    <button class="set-tab" data-tab="playback" type="button">播放</button>
    <button class="set-tab" data-tab="general" type="button">通用</button>`);
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

      <div class="set-group">
        <div class="set-label">窗口装饰 <span class="set-note-inline">仅桌面端生效，切换后自动重建窗口</span></div>
        <div class="opt-cards" id="decor-cards">
          <button class="opt-card" data-opt="csd" type="button">自绘标题栏（CSD）</button>
          <button class="opt-card" data-opt="ssd" type="button">系统标题栏（SSD）</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">关闭按钮行为 <span class="set-note-inline">点窗口右上角 ✕ 时（CSD/SSD 通用）</span></div>
        <div class="opt-cards" id="close-cards">
          <button class="opt-card" data-opt="tray" type="button">缩放到托盘</button>
          <button class="opt-card" data-opt="quit" type="button">退出程序</button>
        </div>
        <p class="muted set-hint">缩放到托盘：窗口隐藏，播放与系统托盘图标继续，托盘菜单「退出」才结束程序。</p>
      </div>

      <div class="set-group">
        <div class="set-label">字体设置</div>
        <div class="set-row"><span class="set-row__label">界面字体</span>
          <div class="set-row__ctrl font-row">
            <select id="font-ui" aria-label="界面字体预设">${fontOptions}</select>
            <input id="font-ui-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="界面字体 font-family 列表"
              placeholder="留空，如 Source Han Sans, system-ui, sans-serif" />
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">歌词字体</span>
          <div class="set-row__ctrl font-row">
            <select id="font-lyric" aria-label="歌词字体预设">${fontOptions}</select>
            <input id="font-lyric-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="歌词字体 font-family 列表" placeholder="" />
          </div>
        </div>
        <p class="muted set-hint">输入框里填的就是 CSS font-family 列表（逗号分隔、按优先级挑第一个装得上的），改完即时生效；留空表示不覆盖，走内置默认栈。</p>
      </div>
    </section>

    <section class="set-panel" data-panel="playback" hidden>
      <div class="set-group" id="backend-device"${isMac ? " hidden" : ""}>
        <div class="set-label">音频输出设备</div>
        <div class="set-row"><span class="set-row__label">输出设备</span>
          <div class="set-row__ctrl"><select id="audio-backend" disabled><option>系统默认</option></select></div>
        </div>
        <p class="muted set-hint" id="audio-device-hint">MPV 引擎下可直选输出设备（PipeWire/Pulse/ALSA…），切换即时生效；浏览器后端跟随系统。</p>
      </div>

      <div class="set-group">
        <div class="set-label">播放引擎 <span class="set-note-inline" id="engine-note">- 默认 MPV，可选浏览器</span></div>
        <div class="opt-radios" id="decode-radios">
          ${decodeRow("MPV", "MPV（原生引擎）")}${decodeRow("Blink", "浏览器 &lt;audio&gt;")}
        </div>
        <p class="muted set-hint" id="engine-hint">MPV：主进程原生播放，带内存滑动窗口缓存与设备直选，MPRIS/媒体键体验最完整；浏览器：渲染层 &lt;audio&gt; 兜底。切换即时生效，当前曲目换轨续播。</p>
      </div>

      <div class="set-group">
        <div class="set-label">淡入淡出 <span class="set-note-inline">仅 MPV 引擎生效</span></div>
        <div class="opt-cards" id="fade-cards">
          <button class="opt-card" data-opt="off" type="button">关闭</button>
          <button class="opt-card" data-opt="short" type="button">短（0.15s）</button>
          <button class="opt-card" data-opt="normal" type="button">标准（0.4s）</button>
          <button class="opt-card" data-opt="long" type="button">长（0.8s）</button>
        </div>
        <p class="muted set-hint">起播从静音升到当前音量；暂停 / 切歌 / 停止时先降下来再停（切歌时淡出与下一首的淡入自然衔接）。浏览器 &lt;audio&gt; 后端不生效。</p>
      </div>

      <div class="set-group">
        <div class="set-label">默认音质 <span class="set-note-inline" id="q-member-note"></span></div>
        <div class="opt-cards" id="quality-grid">
          <button class="opt-card q" data-q="auto" type="button">自动</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">Fallback 排序 <span class="set-note-inline">高档不可用时的降档顺序</span></div>
        <div class="opt-cards" id="qfallback-cards">
          <button class="opt-card" data-opt="no-atmos" type="button">不优先全景声</button>
          <button class="opt-card" data-opt="rank" type="button">按标准排序</button>
        </div>
        <p class="muted set-hint">自动/降档时优先取到「臻品母带」，跳过「臻品全景声」（显式点选全景声不受影响）；「按标准排序」则回退链保持 rank 降序原样。</p>
        <p class="muted set-hint">档位即时生效（下一首起按新音质协商取链）。臻品母带/全景声等高档位仅限会员；本后端只流播明文档，不提供加密档（QMC）解密。</p>
      </div>
    </section>

    <section class="set-panel" data-panel="general" hidden>
      <div class="set-group">
        <div class="set-label">配置文件</div>
        <p class="muted set-hint">以下设置全部持久化在系统标准配置目录的 <code>quaver.conf</code>（INI）里，可以直接手改；登录凭证加密存在系统密钥管理器里，不在这个目录、也不进浏览器。</p>
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
        <h4> 又一个基于 Electron + Vite 前端 + TS/Py 混合后端的 QQ 音乐第三方客户端</h4>
        <small> Version: ${__APP_VERSION__} </small>
      </div>
    </section>`;

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

  const syncSel = (box: HTMLElement, attr: "opt" | "q", active: string) =>
    box.querySelectorAll<HTMLElement>("[data-" + attr + "]").forEach((b) => b.classList.toggle("sel", b.dataset[attr] === active));

  // 外观模式：跟随系统 / 明镜白 / 玄幻黑（prefs 写 html[data-theme]，style.css 响应）
  const themeBox = wrap.querySelector<HTMLElement>("#theme-cards")!;
  const syncTheme = () => syncSel(themeBox, "opt", getTheme());
  themeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setTheme(b.dataset.opt as any); syncTheme(); }; });
  syncTheme();

  // 窗口装饰：CSD（右上角自绘按钮簇）/ SSD（系统标题栏）。Electron 桥重建窗口；浏览器仅隐藏按钮簇。
  const decorBox = wrap.querySelector<HTMLElement>("#decor-cards")!;
  const syncDecor = () => syncSel(decorBox, "opt", getDecor());
  decorBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setDecor(b.dataset.opt as any); syncDecor(); }; });
  syncDecor();

  // 关闭按钮行为：缩放到托盘 / 退出程序（Electron 桥同步主进程；浏览器 dev 无效果）
  const closeBox = wrap.querySelector<HTMLElement>("#close-cards")!;
  const syncClose = () => syncSel(closeBox, "opt", getCloseAction());
  closeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setCloseAction(b.dataset.opt as any); syncClose(); }; });
  syncClose();

  // Fallback 排序：默认「不优先全景声」（母带优先，atmos51 压链尾兜底）；改动自下一首协商起生效
  const fbBox = wrap.querySelector<HTMLElement>("#qfallback-cards")!;
  const syncFb = () => syncSel(fbBox, "opt", getFallbackSort());
  fbBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setFallbackSort(b.dataset.opt as any); syncFb(); }; });
  syncFb();

  // 淡入淡出预设：持久化 + 立即下发时长（引擎侧做振幅包络；Blink 后端无此项）
  const fadeBox = wrap.querySelector<HTMLElement>("#fade-cards")!;
  const syncFade = () => syncSel(fadeBox, "opt", getFade());
  fadeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => { void player.setFadePreset(b.dataset.opt as FadePreset); syncFade(); };
  });
  syncFade();

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
      const css = FONT_PRESETS[sel.value]?.css ?? "";
      input.value = css;
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
    const cur = r.devices.some((d) => d.id === r.current) ? r.current : "auto";
    devSel.value = cur;
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
  const qBox = wrap.querySelector<HTMLElement>("#quality-grid")!;
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
      api<any>("/user/me"),
      api<any>("/user/vip").catch(() => null),
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
  let channel = tabs[0]?.dataset.ch ?? "mobile";
  let timer: number | undefined;
  let stopped = false;

  async function start() {
    window.clearInterval(timer);
    qr.innerHTML = `<div class="muted">生成中…</div>`;
    lstate.textContent = "";
    let d: any;
    try {
      d = await api<any>(`/login/qrcode/${channel}`);
    } catch (e: any) {
      qr.innerHTML = `<div class="muted">${/429|backoff|频繁/.test(e.message) ? "操作太快，等 60-90s 再重试" : e.message}</div>`;
      return;
    }
    if (stopped) return;
    qr.innerHTML = `<img src="${d.img}" alt="登录二维码"/>`;
    lstate.textContent = "等待扫码…";

    timer = window.setInterval(async () => {
      if (stopped) { window.clearInterval(timer); return; }
      try {
        const c: any = await api(`/login/qrcode/${channel}/status?identifier=${encodeURIComponent(d.identifier)}`);
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
      const ch = b.dataset.ch!;
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
      const d: any = await api("/search/hotkey");
      const keys: string[] = (d?.vec_hotkey ?? []).map((x: any) => x.title || x.query).filter(Boolean);
      box.innerHTML = keys.length
        ? `<div class="hot-chips">${keys.map((k) => `<button class="chip" type="button">${k.replace(/</g, "&lt;")}</button>`).join("")}</div>`
        : `<div class="muted">输入关键词后回车即可搜索</div>`;
      box.querySelectorAll<HTMLElement>(".chip").forEach((c) => {
        c.onclick = () => {
          pushHistory(c.textContent || "");
          location.hash = `#/search?keyword=${encodeURIComponent(c.textContent || "")}`;
        };
      });
    } catch (e: any) {
      box.innerHTML = `<div class="muted">${e.message}</div>`;
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
    if (!list.length) { box.innerHTML = `<div class="muted">没有找到相关内容</div>`; return; }
    const noEm = (s: string) => String(s ?? "").replace(/<\/?em>/gi, "");
    if (tab.type === "0") {
      // 高亮标签兜底剥离：后端 highlight=true，name 里可能带 <em>
      for (const s of list) {
        s.name = noEm(s.name);
        for (const g of s.singer ?? []) g.name = noEm(g.name);
        if (s.album) s.album.name = noEm(s.album.name);
      }
      // 双击 = 插队播放：排到当前曲之后等着播（不清空、也不打断正在放的列表）
      renderSongRows(box, list, { showAlbum: true, onPlay: (s) => enqueueNextWithToast(s) });
    } else if (tab.type === "1") {
      box.classList.add("grid");
      box.innerHTML = list.map((x) => `<a class="card" href="#/singer?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(noEm(x.name) || "歌手")}">
          <div class="art round">${x.pic ? `<img src="${upPic(x.pic)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${noEm(x.name) || "歌手"}</div><div class="sub">${x.song_num ? `${x.song_num} 首` : ""}</div></a>`).join("");
    } else if (tab.type === "2") {
      box.classList.add("grid");
      box.innerHTML = list.map((x) => `<a class="card" href="#/album?mid=${encodeURIComponent(x.mid ?? "")}">
          <div class="art">${x.pic ? `<img src="${upPic(x.pic)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${noEm(x.name) || "专辑"}</div>
          <div class="sub">${noEm(x.singer)}${x.time_public ? ` · ${x.time_public}` : ""}</div></a>`).join("");
    } else {
      box.className = "grid playlist-grid";
      box.innerHTML = list.map((x) => `<a class="card" href="#/playlist?id=${encodeURIComponent(x.id ?? x.dirid ?? "")}&name=${encodeURIComponent(noEm(x.title) || "歌单")}">
          <div class="art">${x.picurl ? `<img src="${upPic(x.picurl)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${noEm(x.title) || "歌单"}</div>
          <div class="sub">${x.nickname ? noEm(x.nickname) + " 创建" : ""}${x.songnum ? ` · ${x.songnum} 首` : ""}</div></a>`).join("");
    }
    const total: number = d?.total_num ?? 0;
    if (d?.nextpage && d.nextpage !== -1) {
      const more = h("div", "more-bar");
      const btn = h("button", "ghost-btn", `加载更多（共 ${total || "?"} 条）`);
      btn.onclick = () => go(page + 1);
      more.append(btn);
      box.append(more);
    }
  } catch (e: any) {
    box.innerHTML = `<div class="muted">搜索失败：${e.message}</div>`;
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
