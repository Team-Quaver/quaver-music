// Quaver — 路由视图：daily（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import type { DailyResp } from "./_shared";
import { errText, h, mountHead, mountStickyBar, playAllButton } from "./_shared";

const dailyCover = (day: string) => `
  <div class="daily-cover" role="img" aria-label="今日 ${day} 日">
    <svg class="daily-cover__calendar" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="6" y="10" width="52" height="48" rx="10" stroke="currentColor" stroke-width="2.4"/>
      <path d="M6.5 22.5h51M20 5.5v9M44 5.5v9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
    </svg>
    <span class="daily-cover__day">${day}</span>
  </div>`;

export default async function dailyView(root: HTMLElement) {
  // 真的「每日30首」：系统虚拟歌单（dirid 202），每天由服务端重生成 30 首。
  // 页面沿用歌单页的信息头 + 吸顶条，让这个系统歌单和普通歌单保持同一套视觉语言。
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const cover = dailyCover(day);
  let songs: Song[] = [];
  let desc = "";
  try {
    const d = (await api<DailyResp>("/recommend/daily?page=1&num=100")) ?? {}; // 30 首一把拿全，不用翻页
    songs = d.songs ?? [];
    desc = d.info?.desc ?? "";
  } catch (e) {
    root.innerHTML = "";
    const head = mountHead(root, {
      artHtml: cover,
      name: "每日 30 首",
      meta: "",
      desc: "今天的推荐暂时没有拿到。请确认登录状态后再试。",
    });
    head.querySelector<HTMLElement>(".pl-meta")?.remove();
    root.append(h("div", "rows muted", `${errText(e)} — 需要先登录`));
    return;
  }

  root.innerHTML = "";
  const head = mountHead(root, {
    artHtml: cover,
    name: "每日 30 首",
    meta: "",
    desc: desc || "每天按你的口味，重新挑选 30 首。",
  });
  // 每日 30 首的信息头不再重复曲目数；歌单封面本身已经说明了日期。
  head.querySelector<HTMLElement>(".pl-meta")?.remove();
  const sticky = mountStickyBar(root, { artHtml: cover, name: "每日 30 首" });
  const playAll = playAllButton(() => songs);
  sticky.right.append(playAll.el);
  const box = h("div", "rows");
  root.append(box);

  if (!songs.length) {
    box.innerHTML = `<div class="muted">今天的 30 首还没生成，稍后再来（也确认下是否已登录）</div>`;
    return sticky.off;
  }
  renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  return sticky.off;
}

/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */
