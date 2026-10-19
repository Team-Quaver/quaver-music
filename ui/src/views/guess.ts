// Quaver — 路由视图：guess（由 src/views/index.ts 按需动态导入）
//
// 猜你喜欢不再是“一次拉一张歌单、双击某一行”的页面，而是播放器里的无限电台：
//   ① 进入即展开正在播放页，由 player.startRadio() 取第一轮 5 首并起播；
//   ② 播到本轮第五首时，播放器自动再取 5 首并删除当前曲之前的历史；
//   ③ 电台只向前走，上一曲在 UI、热键、媒体键三处统一屏蔽。
// 本页只保留电台状态与“回到正在播放/换一批”两个入口，真正的队列与续批逻辑在 player.ts。
import { toast } from "../components/SongMenu";
import { songTitle } from "../lib/api";
import { player } from "../player";
import { errText, h } from "./_shared";

export default async function guessView(root: HTMLElement) {
  const head = h("div", "sticky-head");
  head.append(h("h1", "page-title", "猜你喜欢"));
  head.append(h("p", "muted page-note", "无限电台 · 每 5 首自动续上下一轮"));

  const card = h("div", "guess-radio");
  card.innerHTML = `
    <div class="guess-radio__mark" aria-hidden="true">∞</div>
    <div class="guess-radio__copy">
      <div class="guess-radio__eyebrow">为你连续播放</div>
      <div class="guess-radio__status" id="guess-radio-status">正在为你取歌…</div>
      <p class="guess-radio__note">一轮 5 首。播到第五首时自动续批，并清掉正在播放曲之前的旧歌。</p>
    </div>
    <div class="guess-radio__actions">
      <button type="button" class="ghost-btn" id="guess-radio-open">回到正在播放</button>
      <button type="button" class="ghost-btn ghost-btn--quiet" id="guess-radio-restart">换一批</button>
    </div>`;
  root.append(head, card);

  const status = card.querySelector<HTMLElement>("#guess-radio-status")!;
  const open = card.querySelector<HTMLButtonElement>("#guess-radio-open")!;
  const restart = card.querySelector<HTMLButtonElement>("#guess-radio-restart")!;
  let disposed = false;

  const paint = () => {
    const s = player.current;
    if (player.radioLoading) status.textContent = "正在为你取歌…";
    else if (player.radioError) status.textContent = player.radioError;
    else if (s) status.textContent = `正在播放 · ${songTitle(s)}`;
    else status.textContent = "点击“换一批”重新开启电台";
    open.disabled = !s;
    restart.disabled = player.radioLoading;
    restart.textContent = player.radioLoading ? "取歌中…" : "换一批";
  };

  const start = async () => {
    try {
      await player.startRadio();
    } catch (e) {
      if (!disposed && root.isConnected) toast(errText(e) || "猜你喜欢暂时不可用", "err");
    }
    if (!disposed && root.isConnected) paint();
  };

  open.addEventListener("click", () => {
    if (!player.current) return;
    player.expanded = true;
    player.notifyPublic();
  });
  restart.addEventListener("click", () => void start());

  // 电台已在跑（从别的页面点回来）就只展开当前会话；换一批必须由显式按钮触发。
  // 首次进入时 startRadio 会先同步 expanded=true，再等网络，不是取完歌才展开。
  if (player.radioActive) {
    player.expanded = true;
    player.notifyPublic();
  } else {
    await start();
  }
  const off = player.on(paint);
  paint();
  return () => {
    disposed = true;
    off();
  };
}
