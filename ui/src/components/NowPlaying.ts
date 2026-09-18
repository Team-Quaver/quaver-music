// 「正在播放」页（NowPlaying 屏）：点击播放条封面/歌词按钮展开，顶栏「收起播放页」收起。
// 全屏覆盖（常驻播放条仍可见可点）；内部分三栏：歌词 / 封面+曲名+音质 / 播放列表（QueuePanel 挂载位）。
// 进度与传输控制由常驻播放条承担，本页不重复。
import { player, type Song } from "../player";
import { coverUrl, getLastStream, getStreamTiers, getSessionQuality, effectiveQuality, QUALITY_SHORT } from "../lib/api";
import { icon } from "../verse/icons";

export function NowPlaying(): HTMLElement {
  const el = document.createElement("div");
  el.className = "np";
  el.id = "now-playing";
  el.innerHTML = `
    <div class="np-top">
      <button type="button" class="v-btn v-btn--ghost" id="np-collapse">${icon("chevronDown", 16)}收起播放页</button>
    </div>
    <div class="np-body">
      <section class="np-lyrics-col">
        <p class="overline-11">歌词</p>
        <div class="np-lyrics lyric-font" id="np-lyrics"></div>
      </section>
      <section class="np-mid">
        <div class="np-cover" id="np-cover"></div>
        <h1 class="display-24 ellipsis" id="np-title">未在播放</h1>
        <p class="body-14 ellipsis" id="np-artist" style="margin: 0; color: var(--ink-muted)"></p>
        <p class="caption-12 ellipsis" id="np-album" style="margin: 0"></p>
        <div class="np-tags" id="np-tags"></div>
        <div class="np-actions">
          <button type="button" class="v-iconbtn" id="np-love" aria-label="收藏" title="收藏"></button>
          <button type="button" class="v-btn v-btn--ghost v-btn--sm" id="np-trans" aria-pressed="true">译文</button>
        </div>
      </section>
      <aside class="np-queue" id="np-queue" aria-label="播放列表"></aside>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const lyrics = $("np-lyrics"), cover = $("np-cover");
  const title = $("np-title"), artist = $("np-artist"), album = $("np-album");
  const tags = $("np-tags"), love = $("np-love"), trans = $("np-trans");

  $("np-collapse").onclick = () => { player.expanded = false; player.notifyPublic(); };
  trans.onclick = () => player.toggleTrans();
  love.onclick = () => player.toggleLove(player.current);

  let lastMid = "";        // 歌词行 DOM 只在换曲/状态迁移时重建
  let lastLyricState = "";
  let lastIdx = -1;        // 高亮行索引（避免每帧改 class）
  let lineEls: HTMLElement[] = [];

  // —— 滚轮翻阅：浏览模式暂停自动跟随；3s 无操作回到跟随，或点击任意行立刻跟随该句 ——
  let browsing = false;
  let browseTimer = 0;
  const enterBrowse = () => {
    browsing = true;
    window.clearTimeout(browseTimer);
    browseTimer = window.setTimeout(() => {
      browsing = false;
      followCurrent(); // 回到跟随态：立刻把当前句滚回中心
    }, 3000);
  };
  lyrics.addEventListener("wheel", enterBrowse, { passive: true });
  lyrics.addEventListener("pointerdown", enterBrowse, { passive: true });

  function followCurrent() {
    const line = lineEls[lastIdx];
    if (line) lyrics.scrollTo({ top: line.offsetTop + line.offsetHeight / 2 - lyrics.clientHeight / 2, behavior: "smooth" });
  }

  function buildLyricDom(s: Song | undefined) {
    lastMid = s?.mid ?? "";
    lastIdx = -1;
    browsing = false;
    if (!s) { lyrics.innerHTML = `<div class="np-ly-empty">未在播放</div>`; lineEls = []; return; }
    if (player.lyricState === "loading" || (player.lyricState === "idle" && !player.lyrics.length)) { lyrics.innerHTML = `<div class="np-ly-empty">歌词加载中…</div>`; lineEls = []; return; }
    if (!player.lyrics.length) { lyrics.innerHTML = `<div class="np-ly-empty">暂无歌词</div>`; lineEls = []; return; }
    lyrics.innerHTML = "";
    for (const line of player.lyrics) {
      const d = document.createElement("div");
      d.className = "np-ly-line";
      d.tabIndex = 0;
      d.setAttribute("role", "button");
      d.title = "点击从这句播放";
      d.innerHTML = `<span class="l1">${escapeHtml(line.text)}</span>${line.trans ? `<span class="l2">${escapeHtml(line.trans)}</span>` : ""}`;
      d.onclick = () => { player.seek(line.t); browsing = false; }; // 点击跳回该行并恢复跟随
      d.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); player.seek(line.t); browsing = false; } };
      lyrics.append(d);
    }
    lineEls = [...lyrics.querySelectorAll<HTMLElement>(".np-ly-line")];
  }

  // 音质标签：outline=当前档，默认色=最高可播（档位不同时才出现第二枚）
  let maxLabel = "";
  void getStreamTiers()
    .then((t) => { const id = t?.max; maxLabel = id ? (QUALITY_SHORT[id] ?? id) : ""; })
    .catch(() => {});
  function paintTags() {
    const ls = getLastStream();
    const want = getSessionQuality();
    const curLabel = player.current && ls
      ? (QUALITY_SHORT[ls.tier] ?? ls.label)
      : (QUALITY_SHORT[want ?? effectiveQuality()] ?? "");
    tags.innerHTML = `${curLabel ? `<span class="v-tag v-tag--outline">${escapeHtml(curLabel)}</span>` : ""}
      ${maxLabel && maxLabel !== curLabel ? `<span class="v-tag">${escapeHtml(maxLabel)} 可用</span>` : ""}`;
  }

  player.on(() => {
    const s = player.current;
    const open = player.expanded;
    el.classList.toggle("open", open);
    el.classList.toggle("no-trans", !player.showTrans);
    trans.classList.toggle("is-loved", player.showTrans);
    trans.setAttribute("aria-pressed", String(player.showTrans));
    if (!open) return;

    // 换曲 或 歌词状态迁移（loading→ok/none 时行 DOM 需要重建，否则占位/歌词丢失）
    const st: "idle" | "loading" | "ok" | "none" = player.lyrics.length ? "ok" : player.lyricState;
    if (s?.mid !== lastMid || st !== lastLyricState) buildLyricDom(s);
    lastLyricState = st;
    title.textContent = s?.name ?? "未在播放";
    title.title = s?.name ?? "";
    const singerLine = s ? (s.singer ?? []).map((x) => x.name).join(" / ") : "点一首歌试试";
    artist.textContent = singerLine;
    artist.title = singerLine;
    const albumName = (s as any)?.album?.name ?? "";
    album.textContent = albumName;
    album.title = albumName;
    album.style.display = albumName ? "" : "none";
    const pic = s ? coverUrl(s, 500) : "";
    cover.innerHTML = pic ? `<img src="${pic}" alt=""/>` : "";
    paintTags();
    const loved = !!s && player.loved.has(s.mid);
    love.innerHTML = icon(loved ? "heartOn" : "heart");
    love.classList.toggle("v-iconbtn--on", loved);
    love.setAttribute("aria-label", loved ? "取消收藏" : "收藏");

    // 高亮当前歌词行 + 滚动居中（翻阅模式暂停自动跟随；3s 静默或点击行号恢复）
    if (lineEls.length) {
      const t = player.time + 0.2;
      let idx = -1;
      for (let i = 0; i < player.lyrics.length; i++) {
        if (player.lyrics[i].t <= t) idx = i; else break;
      }
      if (idx !== lastIdx) {
        if (lastIdx >= 0 && lineEls[lastIdx]) lineEls[lastIdx].classList.remove("cur");
        if (idx >= 0 && lineEls[idx]) lineEls[idx].classList.add("cur");
        lastIdx = idx;
        if (!browsing && idx >= 0) followCurrent();
      }
    }
  });
  return el;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
