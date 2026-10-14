// Quaver — 路由视图：daily（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import type { DailyResp } from "./_shared";
import { errText, listPage } from "./_shared";
export default async function dailyView(root: HTMLElement) {
  // 真的「每日30首」：它是**系统虚拟歌单**（dirid 固定 202，与「我喜欢」201 同一族），
  // 每天由服务端重生成 30 首，disstid 每天都变 —— 所以后端按 dirid 取（见 /recommend/daily），
  // 前端只管拿详情，结构与普通歌单完全一致（info/songs/total/hasmore）。
  // 以前这页是假的：拿「我喜欢」按日期种子随机凑 30 首（官方接口未开放时的占位），现已接真接口。
  const { rows: box, off: offHead } = listPage(root, "每日 30 首", "QQ 音乐「每日30首」：每天按你的口味重算 30 首");
  const note = root.querySelector<HTMLElement>(".page-note");
  try {
    const d = (await api<DailyResp>("/recommend/daily?page=1&num=100")) ?? {}; // 30 首一把拿全，不用翻页
    const songs: Song[] = d.songs ?? [];
    // 服务端那句编辑语（「甄选私人好品味：今日份的 X、Y、Z…」）比我们自己编的说明好看
    if (note && d.info?.desc) note.textContent = d.info.desc;
    if (!songs.length) {
      box.innerHTML = `<div class="muted">今天的 30 首还没生成，稍后再来（也确认下是否已登录）</div>`;
      return;
    }
    box.innerHTML = "";
    renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e) {
    box.innerHTML = `<div class="muted">${errText(e)} — 需要先登录</div>`;
  }
  return offHead; // 吸顶跟踪退订
}

/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */
