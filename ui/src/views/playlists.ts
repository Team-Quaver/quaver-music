// Quaver — 路由视图：playlists（歌单集合页；由 src/views/index.ts 按需动态 import）
//
// 设置 → 外观 → 歌单 选「歌单集合页」时，侧栏歌单区整块隐藏、导航按钮在侧栏内垂直居中，
// 歌单改由本页以 grid 分区承载：我创建的歌单（lib/playlists.ts）/ 我收藏的歌单（lib/favs.ts）。
// 菜单栏态下侧栏照常列歌单，本页仍是「全部歌单」的稳定落地页（顶栏「歌单」按钮进来）。
//
// 两个数据源各自独立拉取、独立降级：自建失败不影响收藏，反之亦然。收藏增删经 favs 订阅
// 即时重画；自建删除走右键菜单的 onDeleted（deleteSonglist 已更新 lib 侧缓存）。
import { escHtml, upPic } from "../lib/api";
import { favSonglists, loadFavSonglists, onFavSonglistsChange } from "../lib/favs";
import { isMySonglistsLoaded, loadMySonglists, mySonglists } from "../lib/playlists";
import { openPlaylistMenu } from "../components/PlaylistMenu";
import { cardPlay, errText, h, navCard, routeScroller, trackStuck } from "./_shared";

// 卡片落地路由：自建与收藏共用 disstid/tid + name（与侧栏条目同一套口径）
const hrefOf = (id: number | string, title: string) =>
  `#/playlist?id=${encodeURIComponent(String(id))}&name=${encodeURIComponent(title)}`;
// 卡片副行：曲目数（自建/收藏都带 songnum）；缺了就退回「歌单」
const subOf = (songnum: unknown) => (Number(songnum) > 0 ? `${Number(songnum)} 首` : "歌单");

export default async function playlistsView(root: HTMLElement) {
  const head = h("div", "sticky-head home-pagehead", `
    <h1 class="page-title">歌单</h1>
    <p class="muted">我创建的歌单与我收藏的歌单</p>`);
  root.append(head);
  const offHead = trackStuck(head, routeScroller(root));

  const section = (title: string, note: string) => {
    const sec = h("section", "pl-sec");
    sec.innerHTML = `<div class="sec-head"><h2>${title}</h2><span class="muted">${note}</span></div>`;
    const grid = h("div", "grid playlist-grid", `<div class="muted">加载中…</div>`);
    sec.append(grid);
    return { sec, grid };
  };
  const created = section("我创建的歌单", "我的作品");
  const faved = section("我收藏的歌单", "收集的别人的歌单");
  root.append(created.sec, faved.sec);

  // 我的自建歌单卡：右键菜单可立即播放 / 插队 / 删除（删除成功后 lib 缓存已摘除，重画即可）
  const paintCreated = () => {
    const list = mySonglists();
    created.grid.innerHTML = "";
    if (!list.length) { created.grid.innerHTML = `<div class="muted">还没有创建的歌单</div>`; return; }
    for (const x of list) {
      const href = hrefOf(x.id, x.title);
      const card = navCard(href, upPic(x.picurl), x.title, subOf(x.songnum), () => cardPlay("playlist", String(x.id), href));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openPlaylistMenu(e.clientX, e.clientY,
          { id: x.id, title: x.title, dirid: x.dirid, songnum: x.songnum },
          { kind: "created", onDeleted: paintCreated }, card);
      });
      created.grid.append(card);
    }
  };

  // 我收藏的歌单卡：取消收藏经 favs 数据层乐观更新，订阅回灌本页重画（不必自挂 onDeleted）
  const paintFaved = () => {
    const list = favSonglists();
    faved.grid.innerHTML = "";
    if (!list.length) { faved.grid.innerHTML = `<div class="muted">还没有收藏的歌单</div>`; return; }
    for (const x of list) {
      const href = hrefOf(x.id, String(x.title ?? "歌单"));
      const card = navCard(href, upPic(String(x.picurl ?? "")), String(x.title ?? "歌单"), subOf(x.songnum),
        () => cardPlay("playlist", String(x.id), href));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openPlaylistMenu(e.clientX, e.clientY,
          { id: x.id, title: String(x.title ?? "歌单"), songnum: x.songnum },
          { kind: "fav" }, card);
      });
      faved.grid.append(card);
    }
  };

  // 侧栏已拉过就先用缓存上屏（不闪「加载中」）；两个源各自 await 各自画，互不阻塞
  if (isMySonglistsLoaded()) paintCreated();
  const offFavs = onFavSonglistsChange(paintFaved);
  await Promise.allSettled([
    loadMySonglists().then(paintCreated).catch((e) => {
      created.grid.innerHTML = `<div class="muted">${escHtml(errText(e) || "歌单加载失败")}</div>`;
    }),
    loadFavSonglists().then(paintFaved).catch((e) => {
      faved.grid.innerHTML = `<div class="muted">${escHtml(errText(e) || "收藏歌单加载失败")}</div>`;
    }),
  ]);

  return () => { offHead(); offFavs(); };
}
