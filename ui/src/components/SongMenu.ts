// Quaver — 歌曲行右键菜单（歌曲列表通用，搜索页同样生效）
//
// 菜单结构（自上而下）：
//   插队播放 / 加入歌单 ▸ 我创建的歌单 / 从歌单删除 / 跳转至 ▸ 歌手·专辑·同名搜索 /
//   更多操作 ▸ 复制歌曲链接·复制歌曲名称
//
// 设计约束：
//  - 面板是 body 下的常驻层（position:fixed），不受 .route 的 transform/overflow 影响；
//  - 子菜单悬停展开、可返回（指针越过间隙有 150ms 宽限）；打开下一个父项时深层菜单立刻收起；
//  - 关闭时机：点面板外 / Esc / 滚动 / 窗口尺寸变化 / 路由变化 —— 位置是算好的，留着就会错位；
//  - 「从歌单删除」只在**自己有写权限的歌单页**出现（别人歌单/我喜欢的删除由红心承担）。
import { player } from "../player";
import { copyText, songShareUrl, songSubtitle, songTitle, stripEm, upPic } from "../lib/api";
import {
  addSongToSonglist, isMySonglistsLoaded, loadMySonglists, mySonglists, removeSongFromSonglist,
  type MyPlaylist,
} from "../lib/playlists";

export interface SongMenuContext {
  song: any;
  /** 所在列表（「播放该列表」语义留白：本菜单不做整列表替换，只用它取序号） */
  list: any[];
  index: number;
  /** 当前所在歌单：removable=true 时才出现「从歌单删除」 */
  playlist?: { dirid: number; tid: number; title: string; removable: boolean };
  /** 从歌单删成之后的回调（视图侧把行移走 / 改计数） */
  onRemoved?: () => void;
}

interface MenuItem {
  label: string;
  note?: string;
  thumb?: string;
  round?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** 惰性子菜单（每次展开重算；可异步，展开时先画「载入中…」） */
  sub?: () => MenuItem[] | Promise<MenuItem[]>;
  run?: () => void | Promise<void>;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

const VIEW_PAD = 8;      // 面板离视口边缘的最小余量
const SUB_GAP = 4;       // 子菜单与父面板的水平间隙
const SUB_GRACE_MS = 150; // 指针离开父项后给子菜单的宽限

// —— 提示条：菜单动作的反馈（加入歌单/复制这类没有原地视觉结果的动作）——
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
export function toast(msg: string, kind: "ok" | "err" = "ok") {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.toggle("err", kind === "err");
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), kind === "err" ? 3600 : 2000);
}

// —— 菜单层 ——
let layer: HTMLElement | null = null;
let panels: HTMLElement[] = [];   // 打开中的面板（0 = 顶层）
/** 菜单的锚点（右键的那一行）：滚动时用它判断「谁在滚」会不会真把菜单甩脱位置 */
let anchorEl: HTMLElement | null = null;
let subGrace = 0;
/** 子菜单请求序号：异步内容回来时只认最后一次悬停（否则快速划过父项会让旧内容落地） */
let subSeq = 0;
/** 菜单项自增 id：面板记下自己是由哪个项挂出来的，同项重复悬停就不用重建 */
let itemSeq = 0;

const invalidateSubs = () => { subSeq++; };

function ensureLayer(): HTMLElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "ctx-layer";
    document.body.append(layer);
  }
  return layer;
}

function dropPanels(from: number) {
  for (const p of panels.slice(from)) p.remove();
  panels = panels.slice(0, from);
}

