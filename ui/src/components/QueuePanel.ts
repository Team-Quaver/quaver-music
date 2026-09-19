// 播放列表面板：点击切歌 / 拖拽排序 / 单曲移除 / 一键清空。
// 外壳 = 共用右下浮窗（FloatWindow，与音质窗同一控件）：主页与全屏播放页同一形态，
// 开关只跟随 player.queueOpen，不重建列表或交互状态。
// 当前行 = 三信号（选中底 + accent 歌名 + 圆点）；拖拽中的行拿 shadow-main（GUIDELINES 允许）。
import { player, type Song } from "../player";
import { songTitle } from "../lib/api";
import { icon } from "../verse/icons";
import { FloatWindow } from "./FloatWindow";

export function QueuePanel(): HTMLElement {
  const win = FloatWindow({
    id: "queue-panel",
    title: "播放列表",
    onRequestClose: () => { player.queueOpen = false; player.notifyPublic(); },
  });
  const el = win.el;
  const list = win.body;
  list.classList.add("qp-list");
  list.id = "qp-list";
  const cnt = win.meta;
  cnt.id = "qp-cnt";
  win.actions.insertAdjacentHTML("afterbegin",
    `<button type="button" class="v-iconbtn v-iconbtn--sm" id="qp-clear" title="清空播放列表" aria-label="清空播放列表">${icon("trash", 16)}</button>`);
  el.querySelector<HTMLElement>("#qp-clear")!.onclick = () => player.clearQueue();
  win.setOpen(player.queueOpen);

  // —— 列表渲染（订阅式：队列/指针/播放态变化才重建） ——
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  let suppressClick = false; // 拖拽松手后补发的 click 不切歌
  let sig = "";
  player.on(() => {
    win.setOpen(player.queueOpen);
    const s = player.queue.map((q) => q.mid).join(",") + "#" + player.index + "#" + player.playing + "#" + player.loading;
    if (s === sig) return; // 内容没变不重建
    sig = s;
    cnt.textContent = player.queue.length ? `${player.queue.length} 首` : "";
    list.innerHTML = "";
    if (!player.queue.length) {
      list.innerHTML = `<div class="qp-empty">队列为空<span>播放一首歌，或用「下一首播放」加入</span></div>`;
      return;
    }
    player.queue.forEach((q, i) => list.append(rowOf(q, i)));
    revealCurrent();
  });

  /** 把当前曲滚到列表可见处 —— **只动 .qp-list 自己的 scrollTop**，不动祖先滚动容器。 */
  function revealCurrent() {
    const row = list.querySelector<HTMLElement>(".qp-row--cur");
    if (!row) return;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top;
    else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom;
  }

  function rowOf(q: Song, i: number): HTMLElement {
    const cur = i === player.index;
    const row = document.createElement("div");
    row.className = "qp-row" + (cur ? " qp-row--cur" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = songTitle(q);
    row.innerHTML = `
      <span class="qp-grip" title="拖动排序">${icon("grip", 16)}</span>
      <span class="qp-idx">${cur ? icon("dot", 12) : i + 1}</span>
      <span class="qp-main">
        <span class="qp-t">${escapeHtml(songTitle(q))}</span>
        <span class="qp-a">${escapeHtml((q.singer ?? []).map((x) => x.name).join(" / "))}</span>
      </span>
      <button type="button" class="v-iconbtn v-iconbtn--sm qp-del" title="移出队列" aria-label="移出队列">${icon("close", 14)}</button>
    `;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".qp-grip, .qp-del")) return; // 把手/删除钮不触发切歌
      if (suppressClick) return;
      player.jump(i);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement) === row) { e.preventDefault(); player.jump(i); }
    });
    row.querySelector<HTMLElement>(".qp-del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      player.removeAt(i);
    });
    bindDrag(row, i);
    return row;
  }

  // —— 拖拽排序（指针事件，抓把手起拖；行高等高 → 换位即换序）——
  // 原理：行始终留在文档流里（transform 只做视觉位移），指针进入相邻行半格即交换 DOM 位置，
  // 换位后按「视觉顶边贴指针」重算 transform，肉眼无跳变。松手按最终 DOM 序提交 player.moveInQueue。
  function bindDrag(row: HTMLElement, fromIdx: number) {
    const grip = row.querySelector<HTMLElement>(".qp-grip")!;
    const swapUnder = (pointerY: number) => {
      for (const sib of [...list.children] as HTMLElement[]) {
        if (sib === row) continue;
        const r = sib.getBoundingClientRect();
        if (pointerY >= r.top && pointerY < r.bottom) {
          if (pointerY < r.top + r.height / 2) list.insertBefore(row, sib);
          else list.insertBefore(row, sib.nextSibling);
          return;
        }
      }
      const kids = [...list.children] as HTMLElement[];
      if (!kids.length) return;
      const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
      if (pointerY < first.top) list.insertBefore(row, list.firstElementChild);
      else if (pointerY >= last.bottom) list.append(row); // 拖出列表末端 = 移到队尾
    };
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      let dragging = false;
      let dy = 0;
      const startY = e.clientY;
      const grabOffset = startY - row.getBoundingClientRect().top; // 指针在行内的抓取偏移
      const pid = e.pointerId;
      try { grip.setPointerCapture(pid); } catch { /* 合成事件降级 */ }
      const layout = (pointerY: number) => {
        const flowTop = row.getBoundingClientRect().top - dy; // rect 含当前 transform，减掉 = 文档流顶边
        dy = pointerY - grabOffset - flowTop; // 视觉顶边始终贴着「指针 - 抓取偏移」
        row.style.transform = `translateY(${dy}px)`;
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) < 5) return; // 位移阈值：点了不走不算拖
          dragging = true;
          suppressClick = true;
          row.classList.add("dragging");
        }
        const lr = list.getBoundingClientRect();
        if (ev.clientY < lr.top + 26) list.scrollTop -= 9; // 贴边自动滚动
        else if (ev.clientY > lr.bottom - 26) list.scrollTop += 9;
        swapUnder(ev.clientY);
        layout(ev.clientY);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        if (!dragging) return;
        row.classList.remove("dragging");
        row.style.transform = "";
        const to = [...list.children].indexOf(row);
        if (to !== fromIdx) player.moveInQueue(fromIdx, to);
        setTimeout(() => { suppressClick = false; }, 0); // click 在 pointerup 之后补发，只吞这一发
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
  }

  return el;
}
