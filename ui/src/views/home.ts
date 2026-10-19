// Quaver — 路由视图：home（由 src/views/index.ts 按需动态 import，不在首屏解析）
import "./home.css";
import { api, upPic } from "../lib/api";
import { icons } from "../lib/icons";
import { renderSongRows } from "../lib/songs";
import { periodCaption } from "../lib/toplist-periods";
import { player } from "../player";
import type { Song } from "../player";
import { toast } from "../components/SongMenu";
import type {
  RecommendSonglistResp, SonglistCard, ToplistCard, ToplistCategoryResp, ToplistGroup,
} from "./_shared";
import { cardPlay, compactCount, errText, h, homeStatus, navCard, routeScroller, trackStuck } from "./_shared";

interface AISonglistResp extends RecommendSonglistResp { total?: number; hasmore?: boolean }

// —— 首页：页头 + 双栏领区（快速开始 / 新歌速递）+ 推荐网格 + AI 歌单 + 排行榜 ——
// 四个数据源并行、独立降级：任一失败不影响其他块，各自原地给重试。
export default async function homeView(root: HTMLElement) {
  const homeHead = h("div", "sticky-head home-pagehead", `
    <h1 class="page-title">首页</h1>
    <p class="muted">从歌单和新歌开始，开启今日</p>`);
  root.append(homeHead);
  const offHead = trackStuck(homeHead, routeScroller(root));

  const lead = h("div", "home-lead");

  const quickStart = h("section", "home-panel");
  const quickHead = h("div", "sec-head home-quick-head", `<h2>快速开始</h2>`);
  const quick = h("div", "home-quick");
  const addQuickAction = (label: string, icon: string, run: () => void) => {
    const btn = h("button", "home-quick__item",
      `<span class="home-quick__icon" aria-hidden="true">${icon}</span><span class="home-quick__label">${label}</span>`) as HTMLButtonElement;
    btn.type = "button";
    btn.onclick = run;
    quick.append(btn);
  };
  addQuickAction("猜你喜欢 - 无限电台", icons.radio, () => {
    if (player.radioLoading) return;
    void player.startRadio().catch((e) => {
      if (root.isConnected) toast(errText(e) || "猜你喜欢暂时不可用", "err");
    });
  });
  addQuickAction("每日三十首", icons.calendar, () => { location.hash = "#/daily"; });
  addQuickAction("我喜欢", icons.heart, () => { location.hash = "#/liked"; });
  quickStart.append(quickHead, quick);

  const newest = h("section", "home-panel");
  const newHead = h("div", "sec-head sec-head--split");
  newHead.innerHTML = `<div class="sec-head__title"><h2>新歌速递</h2><span class="muted">最新发行</span></div>`;
  const playNew = h("button", "ghost-btn", "播放全部") as HTMLButtonElement;
  playNew.type = "button";
  playNew.disabled = true;
  newHead.append(playNew);
  const newRows = h("div", "rows home-new-list", `<div class="muted">加载中…</div>`);
  newest.append(newHead, newRows);

  lead.append(quickStart, newest);

  const recommendations = h("section", "home-recommendations");
  recommendations.innerHTML = `<div class="sec-head">
    <h2>推荐歌单</h2><span class="muted">为你挑选</span>
  </div>`;
  const grid = h("div", "grid playlist-grid home-cards", `<div class="muted">加载中…</div>`);
  recommendations.append(grid);

  const ai = h("section", "home-ai");
  const aiHead = h("div", "sec-head sec-head--split");
  aiHead.innerHTML = `<div class="sec-head__title home-ai__title">
    <h2><span class="home-ai__icon" aria-hidden="true">${icons.sparkles}</span>AI 歌单</h2>
    <span class="muted">顺着你的口味继续</span>
  </div>`;
  const aiRefresh = h("button", "ghost-btn home-ai__refresh", "换一批") as HTMLButtonElement;
  aiRefresh.type = "button";
  aiRefresh.disabled = true;
  aiHead.append(aiRefresh);
  const aiGrid = h("div", "grid playlist-grid home-cards home-ai__grid", `<div class="muted">正在生成…</div>`);
  aiGrid.setAttribute("aria-live", "polite");
  ai.append(aiHead, aiGrid);

  const toplist = h("section", "home-toplist");
  const topHead = h("div", "sec-head sec-head--split home-toplist__head");
  topHead.innerHTML = `<div class="sec-head__title">
    <h2>排行榜</h2><span class="muted">近三个月期次可回溯</span>
  </div>`;
  const topGroups = h("div", "tag-tabs home-toplist__groups");
  topHead.append(topGroups);
  const topGrid = h("div", "grid playlist-grid home-cards home-toplist__grid", `<div class="muted">加载中…</div>`);
  toplist.append(topHead, topGrid);

  root.append(lead, recommendations, ai, toplist);

  const playlistCard = (x: SonglistCard, aiPick = false): HTMLElement | null => {
    const id = String(x.id ?? "");
    if (!id) return null;
    const title = String(x.title ?? "歌单");
    const href = `#/playlist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(title)}`;
    const listens = compactCount(x.listennum);
    const sub = aiPick
      ? ["AI 生成", listens ? `${listens}次播放` : ""].filter(Boolean).join(" · ")
      : [x.creator_nick || "", listens ? `${listens}次播放` : ""].filter(Boolean).join(" · ") || "歌单";
    const card = navCard(href, upPic(x.picurl), title, sub,
      () => cardPlay("playlist", id, href));
    if (aiPick) {
      card.classList.add("ai-card");
      card.querySelector(".art")?.insertAdjacentHTML("beforeend", `<span class="ai-card__badge">AI</span>`);
    }
    return card;
  };

  const loadPlaylists = async () => {
    grid.innerHTML = `<div class="muted">加载中…</div>`;
    try {
      const list = (await api<RecommendSonglistResp>("/recommend/songlist?page=1&num=13"))?.songlists ?? [];
      if (!list.length) {
        homeStatus(grid, "暂时没有推荐歌单", "稍后回来看看", loadPlaylists);
        return;
      }

      grid.innerHTML = "";
      for (const x of list.slice(0, 13)) {
        const card = playlistCard(x);
        if (card) grid.append(card);
      }
      if (!grid.childElementCount) homeStatus(grid, "暂时没有推荐歌单", "稍后回来看看", loadPlaylists);
    } catch (e) {
      homeStatus(grid, "推荐歌单加载失败", errText(e) || "网络暂时不可用", loadPlaylists);
    }
  };

  const toplistCard = (x: ToplistCard): HTMLElement | null => {
    const id = String(x.id ?? "");
    if (!id) return null;
    const title = String(x.title ?? "排行榜");
    const canBacktrack = x.history_supported !== false;
    const href = `#/toplist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(title)}${canBacktrack ? "" : "&history=0"}`;
    const listens = compactCount(x.listennum);
    const cadence = x.update_tips || (Number(x.update_type) === 0 ? "每周更新" : "每日更新");
    const sub = [cadence, canBacktrack ? periodCaption(x.period) : "仅当前期", listens ? `${listens}次播放` : ""]
      .filter(Boolean).join(" · ");
    const card = navCard(href, upPic(x.picurl), title, sub,
      () => cardPlay("toplist", id, href));
    card.querySelector(".art")?.insertAdjacentHTML("beforeend", `<span class="ai-card__badge">榜</span>`);
    return card;
  };

  let topData: ToplistGroup[] = [];
  let selectedTopGroup = 0;
  const paintTopGroups = () => {
    topGroups.innerHTML = "";
    if (topData.length <= 1) return;
    topData.forEach((group, index) => {
      const btn = h("button", `tag${index === selectedTopGroup ? " sel" : ""}`, "") as HTMLButtonElement;
      btn.type = "button";
      btn.textContent = group.name || `分类 ${index + 1}`;
      btn.onclick = () => {
        selectedTopGroup = index;
        paintTopGroups();
        paintTopGroup();
      };
      topGroups.append(btn);
    });
  };
  const paintTopGroup = () => {
    topGrid.innerHTML = "";
    const list = topData[selectedTopGroup]?.toplists ?? [];
    for (const x of list) {
      const card = toplistCard(x);
      if (card) topGrid.append(card);
    }
    if (!topGrid.childElementCount) homeStatus(topGrid, "这个分类暂时没有榜单", "稍后回来看看", loadToplists);
  };
  const loadToplists = async () => {
    topGroups.innerHTML = "";
    topGrid.innerHTML = `<div class="muted">加载中…</div>`;
    try {
      const d = (await api<ToplistCategoryResp>("/top/category")) ?? {};
      topData = (d.groups ?? []).filter((g) => (g.toplists ?? []).length);
      if (!topData.length) {
        homeStatus(topGrid, "暂时没有排行榜", "稍后回来看看", loadToplists);
        return;
      }
      selectedTopGroup = Math.min(selectedTopGroup, topData.length - 1);
      paintTopGroups();
      paintTopGroup();
    } catch (e) {
      homeStatus(topGrid, "排行榜加载失败", errText(e) || "网络暂时不可用", loadToplists);
    }
  };

  let aiNextPage = 1;
  let aiRequest = 0;
  const loadAISonglists = async (page = 1) => {
    const request = ++aiRequest;
    aiRefresh.disabled = true;
    aiGrid.innerHTML = `<div class="muted home-ai__loading">正在生成…</div>`;
    try {
      const d = (await api<AISonglistResp>(`/recommend/ai-songlist?page=${page}&num=8`)) ?? {};
      if (request !== aiRequest) return;
      const list = d.songlists ?? [];
      if (!list.length) {
        if (page > 1) {
          aiNextPage = 1;
          homeStatus(aiGrid, "这一批已经到底了", "让 AI 从头再挑一批", () => void loadAISonglists(1));
        } else {
          homeStatus(aiGrid, "AI 歌单暂时没有内容", "稍后再生成一批", () => void loadAISonglists(1));
        }
        return;
      }

      aiGrid.innerHTML = "";
      for (const x of list.slice(0, 8)) {
        const card = playlistCard(x, true);
        if (card) aiGrid.append(card);
      }
      if (!aiGrid.childElementCount) {
        homeStatus(aiGrid, "AI 歌单暂时没有内容", "稍后再生成一批", () => void loadAISonglists(1));
        return;
      }
      const hasMore = d.hasmore ?? Number(d.total ?? 0) > page * 8;
      aiNextPage = hasMore ? page + 1 : 1;
      aiRefresh.textContent = hasMore ? "换一批" : "再来一批";
    } catch (e) {
      if (request !== aiRequest) return;
      homeStatus(aiGrid, "AI 歌单生成失败", errText(e) || "网络暂时不可用", () => void loadAISonglists(page));
    } finally {
      if (request === aiRequest) aiRefresh.disabled = false;
    }
  };
  aiRefresh.onclick = () => void loadAISonglists(aiNextPage);

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

  await Promise.all([loadPlaylists(), loadNewSongs(), loadAISonglists(1), loadToplists()]);
  return offHead; // 吸顶跟踪退订交给 renderRoute
}
