// Quaver — 路由视图：local（由 src/views/index.ts 按需动态 import，不在首屏解析）
//
// 形态与「我喜欢」「每日 30 首」一致：系统虚拟歌单的信息头（封面 + 标题 + 计数 + 简介）、
// 吸顶条与曲目表。源管理（添加文件夹 / NAS·WebDAV、扫描、路径管理）不再内联在页面上，
// 收进 components/LocalSourcesDialog 的模态浮窗（与更新弹窗同一套玻璃壳）。
//
// 数据层仍在 lib/local.ts（同源 /api/local/*，真相在 electron/local/library.ts）；这一页只管：
//   ① 曲目表（复用行渲染 + 列表工具条；红心列隐藏 —— 在线收藏与本地无关）；
//   ② 「管理音乐源」入口 + 曲目计数。
// 单曲重刮 / 导入歌词封面等操作在行右键菜单（SongMenu）。
import "./local.css";
import { songListTools } from "../components/ListTools";
import { showLocalSourcesDialog } from "../components/LocalSourcesDialog";
import { loadLocalLibrary, localSnapshot, onLocalLibraryChange, trackToSong } from "../lib/local.ts";
import type { LibrarySnapshot } from "../lib/local.ts";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import { h, mountHead, mountStickyBar, playAllButton } from "./_shared";

// 系统歌单封面：Accent 渐变底（底色/渐变在 style.css，与每日/我喜欢的封面同组），
// 图标沿用侧栏「本地音乐」的文件夹形，纯白描边。
const LOCAL_COVER = `
  <div class="local-cover" role="img" aria-label="本地音乐">
    <svg class="local-cover__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h4L12 7h6.5A1.5 1.5 0 0 1 20 8.5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/>
      <circle cx="12" cy="12.6" r="2.2" fill="currentColor" stroke="none"/>
    </svg>
  </div>`;

export default async function localView(root: HTMLElement) {
  root.classList.add("local-page");

  const head = mountHead(root, {
    artHtml: LOCAL_COVER,
    name: "本地音乐",
    meta: "0 首",
    desc: "本机文件夹与 NAS 中的音乐，统一在这里播放；歌曲信息、封面与歌词可联网刮削补齐。",
  });

  const metaEl = head.querySelector<HTMLElement>(".pl-meta");
  const sticky = mountStickyBar(root, { artHtml: LOCAL_COVER, name: "本地音乐" });
  const nameEl = sticky.bar.querySelector<HTMLElement>(".sticky-bar__name");
  const box = h("div", "rows local-rows", `<div class="muted">载入中…</div>`);

  root.append(box);

  let snap: LibrarySnapshot | null = null;
  let items: Song[] = [];

  const tools = songListTools({
    source: () => items,
    hint: "在本地库内搜索",
    paint: (songs, st) => {
      playAll.sync();

      if (!songs.length) {
        box.innerHTML = `<div class="muted">${st.filtering || snap?.tracks.length
          ? "没有匹配的歌曲"
          : "本地库还是空的 —— 点上方「管理音乐源」添加音乐文件夹或 NAS。"}</div>`;

        return;
      }

      renderSongRows(box, songs, {
        hideLove: true,
        showAlbum: true,
        onPlay: (s, i, all) => player.playList(all, i),
      });
      player.markActive();
    },
  });

  sticky.right.append(tools.el);

  // 源管理入口：常驻在吸顶条右侧，滚到哪儿都够得着（浮窗内容见 LocalSourcesDialog）
  // SAFETY: h() 按第一个参数 "button" 建节点，返回的必然是 HTMLButtonElement
  const manage = h("button", "ghost-btn sticky-manage", "管理音乐源") as HTMLButtonElement;

  manage.type = "button";
  manage.title = "添加文件夹 / NAS（WebDAV）、重新扫描与移除源";
  manage.onclick = () => showLocalSourcesDialog();
  sticky.right.append(manage);

  const playAll = playAllButton(() => tools.visible());

  sticky.right.append(playAll.el);

  const setCount = (n: number) => {
    if (metaEl) metaEl.textContent = `${n} 首`;

    if (nameEl) nameEl.textContent = n ? `本地音乐 · ${n} 首` : "本地音乐";
  };

  const apply = () => {
    if (!snap) return;

    const lib = snap;

    items = lib.tracks.map((t) => trackToSong(t, lib.sources));
    setCount(items.length);
    tools.repaint();
  };

  const off = onLocalLibraryChange(() => { snap = localSnapshot(); apply(); });

  snap = await loadLocalLibrary(true);

  if (!snap) { box.innerHTML = `<div class="muted">本地曲库服务不可用（sidecar 中继未就绪？）</div>`; }

  apply();

  return () => { off(); sticky.off(); };
}
