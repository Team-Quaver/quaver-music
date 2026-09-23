// 歌单行渲染（跨视图复用；对齐设计稿：三行文字 + 单曲心形 + 双击播放 + 歌手/专辑跳转）
// 右键 = 歌曲菜单（SongMenu：插队播放/加入歌单/从歌单删除/跳转至/更多操作）
import { api, coverUrl, escHtml as esc, fmtTime, songSubtitle, songTitle } from "./api";
import { player } from "../player";
import { bindSongMenu } from "../components/SongMenu";

export interface RowHooks {
  onPlay?: (song: any, index: number, all: any[]) => void;
  // 点击行内歌手/专辑链接跳视图
  showArtist?: boolean;
  showAlbum?: boolean;
  /** 红心切换落定后回调（loved = 写接口终态，失败已在 player 侧回滚）。
   *  「我喜欢」页据此把取消收藏的行移出列表。 */
  onLove?: (song: any, loved: boolean) => void;
  /** 当前所在歌单：removable=true 时右键菜单才出现「从歌单删除」（写接口要 dirid + tid） */
  playlist?: { dirid: number; tid: number; title: string; removable: boolean };
  /** 从歌单删除成功后的回调（视图侧改计数等；行的移除由本模块负责） */
  onRemoved?: (song: any) => void;
}

// —— 行内红心：与 player.loved（单一真相源）同步 ——
function paintLove(btn: HTMLElement, on: boolean) {
  btn.textContent = on ? "♥" : "♡";
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "取消收藏" : "收藏";
}

/** 按当前收藏态原地重画已挂载的行内红心（开机预载落定 / 别处取消收藏后调用） */
export function syncRowHearts(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(".row[data-songkey] > [data-love]").forEach((btn) => {
    const row = btn.closest<HTMLElement>(".row[data-songkey]");
    paintLove(btn, !!row && player.loved.has(row.dataset.songkey!));
  });
}

// 收藏态一变（预载灌满 / 播放条取消 / 别处点赞）→ 已渲染的行原地跟随，不必等切视图。
// 按版本号去重：player.notify 每次 timeupdate 都会来，不能在这空刷几百行。
let paintedLoveVersion = -1;
player.on(() => {
  if (player.loveVersion === paintedLoveVersion) return;
  paintedLoveVersion = player.loveVersion;
  syncRowHearts();
});

function linkTo(kind: "singer" | "album", o: any, label: string): string {
  if (!o?.mid) return esc(label); // 无 mid（如部分合唱署名）：退化成纯文本，不给死链
  return `<a class="meta-link" data-link="${kind}:${esc(o.mid)}:${esc(o.name ?? label)}" title="${esc(label)}">${esc(label)}</a>`;
}

/** 行内歌手区：多歌手（合唱/合作）逐个成链，以 " / " 分隔——整条链只挂第一个歌手 mid 的话，
 *  点谁都跳到第一位歌手，所以这里必须按人拆链（点击路由见下方 [data-link] 委托）。 */
function artistLinks(singers: any[] | undefined): string {
  return (singers ?? []).map((a) => linkTo("singer", a, a?.name ?? "")).join(" / ");
}

export function renderSongRows(box: HTMLElement, songs: any[], hooks: RowHooks = {}) {
  box.innerHTML = "";
  for (const [i, s] of songs.entries()) {
    s._key = s.mid ?? String(s.id ?? Math.random());
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.songkey = s._key;
    row.title = "双击播放 · 右键更多";
    const pic = coverUrl(s, 150);
    const artistLine = hooks.showArtist === false ? "" :
      `<span class="ra">${(s.singer ?? []).length ? artistLinks(s.singer) : ""}</span>`;
    const albumLine = hooks.showAlbum ? `<span class="ral">${s.album?.name ? linkTo("album", s.album, s.album.name) : ""}</span>` : "";
    const loved = player.loved.has(s.mid);
    // 标题 = title（主名 + 版本后缀）；subtitle 是独立的一句话说明，跟在标题后做次级文本
    const sub = songSubtitle(s);
    row.innerHTML = `<span class="idx">${i + 1}</span>
      <span class="rthumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
      <span class="rmeta"><span class="rt" style="display:block">${esc(songTitle(s))}${sub ? `<span class="rt-sub">${esc(sub)}</span>` : ""}</span>${artistLine}${albumLine}</span>
      <button class="row-love${loved ? " on" : ""}" data-love aria-label="收藏" aria-pressed="${loved}" title="${loved ? "取消收藏" : "收藏"}">${loved ? "♥" : "♡"}</button>
      <span class="dur">${fmtTime(s.interval)}</span>`;

    // 单击 = 选中 + 后台预加载播放链接（释放旧预载）；双击 = 打断切歌立即播放
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-love],a")) return;
      box.querySelectorAll(".row.sel").forEach((r) => r !== row && r.classList.remove("sel"));
      row.classList.add("sel");
      player.prefetchSong(s);
    });
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("[data-love],a")) return;
      hooks.onPlay?.(s, i, songs);
    });
    // 触屏/快速点按场景兜底：单击封面 = 选中 + 预加载（不直接起播，防误触；双击起播）
    row.querySelector(".rthumb")!.addEventListener("click", () => player.prefetchSong(s));
    row.querySelector("[data-love]")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLElement;
      const done = player.toggleLove(s); // 先乐观改态并广播（同步段），再等在线写接口
      paintLove(btn, player.loved.has(s.mid));
      const fin = await done;            // 终态：写失败已回滚
      if (fin !== null) paintLove(btn, fin);
      hooks.onLove?.(s, fin ?? player.loved.has(s.mid));
    });
    // 歌手/专辑跳转（事件委托到行；拼 hash 进对应视图）
    row.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-link]");
      if (!a) return;
      e.stopPropagation();
      const v = a.dataset.link!;
      const c1 = v.indexOf(":"), c2 = v.indexOf(":", c1 + 1);
      const kind = v.slice(0, c1), mid = v.slice(c1 + 1, c2), name = v.slice(c2 + 1);
      location.hash = `#/${kind}?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(name ?? "")}`;
    });
    // 右键菜单：上下文在打开时现取（列表可能已被重画，序号以当时的 DOM 为准）
    bindSongMenu(row, () => ({
      song: s,
      list: songs,
      index: [...box.children].indexOf(row),
      playlist: hooks.playlist,
      onRemoved: () => {
        // 行淡出移除（与「我喜欢」取消收藏同一套动作），随后交给视图改计数
        row.classList.add("leaving");
        setTimeout(() => row.remove(), 220);
        hooks.onRemoved?.(s);
      },
    }));
    box.append(row);
  }
}

// 分页加载我喜欢（30/页），返回歌曲数组（供视图计数/播放）
export async function loadLiked(box: HTMLElement, hooks: RowHooks = {}, limit = 300): Promise<any[]> {
  box.innerHTML = `<div class="muted">加载中…</div>`;
  const all: any[] = [];
  for (let page = 1; (page - 1) * 30 < limit; page++) {
    const r: any = await api(`/user/liked?page=${page}&num=30`);
    const batch = r?.songs ?? [];
    all.push(...batch);
    if (!r?.hasmore || batch.length === 0) break;
  }
  box.innerHTML = "";
  renderSongRows(box, all, hooks);
  return all;
}
