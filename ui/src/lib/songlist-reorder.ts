// Quaver — 歌单页「拖拽重排」：按住行体拖动 → 全量提交 POST /songlist/{dirid}/order
//
// 与队列面板拖拽（components/QueuePanel.ts）同一套指针机制，几何/序列纯逻辑共用
// lib/reorder.ts（dropSlot / edgeSpeed / applyVisibleOrder）。差异只在提交端：
// 队列是本地数组挪位，歌单是**全量顺序写上游**（SeqSonglist），所以有三条额外纪律：
//  1. 只在「默认序 + 无搜索」开放（视图侧由 tools.plain() 现问 enabled()）。
//     筛排副本的拖拽结果映射不回服务端顺序 —— 排过序的列表上拖一行，等于按拼音序
//     重写「加入顺序」，用户没有表达这个意图。
//  2. 提交的是**整单**新顺序（读侧对象数组）。上游对部分提交照样回成功但会打乱
//     未提交歌曲的顺序，绝不能只发被拖的那几行。
//  3. 写确认前乐观改序（DOM 已经是新顺序），失败整表回滚重画 + toast；
//     成功后由 noteSonglistOrder 记庇护 + 增量回源（读侧滞后与增删同族）。
//
// 两条从 QueuePanel 继承的机制性坑（改这里前先看那边注释的完整版）：
//  ① pointermove/up/cancel 挂 window 不挂把手：insertBefore 摘插元素的瞬间浏览器
//     会丢 setPointerCapture 的捕获，挂把手上的监听从此收不到事件 → 拖到一半僵死。
//  ② 量文档流位置前先清内联 transform：.row.dragging 的 transition 不许带 transform，
//     否则 rect 量到动画中间值，残差逐帧复利，行越拖越飘最后飞出指针。
import { dropSlot, edgeSpeed, applyVisibleOrder } from "./reorder";
import { renumberRows, suppressNextRowClick } from "./songs";
import { toast } from "./toast";

export interface SonglistReorderOptions {
  /** 行容器（.rows；行由 renderSongRows 渲染，重画会整批换节点 —— 委托挂容器上不受影响） */
  box: HTMLElement;
  /** 滚动容器（.route）：贴边自动滚动只滚它，绝不 scrollIntoView 连带祖先 */
  scroller: HTMLElement;
  /** 当前是否允许拖（默认序 + 无搜索 + 可写歌单）；每次 pointerdown 现问 */
  enabled: () => boolean;
  /** 读服务端原序（视图的 all；只读，提交前不改它） */
  source: () => any[];
  /** 提交成功：视图把 all 换成新序并同步 painted */
  onOrdered: (ordered: any[]) => void;
  /** 拖拽进行中列表被跟进重画摘了节点 / Esc 取消：视图按当前数据整表重画
   *  （与 onRollback 分开：取消时数据没变，「我喜欢」这类数据层持有真相的视图
   *  不能拿视图本地副本盖回去） */
  onAbort: () => void;
  /** 提交失败：视图按旧序整表重画（DOM 里被拖的行要放回去） */
  onRollback: () => void;
  /** 提交整单新顺序（写接口 + 乐观跟进 + 庇护都由它负责）：
   *  自建歌单 = reorderSonglist + noteSonglistOrder；「我喜欢」= player.reorderLoved。
   *  失败抛错 → 本模块 toast + onRollback。 */
  submit: (ordered: any[]) => Promise<void>;
}

