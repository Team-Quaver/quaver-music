// Quaver — 路由视图：home（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api, escHtml, upPic } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import type { RecommendSonglistResp } from "./_shared";
import { cardPlay, compactCount, errText, h, homeStatus, navCard, plainText, routeScroller, trackStuck } from "./_shared";
// —— 首页：页头 + 双栏领区（今日精选 / 新歌速递）+ 发丝线分隔的推荐网格 ——
// 两个数据源并行、独立降级：任一失败不影响另一块，各自原地给重试。
export default async function homeView(root: HTMLElement) {
  const homeHead = h("div", "sticky-head home-pagehead", `
    <h1 class="page-title">首页</h1>
    <p class="muted">从歌单和新歌开始，开启今日</p>`);
  root.append(homeHead);
  const offHead = trackStuck(homeHead, routeScroller(root));

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
  return offHead; // 吸顶跟踪退订交给 renderRoute
}

// —— 歌单页收藏按钮（在线收藏写接口：PlaylistFavWrite Fav/CancelFavPlaylist） ——
// 收藏态取自 lib/favs 的收藏歌单缓存（与侧栏同源，收藏后侧栏同帧出现）；
// 自有歌单不渲染（不能收藏自己的歌单），未登录不渲染（收藏必须带登录态）。
// cleanups：视图销毁时的退订登记（playlistView 交给 renderRoute 调用）。
