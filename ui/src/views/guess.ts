// Quaver — 路由视图：guess（由 src/views/index.ts 按需动态导入）
//
// 猜你喜欢是播放器里的无限电台：
//   ① 进入后在 Content View 中央展示当前曲目，控制条在封面/信息上方；
//   ② player.startRadio() 取第一轮 5 首，播到第五首时自动续 5 首并裁掉当前曲之前的历史；
//   ③ 电台只向前走，上一曲、播放列表、循环/随机设置都在电台态屏蔽。
// 「换一批」是唯一会重新取歌的入口；再次进入本页只恢复电台主舞台，不打断当前队列。
import { toast } from "../components/SongMenu";
import { coverUrl, songTitle } from "../lib/api";
import { icons } from "../lib/icons";
import { player } from "../player";
import { errText, h } from "./_shared";

export default async function guessView(root: HTMLElement) {
  root.classList.add("guess-radio-page");

  const stage = h("section", "radio-stage");
  stage.innerHTML = `
    <div class="radio-stage__head">
      <span class="radio-stage__brand"><i aria-hidden="true">∞</i> 无限电台</span>
      <span class="radio-stage__status" id="radio-status">正在为你取歌…</span>
    </div>
    <div class="radio-stage__controls" role="group" aria-label="电台播放控制">
      <button class="radio-control radio-control--main" id="radio-play" type="button" aria-label="播放/暂停" disabled>${icons.play}</button>
      <button class="radio-control" id="radio-next" type="button" aria-label="下一首" disabled>${icons.next}</button>
      <button class="radio-control" id="radio-love" type="button" aria-label="收藏" aria-pressed="false" disabled>${icons.heart}</button>
    </div>
    <div class="radio-stage__art" id="radio-art" aria-hidden="true"><span>∞</span></div>
    <h1 class="radio-stage__title" id="radio-title">未在播放</h1>
    <p class="radio-stage__artist" id="radio-artist"></p>
    <button class="ghost-btn ghost-btn--quiet radio-stage__restart" id="radio-restart" type="button">换一批</button>`;
  root.append(stage);

  const status = stage.querySelector<HTMLElement>("#radio-status")!;
  const art = stage.querySelector<HTMLElement>("#radio-art")!;
  const title = stage.querySelector<HTMLElement>("#radio-title")!;
  const artist = stage.querySelector<HTMLElement>("#radio-artist")!;
  const playBtn = stage.querySelector<HTMLButtonElement>("#radio-play")!;
  const nextBtn = stage.querySelector<HTMLButtonElement>("#radio-next")!;
  const loveBtn = stage.querySelector<HTMLButtonElement>("#radio-love")!;
  const restart = stage.querySelector<HTMLButtonElement>("#radio-restart")!;
  let disposed = false;
  let lastArt = "";

  const paint = () => {
    const s = player.current;
    const loved = !!s && player.loved.has(s.mid);
    const canLove = !!s && !s.local;
    const busy = player.radioLoading;

    playBtn.disabled = !s;
    playBtn.innerHTML = player.loading ? icons.spinner : player.playing ? icons.pause : icons.play;
    playBtn.title = player.loading ? "加载中，点击取消" : player.playing ? "暂停" : "播放";
    playBtn.setAttribute("aria-label", playBtn.title);

    nextBtn.disabled = !s;
    loveBtn.disabled = !canLove;
    loveBtn.innerHTML = loved ? icons.heartFill : icons.heart;
    loveBtn.classList.toggle("on", loved); // 只切空心/实心；不染色
    loveBtn.setAttribute("aria-pressed", String(loved));
    loveBtn.title = s?.local ? "本地歌曲不支持在线收藏" : loved ? "取消收藏" : "收藏";
    loveBtn.setAttribute("aria-label", loveBtn.title);

    restart.disabled = busy;
    restart.textContent = busy ? "取歌中…" : "换一批";

    if (!s) {
      title.textContent = player.radioError || "未在播放";
      artist.textContent = "";
      status.textContent = busy ? "正在为你取歌…" : "等待开始";
      if (lastArt) { lastArt = ""; art.replaceChildren(h("span", "", "∞")); }
      return;
    }

    // 与正在播放页共用 300 档：QQ 封面常用可用尺寸就是 T002R300x300，600 会 404 成灰块。
    const pic = coverUrl(s, 300);
    if (pic !== lastArt) {
      lastArt = pic;
      const img = new Image();
      img.alt = "";
      img.onerror = () => { if (lastArt === pic) art.replaceChildren(h("span", "", "∞")); };
      img.src = pic;
      art.replaceChildren(pic ? img : h("span", "", "∞"));
    }
    title.textContent = songTitle(s);
    const singers = (s.singer ?? []).map((x) => x.name).filter(Boolean).join(" / ");
    const album = s.album?.name ?? "";
    artist.textContent = [singers, album].filter(Boolean).join(" · ");
    status.textContent = busy ? "正在续上下一轮…" : player.radioError || "正在播放";
  };

  const start = async () => {
    try {
      await player.startRadio();
    } catch (e) {
      if (!disposed && root.isConnected) toast(errText(e) || "猜你喜欢暂时不可用", "err");
    }
    if (!disposed && root.isConnected) paint();
  };

  playBtn.addEventListener("click", () => player.toggle());
  nextBtn.addEventListener("click", () => player.next());
  loveBtn.addEventListener("click", () => void player.toggleLove(player.current));
  restart.addEventListener("click", () => void start());

  // 电台主舞台属于 Content View：进入本页就收起正在播放覆盖层，不抢主区域。
  player.expanded = false;
  player.notifyPublic();
  if (!player.radioActive) await start();

  const off = player.on(paint);
  paint();
  return () => {
    disposed = true;
    off();
  };
}
