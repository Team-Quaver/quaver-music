// Quaver — 路由视图：singer-albums（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { albumCardsHtml, fetchSingerAlbums, h, mountHead } from "./_shared";

// —— 歌手全部专辑页：信息头复用歌手页样式 + 全部分页拉取专辑网格 ——
export default async function singerAlbumsView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  const name = q.get("name") || "歌手";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));

  if (!mid) { root.querySelector<HTMLElement>(".rows")!.innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }

  const albumData = await fetchSingerAlbums(mid);
  const albums = albumData?.album_list ?? [];
  const total = albumData?.total ?? albums.length;

  if (!albumData) { root.innerHTML = ""; root.append(h("div", "rows muted", "加载失败：无法获取专辑列表")); return; }

  root.innerHTML = "";
  const avatar = `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg`;
  mountHead(root, {
    artHtml: `<img src="${avatar}" alt=""/>`,
    artRound: true,
    name: `${name}的专辑`,
    meta: total ? `共 ${total} 张` : "",
    desc: "",
  });

  if (!albums.length) { root.append(h("div", "rows muted", "暂无专辑")); return; }

  const grid = h("div", "grid");
  grid.innerHTML = albumCardsHtml(albums);
  root.append(grid);
}

// —— 专辑页（点击行内专辑跳转的落点）：detail + songs 两个端点 ——