function place(panel: HTMLElement, x: number, y: number, parentItem?: HTMLElement) {
  const r = panel.getBoundingClientRect();
  let left = x;
  let top = y;
  if (parentItem) {
    const pr = parentItem.getBoundingClientRect();
    // 优先贴父项右侧；右侧放不下就翻到左侧
    left = pr.right + SUB_GAP;
    if (left + r.width > window.innerWidth - VIEW_PAD) left = pr.left - r.width - SUB_GAP;
    top = pr.top - 6;
  } else if (left + r.width > window.innerWidth - VIEW_PAD) {
    left = x - r.width;
  }
  left = clamp(left, VIEW_PAD, Math.max(VIEW_PAD, window.innerWidth - r.width - VIEW_PAD));
  top = clamp(top, VIEW_PAD, Math.max(VIEW_PAD, window.innerHeight - r.height - VIEW_PAD));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function renderItems(panel: HTMLElement, items: MenuItem[], depth: number) {
  panel.innerHTML = "";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.itemId = String(++itemSeq);
    btn.className = "ct-item"
      + (it.danger ? " danger" : "")
      + (it.sub ? " has-sub" : "")
      + (it.disabled ? " disabled" : "");
    btn.disabled = !!it.disabled;
    btn.setAttribute("role", "menuitem");
    btn.innerHTML =
      `<span class="ct-ic">${it.thumb ? `<img class="${it.round ? "round" : ""}" src="${esc(it.thumb)}" alt="" loading="lazy"/>` : ""}</span>`
      + `<span class="ct-label">${esc(it.label)}</span>`
      + (it.note ? `<span class="ct-note">${esc(it.note)}</span>` : "")
      + (it.sub ? `<span class="ct-caret" aria-hidden="true">›</span>` : "");

    /** 展开本项的子菜单（异步内容先画「载入中…」占位） */
    const openSub = () => {
      if (!it.sub) return;
      if (panels[depth] !== panel) return; // 本面板已被替换/关闭
      // **同层换项**：先把比本项更深的面板收掉再挂自己的。
      // （早期版本在这里写 `panels.length !== depth + 1 → return`，本意是丢掉过期异步结果，
      //   副作用却是「第一个子菜单一开，同层其它项永远打不开」—— 收起深层是必须的，不是拒绝。）
      const cur = panels[depth + 1];
      if (cur && cur.dataset.owner === btn.dataset.itemId) return; // 已经是本项的子菜单：不重建（免得闪烁）
      dropPanels(depth + 1);
      const seq = ++subSeq;
      const show = (list: MenuItem[]) => {
        // 期间指针已换到别的项（seq 变）/ 本面板已被收起 → 丢弃这批内容
        if (seq !== subSeq || panels[depth] !== panel) return;
        openPanel(list, depth + 1, { x: 0, y: 0 }, btn);
      };
      let r: MenuItem[] | Promise<MenuItem[]>;
      try { r = it.sub(); } catch { return; }
      if (Array.isArray(r)) { show(r); return; }
      show([{ label: "载入中…", disabled: true }]);
      r.then(show, () => show([{ label: "载入失败", disabled: true }]));
    };

    if (it.sub) {
      btn.addEventListener("pointerenter", () => {
        window.clearTimeout(subGrace);
        openSub();
      });
      btn.addEventListener("pointerleave", () => {
        window.clearTimeout(subGrace);
        // 这里**不能** invalidateSubs()：本项的子菜单可能正显示「载入中…」，
        // 指针移进子菜单等着，作废掉在飞的请求它就永远停在占位态了。
        subGrace = window.setTimeout(() => dropPanels(depth + 1), SUB_GRACE_MS);
      });
    } else {
      btn.addEventListener("pointerenter", () => {
        window.clearTimeout(subGrace);
        invalidateSubs();        // 移回普通项：在飞的异步子菜单作废
        dropPanels(depth + 1);   // 深层子菜单立刻收起
      });
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      if (it.sub) { openSub(); return; }
      const run = it.run;
      closeMenu();
      void Promise.resolve()
        .then(() => run?.())
        .catch((err: any) => toast(String(err?.message ?? err), "err"));
    });
    panel.append(btn);
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "ct-empty";
    empty.textContent = "（空）";
    panel.append(empty);
  }
}

function openPanel(items: MenuItem[], depth: number, at: { x: number; y: number }, anchor?: HTMLElement): HTMLElement {
  dropPanels(depth);
  const panel = document.createElement("div");
  panel.className = "ctx-menu";
  panel.setAttribute("role", "menu");
  panel.dataset.depth = String(depth);
  // 记住「本面板由哪个菜单项挂出来」：同项重复悬停 / 从子菜单绕回父项时不重建
  panel.dataset.owner = anchor?.dataset.itemId ?? "root";
  // 指针从父项移进本面板 → 撤销父项那边的收起定时器
  panel.addEventListener("pointerenter", () => window.clearTimeout(subGrace));
  ensureLayer().append(panel);
  panels.push(panel);
  renderItems(panel, items, depth);
  place(panel, at.x, at.y, anchor);
  return panel;
}

// —— 关闭：位置是算好的，这几类变化一来就必须收 ——
function onDocDown(e: PointerEvent) {
  if (layer && !layer.contains(e.target as Node)) closeMenu();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); closeMenu(); }
}
/**
 * 滚动收起 —— **只认「会把菜单甩脱位置」的那一种**。
 *
 * 曾经写成「凡是滚动就收」，结果就是本文件头记的那个 bug：菜单**刚开就闪没**。
 * 真因是 .np（正在播放）**不是 display:none**，它是 opacity:0 + translateY(100%) 常驻布局，
 * 于是歌词每换一行就 `lyrics.scrollTo({behavior:"smooth"})` —— smooth 滚动会连发几百毫秒的
 * scroll 事件，被这里的捕获监听当成「页面滚动」。队列面板切歌时 revealCurrent() 改
 * .qp-list.scrollTop、关于页的日志框自动滚到底，都是同源误伤。
 *
 * 菜单是 fixed 定位、坐标来自打开时的指针 —— 只有这两类滚动会让它跟锚点脱节：
 *   ① 文档/窗口自己滚（scroll 事件的 target 是 document / html / body）；
 *   ② 锚点所在的**可滚祖先**滚（本项目里就是 .route）。
 * 别的容器自己滚，锚点没动，菜单也没错位，没道理收。
 */
function onScroll(e: Event) {
  if (!layer) return;
  const t = e.target as Node | null;
  if (!t || t === document || t === document.documentElement || t === document.body) { closeMenu(); return; }
  if (anchorEl && t instanceof Element && (t === anchorEl || t.contains(anchorEl))) closeMenu();
}
function onShift() { closeMenu(); }

function bindGlobal(on: boolean) {
  if (on) {
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onShift);
    window.addEventListener("blur", onShift);
    window.addEventListener("hashchange", onShift);
  } else {
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onShift);
    window.removeEventListener("blur", onShift);
    window.removeEventListener("hashchange", onShift);
  }
}

export function closeMenu() {
  window.clearTimeout(subGrace);
  invalidateSubs();
  dropPanels(0);
  layer?.remove();
  layer = null;
  anchorEl = null;
  bindGlobal(false);
}

export function isSongMenuOpen() { return !!layer; }

// —— 菜单内容 ——

/** 插队播放（菜单项与搜索页双击共用一处语义 + 一处回执）：
 *  把歌排到当前曲之后等着播 —— 不切歌、不打断；唯一可见反馈就是队列里多了一条，
 *  所以补一条 toast，否则「什么都没发生」。队列空着时会直接起播，那时文案也跟着变。 */
export function enqueueNextWithToast(song: any) {
  if (!song?.mid) return;
  const playing = !!player.current;
  const label = songTitle(song) || "这首歌";
  player.enqueueNext(song);
  toast(playing ? `已插队：${label}（下一首播放）` : `开始播放：${label}`);
}

function artistItems(song: any): MenuItem[] {
  const singers: any[] = song?.singer ?? [];
  if (!singers.length) return [{ label: "没有歌手信息", disabled: true }];
  return singers.map((a) => ({
    label: stripEm(a?.name) || "未知歌手",
    thumb: a?.mid || a?.pmid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${a.pmid || a.mid}.jpg` : "",
    round: true,
    disabled: !a?.mid,
    run: () => {
      if (!a?.mid) return;
      location.hash = `#/singer?mid=${encodeURIComponent(a.mid)}&name=${encodeURIComponent(stripEm(a.name) || "歌手")}`;
    },
  }));
}

function albumItems(song: any): MenuItem[] {
  const alb = song?.album;
  if (!alb?.mid && !alb?.pmid) return [{ label: "没有专辑信息", disabled: true }];
  const base = String(alb.pmid || alb.mid).split("_")[0];
  return [{
    label: stripEm(alb.name) || "专辑",
    thumb: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${base}.jpg`,
    run: () => {
      location.hash = `#/album?mid=${encodeURIComponent(alb.mid ?? base)}&name=${encodeURIComponent(stripEm(alb.name) || "专辑")}`;
    },
  }];
}

function playlistItems(ctx: SongMenuContext): Promise<MenuItem[]> | MenuItem[] {
  const build = (list: MyPlaylist[]): MenuItem[] => {
    if (!list.length) return [{ label: "还没有自建歌单", disabled: true }];
    return list.map((p) => ({
      label: p.title,
      note: p.songnum ? `${p.songnum} 首` : "",
      thumb: upPic(p.picurl),
      run: async () => {
        await addSongToSonglist(p, ctx.song);
        toast(`已加入「${p.title}」`);
      },
    }));
  };
  if (isMySonglistsLoaded()) return build(mySonglists());
  return loadMySonglists().then(build, () => [{ label: "歌单加载失败（需要登录）", disabled: true }]);
}

function buildItems(ctx: SongMenuContext): MenuItem[] {
  const song = ctx.song;
  const name = songTitle(song) || "这首歌";
  const sub = songSubtitle(song);
  const items: MenuItem[] = [
    {
      label: "插队播放",
      note: "排到下一首",
      run: () => enqueueNextWithToast(song),
    },
    { label: "加入歌单", sub: () => playlistItems(ctx) },
  ];
  if (ctx.playlist?.removable) {
    items.push({
      label: "从歌单删除",
      danger: true,
      run: async () => {
        await removeSongFromSonglist(ctx.playlist!, song);
        ctx.onRemoved?.();
        toast(`已从「${ctx.playlist!.title}」移除`);
      },
    });
  }
  items.push(
    {
      label: "跳转至",
      sub: () => [
        { label: "歌手", sub: () => artistItems(song) },
        { label: "专辑", sub: () => albumItems(song) },
        {
          label: "同名搜索",
          note: name,
          run: () => { location.hash = `#/search?keyword=${encodeURIComponent(stripEm(song.name) || name)}`; },
        },
      ],
    },
    {
      label: "更多操作",
      sub: () => [
        {
          label: "复制歌曲链接",
          run: async () => {
            const ok = await copyText(songShareUrl(song.mid));
            toast(ok ? "已复制歌曲链接" : "复制失败（剪贴板不可用）", ok ? "ok" : "err");
          },
        },
        {
          label: "复制歌曲名称",
          run: async () => {
            const ok = await copyText(sub ? `${name} ${sub}` : name);
            toast(ok ? `已复制：${name}` : "复制失败（剪贴板不可用）", ok ? "ok" : "err");
          },
        },
      ],
    },
  );
  return items;
}

/** 在 (x, y) 打开菜单（坐标一般是鼠标位置）。anchor = 右键的那一行，滚动判据要用它 */
export function openSongMenu(x: number, y: number, ctx: SongMenuContext, anchor?: HTMLElement) {
  closeMenu(); // 只留一层：换目标/重复右键都以最后一次为准
  anchorEl = anchor ?? null;
  void loadMySonglists().catch(() => {}); // 预热：悬停到「加入歌单」时列表多半已就绪
  bindGlobal(true);
  openPanel(buildItems(ctx), 0, { x, y });
}

/** 给一行挂右键菜单（行元素只需在触发时能提供上下文） */
export function bindSongMenu(row: HTMLElement, get: () => SongMenuContext) {
  row.addEventListener("contextmenu", (e) => {
    const me = e as MouseEvent;
    me.preventDefault();
    me.stopPropagation();
    openSongMenu(me.clientX, me.clientY, get(), row);
  });
}
