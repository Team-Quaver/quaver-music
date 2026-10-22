// Quaver — 路由视图：local（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { songListTools } from "../components/ListTools";
import { toast } from "../components/SongMenu";
import { api, escHtml } from "../lib/api";
import { addFolderSource, addWebdavSource, loadLocalLibrary, localSnapshot, onLocalLibraryChange, removeLocalSource, scanSummary, scrapeSummary, trackToSong, triggerLocalScan, triggerScrape } from "../lib/local.ts";
import type { LibrarySnapshot } from "../lib/local.ts";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import { h, mountStickyBar, playAllButton } from "./_shared";

// —— 本地音乐（本地文件夹 + NAS：播放 · 刮削）——
// 数据层在 lib/local.ts（同源 /api/local/*，真相在 electron/local/library.ts）；这一页只管三件事：
//   ① 源管理（添加本机/NAS 挂载目录、WebDAV，扫描进度）；
//   ② 曲目表（复用行渲染 + 列表工具条；红心列隐藏 —— 在线收藏与本地无关）；
//   ③ 刮削入口（未匹配的补、全部重刮、行级右键的单曲重刮在 SongMenu）。
// 选目录是 Electron 专属（quaverLocal 桥）；浏览器 dev 给手输路径的输入框（NAS 挂载目录本来就是路径）。
export default async function localView(root: HTMLElement) {
  const title = h("h1", "page-title", "本地音乐 ");
  const cnt = h("span", "muted cnt");
  title.append(cnt);
  root.append(title);

  const panel = h("div", "local-panel");
  root.append(panel);

  const sticky = mountStickyBar(root, { name: "本地音乐" });
  const nameEl = sticky.bar.querySelector<HTMLElement>(".sticky-bar__name");
  const box = h("div", "rows", `<div class="muted">载入中…</div>`);
  root.append(box);

  let snap: LibrarySnapshot | null = null;
  let items: Song[] = [];

  const tools = songListTools({
    source: () => items,
    hint: "在本地库内搜索",
    paint: (songs, st) => {
      playAll.sync();

      if (!songs.length) {
        box.innerHTML = `<div class="muted">${st.filtering || snap?.tracks.length ? "没有匹配的歌曲" : "本地库还是空的 —— 添加一个音乐文件夹（NAS 挂载目录同理），或直连 WebDAV 后点「重新扫描」"}</div>`;

        return;
      }

      renderSongRows(box, songs, {
        hideLove: true,
        showAlbum: true,
        onPlay: (s, i, all) => player.playList(all, i),
      });
      player.markActive();
    },
  });

  sticky.right.append(tools.el);
  const playAll = playAllButton(() => tools.visible());
  sticky.right.append(playAll.el);

  const setCount = (n: number) => {
    const text = n ? `· ${n} 首` : "";
    cnt.textContent = text;

    if (nameEl) nameEl.textContent = `本地音乐 ${text}`.trim();
  };

  // —— 添加表单（折叠式；folder=手输路径 / webdav=四字段）——
  const addForm = (kind: "folder" | "webdav"): HTMLElement => {
    const f = h("div", "local-form");

    if (kind === "folder") {
      f.innerHTML = `
        <label class="lf-row"><span>目录路径</span><input type="text" placeholder="如 /home/x/Music 或已挂载的 NAS：/mnt/nas/music" spellcheck="false"/></label>
        <div class="lf-foot"><button class="ghost-btn lf-ok" type="button">添加并扫描</button><span class="muted lf-msg"></span></div>`;
    } else {
      f.innerHTML = `
        <label class="lf-row"><span>名称</span><input type="text" placeholder="我的 NAS" spellcheck="false"/></label>
        <label class="lf-row"><span>WebDAV 地址</span><input type="text" placeholder="http(s)://nas.local:5005/dav/music" spellcheck="false"/></label>
        <label class="lf-row"><span>账号</span><input type="text" autocomplete="off"/></label>
        <label class="lf-row"><span>密码</span><input type="password" autocomplete="new-password"/></label>
        <div class="lf-foot"><button class="ghost-btn lf-ok" type="button">测试并添加</button><span class="muted lf-msg"></span></div>`;
    }

    const okBtn = f.querySelector<HTMLButtonElement>(".lf-ok")!;
    const msg = f.querySelector<HTMLSpanElement>(".lf-msg")!;
    okBtn.onclick = async () => {
      const inputs = [...f.querySelectorAll<HTMLInputElement>("input")].map((x) => x.value.trim());
      msg.textContent = "连接中…"; okBtn.disabled = true;

      try {
        if (kind === "folder") {
          if (!inputs[0]) throw new Error("路径不能为空");
          await addFolderSource("", inputs[0]);
        } else {
          await addWebdavSource({ name: inputs[0], url: inputs[1], username: inputs[2], password: inputs[3] });
        }

        f.remove();
        await triggerLocalScan();
        toast("源已添加，扫描已开始");
      } catch (e: any) {
        msg.textContent = String(e?.message ?? e).slice(0, 120);
        okBtn.disabled = false;
      }
    };

    return f;
  };

  const toggleForm = (kind: "folder" | "webdav") => {
    const old = panel.querySelector(".local-form");

    if (old) { old.remove(); return; }

    panel.append(addForm(kind));
  };

  const renderPanel = () => {
    if (!snap) return;
    panel.innerHTML = "";
    const srcs = snap.sources;
    const stats = snap.stats;
    // —— 动作条 ——
    const bar = h("div", "local-actions");
    const busy = snap.scan.running || snap.scrape.running;
    const scanBtn = h("button", "ghost-btn", snap.scan.running ? `扫描中… (${snap.scan.processed})` : "重新扫描") as HTMLButtonElement;
    scanBtn.type = "button"; scanBtn.disabled = busy;
    scanBtn.onclick = () => void triggerLocalScan();
    const toScrape = srcs.length && !stats.tracks ? 0 : stats.tracks - stats.matched;
    const scrapeBtn = h("button", "ghost-btn", snap.scrape.running ? `刮削中… ${snap.scrape.processed}/${snap.scrape.total}` : (toScrape > 0 ? `刮削未匹配 (${toScrape})` : "重新刮削全部")) as HTMLButtonElement;
    scrapeBtn.type = "button"; scrapeBtn.disabled = busy;
    scrapeBtn.title = "联网按「歌名+歌手」匹配 QQ 音乐，补齐歌曲信息、歌词（含翻译）与封面";
    scrapeBtn.onclick = () => void triggerScrape(toScrape > 0 ? {} : { all: true, force: true });
    const addFolderBtn = h("button", "ghost-btn", "添加文件夹") as HTMLButtonElement;
    addFolderBtn.type = "button"; addFolderBtn.disabled = busy;
    addFolderBtn.onclick = async () => {
      if (!window.quaverLocal) { toggleForm("folder"); return; }

      const r = await window.quaverLocal.pickFolder();

      if (!r.ok) { toast(r.error ?? "选择目录失败", "err"); return; }

      if (r.canceled || !r.path) return;
      const name = r.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || r.path;
      await addFolderSource(name, r.path);
      await triggerLocalScan();
      toast(`已添加「${name}」，扫描已开始`);
    };

    const addDavBtn = h("button", "ghost-btn", "添加 NAS (WebDAV)") as HTMLButtonElement;
    addDavBtn.type = "button"; addDavBtn.disabled = busy;
    addDavBtn.onclick = () => toggleForm("webdav");
    bar.append(scanBtn, scrapeBtn, addFolderBtn, addDavBtn);
    panel.append(bar);

    // —— 状态行（扫描/刮削摘要，错误数悬浮可见）——
    const lines: string[] = [];
    const sc = scanSummary(snap.scan); if (sc) lines.push(sc);
    const sp = scrapeSummary(snap.scrape); if (sp) lines.push(sp);

    if (lines.length) {
      const st = h("div", "local-status", escHtml(lines.join(" ｜ ")));

      if (snap.scan.errors.length) {
        st.title = "扫描错误：\n" + snap.scan.errors.join("\n");
        st.classList.add("has-err");
      }

      if (snap.scrape.lastError) st.title = (st.title ? st.title + "\n" : "") + "最近刮削错误：" + snap.scrape.lastError;
      panel.append(st);
    }

    // —— 源清单 ——
    const srcBox = h("div", "local-srcs");

    if (!srcs.length) {
      srcBox.innerHTML = `<div class="muted local-src-empty">还没有音乐源 —— 「本地音乐」同时吃本机目录、已挂载的 NAS 共享与 WebDAV。</div>`;
    }

    for (const src of srcs) {
      const card = h("div", "local-src");
      const badge = `<span class="local-badge${src.kind === "webdav" ? " nas" : ""}">${src.kind === "webdav" ? "NAS·WebDAV" : "本地"}</span>`;
      const loc = escHtml(src.kind === "webdav" ? (src.url ?? "") : (src.path ?? ""));
      card.innerHTML = `${badge}<span class="ls-name">${escHtml(src.name)}</span><span class="ls-path muted" title="${loc}">${loc}</span><span class="ls-count">${src.trackCount} 首</span>`;
      const btns = h("span", "ls-ops");
      const revealBtn = h("button", "ghost-btn ghost-btn--quiet", "打开位置") as HTMLButtonElement;
      revealBtn.type = "button";

      if (src.kind !== "folder" || !window.quaverLocal) revealBtn.hidden = true;
      revealBtn.onclick = async () => {
        // 源级「打开位置」：借首个曲目 id 由主进程从库里反查目录后高亮（无曲目则不可用）
        const t = snap?.tracks.find((x) => x.sourceId === src.id);

        if (!t || !window.quaverLocal) return;
        const r = await window.quaverLocal.reveal(t.id);

        if (!r.ok) toast(r.error ?? "无法定位", "err");
      };

      const rmBtn = h("button", "ghost-btn ghost-btn--quiet danger", "移除") as HTMLButtonElement;
      rmBtn.type = "button";
      rmBtn.onclick = async () => {
        if (!confirm(`移除「${src.name}」？曲目会从曲库与缓存中删除（磁盘文件不动），正在播放的该源曲目会停。`)) return;

        try {
          await removeLocalSource(src.id);
          toast("已移除");
        } catch (e: any) { toast(String(e?.message ?? e), "err"); }
      };

      btns.append(revealBtn, rmBtn);
      card.append(btns);
      srcBox.append(card);
    }

    panel.append(srcBox);

    // —— 计数 ——
    const stat = h("div", "local-stats muted");
    stat.textContent = srcs.length
      ? `${stats.tracks} 首 · 已刮削 ${stats.matched} · 有封面 ${stats.withCover} · 有歌词 ${stats.withLyric}`
      : "";
    panel.append(stat);
  };

  const apply = () => {
    if (!snap) return;
    items = snap.tracks.map((t) => trackToSong(t, snap!.sources));
    setCount(items.length);
    renderPanel();
    tools.repaint();
  };

  const off = onLocalLibraryChange(() => { snap = localSnapshot(); apply(); });
  snap = await loadLocalLibrary(true);

  if (!snap) { box.innerHTML = `<div class="muted">本地曲库服务不可用（sidecar 中继未就绪？）</div>`; }

  apply();

  // 正在播放的是本地曲目时进页 → 立刻高亮所在行（markActive 由 player 订阅驱动，这里补一次）
  return () => { off(); };
}

