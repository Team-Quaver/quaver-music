// Quaver — 歌曲列表工具条：本地搜索 + 排序（歌单页 / 我喜欢共用）
//
// 需求口径：排序 = 默认 / 歌曲名正倒 / 歌手正倒，**全部本地生效**（不回源）。
// 两条不能动的约束：
//  1. **原序不许动**：「默认」= 服务端给的顺序 —— 歌单是 orderlist（= 加入歌单的时间），
//     我喜欢是收藏顺序。所以过滤/排序一律作用在副本上，source() 那份数组只读
//     （就地 sort 会把「加入时间」这类信息永久弄丢，再也拿不回来）。
//  2. 控件靠右（版式在 style.css 的 .list-tools），命中计数在左。
//
// 调用方只需给两样东西：读原序的取值器 + 渲染回调（拿到筛排后的列表）。
// 用**函数**取原序而不是直接传数组：删除一行后调用方改的是自己那份数组的内容，
// 不必回来重新注册，这里的引用也不会悬空。
import { songSubtitle, songTitle } from "../lib/api";

export type RowSortKey = "default" | "name" | "singer";

export interface SongListTools {
  el: HTMLElement;
  /** 当前「筛选 + 排序」后的列表（调用方要用可见顺序时读它） */
  visible(): any[];
  /** 按当前条件重画（触发 paint 回调）并刷新计数 */
  repaint(): void;
  /** 只刷新计数读数（列表内容被外部删掉一行、但不需要重排时用） */
  refreshCount(): void;
}

export interface SongListToolsOptions {
  /** 读「服务端原序」。每次取值都重新读，删除后调用方改的数组内容即时可见 */
  source: () => any[];
  /** 渲染回调：收到筛选 + 排序后的列表；`filtering` 用来区分「搜索没命中」与「列表本来就空」 */
  paint: (list: any[], state: { filtering: boolean }) => void;
  /** 搜索框占位文案（歌单页 / 我喜欢 各说各的） */
  hint?: string;
}

/** 中文按拼音排；数字感知（「第 2 首」排在「第 10 首」前面） */
const COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/** 逐字符重建整张列表（大列表上千行）会卡，输入按这个时长合并；点击排序/清空立即画。 */
const INPUT_DEBOUNCE_MS = 120;

export function songListTools(opts: SongListToolsOptions): SongListTools {
  const el = document.createElement("div");
  el.className = "list-tools";
  el.innerHTML = `
    <span class="lt-count"></span>
    <span class="sb-field lt-search">
      <span class="sb-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg></span>
      <input class="lt-kw" type="search" placeholder="${opts.hint ?? "在列表内搜索"}" autocomplete="off" spellcheck="false" aria-label="在列表内搜索" />
      <button class="lt-clr" type="button" title="清空" aria-label="清空搜索" hidden>✕</button>
    </span>
    <div class="lt-sort" role="group" aria-label="排序方式">
      <button class="lt-sg" type="button" data-sort="default" aria-pressed="true">默认</button>
      <button class="lt-sg" type="button" data-sort="name" aria-pressed="false">歌曲名<i class="dir"></i></button>
      <button class="lt-sg" type="button" data-sort="singer" aria-pressed="false">歌手<i class="dir"></i></button>
    </div>`;

  const kwEl = el.querySelector<HTMLInputElement>(".lt-kw")!;
  const clrEl = el.querySelector<HTMLButtonElement>(".lt-clr")!;
  const countEl = el.querySelector<HTMLElement>(".lt-count")!;
  const sortBtns = [...el.querySelectorAll<HTMLButtonElement>(".lt-sg")];

  let kw = "";
  let sortKey: RowSortKey = "default";
  let desc = false;
  let timer = 0;

  const nameOf = (s: any) => songTitle(s);
  // 合唱/合作：整串参与排序，别只看第一位歌手
  const singerOf = (s: any) => (s.singer ?? []).map((x: any) => x?.name ?? "").join(" / ");
  // \u0001 分隔，免得「名字末尾 + 歌手开头」拼出跨字段的假命中
  const hayOf = (s: any) =>
    [songTitle(s), s.name, songSubtitle(s), singerOf(s), s.album?.name ?? ""].join("\u0001").toLowerCase();

  function visible(): any[] {
    const all = opts.source();
    const q = kw.trim().toLowerCase();
    const list = q ? all.filter((s) => hayOf(s).includes(q)) : all.slice();
    if (sortKey === "default") return list; // 原序原样返回
    const key = sortKey === "name" ? nameOf : singerOf;
    // 主键相同再用曲名兜底：顺序稳定可预期（同名不同版本相邻）
    const sorted = list.sort((a, b) => COLLATOR.compare(key(a), key(b)) || COLLATOR.compare(nameOf(a), nameOf(b)));
    return desc ? sorted.reverse() : sorted;
  }

  function refreshCount() {
    countEl.textContent = kw.trim() ? `${visible().length} / ${opts.source().length} 首` : "";
  }

  function paint() {
    window.clearTimeout(timer); // 立即画的场合（点击/清空）把排队中的那次吃掉，别画两遍
    timer = 0;
    for (const b of sortBtns) {
      const on = b.dataset.sort === sortKey;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      const dir = b.querySelector<HTMLElement>(".dir");
      if (dir) dir.textContent = on && sortKey !== "default" ? (desc ? "↓" : "↑") : "";
    }
    clrEl.hidden = !kw;
    refreshCount();
    opts.paint(visible(), { filtering: !!kw.trim() });
  }

  const paintSoon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(paint, INPUT_DEBOUNCE_MS);
  };

  kwEl.addEventListener("input", () => { kw = kwEl.value; clrEl.hidden = !kw; paintSoon(); });
  kwEl.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    kwEl.value = "";
    kw = "";
    paint();
  });
  clrEl.addEventListener("click", () => { kwEl.value = ""; kw = ""; kwEl.focus(); paint(); });
  for (const b of sortBtns) {
    b.addEventListener("click", () => {
      const key = b.dataset.sort as RowSortKey;
      if (key === sortKey) { if (key !== "default") desc = !desc; } // 同一个键再点 = 正/倒对调
      else { sortKey = key; desc = false; }
      paint();
    });
  }

  return { el, visible, repaint: paint, refreshCount };
}
