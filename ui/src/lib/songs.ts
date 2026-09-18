// 歌曲行渲染（跨视图复用）：Verse TrackRow 结构（v-row）。
// 三信号表正在播放（行底色 + accent 歌名 + 序号处圆点）；已收藏 = accent + 实心爱心。
// 单击 = 选中 + 后台预加载；双击 = 立即播放；行内歌手/专辑链跳视图。
import { api, coverUrl } from "./api";
import { player } from "../player";
import { icon } from "../verse/icons";
import { formatTime } from "../verse/format";

export interface RowHooks {
  onPlay?: (song: any, index: number, all: any[]) => void;
  // 点击行内歌手/专辑链接跳视图
  showArtist?: boolean;
  showAlbum?: boolean;
  /** 红心切换落定后回调（loved = 写接口终态，失败已在 player 侧回滚）。
   *  「我喜欢」页据此把取消收藏的行移出列表。 */
  onLove?: (song: any, loved: boolean) => void;
}

const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// —— 行内红心：与 player.loved（单一真相源）同步 ——
function paintLove(btn: HTMLElement, on: boolean) {
  btn.innerHTML = icon(on ? "heartOn" : "heart", 16);
  btn.classList.toggle("v-iconbtn--on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "取消收藏" : "收藏");
  btn.title = on ? "取消收藏" : "收藏";
}

/** 按当前收藏态原地重画已挂载的行内红心（开机预载落定 / 别处取消收藏后调用） */
export function syncRowHearts(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(".v-row[data-songkey] > .v-row__actions [data-love]").forEach((btn) => {
    const row = btn.closest<HTMLElement>(".v-row[data-songkey]");
    paintLove(btn, !!row && player.loved.has(row.dataset.songkey!));
  });
}

// 收藏态一变（预载灌满 / 播放条取消 / 别处点赞）→ 已渲染的行原地跟随，不必等切视图。
// 按版本号去重：player.notify 每次 timeupdate 都会来，不能在这空刷几百行。
let paintedLoveVersion = -1;
let paintedTrackKey: unknown = Symbol("none");
player.on(() => {
  if (player.loveVersion !== paintedLoveVersion) {
    paintedLoveVersion = player.loveVersion;
    syncRowHearts();
  }
  // 正在播放行三信号（只在曲目切换时 touching DOM）
  const key = player.current ? (player.current._key ?? player.current.mid) : null;
  if (key !== paintedTrackKey) {
    paintedTrackKey = key;
    syncPlayingRows();
  }
});

/** 按 player.current 原地重画正在播放行（底色 + accent 歌名 + 序号圆点） */
export function syncPlayingRows(root: ParentNode = document) {
  const key = player.current ? String(player.current._key ?? player.current.mid ?? "") : "";
  root.querySelectorAll<HTMLElement>(".v-row[data-songkey]").forEach((row) => {
    const on = !!key && row.dataset.songkey === key;
    if (row.classList.contains("v-row--playing") === on) return;
    row.classList.toggle("v-row--playing", on);
    const idx = row.querySelector<HTMLElement>(".v-row__index")!;
    idx.innerHTML = on ? icon("dot", 14) : esc(idx.dataset.n ?? "");
  });
}

function linkTo(kind: "singer" | "album", o: any, label: string): string {
  if (!o?.mid) return esc(label); // 无 mid（如部分合唱署名）：退化成纯文本，不给死链
  return `<a data-link="${kind}:${esc(o.mid)}:${esc(o.name ?? label)}" title="${esc(label)}">${esc(label)}</a>`;
}

/** 行内歌手区：多歌手（合唱/合作）逐个成链，以 " / " 分隔——整条链只挂第一个歌手 mid 的话，
 *  点谁都跳到第一位歌手，所以这里必须按人拆链（点击路由见下方 [data-link] 委托）。 */
function artistLinks(singers: any[] | undefined): string {
  return (singers ?? []).map((a) => linkTo("singer", a, a?.name ?? "")).join(" / ");
}

/** 列表头（overline-11 + 发丝线）：列宽与 v-row 对齐（序号 24 / 封面 40 / 歌名自适应 / 专辑 30% / 时长） */
export function tableHead(showAlbum: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "v-thead";
  el.innerHTML = `<span class="v-thead__index">#</span><span class="v-thead__title">歌曲</span>${showAlbum ? `<span class="v-thead__album">专辑</span>` : ""}<span>时长</span>`;
  return el;
}

/** 空状态（一句陈述 + 一句后果 + 一个出口按钮；不用感叹号与 emoji） */
export function emptyState(title: string, note: string, action?: { label: string; href: string }): HTMLElement {
  const el = document.createElement("div");
  el.className = "v-empty";
  el.innerHTML = `<div class="v-empty__art"></div>
    <p class="title-15">${esc(title)}</p>
    <p class="body-14" style="color: var(--ink-muted)">${esc(note)}</p>
    ${action ? `<a class="v-btn v-btn--secondary" href="${esc(action.href)}">${esc(action.label)}</a>` : ""}`;
  return el;
}

// 每列表框一份多选集 + 锚点（存在 box 上；重渲染即清空）
const selOf = (box: HTMLElement): Set<string> =>
  ((box as any)._vsel ??= new Set<string>());
const anchorOf = (box: HTMLElement): HTMLElement | null => (box as any)._vanchor ?? null;
const setAnchor = (box: HTMLElement, r: HTMLElement | null) => { (box as any)._vanchor = r; };
function paintSel(box: HTMLElement) {
  const sel = selOf(box);
  box.querySelectorAll<HTMLElement>(".v-row[data-songkey]").forEach((r) =>
    r.classList.toggle("v-row--selected", sel.has(r.dataset.songkey!)));
}

/** 右键菜单（单例）：播放 / 播放选中 / 收藏 / 复制歌名 */
let ctxMenu: HTMLElement | null = null;
function closeMenu() { ctxMenu?.remove(); ctxMenu = null; }
document.addEventListener("pointerdown", (e) => {
  if (ctxMenu && !(e.target as HTMLElement).closest(".v-ctx")) closeMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

function openRowMenu(x: number, y: number, box: HTMLElement, songs: any[], song: any, hooks: RowHooks) {
  closeMenu();
  const sel = selOf(box);
  const key = String(song._key);
  if (!sel.has(key)) { sel.clear(); sel.add(key); setAnchor(box, box.querySelector(`.v-row[data-songkey="${CSS.escape(key)}"]`)); paintSel(box); }
  const loved = player.loved.has(song.mid);
  const menu = document.createElement("div");
  menu.className = "v-menu v-ctx";
  menu.setAttribute("role", "menu");
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "v-menu__item";
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.onclick = () => { closeMenu(); fn(); };
    menu.append(b);
  };
  const idx = songs.indexOf(song);
  btn("播放", () => {
    if (hooks.onPlay) hooks.onPlay(song, Math.max(0, idx), songs);
    else player.playList([song], 0);
  });
  if (sel.size > 1) {
    btn(`播放选中 ${sel.size} 首`, () => {
      const picked = songs.filter((s) => sel.has(String(s._key)));
      if (picked.length) player.playList(picked, 0);
    });
  }
  btn(loved ? "取消收藏" : "收藏", async () => {
    const done = player.toggleLove(song); // 乐观改态（行内红心经 syncRowHearts 跟随），再等写接口
    const fin = await done;               // 终态：写失败已回滚
    syncRowHearts(box);
    hooks.onLove?.(song, fin ?? player.loved.has(song.mid));
  });
  btn("复制歌名", () => {
    const t = String(song.name ?? "");
    if (navigator.clipboard) void navigator.clipboard.writeText(t).catch(() => {});
  });
  document.body.append(menu);
  ctxMenu = menu;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  menu.querySelector<HTMLElement>(".v-menu__item")?.focus();
}

export function renderSongRows(box: HTMLElement, songs: any[], hooks: RowHooks = {}) {
  box.innerHTML = "";
  (box as any)._vsel = new Set<string>();
  (box as any)._vanchor = null;
  for (const [i, s] of songs.entries()) {
    s._key = s.mid ?? String(s.id ?? Math.random());
    const row = document.createElement("div");
    row.className = "v-row";
    row.dataset.songkey = s._key;
    row.tabIndex = 0;
    row.setAttribute("role", "row");
    row.title = "双击播放";
    const pic = coverUrl(s, 150);
    const artistLine = hooks.showArtist === false ? "" :
      `<div class="v-row__sub">${(s.singer ?? []).length ? artistLinks(s.singer) : ""}</div>`;
    const albumLine = hooks.showAlbum ? `<div class="v-row__album">${s.album?.name ? linkTo("album", s.album, s.album.name) : ""}</div>` : "";
    const n = String(i + 1).padStart(2, "0");
    const loved = player.loved.has(s.mid);
    const playing = !!player.current && String(player.current._key ?? player.current.mid ?? "") === String(s._key);
    if (playing) row.classList.add("v-row--playing");
    row.innerHTML = `<span class="v-row__index" data-n="${n}">${playing ? icon("dot", 14) : n}</span>
      <img class="v-row__cover" src="${pic || TRANSPARENT}" alt="" loading="lazy"/>
      <div class="v-row__main">
        <div class="v-row__title"><span>${esc(s.name ?? "")}</span></div>
        ${artistLine}
      </div>
      ${albumLine}
      <div class="v-row__actions">
        <button type="button" class="v-iconbtn v-iconbtn--sm${loved ? " v-iconbtn--on" : ""}" data-love
          aria-label="${loved ? "取消收藏" : "收藏"}" aria-pressed="${loved}" title="${loved ? "取消收藏" : "收藏"}">${icon(loved ? "heartOn" : "heart", 16)}</button>
      </div>
      <span class="v-row__time">${formatTime(s.interval)}</span>`;

    // 单击 = 选中 + 后台预加载播放链接（释放旧预载）；Ctrl/Shift 多选；双击 / 回车 = 打断切歌立即播放
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-love],a")) return;
      const me = e as MouseEvent;
      const sel = selOf(box);
      const key = String(s._key);
      if (me.ctrlKey || me.metaKey) {
        if (sel.has(key)) sel.delete(key); else sel.add(key);
        setAnchor(box, row);
        paintSel(box);
        return; // 多选切换不预加载
      }
      if (me.shiftKey) {
        const anchor = anchorOf(box);
        const rows = [...box.querySelectorAll<HTMLElement>(".v-row[data-songkey]")];
        const a = anchor ? rows.indexOf(anchor) : -1;
        const b = rows.indexOf(row);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
          rows.slice(lo, hi + 1).forEach((r) => sel.add(r.dataset.songkey!));
          paintSel(box);
          return;
        }
      }
      sel.clear();
      sel.add(key);
      setAnchor(box, row);
      paintSel(box);
      player.prefetchSong(s);
    });
    // 整行右键菜单：播放 / 播放选中 / 收藏 / 复制歌名
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openRowMenu(e.clientX, e.clientY, box, songs, s, hooks);
    });
    const fire = (e: Event) => {
      if ((e.target as HTMLElement).closest("[data-love],a")) return;
      hooks.onPlay?.(s, i, songs);
    };
    row.addEventListener("dblclick", fire);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement) === row) { e.preventDefault(); hooks.onPlay?.(s, i, songs); }
    });
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
    box.append(row);
  }
}

// 分页加载我喜欢（30/页），返回歌曲数组（供视图计数/播放）
export async function loadLiked(box: HTMLElement, hooks: RowHooks = {}, limit = 300): Promise<any[]> {
  box.innerHTML = `<div class="caption-12">加载中…</div>`;
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
