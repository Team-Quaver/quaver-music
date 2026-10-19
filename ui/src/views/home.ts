// Quaver — 路由视图：home（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api, upPic } from "../lib/api";
import { icons } from "../lib/icons";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import { toast } from "../components/SongMenu";
import type { RecommendSonglistResp } from "./_shared";
import { cardPlay, compactCount, errText, h, homeStatus, navCard, routeScroller, trackStuck } from "./_shared";

// —— 首页：页头 + 双栏领区（快速开始 / 新歌速递）+ 发丝线分隔的推荐网格 ——
// 两个数据源并行、独立降级：任一失败不影响另一块，各自原地给重试。
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

  root.append(lead, recommendations);

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
        const id = String(x.id ?? "");
        const title = String(x.title ?? "歌单");
        const href = `#/playlist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(title)}`;
        const listens = compactCount(x.listennum);
        const sub = [x.creator_nick || "", listens ? `${listens}次播放` : ""].filter(Boolean).join(" · ") || "歌单";
        grid.append(navCard(href, upPic(x.picurl), title, sub,
          () => cardPlay("playlist", id, href)));
      }
    } catch (e) {
      homeStatus(grid, "推荐歌单加载失败", errText(e) || "网络暂时不可用", loadPlaylists);
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
  return offHead; // 吸顶跟踪退订交给 renderRoute
}
