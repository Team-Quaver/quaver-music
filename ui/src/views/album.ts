// Quaver — 路由视图：album（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { AlbumDetailResp, AlbumSongsResp } from "./_shared";
import { albumSongsInSourceOrder, errText, h, mountHead, mountStickyBar, playAllButton } from "./_shared";
// —— 专辑页（点击行内专辑跳转的落点）：detail + songs 两个端点 ——
export default async function albumView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { root.querySelector<HTMLElement>(".rows")!.innerHTML = `<div class="muted">缺少专辑 mid</div>`; return; }
  try {
    const [detail, list] = await Promise.all([
      api<AlbumDetailResp>(`/album/${encodeURIComponent(mid)}/detail`).catch(() => null),
      api<AlbumSongsResp>(`/album/${encodeURIComponent(mid)}/songs?num=100`),
    ]);
    const alb = detail?.album ?? {};
    const songs = albumSongsInSourceOrder(list);
    root.innerHTML = "";
    const picMid = alb.pmid || alb.mid || mid;
    const singers: string = (alb.singer?.length ? alb.singer : detail?.singers ?? []).map((x) => x.name ?? "").join(" / ");
    const metaParts = [
      singers,
      alb.time_public,
      list?.total_num ? `${list.total_num} 首` : "",
    ].filter(Boolean);
    const albumName = alb.name ?? "专辑";
    const albumArt = picMid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${picMid.split("_")[0]}.jpg`
      : "";
    mountHead(root, {
      artHtml: albumArt ? `<img src="${albumArt}" alt=""/>` : "",
      name: albumName,
      meta: metaParts.join(" · "),
      desc: alb.desc || "",
    });
    // 专辑页与歌手/歌单页使用同一套吸顶条；专辑只需要在左侧保留封面 + 标题，
    // 不把歌手、发行日期、歌曲数等详情重复塞进吸顶区。
    const sticky = mountStickyBar(root, {
      artHtml: albumArt ? `<img src="${albumArt}" alt=""/>` : "",
      name: albumName,
    });
    const box = h("div", "rows");
    root.append(box);
    if (!songs.length) {
      box.innerHTML = `<div class="muted">没有取到歌曲</div>`;
      return sticky.off;
    }
    const playAll = playAllButton(() => songs); // 专辑序固定（发行序），整张一键开播
    sticky.right.append(playAll.el);
    renderSongRows(box, songs, { showArtist: true, showAlbum: false, onPlay: (s, i, all) => player.playList(all, i) });
    return sticky.off;
  } catch (e) {
    root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${errText(e)}`));
  }
}

// —— 列表页公共壳 ——