const SQUEEZE_MS = 180;
const EASE = "cubic-bezier(.22,.61,.36,1)";
const DRAG_THRESHOLD = 6;

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 给歌单行容器装上拖拽重排（一个容器装一次；返回退订函数，视图 cleanup 调用）。 */
export function bindSonglistReorder(opts: SonglistReorderOptions): () => void {
  const { box, scroller } = opts;
  let dragRow: HTMLElement | null = null;
  let submitting = false; // 写接口在途：不接受第二次拖拽（顺序基线还没落定）
  const shifts = new WeakMap<HTMLElement, Animation>();

  const rowsNow = () => [...box.querySelectorAll<HTMLElement>(".row[data-songkey]")];

  function squeeze(others: HTMLElement[], mutate: () => void) {
    const before = others.map((el) => el.getBoundingClientRect().top);
    mutate();

    if (reduceMotion()) return;

    for (let i = 0; i < others.length; i++) {
      const el = others[i];
      const d = before[i] - el.getBoundingClientRect().top;

      if (Math.abs(d) < 0.5) continue;
      shifts.get(el)?.cancel();
      shifts.set(el, el.animate(
        [{ transform: `translateY(${d}px)` }, { transform: "translateY(0)" }],
        { duration: SQUEEZE_MS, easing: EASE },
      ));
    }
  }

  /** 松手提交：DOM 序 → 对象序（行元素与 song 对象的对位靠渲染时的 WeakMap 不可见，
   *  这里用 data-songkey + source 对位；重复 mid 时按出现次数依次配对）。 */
  function commit(row: HTMLElement, fromIdx: number) {
    const domRows = rowsNow();
    const to = domRows.indexOf(row);

    if (to === fromIdx || to < 0) return; // 原地落回：transform 已清，天然落位
    const source = opts.source();
    // 行序 → 歌序：按 songkey 分桶保序配对（第 k 个同 key 行领走 source 里第 k 个同 key 对象）
    const byKey = new Map<string, any[]>();

    for (const s of source) {
      const key = String(s._key ?? s.mid ?? "");
      const bucket = byKey.get(key);

      if (bucket) bucket.push(s);
      else byKey.set(key, [s]);
    }

    const orderedVisible: any[] = [];

    for (const el of domRows) {
      const s = byKey.get(el.dataset.songkey ?? "")?.shift();

      if (s) orderedVisible.push(s);
    }

    // 拖拽期间列表被别处重画（增删广播）→ DOM 行对不上原序成员：作废这次拖拽
    if (orderedVisible.length !== domRows.length) { opts.onAbort(); return; }

    const ordered = applyVisibleOrder(source, orderedVisible);

    submitting = true;
    box.classList.add("order-busy");
    opts.submit(ordered)
      .then(() => { opts.onOrdered(ordered); })
      .catch((e: any) => {
        toast("歌单重排失败：" + String(e?.message ?? e), "err");
        opts.onRollback();
      })
      .finally(() => {
        submitting = false;
        box.classList.remove("order-busy");
      });
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || dragRow || submitting || !opts.enabled()) return;
    // SAFETY: pointerdown 的目标必然是 Element（DOM 指针事件的不变量）
    const target = e.target as HTMLElement;

    // 行内链接/按钮保持原生交互，不参与起拖（普通行体单击仍走选中/预加载，双击播放）
    if (target.closest("a, button, input, textarea, select")) return;
    const row = target.closest<HTMLElement>(".row[data-songkey]");

    if (!row || !box.contains(row)) return;
    const fromIdx = rowsNow().indexOf(row);
    const pid = e.pointerId;
    const startY = e.clientY;
    const grabOffset = startY - row.getBoundingClientRect().top;
    let dragging = false;
    let dirty = false;
    let lastY = startY;
    let raf = 0;

    const layout = () => {
      row.style.transform = "";
      const flowTop = row.getBoundingClientRect().top;
      row.style.transform = `translateY(${lastY - grabOffset - flowTop}px)`;
    };

    const reorder = () => {
      const kids = rowsNow();
      const at = kids.indexOf(row);
      const boxes = kids.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, height: r.height }; });
      const slot = dropSlot(boxes, at, lastY);

      if (slot === at) return;
      const others = kids.filter((el) => el !== row);
      squeeze(others, () => box.insertBefore(row, others[slot] ?? null));
    };

    const frame = () => {
      // 行被别处重画摘出文档（阈值窗口期赶上一轮跟进重画）：作废这次拖拽，别把死节点插回去
      if (!row.isConnected) { finish(false); return; }

      const sr = scroller.getBoundingClientRect();
      const sp = edgeSpeed(lastY, sr.top, sr.bottom);
      let scrolled = false;

      if (sp) { const b = scroller.scrollTop; scroller.scrollTop += sp; scrolled = scroller.scrollTop !== b; }

      if (scrolled || dirty) { dirty = false; reorder(); layout(); }

      raf = requestAnimationFrame(frame);
    };

    const finish = (commitIt: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);

      if (!dragging) return;
      dragging = false;
      dragRow = null;
      row.classList.remove("dragging");
      box.classList.remove("reordering");
      row.style.transform = "";
      suppressNextRowClick();

      if (commitIt) {
        renumberRows(box);
        commit(row, fromIdx);
      } else {
        // Esc/pointercancel：DOM 已经挪过 → 交回视图按当前数据重画（比逆向挪 DOM 稳）
        opts.onAbort();
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;

      if (!row.isConnected) { finish(false); return; }

      lastY = ev.clientY;

      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        dragRow = row;
        row.classList.add("dragging");
        box.classList.add("reordering");
        raf = requestAnimationFrame(frame);
      }

      dirty = true;
    };

    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pid) finish(true); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pid) finish(false); };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      finish(false);
    };

    try { row.setPointerCapture(pid); } catch { /* 合成事件降级 */ }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  }

  box.addEventListener("pointerdown", onPointerDown);

  return () => {
    box.removeEventListener("pointerdown", onPointerDown);
  };
}

/** 拖拽是否进行中（视图的重画守卫：拖拽期间不许整表重画，松手后补） */
export function songlistReorderActive(box: HTMLElement): boolean {
  return box.classList.contains("reordering");
}
