// 播放列表面板：点击切歌 / 拖拽排序 / 单曲移除 / 一键清空。
// 双形态自适应（ResizeObserver 驱动）：
//   内容区宽度足够 → 停靠（.dock）在 .content 右缘（.content-body flex 行内），
//                    路由视图区（主页/搜索/歌手页…）自动让宽 = 整页缩放；
//   宽度不够       → 浮窗（.float）固定于窗口右下、悬在内容之上（原行为）。
import { player, type Song } from "../player";
import { coverUrl, songTitle } from "../lib/api";
import { icons } from "../lib/icons";
import { dropSlot, edgeSpeed } from "../lib/reorder";

/** 内容区达到该宽度才停靠（再窄会把视图区挤得放不下卡片网格） */
const DOCK_MIN_CONTENT = 880;

export function QueuePanel(): HTMLElement {
  const el = document.createElement("div");
  el.className = "queue-panel float";
  el.id = "queue-panel";
  el.innerHTML = `
    <div class="qp-head">
      <span class="qp-title">播放列表<i class="qp-cnt" id="qp-cnt"></i></span>
      <span class="qp-actions">
        <button class="qp-act" id="qp-clear" title="清空队列" aria-label="清空队列">${icons.trash}</button>
        <button class="qp-act" id="qp-close" title="收起" aria-label="收起">${icons.chevronDown}</button>
      </span>
    </div>
    <div class="qp-list" id="qp-list"></div>
  `;
  const list = el.querySelector<HTMLElement>("#qp-list")!;
  const cnt = el.querySelector<HTMLElement>("#qp-cnt")!;
  el.querySelector<HTMLElement>("#qp-close")!.onclick = () => { player.queueOpen = false; player.notifyPublic(); };
  el.querySelector<HTMLElement>("#qp-clear")!.onclick = () => player.clearQueue();

  // —— 形态切换：停靠 / 浮窗（**与开合解耦**，见 applyLayout 的注释）——
  const contentEl = () => document.querySelector<HTMLElement>(".content");
  const contentBody = () => document.querySelector<HTMLElement>(".content-body");
  const npEl = () => document.querySelector<HTMLElement>(".np");
  const dockable = () => { const c = contentEl(); return !!c && c.clientWidth >= DOCK_MIN_CONTENT; };

  /** 定形态（停靠 .dock / 浮窗 .float）并换到对应父节点；返回**是否真的换了父节点**。
   *
   *  关键：形态只看内容区宽度，**跟开关无关 —— 关闭时也要定好**。
   *  早期实现是「打开时才按宽度定形态」，于是首次展开会在同一帧里「换父节点 + 加 .open」，
   *  浏览器把插入与类变更合并成一次样式重算，transition 压根不会启动 ——
   *  表现就是「第一次展开没有动画，之后再展开就正常了」（换过一次父节点之后不再换）。
   *  代价为零：关闭态是 width:0/opacity:0，隐藏着搬节点肉眼看不出。 */
  function applyLayout(): boolean {
    // 正在播放全屏页：一律浮窗（固定右侧的通栏 dock 会把歌词区挤失衡，实测弃用）。
    // float 挂 body、z:70 浮在全屏层（z:50）之上，开关仍由播放条队列按钮驱动；
    // 收回全屏页后走正常逻辑按宽度停靠/浮窗。
    const dock = !(npEl() && player.expanded) && dockable();
    el.classList.toggle("dock", dock);
    el.classList.toggle("float", !dock);
    const want = dock ? contentBody() : document.body;
    if (!want || el.parentElement === want) return false;
    want.append(el);
    return true;
  }

  function applyOpen() {
    const open = player.queueOpen;
    el.classList.toggle("open", open);
    // 关闭态不只是「看不见」：连同 tab 焦点/读屏/「聚焦即滚进视野」一起摘掉。
    // 面板必须常驻 DOM（不能用 display:none，否则没有过渡），不 inert 的话键盘 Tab 能进到里面，
    // 而浏览器会把聚焦元素滚进视野 —— .content 一旦被程序化滚动，整个路由视图就横移
    // （与 scrollIntoView 那起事故同源；见 revealCurrent 的注释）。
    el.toggleAttribute("inert", !open);
  }

  /** 开合 + 形态。刚换过父节点就把 .open 推到下一帧：新插入的节点必须有一帧「关闭态」垫底，
   *  过渡才有的可比（否则从无到有直接落在终态）。 */
  function syncMount() {
    if (applyLayout()) {
      el.classList.remove("open");
      requestAnimationFrame(applyOpen);
      return;
    }
    applyOpen();
  }
  // 关闭时也让形态跟着宽度走：否则窗口尺寸变过之后的下一次展开又会「边换父节点边开」
  const ro = new ResizeObserver(syncMount);
  const contentBox = contentEl();
  if (contentBox) ro.observe(contentBox);
  syncMount();
  // 再补一次：本组件构造时节点**还没进 DOM**（壳层是 `document.body.append(NowPlaying(), QueuePanel())`），
  // 上面那次定完形态后立刻被壳层搬去 body。等一帧再定，让首次展开时形态与父节点都已就位 ——
  // 不补这一次也能靠 syncMount 的 rAF 兜底动画，但那样第一次展开仍会搬节点，不如让它彻底不动。
  requestAnimationFrame(syncMount);

  // —— 列表渲染（订阅式：队列/指针/播放态变化才重建） ——
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  let suppressClick = false; // 拖拽松手后补发的 click 不切歌
  let sig = "";
  let dragRow: HTMLElement | null = null; // 正在被拖的行：它的节点得活着，订阅不许重建列表
  let pendingRebuild = false;             // 拖拽期间被推迟的那次重建（松手后补上）

  function render() {
    list.innerHTML = "";
    if (!player.queue.length) {
      list.innerHTML = `<div class="qp-empty">队列为空<span>播放一首歌，或用「下一首播放」加入</span></div>`;
      return;
    }
    player.queue.forEach((q, i) => list.append(rowOf(q, i)));
    revealCurrent();
  }

  player.on(() => {
    syncMount();
    const s = player.queue.map((q) => q.mid).join(",") + "#" + player.index + "#" + player.playing + "#" + player.loading;
    if (s === sig) return; // 内容没变不重建
    sig = s;
    cnt.textContent = player.queue.length ? `${player.queue.length} 首` : "";
    // 拖拽中**绝不重建**：整表重画会把正在拖的那一行连节点带监听一起换掉，表现就是
    // 「拖到一半突然不动了」—— notify 是 4Hz 的位置广播，随时可能踩进来（缓冲完成、
    // 播放态翻转都会改 sig）。推迟到松手再补：拖拽期间队列本身不会变，晚一会儿重画无感。
    if (dragRow) { pendingRebuild = true; return; }
    render();
  });

  /** 把当前曲滚到列表可见处 —— **只动 .qp-list 自己的 scrollTop**。
   *
   *  千万别用 `row.scrollIntoView()`：它会把**所有**可滚祖先的 scrollport 一起滚。
   *  `.content` 是 `position:relative; overflow:hidden`——overflow:hidden 的盒子**程序化照样能滚**
   *  （scrollLeft 能设），于是路由视图会跟着横移。
   *  浮窗态之所以没暴露：面板 fixed 挂在 body 下，宿主没有可滚祖先，`block:"nearest"` 无事可做；
   *  一旦停靠（.content-body 内）就变成「0 宽 + overflow:hidden 裁切 + translateX(20px)」，
   *  行落在内容区右缘之外 → `.content` 的 scrollLeft 被设上 → **切歌即 ContentView 错位**。
   *  所以这里用 rect 差值自己滚，绝不碰祖先。 */
  function revealCurrent() {
    const row = list.querySelector<HTMLElement>(".cur");
    if (!row) return;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top;
    else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom;
  }

  function rowOf(q: Song, i: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "qp-item" + (i === player.index ? " cur" : "");
    const pic = coverUrl(q, 90); // QQ 音乐 CDN 只认 90/150/300/500 等标准尺寸，64 会 404
    row.innerHTML = `
      <span class="qi-grip" title="拖动排序" aria-hidden="true">${icons.grip}</span>
      <span class="qi-thumb">${pic ? `<img src="${pic}" alt="" loading="lazy" draggable="false"/>` : ""}</span>
      <span class="qi-i">${i === player.index ? (player.loading ? "…" : player.playing ? "♪" : "❚❚") : i + 1}</span>
      <span class="qi-main">
        <span class="qi-n">${escapeHtml(songTitle(q))}</span>
        <span class="qi-a">${escapeHtml((q.singer ?? []).map((x) => x.name).join(" / "))}</span>
      </span>
      <button class="qi-del" title="移出队列" aria-label="移出队列">${icons.close}</button>
    `;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".qi-grip, .qi-del")) return; // 把手/删除钮不触发切歌
      if (suppressClick) return;
      player.jump(i);
    });
    row.querySelector<HTMLElement>(".qi-del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      player.removeAt(i);
    });
    bindDrag(row, i);
    return row;
  }

  // —— 拖拽排序（指针事件）——
  // 行始终留在文档流里（transform 只做视觉位移），指针压过邻行中线就换 DOM 位置，
  // 换位后按「视觉顶边贴指针」重算 transform，肉眼无跳变；松手按最终 DOM 序提交。
  // 邻行的让位走 FLIP（先量旧位置、换位后再量一次，用 WAAPI 从旧位置滑到新位置）——
  // 这就是「被拖的行把上下内容挤开」的观感。
  //
  // 两条曾经让拖拽直接失灵的坑，改这里前先看一眼：
  //  ① 监听挂 window，不挂把手。换位要 insertBefore，元素被摘出来再插回去，那一瞬间
  //     浏览器会丢掉 setPointerCapture 的捕获；捕获一丢，挂在把手上的 pointermove 就再也
  //     收不到（指针早就不在把手上了）→ 拖到一半僵死。事件无论怎么重定向都会冒到 window。
  //  ② 量文档流位置前先把 transform 清掉。.qp-item 自带 transform 过渡，getBoundingClientRect()
  //     读到的是动画中间值，拿它反推流位置会把上一帧的残差再算一遍，行越拖越飘最后飞出指针。
  const SQUEEZE_MS = 180; // 邻行被挤开的滑动时长
  const SETTLE_MS = 200;  // 松手后落位的收尾时长
  const EASE = "cubic-bezier(.22,.61,.36,1)"; // 与全站同一套缓动
  const DRAG_THRESHOLD = 6; // 纵向位移超过它才算拖（点了不走 = 切歌）

  const reduceMotion = () =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** 视口坐标 → 列表内容坐标（滚动位置变化时两者会漂，做差之前先统一到这一把尺子上） */
  const contentY = (viewportY: number) => viewportY - list.getBoundingClientRect().top + list.scrollTop;

  const shifts = new WeakMap<HTMLElement, Animation>();
  /** 邻行让位动画：换位前量一次、换位后量一次，让每行从旧位置滑到新位置。
   *  量的是**当前视觉位置**（可能正在上一次滑动的中途），所以连续换位会平滑接上，不跳。 */
  function squeeze(others: HTMLElement[], mutate: () => void) {
    const before = others.map((el) => el.getBoundingClientRect().top);
    mutate();
    if (reduceMotion()) return;
    for (let i = 0; i < others.length; i++) {
      const el = others[i];
      const d = before[i] - el.getBoundingClientRect().top;
      if (Math.abs(d) < 0.5) continue; // 没动过的行不要挂空动画
      shifts.get(el)?.cancel(); // 上一次还没滑完就被再次挤开：直接接上新目标
      shifts.set(el, el.animate(
        [{ transform: `translateY(${d}px)` }, { transform: "translateY(0)" }],
        { duration: SQUEEZE_MS, easing: EASE },
      ));
    }
  }

  /** 整行可拖（把手只是给个显式入口）：按住行体纵向拖同样能排序。
   *  触屏上纵向手势归列表滚动（.qp-item 是 touch-action:pan-y），拖拽走把手（none）。 */
  function bindDrag(row: HTMLElement, fromIdx: number) {
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".qi-del")) return; // 删除钮：不参与拖拽
      if (dragRow) return; // 一次只拖一行
      const pid = e.pointerId;
      const startY = e.clientY;
      const grabOffset = startY - row.getBoundingClientRect().top; // 指针在行内的抓取偏移
      let dragging = false;
      let dirty = false; // 指针动过了 → 下一帧重算落点
      let lastY = startY;
      let raf = 0;

      /** 把行挪到「指针 - 抓取偏移」处（见上面坑 ②） */
      const layout = () => {
        row.style.transform = "";
        const flowTop = row.getBoundingClientRect().top;
        row.style.transform = `translateY(${lastY - grabOffset - flowTop}px)`;
      };
      /** 落点变了才动 DOM；动就走 squeeze，让被挤开的邻行滑过去 */
      const reorder = () => {
        const kids = [...list.children] as HTMLElement[];
        const at = kids.indexOf(row);
        const boxes = kids.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, height: r.height }; });
        const slot = dropSlot(boxes, at, lastY);
        if (slot === at) return;
        const others = kids.filter((el) => el !== row);
        squeeze(others, () => list.insertBefore(row, others[slot] ?? null));
      };
      /** 每帧结算一次：贴边自动滚动 + 落点 + 位移（不在 pointermove 里直接算，
       *  指针事件来得多快就重排多少次没必要，而且贴边悬停不动也得继续滚） */
      const frame = () => {
        const lr = list.getBoundingClientRect();
        const sp = edgeSpeed(lastY, lr.top, lr.bottom);
        let scrolled = false;
        if (sp) { const b = list.scrollTop; list.scrollTop += sp; scrolled = list.scrollTop !== b; }
        if (scrolled || dirty) { dirty = false; reorder(); layout(); }
        raf = requestAnimationFrame(frame);
      };
      /** 松手/取消：落回最终槽位并提交 */
      const finish = (commit: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        cancelAnimationFrame(raf);
        if (!dragging) return;
        const to = [...list.children].indexOf(row);
        const from = contentY(row.getBoundingClientRect().top); // 松手瞬间的视觉位置（内容坐标）
        dragging = false;
        dragRow = null;
        row.classList.remove("dragging");
        list.classList.remove("reordering");
        row.style.transform = "";
        setTimeout(() => { suppressClick = false; }, 0); // click 在 pointerup 之后补发，只吞这一发
        if (commit && to !== fromIdx && !pendingRebuild) {
          // pendingRebuild = 拖拽期间队列变过（4Hz 广播里插进来的一首/删掉的一首）：
          // 这时 DOM 里的行下标已经不对应 player.queue，硬提交会把**别的**歌挪走 —— 宁可作废。
          player.moveInQueue(fromIdx, to); // 同步 notify → 列表按新序重建
          settle(to, from);
        } else if (pendingRebuild) {
          render(); // 顺序作废 / 队列变过 → 按最新队列重画
        }
        pendingRebuild = false;
      };
      /** 松手后列表已重建：把落在最终槽位的新行从松手位置滑回去（否则是硬闪一下） */
      const settle = (to: number, fromTop: number) => {
        const el = list.children[to] as HTMLElement | undefined;
        if (!el || reduceMotion()) return;
        const d = fromTop - contentY(el.getBoundingClientRect().top);
        if (Math.abs(d) < 1) return;
        shifts.get(el)?.cancel();
        el.animate([{ transform: `translateY(${d}px)` }, { transform: "translateY(0)" }],
          { duration: SETTLE_MS, easing: EASE });
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        lastY = ev.clientY;
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return; // 位移阈值：点了不走不算拖
          dragging = true;
          suppressClick = true;
          dragRow = row;
          row.classList.add("dragging");
          list.classList.add("reordering");
          raf = requestAnimationFrame(frame);
        }
        dirty = true;
      };
      const onUp = (ev: PointerEvent) => { if (ev.pointerId === pid) finish(true); };
      const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pid) finish(false); };
      /** Esc 取消：先挪回原位再收尾（finish 里 to === fromIdx，不会提交） */
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        const kids = [...list.children] as HTMLElement[];
        const at = kids.indexOf(row);
        if (at !== fromIdx) {
          const others = kids.filter((el) => el !== row);
          squeeze(others, () => list.insertBefore(row, others[fromIdx] ?? null));
        }
        finish(false);
      };
      // 捕获仍要设：指针滑出面板/窗口时事件照样回得来（贴边滚动靠它续命）；
      // 丢了也没关系 —— 上面三个监听全挂在 window 上。
      try { row.setPointerCapture(pid); } catch { /* 合成事件降级 */ }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
    });
  }

  return el;
}
