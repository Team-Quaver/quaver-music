// Quaver — 路由视图：liked（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { songListTools } from "../components/ListTools";
import { renderSongRows, renumberRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import { h, mountHead, mountStickyBar, playAllButton, sameMids } from "./_shared";
/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */

const likedCover = `
  <div class="liked-cover" role="img" aria-label="我喜欢">
    <svg class="liked-cover__heart" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z" fill="#fff" stroke="#fff"/>
    </svg>
  </div>`;

export default async function likedView(root: HTMLElement) {
  // 与「每日 30 首」同一套信息头 + 吸顶条：Accent 封面在前，收藏计数与工具条随后。
  // 封面里的红心固定纯白实心，不跟随 Accent 混色。
  const cover = likedCover;

  const head = mountHead(root, {
    artHtml: cover,
    name: "我喜欢",
    meta: "0 首",
    desc: "收藏的歌曲都会在这里。",
  });

  const metaEl = head.querySelector<HTMLElement>(".pl-meta");
  const sticky = mountStickyBar(root, { artHtml: cover, name: "我喜欢" });
  const nameEl = sticky.bar.querySelector<HTMLElement>(".sticky-bar__name");
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);

  let items: Song[] = []; // 原序 = 收藏顺序（服务端返回的顺序），工具条只读它
  let painted: Song[] = []; // 最近一次上屏的序列（筛排后的副本）：列表级重画只在与缓存不一致时发生
  let shown = 0; // 标题计数（服务端 total 优先：超预载上限时也报真实总数）

  const setCount = (n: number) => {
    shown = Math.max(0, n);

    if (metaEl) metaEl.textContent = `${shown} 首`;

    // 吸顶条里那份缩略名跟着走：条上不显示计数会是「看着像另一个人」
    if (nameEl) nameEl.textContent = shown ? `我喜欢 · ${shown} 首` : "我喜欢";
  };

  const keyOf = (s: Song) => String(s._key ?? s.mid ?? "");

  // 取消收藏：行淡出后移出本页 + 计数 -1。只在写接口确认后调用——失败已在 player 侧回滚，不会触发
  const dropRow = (song: Song) => {
    const key = keyOf(song);
    const row = key ? box.querySelector<HTMLElement>(`.row[data-songkey="${CSS.escape(key)}"]`) : null;

    if (row?.classList.contains("leaving")) return; // 已在淡出：别把计数扣两次
    // 从原序与上屏序列里都摘掉：player.likedCache 是**换新数组**（filter），这里的 items/painted
    // 还指着旧数组，不摘的话下次重排/筛选会把这行放回来（或触发一次无谓的整表重画）。
    const byKey = (x: Song) => keyOf(x) === key;
    const at = items.findIndex(byKey);

    if (at >= 0) items.splice(at, 1);
    const pat = painted.findIndex(byKey);

    if (pat >= 0) painted.splice(pat, 1);

    if (row) {
      row.classList.add("leaving");
      setTimeout(() => { row.remove(); renumberRows(box); }, 220);
    }

    setCount(shown - 1);
    tools.refreshCount();
  };

  // 工具条（本地搜索 + 排序；与歌单页共用 components/ListTools.ts）
  const tools = songListTools({
    source: () => items,
    hint: "在我喜欢内搜索",
    paint: (songs, st) => {
      playAll.sync(); // 筛排结果变了 → 「播放全部」可用态跟着走
      painted = songs; // 记下真正上屏的序列（筛排副本），列表级重画据此去重

      if (!songs.length) {
        box.innerHTML = `<div class="muted">${st.filtering ? "没有匹配的歌曲" : "还没有收藏的歌曲"}</div>`;

        return;
      }

      setCount(Math.max(items.length, player.likedTotal));
      renderSongRows(box, songs, {
        onPlay: (_s, i, all) => player.playList(all, i),
        onLove: (song, on) => { if (!on) dropRow(song); }, // 取消红心 = 取消单曲收藏 + 移出本页
      });
      player.markActive(); // 重排后当前曲可能换了行位置
    },
  });

  sticky.right.append(tools.el); // 工具条住进吸顶条右侧（与歌单/歌手页同一位置）
  const playAll = playAllButton(() => tools.visible()); // 吃当前搜索+排序后的可见列表
  sticky.right.append(playAll.el); // 「播放全部」固定在吸顶条最右
  root.append(box);
  const adopt = (songs: Song[]) => { items = songs; tools.repaint(); };

  // 写后增量回源/别处收藏（player 侧）落定 → 打开中的本页即时跟进。
  // 延一拍再动手：行内取消红心的 dropRow（含淡出）在同任务里先落地，多数变更到这里已自洽。
  // 仍不一致时：纯移除逐行淡出补齐（兜住播放条等别处的取消），其余整表重画；有行在淡出则先跳过。
  const offList = player.onLovedListChange(() => {
    const cur = player.likedCache;

    if (!cur || sameMids(painted, cur)) return;
    setTimeout(() => {
      const now = player.likedCache;

      if (!now || sameMids(painted, now) || box.querySelector(".row.leaving")) return;
      const nowKeys = new Set(now.map(keyOf));
      const paintKeys = new Set(painted.map(keyOf));
      const gone = painted.filter((s) => !nowKeys.has(keyOf(s)));
      const added = [...nowKeys].filter((k) => !paintKeys.has(k));

      if (!added.length && gone.length) { for (const s of gone) dropRow(s); return; }

      adopt(now);
    }, 0);
  });

  // 预载命中（开机已拉回）：首帧直接出，红心默认全部点亮；随后按 TTL 后台对账，内容变了才重画
  const cached = player.likedCache;

  if (cached) adopt(cached);
  const ok = await player.loadLoved();

  if (!ok) {
    offList();
    sticky.off();

    if (!cached) {
      tools.el.remove(); // 拉不到就别摆一排没用的控件
      sticky.bar.remove(); // 内容也没有时，别在标题下留一条空的吸顶条

      if (metaEl) metaEl.textContent = "";
      const desc = head.querySelector<HTMLElement>(".pl-desc");

      if (desc) desc.textContent = "暂时没有拿到收藏列表，请确认登录状态。";
      box.innerHTML = `<div class="muted">加载失败 — 需要先登录</div>`;
    }

    return;
  }

  const fresh: Song[] = player.likedCache ?? [];

  if (!sameMids(painted, fresh)) adopt(fresh);
  player.syncLovedSoon(); // 进页顺带一次小窗对账：TTL 内不整单重载也能纠漂移

  return () => { offList(); sticky.off(); };
}

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
