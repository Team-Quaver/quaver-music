// Quaver — 路由视图：singer（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api, songSubtitle, songTitle, upPic } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import type { AlbumBrief, SingerDescResp, SingerInfoResp, SingerSongsResp } from "./_shared";
import { albumCardsHtml, fetchSingerAlbums, h, mountHead, mountStickyBar, playAllButton } from "./_shared";

// —— 歌手页（点击行内歌手跳转的落点）：信息头 + 分类标签（热歌 / 新歌 / 专辑） ——
// 三块内容一次性并拉，标签只决定「显示哪一块」：切换不重新请求、不重置 .route 滚动位置。
// 默认落在「热歌」。信息头仍与歌单/专辑页同一套（左图右文、上对齐）。
const SINGER_TABS = [
  { key: "hot", label: "热歌" },
  { key: "new", label: "新歌" },
  { key: "album", label: "专辑" },
] as const;

export default async function singerView(root: HTMLElement, q: URLSearchParams) {
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
    fetchSingerAlbums(mid),
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

  // 吸顶单行条：小头像 + 歌手名在左；条内右侧 = 搜索框 + 分类标签（热歌/新歌/专辑），
  // 两件一起吸顶（下翻时常驻）。搜索框排在筛选标签**左边**（先搜后筛的阅读顺序）。
  const sticky = mountStickyBar(root, { artHtml: `<img src="${avatar}" alt=""/>`, round: true, name: displayName });
  const search = h("span", "sb-field lt-search");
  search.innerHTML = `<span class="sb-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg></span>
    <input class="sticky-kw" type="search" placeholder="在歌手内搜索" autocomplete="off" spellcheck="false" aria-label="在歌手内搜索"/>
    <button class="lt-clr" type="button" title="清空" aria-label="清空搜索" hidden>✕</button>`;
  const kwEl = search.querySelector<HTMLInputElement>(".sticky-kw")!;
  const clrEl = search.querySelector<HTMLButtonElement>(".lt-clr")!;
  /** 当前关键词（原样表小写）：空 = 不筛 */
  const query = () => kwEl.value.trim().toLowerCase();

  /** 一首歌是否命中：曲名（含版本后缀）/ 副标题 / 歌手 / 专辑，字段间用分隔符，避免跨字段假命中 */
  const hitSong = (song: Song) => {
    const q = query();

    if (!q) return true;

    const hay = [
      songTitle(song), songSubtitle(song),
      (song.singer ?? []).map((x) => x?.name ?? "").join(" "),
      song.album?.name ?? "",
    ].join("\u0001").toLowerCase();

    return hay.includes(q);
  };

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
  sticky.right.append(search, tabs); // 条内右侧：搜索框 + 分类标签（一起吸顶）
  // 「播放全部」放吸顶条最右：播**当前 Tag 面板 + 搜索筛选**后的可见列表；
  // 专辑面板没有可播歌列（是卡片网格不是歌），置灰。各曲目面板重画时上报自己的可见列表。
  let activeTab = "hot";
  let activePanel: HTMLElement | null = null;
  const panelSongs = new Map<HTMLElement, Song[]>();

  const playAll = playAllButton(() =>
    activePanel && activeTab !== "album" ? panelSongs.get(activePanel) ?? [] : []);

  sticky.right.append(playAll.el);
  root.append(body);

  // 三个面板各自记住了「重画」函数：关键词一变就按原数组重筛重画（序号连续、空态文案分清
  // 「搜索没命中」与「本来就没有」）。搜索只作用在已拉回的本地数据上，不发请求。
  const painters: (() => void)[] = [];

  const songPanel = (src: () => Song[], empty: string) => {
    const p = h("div", "tag-panel");
    const rows = h("div", "rows");
    p.append(rows);

    const paint = () => {
      const list = src().filter(hitSong);
      panelSongs.set(p, list); // 上报可见列表给「播放全部」（当前面板才被读）
      playAll.sync();

      if (!list.length) {
        rows.innerHTML = `<div class="muted">${query() ? "没有匹配的歌曲" : empty}</div>`;

        return;
      }

      renderSongRows(rows, list, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
    };

    painters.push(paint);
    paint();

    return p;
  };

  const hotPanel = songPanel(() => songs, "没有取到热门歌曲");
  const newPanel = songPanel(() => newSongs, "暂无新歌");
  const albumPanel = h("div", "tag-panel");

  if (albums.length) {
    const more = h("div", "sec-row");
    more.style.marginTop = "0";
    more.innerHTML = `<span class="muted">共 ${albumData?.total ?? albums.length} 张</span>
      <a class="sec-more" href="#/singer-albums?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(displayName)}">查看全部 ›</a>`;
    const grid = h("div", "grid");
    grid.innerHTML = albumCardsHtml(albums);
    const none = h("div", "rows muted", "没有匹配的专辑");
    none.hidden = true; // 只在筛空时露出来
    albumPanel.append(more, grid, none);
    painters.push(() => {
      const q = query();
      let shown = 0;

      for (const card of grid.querySelectorAll<HTMLElement>(".card")) {
        const hit = !q || (card.textContent ?? "").toLowerCase().includes(q);
        card.hidden = !hit;

        if (hit) shown++;
      }

      none.hidden = !q || shown > 0;
      more.hidden = !!q; // 搜索态下「共 N 张 / 查看全部」先收起来，免得跟筛选结果打架
    });
  } else {
    albumPanel.innerHTML = `<div class="rows muted">暂无专辑</div>`;
  }

  const panels = [hotPanel, newPanel, albumPanel];
  body.append(...panels);

  // 搜索框接线：输入合并 120ms（与 ListTools 同口径），✕ / Esc 立即重画
  let kwTimer = 0;

  const runFilter = () => {
    window.clearTimeout(kwTimer);
    kwTimer = 0;
    clrEl.hidden = !query();

    for (const paint of painters) paint();
  };

  kwEl.addEventListener("input", () => {
    clrEl.hidden = !query();
    window.clearTimeout(kwTimer);
    kwTimer = window.setTimeout(runFilter, 120);
  });
  kwEl.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    kwEl.value = "";
    runFilter();
  });
  clrEl.addEventListener("click", () => { kwEl.value = ""; kwEl.focus(); runFilter(); });

  const select = (key: string) => {
    const idx = SINGER_TABS.findIndex((t) => t.key === key);
    activeTab = key;
    activePanel = idx >= 0 ? panels[idx] : null;
    panels.forEach((p, i) => (p.hidden = SINGER_TABS[i].key !== key));
    tabs.querySelectorAll<HTMLElement>(".tag").forEach((b) => b.classList.toggle("sel", b.dataset.tab === key));
    playAll.sync(); // 切到专辑 Tag → 没有可播列表，按钮置灰
  };

  // 切换动画门闩（.tab-anim 见 style.css）：首次点击才挂上，首屏入场交给 .route>.entering；
  // 重复点当前标签直接返回，否则会把已显示的面板重播一次、看着像闪了一下。
  tabs.querySelectorAll<HTMLElement>(".tag").forEach((b) => (b.onclick = () => {
    if (b.classList.contains("sel")) return;
    body.classList.add("tab-anim");
    select(b.dataset.tab!);
  }));
  select("hot");

  return () => { window.clearTimeout(kwTimer); sticky.off(); }; // 滚动监听退订交给 renderRoute
}

// —— 歌手全部专辑页：信息头复用歌手页样式 + 全部分页拉取专辑网格 ——
