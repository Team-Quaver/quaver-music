// Quaver — 路由视图：playlist（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { songListTools } from "../components/ListTools";
import { upPic } from "../lib/api";
import { getMyMusicid, loadFavSonglists } from "../lib/favs";
import { getCachedSonglist, loadSonglistDetail, noteSonglistWrite, onSonglistChange, syncSonglistSoon } from "../lib/songlist-detail";
import type { SonglistDetail } from "../lib/songlist-detail";
import { renderSongRows, renumberRows } from "../lib/songs";
import type { RowHooks } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import type { SonglistInfo } from "./_shared";
import { errText, favSonglistButton, h, mountHead, mountStickyBar, playAllButton, sameMids } from "./_shared";

// —— 歌单页：信息头（封面/标题/制作人/描述）+ 歌曲列表（缓存秒开 / 整单回源 / 写后增量对账） ——
export default async function playlistView(root: HTMLElement, q: URLSearchParams) {
  const name = q.get("name") || "歌单";
  const id = q.get("id") || "";
  // 收藏按钮的 favs 订阅退订登记：视图被替换/打断丢弃时由 renderRoute 调用（见 favSonglistButton）
  const cleanups: (() => void)[] = [];
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);

  if (!/^\d+$/.test(id)) { box.innerHTML = `<div class="muted">歌单 id 无效</div>`; return; }

  // 详情缓存命中：首帧直接上屏（整单分页很贵），未命中/过期才整单回源；随后增量窗口对账
  const cached = getCachedSonglist(id);
  let info: SonglistInfo | null = cached?.info ?? null;
  let all: Song[] = cached ? cached.songs : []; // 原序 = 服务端顺序（orderlist），工具条只读它
  // 收藏态与自身音乐号跟歌单详情并行取，信息头渲染时按钮已就绪（不等额外往返）
  const favsReady = Promise.all([getMyMusicid(), loadFavSonglists().catch(() => [])]);
  let detail: SonglistDetail | null = null;

  try {
    detail = await loadSonglistDetail(id); // TTL 内吃缓存（不发请求），过期才分页拉全
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${errText(e)}</div>`;

    return;
  }

  if (detail && detail !== cached) { info = detail.info; all = detail.songs; }

  root.innerHTML = "";

  const logo = upPic(info?.picurl || "");
  const creator = info?.creator?.nick ? `${info.creator.nick} 制作` : "";
  let songCount = Number(info?.songnum ?? all.length) || all.length;
  await favsReady.catch(() => {});

  const head = mountHead(root, {
    artHtml: logo ? `<img src="${logo}" alt=""/>` : "",
    name: info?.title ?? name,
    meta: [creator, `${songCount} 首`].filter(Boolean).join(" · "),
    desc: info?.desc || "",
    actions: await favSonglistButton({
      id,
      title: info?.title ?? name,
      picurl: logo,
      songnum: info?.songnum,
      creatorMusicid: info?.creator?.musicid,
    }, cleanups).catch(() => null),
  });

  // 吸顶单行条：小封面 + 标题在左，工具条（搜索/排序）由下方挪进条内右侧 —— 下翻时整体固定
  const sticky = mountStickyBar(root, { artHtml: logo ? `<img src="${logo}" alt=""/>` : "", name: info?.title ?? name });
  cleanups.push(sticky.off);

  const rows = h("div", "rows");

  if (!all.length) {
    root.append(rows);
    rows.innerHTML = `<div class="muted">歌单为空或不可见</div>`;

    return () => cleanups.forEach((f) => f());
  }

  // 工具条（本地搜索 + 排序）：控件靠右。实现见 components/ListTools.ts
  // all 恒为服务端原序（orderlist = 加入歌单的时间），工具条只读它，排序作用在副本上。
  const tools = songListTools({
    source: () => all,
    hint: "在歌单内搜索",
    paint: (list) => {
      playAll.sync(); // 筛排结果变了 → 「播放全部」可用态跟着走
      painted = list; // 记下真正上屏的序列（筛排副本），列表级重画据此去重

      if (!list.length) { rows.innerHTML = `<div class="muted">没有匹配的歌曲</div>`; return; }

      renderSongRows(rows, list, hooksFor());
      player.markActive(); // 重排后当前曲可能换了行位置
    },
  });

  sticky.right.append(tools.el); // 工具条住进吸顶条右侧（搜索/排序下翻常驻）
  const playAll = playAllButton(() => tools.visible()); // 吃当前筛选+排序后的可见列表
  sticky.right.append(playAll.el); // 「播放全部」固定在吸顶条最右
  root.append(rows);
  // 右键菜单的「从歌单删除」只给自有歌单（写接口要 dirid，读详情用 disstid —— 两者不同源）
  const metaEl = head.querySelector<HTMLElement>(".pl-meta");
  const myId = await getMyMusicid().catch(() => null);
  const own = !!myId && Number(info?.creator?.musicid) === myId && Number(info?.dirid) > 0;

  // —— 打开中的本页跟着数据走（与 likedView 同一套） ——
  let painted: Song[] = []; // 最近一次上屏的序列（筛排后的副本）：列表级重画只在与缓存不一致时发生
  const keyOf = (s: Song) => String(s._key ?? s.mid ?? "");

  const paintMeta = () => {
    if (metaEl) metaEl.textContent = [creator, `${songCount} 首`].filter(Boolean).join(" · ");
  };

  const adopt = (songs: Song[], total?: number) => {
    all = songs;

    if (typeof total === "number" && total > 0) songCount = total;
    paintMeta();
    tools.repaint();
  };

  const dropRow = (song: Song) => {
    const key = keyOf(song);
    const row = key ? rows.querySelector<HTMLElement>(`.row[data-songkey="${CSS.escape(key)}"]`) : null;

    if (row?.classList.contains("leaving")) return; // 已在淡出：别把计数扣两次
    const byKey = (x: Song) => keyOf(x) === key;
    const at = all.findIndex(byKey);

    if (at >= 0) all.splice(at, 1);
    const pat = painted.findIndex(byKey);

    if (pat >= 0) painted.splice(pat, 1);

    if (row) {
      row.classList.add("leaving");
      setTimeout(() => { row.remove(); renumberRows(rows); }, 220);
    }

    if (songCount > 0) songCount--;
    paintMeta();
    tools.refreshCount();
  };

  // 写后增量回源/别处增删（songlist-detail 侧）落定 → 打开中的本页即时跟进。
  // 延一拍再动手：行内删除的淡出在同任务里先落地，多数变更到这里已自洽。
  // 仍不一致时：纯移除逐行淡出补齐，其余整表重画；有行在淡出则先跳过。
  const offFollow = onSonglistChange(id, () => {
    const cur = getCachedSonglist(id);

    if (!cur || sameMids(painted, cur.songs)) return;
    setTimeout(() => {
      const now = getCachedSonglist(id);

      if (!now || sameMids(painted, now.songs) || rows.querySelector(".row.leaving")) return;
      const nowKeys = new Set(now.songs.map(keyOf));
      const paintKeys = new Set(painted.map(keyOf));
      const gone = painted.filter((s) => !nowKeys.has(keyOf(s)));
      const added = [...nowKeys].filter((k) => !paintKeys.has(k));

      if (!added.length && gone.length) { for (const s of gone) dropRow(s); return; }

      adopt(now.songs, now.total);
    }, 0);
  });

  function hooksFor(): RowHooks {
    return {
      showAlbum: true,
      // 双击播的是**当前看到的那一列**（排过序/筛过），不是服务端原序 —— 与眼睛一致
      onPlay: (_s, i, all2) => player.playList(all2, i),
      playlist: {
        dirid: Number(info?.dirid ?? 0),
        tid: Number(info?.id ?? 0),
        title: info?.title ?? name,
        removable: own,
      },
      onRemoved: (song) => {
        // 从原序里也去掉，否则下次重排/筛选会把它放回来（行的淡出由 songs.ts 负责，这里不重画）
        const at = all.indexOf(song);

        if (at >= 0) all.splice(at, 1);
        const pat = painted.indexOf(song); // 上屏序列同步摘掉：跟进逻辑据此判定已自洽，不再触发重画

        if (pat >= 0) painted.splice(pat, 1);
        // 庇护名单 + 增量回源（缓存由它摘行并广播；love-song-reload 同款，防旧读数把删行放回来）
        noteSonglistWrite(id, String(song.mid ?? ""), false, song);

        if (songCount > 0) songCount--;

        if (metaEl) metaEl.textContent = [creator, `${songCount} 首`].filter(Boolean).join(" · ");
        tools.refreshCount();
      },
    };
  }

  tools.repaint();

  // 进页吃的是缓存时顺带一次小窗对账（整单刚回源过就不必再打）；TTL 内不整单重载也能纠漂移
  if (detail === cached) syncSonglistSoon(id);
  cleanups.push(offFollow); // 退订交给视图 cleanup（cleanups 数组，路由切换不留死监听）

  return () => cleanups.forEach((f) => f());
}

// 专辑卡网格（歌手页「专辑」标签 / 歌手全部专辑页共用同一套卡面）
