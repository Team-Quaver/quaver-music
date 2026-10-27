// Quaver — 路由视图：all（所有歌曲；由 src/views/index.ts 按需动态 import）
//
// 数据 = 本地音乐 + 我喜欢。三个视图共用同一份合流结果：
//   • 列表：复用 ListTools（搜索 + 歌名/歌手排序）；
//   • 歌手分类：繁简歌手名归一后分组，点卡片看该歌手全部歌曲；
//   • 专辑分类：专辑 mid 优先、名称兜底分组，点卡片看整张专辑。
import "./all.css";
import { coverUrl, escHtml } from "../lib/api";
import { resolveArtistAvatar } from "../lib/artist-avatar";
import {
  groupSongsByAlbum,
  groupSongsByArtist,
  mergeAllSongs,
  type AlbumGroup,
  type ArtistGroup,
} from "../lib/all-songs";
import {
  loadLocalLibrary,
  localSnapshot,
  onLocalLibraryChange,
  trackToSong,
  type LibrarySnapshot,
} from "../lib/local";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import { songListTools } from "../components/ListTools";
import { errText, h, mountHead, mountListFabs, mountStickyBar, playAllButton } from "./_shared";

const VIEWS = [
  { key: "list", label: "列表" },
  { key: "artist", label: "歌手分类" },
  { key: "album", label: "专辑分类" },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

const discCover = `
  <div class="all-cover" role="img" aria-label="所有歌曲">
    <span class="all-cover__glint" aria-hidden="true"></span>
  </div>`;

const viewOf = (raw: string | null): ViewKey => VIEWS.find((view) => view.key === raw)?.key ?? "list";

export default async function allSongsView(root: HTMLElement, q: URLSearchParams) {
  root.classList.add("all-page");
  root.append(h("div", "rows muted", "正在整理所有歌曲…"));

  let localError = "";
  let likedError = "";

  const [localData, likedData] = await Promise.all([
    loadLocalLibrary()
      .then((snapshot) => snapshot)
      .catch((e) => {
        localError = errText(e);

        return localSnapshot();
      }),
    player.loadLoved()
      .then((ok) => {
        if (!ok) likedError = "需要登录后才能读取「我喜欢」";

        return player.likedCache ?? [];
      })
      .catch((e) => {
        likedError = errText(e);

        return player.likedCache ?? [];
      }),
  ]);

  const songsFromSnapshot = (snapshot: LibrarySnapshot | null): Song[] =>
    snapshot ? snapshot.tracks.map((track) => trackToSong(track, snapshot.sources)) : [];

  let localSongs = songsFromSnapshot(localData);
  let likedSongs = likedData.filter((song) => !!song?.mid);
  let allSongs = mergeAllSongs(localSongs, likedSongs);
  const albumCover = (song: Song) => coverUrl(song, 300);
  let albumGroups = groupSongsByAlbum(allSongs, albumCover);
  let artistGroups: ArtistGroup[] | null = null;
  let artistFlight: Promise<void> | null = null;
  let artistGen = 0;
  let alive = true;
  let activeView = viewOf(q.get("view"));
  let selectedArtist = "";
  let selectedAlbum = "";

  root.replaceChildren();

  const head = mountHead(root, {
    artHtml: discCover,
    name: "所有歌曲",
    meta: "",
    desc: "本地音乐与你喜欢的歌曲，合在一处。",
  });

  const metaEl = head.querySelector<HTMLElement>(".pl-meta");
  const sourceNote = h("div", "all-source-note muted");
  sourceNote.hidden = true;
  root.append(sourceNote);

  const sticky = mountStickyBar(root, { artHtml: discCover, name: "所有歌曲" });
  const stickyName = sticky.bar.querySelector<HTMLElement>(".sticky-bar__name");
  const scroller = root.closest<HTMLElement>(".route") ?? root;
  let bodyResizeRaf = 0;

  // 吸顶后只留“吸顶栏 + 内容”占满滚动视口：页面最多滚到吸顶栏贴顶，
  // 之后的滚轮交给左/右各自的内部滚动区，顶部信息不再移动。
  const syncBodyHeight = () => {
    bodyResizeRaf = 0;

    const routePadTop = Number.parseFloat(
      getComputedStyle(scroller).getPropertyValue("--route-pad-top"),
    ) || 6;

    const height = Math.max(240, scroller.clientHeight - sticky.bar.offsetHeight - routePadTop);

    root.style.setProperty("--all-body-h", `${Math.round(height)}px`);
  };

  const queueBodyHeight = () => {
    if (bodyResizeRaf) return;
    bodyResizeRaf = requestAnimationFrame(syncBodyHeight);
  };

  const tabs = h("div", "tag-tabs all-tabs");
  tabs.innerHTML = VIEWS.map(
    (view) => `<button class="tag" type="button" data-view="${view.key}">${view.label}</button>`,
  ).join("");
  sticky.right.append(tabs);

  const body = h("div", "tag-body all-tabs-body");
  const listPanel = h("div", "tag-panel all-list-panel");
  const artistPanel = h("div", "tag-panel");
  const albumPanel = h("div", "tag-panel");
  body.append(listPanel, artistPanel, albumPanel);
  root.append(body);

  const setMeta = () => {
    const total = allSongs.length;

    const text = total
      ? `共 ${total} 首 · 本地 ${localSongs.length} · 喜欢 ${likedSongs.length}`
      : "还没有可显示的歌曲";

    if (metaEl) metaEl.textContent = text;

    if (stickyName) stickyName.textContent = total ? `所有歌曲 · ${total} 首` : "所有歌曲";

    const notes: string[] = [];

    if (localError) notes.push(`本地音乐暂不可用：${localError}`);

    if (likedError) notes.push(likedError);
    sourceNote.textContent = notes.join(" · ");
    sourceNote.hidden = !notes.length;
  };

  // —— 列表：复用全站列表工具条 ——
  const listToolbar = h("div", "all-list-toolbar");
  const listRows = h("div", "rows all-list-rows");

  const tools = songListTools({
    source: () => allSongs,
    hint: "在所有歌曲内搜索",
    paint: (songs, state) => {
      playAll.sync();

      if (!songs.length) {
        listRows.innerHTML = `<div class="muted">${
          state.filtering
            ? "没有匹配的歌曲"
            : allSongs.length
              ? "没有可显示的歌曲"
              : "本地曲库与「我喜欢」都还是空的"
        }</div>`;

        return;
      }

      renderSongRows(listRows, songs, {
        showAlbum: true,
        onPlay: (_song, index, all) => player.playList(all, index),
      });
      player.markActive();
    },
  });

  listToolbar.append(tools.el);
  listPanel.append(listToolbar, listRows);

  // —— 分类主从布局：左侧歌手/专辑列表，右侧当前项的 Track ——
  const paintArtistAvatar = (host: HTMLElement, group: ArtistGroup) => {
    const initial = Array.from(group.name)[0] ?? "?";
    const fallback = () => host.replaceChildren(h("span", "all-art-letter", escHtml(initial)));

    const showImage = (url: string) => {
      if (!url) {
        fallback();

        return;
      }

      const img = new Image();
      img.className = "all-artist-avatar";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = fallback;
      img.src = url;
      host.replaceChildren(img);
    };

    fallback();
    void resolveArtistAvatar(group.name, group.mid).then((avatar) => {
      if (!alive || !host.isConnected) return;

      if (!group.mid && avatar.mid) group.mid = avatar.mid;
      showImage(avatar.url);
    });
  };

  const paintAlbumArt = (host: HTMLElement, group: AlbumGroup) => {
    const initial = Array.from(group.name)[0] ?? "?";
    const fallback = () => host.replaceChildren(h("span", "all-art-fallback", `<i>${escHtml(initial)}</i>`));
    const img = new Image();

    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = fallback;

    if (!group.cover) {
      fallback();

      return;
    }

    img.src = group.cover;
    host.replaceChildren(img);
  };

  const makeBrowser = (panel: HTMLElement, kind: "artist" | "album", label: string) => {
    panel.classList.add("all-browser", `all-browser--${kind}`);
    const rail = h("aside", "all-browser__rail");
    const railHead = h("div", "all-browser__rail-head");
    const railTitle = h("strong", "", label);
    const railCount = h("span", "muted");
    const list = h("div", "all-browser__list");
    const tracks = h("section", "all-browser__tracks");
    railHead.append(railTitle, railCount);
    rail.append(railHead, list);
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", `${label}列表`);

    return { rail, list, railCount, tracks };
  };

  const browserItem = (
    group: ArtistGroup | AlbumGroup,
    kind: "artist" | "album",
    selected: boolean,
    onPick: () => void,
  ) => {
    const item = document.createElement("button");

    const sub = kind === "album" && "artist" in group
      ? String(group.artist || "未知歌手")
      : "歌手";

    const thumb = h("span", `all-browser__thumb${kind === "artist" ? " round" : ""}`);
    const copy = h("span", "all-browser__copy");
    const name = h("span", "all-browser__name");
    const note = h("span", "all-browser__sub");
    const count = h("span", "all-browser__count");

    item.type = "button";
    item.className = "all-browser__item";
    item.dataset.groupKey = group.key;
    item.classList.toggle("sel", selected);
    item.setAttribute("aria-pressed", String(selected));
    name.textContent = group.name;
    note.textContent = sub;
    count.textContent = `${group.songs.length} 首`;
    copy.append(name, note);
    item.append(thumb, copy, count);
    item.onclick = onPick;

    if (kind === "artist" && "mid" in group) paintArtistAvatar(thumb, group);
    else if (kind === "album" && "cover" in group) paintAlbumArt(thumb, group);

    return item;
  };

  const renderGroupTracks = (
    group: ArtistGroup | AlbumGroup,
    kind: "artist" | "album",
    host: HTMLElement,
  ) => {
    const head = h("div", "all-browser__head");
    const art = h("span", `all-browser__head-art${kind === "artist" ? " round" : ""}`);
    const heading = h("div", "all-browser__heading");
    const title = h("h2", "", escHtml(group.name));
    const note = h("span", "muted");
    const rows = h("div", "rows all-browser__rows");
    rows.dataset.listScroller = "";

    note.textContent = kind === "album" && "artist" in group
      ? `${String(group.artist || "未知歌手")} · ${group.songs.length} 首`
      : `${group.songs.length} 首`;
    heading.append(title, note);
    head.append(art, heading);
    host.replaceChildren(head, rows);

    if (kind === "artist" && "mid" in group) paintArtistAvatar(art, group);
    else if (kind === "album" && "cover" in group) paintAlbumArt(art, group);

    renderSongRows(rows, group.songs, {
      showArtist: kind === "album",
      showAlbum: kind === "artist",
      onPlay: (_song, index, all) => player.playList(all, index),
    });
    playAll.sync();
    player.markActive();
  };

  // —— 歌手分类：繁简归并键在 artist-key.ts ——
  const artistIntro = h("div", "muted all-group-intro", "左侧选择歌手，右侧查看歌曲。繁体与简体写法会自动归为一组。");
  const artistBrowser = makeBrowser(artistPanel, "artist", "歌手");
  artistPanel.append(artistIntro, artistBrowser.rail, artistBrowser.tracks);

  const paintArtistDetail = () => {
    const group = artistGroups?.find((item) => item.key === selectedArtist) ?? artistGroups?.[0];

    if (!group) {
      artistBrowser.tracks.innerHTML = `<div class="all-browser__empty">还没有可以显示的歌曲</div>`;

      return;
    }

    selectedArtist = group.key;
    artistBrowser.list.querySelectorAll<HTMLElement>(".all-browser__item").forEach((card) => {
      const on = card.dataset.groupKey === group.key;
      card.classList.toggle("sel", on);
      card.setAttribute("aria-pressed", String(on));
    });
    renderGroupTracks(group, "artist", artistBrowser.tracks);
  };

  const paintArtists = () => {
    artistBrowser.list.replaceChildren();

    if (!artistGroups) {
      artistBrowser.railCount.textContent = "";
      artistBrowser.list.innerHTML = `<div class="all-browser__empty">正在整理歌手分类…</div>`;
      artistBrowser.tracks.innerHTML = "";

      return;
    }

    artistBrowser.railCount.textContent = `${artistGroups.length} 位`;

    if (!artistGroups.length) {
      artistBrowser.list.innerHTML = `<div class="all-browser__empty">还没有可以分类的歌手</div>`;
      artistBrowser.tracks.innerHTML = "";

      return;
    }

    if (!artistGroups.some((group) => group.key === selectedArtist)) selectedArtist = artistGroups[0]!.key;

    for (const group of artistGroups) {
      const item = browserItem(
        group,
        "artist",
        group.key === selectedArtist,
        () => {
          selectedArtist = group.key;
          paintArtistDetail();
        },
      );

      artistBrowser.list.append(item);
    }

    paintArtistDetail();
  };

  const ensureArtists = () => {
    if (artistGroups) {
      paintArtists();

      return Promise.resolve();
    }

    if (artistFlight) return artistFlight;
    const snapshot = allSongs.slice();
    const gen = ++artistGen;
    artistFlight = groupSongsByArtist(snapshot).then((groups) => {
      if (!alive || gen !== artistGen) return;
      artistGroups = groups;
      paintArtists();
    }).catch((e) => {
      if (!alive || gen !== artistGen) return;
      artistBrowser.list.innerHTML = `<div class="all-browser__empty">${escHtml(errText(e))}</div>`;
      artistBrowser.tracks.innerHTML = "";
    }).finally(() => {
      if (gen === artistGen) artistFlight = null;
    });

    return artistFlight;
  };

  // —— 专辑分类 ——
  const albumBrowser = makeBrowser(albumPanel, "album", "专辑");
  albumPanel.append(albumBrowser.rail, albumBrowser.tracks);

  const paintAlbumDetail = () => {
    const group = albumGroups.find((item) => item.key === selectedAlbum) ?? albumGroups[0];

    if (!group) {
      albumBrowser.tracks.innerHTML = `<div class="all-browser__empty">还没有可以显示的歌曲</div>`;

      return;
    }

    selectedAlbum = group.key;
    albumBrowser.list.querySelectorAll<HTMLElement>(".all-browser__item").forEach((card) => {
      const on = card.dataset.groupKey === group.key;
      card.classList.toggle("sel", on);
      card.setAttribute("aria-pressed", String(on));
    });
    renderGroupTracks(group, "album", albumBrowser.tracks);
  };

  const paintAlbums = () => {
    albumBrowser.list.replaceChildren();
    albumBrowser.railCount.textContent = `${albumGroups.length} 张`;

    if (!albumGroups.length) {
      albumBrowser.list.innerHTML = `<div class="all-browser__empty">还没有可以分类的专辑</div>`;
      albumBrowser.tracks.innerHTML = "";

      return;
    }

    if (!albumGroups.some((group) => group.key === selectedAlbum)) selectedAlbum = albumGroups[0]!.key;

    for (const group of albumGroups) {
      const item = browserItem(
        group,
        "album",
        group.key === selectedAlbum,
        () => {
          selectedAlbum = group.key;
          paintAlbumDetail();
        },
      );

      albumBrowser.list.append(item);
    }

    paintAlbumDetail();
  };

  const panels: Record<ViewKey, HTMLElement> = {
    list: listPanel,
    artist: artistPanel,
    album: albumPanel,
  };

  const selectedGroup = () => activeView === "artist"
    ? artistGroups?.find((item) => item.key === selectedArtist)
    : albumGroups.find((item) => item.key === selectedAlbum);

  const visiblePlaylist = () => activeView === "list"
    ? tools.visible()
    : selectedGroup()?.songs ?? [];

  const playAll = playAllButton(visiblePlaylist);
  let fabs: ReturnType<typeof mountListFabs> | null = null;

  sticky.right.append(playAll.el);

  const select = (key: ViewKey) => {
    activeView = key;
    root.dataset.view = key;

    for (const view of VIEWS) panels[view.key].hidden = view.key !== key;
    tabs.querySelectorAll<HTMLElement>(".tag").forEach((button) => {
      button.classList.toggle("sel", button.dataset.view === key);
    });

    if (key === "list") tools.repaint();
    else if (key === "artist") void ensureArtists();
    else paintAlbums();
    playAll.sync();
    fabs?.sync();
  };

  tabs.querySelectorAll<HTMLElement>(".tag").forEach((button) => {
    button.onclick = () => {
      const key = viewOf(button.dataset.view ?? null);

      if (key === activeView) return;
      body.classList.add("tab-anim");
      select(key);
    };
  });

  const applySources = () => {
    allSongs = mergeAllSongs(localSongs, likedSongs);
    albumGroups = groupSongsByAlbum(allSongs, albumCover);
    artistGroups = null;
    artistGen++;
    artistFlight = null; // 旧任务已按代际作废，不能继续占住「进行中」槽位
    setMeta();
    tools.repaint();

    if (activeView === "artist") void ensureArtists();
    else if (activeView === "album") paintAlbums();
  };

  setMeta();
  paintAlbums();
  select(activeView);
  syncBodyHeight();

  const bodyResize = new ResizeObserver(queueBodyHeight);
  bodyResize.observe(scroller);
  window.addEventListener("resize", queueBodyHeight);

  const offLocal = onLocalLibraryChange(() => {
    const snapshot = localSnapshot();

    if (!snapshot) return;
    localSongs = songsFromSnapshot(snapshot);
    localError = "";
    applySources();
  });

  const offLoved = player.onLovedListChange(() => {
    likedSongs = (player.likedCache ?? []).filter((song) => !!song?.mid);
    likedError = "";
    applySources();
  });

  fabs = mountListFabs(root, () => {
    const panel = panels[activeView];

    return [...panel.querySelectorAll<HTMLElement>(".row[data-songkey]")];
  }, {
    getScroller: () => activeView === "list"
      ? scroller
      : panels[activeView].querySelector<HTMLElement>(".all-browser__rows")
        ?? scroller,
    getScrollTargets: () => [
      scroller,
      artistBrowser.list,
      artistBrowser.tracks,
      albumBrowser.list,
      albumBrowser.tracks,
    ],
  });

  return () => {
    alive = false;
    artistGen++;
    bodyResize.disconnect();
    window.removeEventListener("resize", queueBodyHeight);

    if (bodyResizeRaf) cancelAnimationFrame(bodyResizeRaf);
    offLocal();
    offLoved();
    sticky.off();
    fabs.off();
  };
}
