// Quaver — 路由视图：guess（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { toast } from "../components/SongMenu";
import { api } from "../lib/api";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import { errText, h, listPage } from "./_shared";
/**
 * 猜你喜欢：上游 `get_radio_track` **一次只给 5 首**（num 加大被忽略、回灌 song_ids 续拿报 22006），
 * 好在每轮内容随机 —— 所以后端靠「串行多调几轮 + 按 mid 去重」凑量（并发会被上游 700000 拒）。
 * 代价是**轮数 × 单轮耗时 ≈ 6s**：一口气等完就是 6 秒白屏。这里分两段取：
 *   ① rounds=2（10 首，~2.4s）立刻出画面；② 再 rounds=4 补齐到 ~30 首后重画。
 * 「换一批」走同一条链路：上游池子很大（实测 6 轮 30 首**零重复**），所以两批之间基本撞不上，
 * 不需要把上一批的 mid 排除掉 —— 何况上游也不吃排除参数（`song_ids` 续拿就是 22006）。
 * 取新批次**先攒在临时数组里、成了才整体换上**：换批失败时手上这批还在，不会一片空白。
 */
export default async function guessView(root: HTMLElement) {
  const { rows: box, off: offHead } = listPage(root, "猜你喜欢", "你的品味，懂你意思");
  // 换一批：页头下方、右侧对齐（与列表工具条同一版式语言）
  const bar = h("div", "guess-bar");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost-btn ghost-btn--quiet";
  btn.textContent = "换一批";
  bar.append(btn);
  root.insertBefore(bar, box);

  let songs: Song[] = [];
  let busy = false;

  const paint = () => {
    if (!songs.length) { box.innerHTML = `<div class="muted">暂无推荐，登录后可得</div>`; return; }
    // 双击播的是**当前看到的这一列**（补齐后列表会变长，指针以重画后的为准）
    renderSongRows(box, songs, { onPlay: (s, i, all) => player.playList(all, i) });
    player.markActive(); // 重画后当前曲可能换了行位置
  };

  async function load() {
    if (busy) return;               // 按钮已禁用；这里防的是键盘/程序重复触发
    busy = true;
    btn.disabled = true;
    btn.textContent = "取歌中…";
    const fresh: Song[] = [];       // 先攒在临时数组：失败时手上这批不动
    const seen = new Set<string>();
    const take = (more: Song[]) => {
      for (const s of more ?? []) {
        const k = String(s?.mid ?? "");
        if (!k || seen.has(k)) continue; // 多轮之间会撞歌
        seen.add(k);
        fresh.push(s);
      }
    };
    try {
      take((await api<{ songs?: Song[] }>("/recommend/guess?rounds=2"))?.songs ?? []);
      if (fresh.length) { songs = fresh; paint(); }  // 首批立刻换上画面
      take((await api<{ songs?: Song[] }>("/recommend/guess?rounds=4"))?.songs ?? []);
      if (fresh.length) { songs = fresh; paint(); }  // 补齐（同一个引用随之变长）
      else if (!songs.length) paint();               // 一首都没拿到 → 空态
    } catch (e) {
      // 第二批失败不算失败：保住首批（上游这条链路偶发节流，宁可少几首也别整页报错）
      if (!songs.length) box.innerHTML = `<div class="muted">${errText(e)}</div>`;
      else toast("换一批没成功，先留着当前这批", "err");
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = "换一批";
    }
  }

  btn.addEventListener("click", () => void load());
  await load();
  return offHead; // 吸顶跟踪退订
}

