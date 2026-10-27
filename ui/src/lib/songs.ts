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
  /** 是否显示行首歌曲封面（专辑页本身已有大封面，列表里不再重复） */
  showCover?: boolean;
  /** 红心切换落定后回调（loved = 写接口终态，失败已在 player 侧回滚）。
   *  「我喜欢」页据此把取消收藏的行移出列表。 */
  onLove?: (song: any, loved: boolean) => void;
  /** 当前所在歌单：removable=true 时右键菜单才出现「从歌单删除」（写接口要 dirid + tid） */
  playlist?: { dirid: number; tid: number; title: string; removable: boolean };
  /** 从歌单删除成功后的回调（视图侧改计数等；行的移除由本模块负责） */
  onRemoved?: (song: any) => void;
  /** 隐藏行内红心（本地音乐页：红心是 QQ 侧概念，本地曲目无在线收藏） */
  hideLove?: boolean;
}

// —— 行内红心：与 player.loved（单一真相源）同步 ——
function paintLove(btn: HTMLElement, on: boolean) {
  btn.textContent = on ? "♥" : "♡";
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  // 自绘 Tooltip 读 data-tooltip；再写 title 会被 MutationObserver 归一化，
  // 已显示的提示也会因属性变化闪一下，所以这里直接写唯一数据源。
  btn.dataset.tooltip = on ? "取消收藏" : "收藏";
  btn.setAttribute("aria-label", btn.dataset.tooltip);
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

/** 移除行后重排序号：编号必须跟 DOM 一致 —— 双击/菜单的序号以当时的 DOM 为准，
 *  显示不跟着重排的话，用户「双击第 5 首」实际命中的还是删除前的第 5 行 */
export function renumberRows(box: HTMLElement) {
  [...box.querySelectorAll<HTMLElement>(".row[data-songkey]")].forEach((row, i) => {
    const idx = row.querySelector<HTMLElement>(".idx");

    if (idx) idx.textContent = String(i + 1);
  });
}

/** 行 → 歌曲对象。委托监听靠它把「点到的那一行」还原成当初渲染它的那个对象。
 *  不用「songkey → 歌」的 Map：同名 mid（同曲在列表里出现两次，歌单顺序表允许）会在 Map 里
 *  互相覆盖，两行会拿到同一个对象 —— 而原来的逐行闭包各抓各的。WeakMap 按行元素本身建键，
 *  行被移除即条目可回收，既没有覆盖问题，也不会像闭包那样把整份 songs 数组钉在内存上。 */
const rowSong = new WeakMap<HTMLElement, any>();

/** 一个列表容器的渲染状态 + 委托监听（见 renderSongRows）。
 *  监听器装在**容器**上、一个容器只装一次：行本身不再挂 click/dblclick/红心/跳链四类监听。
 *  几千行的列表 = 上万个监听器闭包（每个还拽着整份 songs 数组），这是大曲库下最实在的一笔
 *  常驻开销；委托之后每行只剩右键菜单那一个监听（bindSongMenu 的契约要求挂在行上）。 */
type ListState = {
  hooks: RowHooks;
  songs: any[];
  /** 已登记给 player.markActive？一个容器只登记一次 —— 重画不重复登记，
   *  否则每次搜索/排序都往 player 那边塞一个指向同一个盒子的弱引用，
   *  高亮时就会把同一个列表扫 N 遍（比整篇扫还慢）。 */
  scoped: boolean;
};

const listState = new WeakMap<HTMLElement, ListState>();

/** 红心点击：先乐观改态并广播，再等在线写接口落定（失败由 player 侧回滚）。 */
async function loveFromRow(btn: HTMLElement, s: any, hooks: RowHooks) {
  const done = player.toggleLove(s);
  paintLove(btn, player.loved.has(s.mid));
  const fin = await done;            // 终态：写失败已回滚

  if (fin !== null) paintLove(btn, fin);
  hooks.onLove?.(s, fin ?? player.loved.has(s.mid));
}

/** 给容器装上委托监听并建好 state（每个容器只装一次；重画只换 state 内容）。 */
function ensureListState(box: HTMLElement): ListState {
  const state: ListState = { hooks: {}, songs: [], scoped: false };

  listState.set(box, state);

  // 事件目标是行内任意子元素（span / img / a / button），统一回收成「行 + 该行的歌曲对象」
  const hitRow = (target: HTMLElement) => {
    const row = target.closest<HTMLElement>(".row[data-songkey]");
    const s = row ? rowSong.get(row) : undefined;

    return row && s ? { row, s } : null;
  };

  box.addEventListener("click", (e) => {
    // SAFETY: 监听挂在容器上，事件目标必然是 Element（DOM 点击事件的不变量）
    const target = e.target as HTMLElement;
    const hit = hitRow(target);

    if (!hit) return;
    const { row, s } = hit;
    const { hooks } = state;

    // 歌手/专辑跳转：行内链优先（跳走了就不选中、不预加载）
    const a = target.closest<HTMLElement>("[data-link]");

    if (a) {
      const v = a.dataset.link!;
      const c1 = v.indexOf(":"), c2 = v.indexOf(":", c1 + 1);
      const kind = v.slice(0, c1), mid = v.slice(c1 + 1, c2), name = v.slice(c2 + 1);

      location.hash = `#/${kind}?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(name ?? "")}`;

      return;
    }

    const btn = target.closest<HTMLElement>("[data-love]");

    // 红心：只收藏，不选中、不预加载（原来靠行监听里的 stopPropagation 达成，这里改成显式 return）
    if (btn) {
      void loveFromRow(btn, s, hooks);

      return;
    }

    // 单击 = 选中 + 后台预加载播放链接（释放旧预载）。
    // 封面（.rthumb）也走这条：原来单独挂过一个封面 click 监听做同一件事，纯重复，已删。
    box.querySelectorAll(".row.sel").forEach((r) => r !== row && r.classList.remove("sel"));
    row.classList.add("sel");
    player.prefetchSong(s);
  });

  box.addEventListener("dblclick", (e) => {
    // SAFETY: 同上，委托到容器的双击事件目标必然是 Element
    const t = e.target as HTMLElement;

    if (t.closest("[data-love],a")) return;
    const hit = hitRow(t);

    if (!hit) return;
    const { row, s } = hit;
    const { hooks } = state;
    // 序号与整列以**当时的 DOM**为准：行被删过之后闭包里的 songs 是旧的，照着播会跳错行
    const rows = [...box.querySelectorAll<HTMLElement>(".row[data-songkey]")];

    const all = rows.flatMap((el) => {
      const song = rowSong.get(el);

      return song ? [song] : [];
    });

    hooks.onPlay?.(s, rows.indexOf(row), all);
  });

  return state;
}

export function renderSongRows(box: HTMLElement, songs: any[], hooks: RowHooks = {}) {
  // 整列先在**离屏 fragment** 里拼好，最后一次性换入。对已挂载的活容器逐行 append 会让浏览器
  // 为每次插入登记样式失效（长列表下累积成反复的重算样式 / 布局）；fragment 只在末尾产生一次。
  const frag = document.createDocumentFragment();
  const showCover = hooks.showCover !== false;
  // 同一容器第二次重画：只换 hooks / songs，不再挂一套监听
  const state = listState.get(box) ?? ensureListState(box);

  state.hooks = hooks;
  state.songs = songs;

  for (const [i, s] of songs.entries()) {
    s._key = s.mid ?? String(s.id ?? Math.random());
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.songkey = s._key;
    row.title = "双击播放 · 右键更多";
    rowSong.set(row, s);
    const pic = showCover ? coverUrl(s, 150) : "";

    const artistLine = hooks.showArtist === false ? "" :
      `<span class="ra">${(s.singer ?? []).length ? artistLinks(s.singer) : ""}</span>`;

    const albumLine = hooks.showAlbum ? `<span class="ral">${s.album?.name ? linkTo("album", s.album, s.album.name) : ""}</span>` : "";
    const loved = player.loved.has(s.mid);
    const isLocal = !!s.local;

    // 本地曲目：红心无意义（QQ 收藏概念）；时长未知（NAS 未解析到容器头）画「–」而不是假 0:00
    const loveBtn = hooks.hideLove || isLocal ? "" :
      `<button class="row-love${loved ? " on" : ""}" data-love aria-label="${loved ? "取消收藏" : "收藏"}" aria-pressed="${loved}" data-tooltip="${loved ? "取消收藏" : "收藏"}">${loved ? "♥" : "♡"}</button>`;

    const durText = isLocal && !(s.interval > 0) ? "–" : fmtTime(s.interval);
    // 标题 = title（主名 + 版本后缀）；subtitle 是独立的一句话说明，跟在标题后做次级文本
    const sub = songSubtitle(s);
    row.innerHTML = `<span class="idx">${i + 1}</span>
      ${showCover ? `<span class="rthumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>` : ""}
      <span class="rmeta"><span class="rt" style="display:block">${esc(songTitle(s))}${sub ? `<span class="rt-sub">${esc(sub)}</span>` : ""}</span>${artistLine}${albumLine}</span>
      ${loveBtn}
      <span class="dur">${durText}</span>`;

    // 右键菜单：唯一还挂在行上的监听（契约要求锚点是行本身，见 SongMenu.bindSongMenu）。
    // 上下文在打开时现取（列表可能已被重画，序号以当时的 DOM 为准）
    bindSongMenu(row, () => ({
      song: s,
      list: state.songs,
      index: [...box.children].indexOf(row),
      playlist: hooks.playlist,
      onRemoved: () => {
        // 行淡出移除（与「我喜欢」取消收藏同一套动作），随后交给视图改计数
        row.classList.add("leaving");
        const parent = row.parentElement;
        setTimeout(() => { row.remove(); if (parent) renumberRows(parent); }, 220);
        hooks.onRemoved?.(s);
      },
    }));
    frag.append(row);
  }

  box.replaceChildren(frag);

  // 行高亮（.playing）现在只在登记过的容器里找，不再整篇文档扫两遍。只登记一次，见 ListState.scoped
  if (!state.scoped) {
    state.scoped = true;
    player.registerRowScope(box);
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
