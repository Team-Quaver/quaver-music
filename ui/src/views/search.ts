// Quaver — 路由视图：search（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { pushHistory } from "../components/SearchBox";
import { playNowWithToast } from "../components/SongMenu";
import { api, escHtml, stripEm, upPic } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import type { Song } from "../player";
import type { HotkeyResp, SearchAlbum, SearchResp, SearchSinger, SearchSonglist } from "./_shared";
import { errText, h } from "./_shared";
// —— 搜索页（顶部常驻搜索框的落点视图）：热搜词 + 分类标签（歌曲/歌手/专辑/歌单） ——
const SEARCH_TABS = [
  { type: "0", label: "歌曲" },
  { type: "1", label: "歌手" },
  { type: "2", label: "专辑" },
  { type: "3", label: "歌单" },
] as const;

export default async function searchView(root: HTMLElement, q: URLSearchParams) {
  const kw = (q.get("keyword") || "").trim();
  const tab = SEARCH_TABS.find((t) => t.type === (q.get("type") ?? "0")) ?? SEARCH_TABS[0];
  const head = h("div", "search-head");
  head.innerHTML = `<h1 class="page-title">${kw ? `“${kw.replace(/</g, "&lt;")}”的搜索结果` : "搜索"}</h1>
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

// —— 本地音乐（本地文件夹 + NAS：播放 · 刮削）——
// 数据层在 lib/local.ts（同源 /api/local/*，真相在 electron/local/library.ts）；这一页只管三件事：
//   ① 源管理（添加本机/NAS 挂载目录、WebDAV，扫描进度）；
//   ② 曲目表（复用行渲染 + 列表工具条；红心列隐藏 —— 在线收藏与本地无关）；
//   ③ 刮削入口（未匹配的补、全部重刮、行级右键的单曲重刮在 SongMenu）。
// 选目录是 Electron 专属（quaverLocal 桥）；浏览器 dev 给手输路径的输入框（NAS 挂载目录本来就是路径）。
