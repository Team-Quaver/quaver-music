// Quaver — 微云音乐网盘（只做音乐，不做通用文件管理）。
//
// 列表来自 QQ 音乐 GetMatchAudio；该接口的条目只有 file_id，没有 pdir_key。
// 播放时由 sidecar 递归索引微云目录反查 pdir_key，再换取下载链接并流式解密
// QMCv1。渲染层永远不接触微云 Cookie / 短链。
//
// 页面形态与本地音乐/虚拟歌单一致：封面 + 标题的信息头、吸顶条（搜索/排序在条上）、
// 曲目表。排序只作用于本地已拉到的条目（不回源），原序 = 微云返回顺序。
import "./cloud.css";
import { api, postJson, coverUrl, escHtml, songArtists } from "../lib/api";
import { toast } from "../lib/toast";
import { player, type Song } from "../player";
import {
  cloudItemToSong, invalidateCloudLibrary, loadCloudLibrary, peekCloudLibrary,
  type CloudItem, type CloudLibrary,
} from "../lib/cloud";
import { errText, h, mountHead, mountStickyBar, playAllButton } from "./_shared";
import { bindSongMenu } from "../components/SongMenu";
import { songListTools } from "../components/ListTools";

interface CloudChangedDetail { key?: string }

interface WeiyunStatus {
  configured: boolean;
  hasQqCredential: boolean;
}

/** 行模型：微云条目 + 供列表工具条搜索/排序读取的 Song 归一化字段。
 *  不可播放的条目（缺 file_id）也要留在列表里如实展示，所以不能直接用 Song 当数据源。 */
interface CloudRow {
  item: CloudItem;
  song: Song | null;
  name: string;
  title: string;
  singer: { name: string }[];
  album: { name: string };
}

const CLOUD_COVER = `
  <div class="cloud-cover" role="img" aria-label="微云音乐网盘">
    <svg class="cloud-cover__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 18.5h10.2a4.3 4.3 0 0 0 .7-8.5 6 6 0 0 0-11.5 1.2A3.7 3.7 0 0 0 7 18.5z"/>
      <path d="M9.5 13.2h5M12 10.8v6.4" opacity=".55"/>
    </svg>
  </div>`;

const button = (label: string, cls = "ghost-btn") => {
  const b = document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = label;

  return b;
};

const rowOf = (item: CloudItem): CloudRow => {
  const song = cloudItemToSong(item);
  const title = item.title || item.fileName;

  return {
    item,
    song,
    name: title,
    title: item.title,
    singer: item.artist ? [{ name: item.artist }] : (song?.singer ?? []),
    album: { name: item.album || song?.album?.name || "" },
  };
};

export default async function cloudView(root: HTMLElement) {
  root.classList.add("cloud-page");

  const head = mountHead(root, {
    artHtml: CLOUD_COVER,
    name: "微云音乐网盘",
    meta: "",
    desc: "",
  });

  const metaEl = head.querySelector<HTMLElement>(".pl-meta")!;
  const sticky = mountStickyBar(root, { artHtml: CLOUD_COVER, name: "微云音乐网盘" });
  const nameEl = sticky.bar.querySelector<HTMLElement>(".sticky-bar__name");
  // 动作条/授权面板与曲目表分开：曲目表由工具条驱动重画，动作条只在库快照落地时重建
  const panel = h("div", "cloud-panel");
  const rowsBox = h("div", "rows cloud-rows");

  root.append(panel, rowsBox);

  let library: CloudLibrary | null = null;
  let status: WeiyunStatus | null = null;
  let rows: CloudRow[] = [];
  let authURL = "";
  let pollTimer: number | null = null;

  const openExternal = (url: string) => {
    const bridge = window.quaverWeiyunAuth;

    if (!bridge) {
      window.open(url, "_blank", "noopener,noreferrer");

      return;
    }

    void bridge.open(url).then((r) => {
      if (!r?.ok) toast(`无法打开微云授权页：${r?.error ?? "未知错误"}`, "err");
    }).catch((e) => toast(`无法打开微云授权页：${errText(e)}`, "err"));
  };

  // 当前可见顺序里的可播放曲目（「播放全部」与右键菜单的列表）
  const visibleSongs = () => tools.visible()
    .map((r: CloudRow) => r.song)
    .filter((s): s is Song => !!s);

  const paintRows = (list: CloudRow[], st: { filtering: boolean }) => {
    playAll.sync();
    rowsBox.replaceChildren();

    if (!list.length) {
      rowsBox.innerHTML = `<div class="muted cloud-empty">${st.filtering
        ? "没有匹配的歌曲"
        : library?.items.length ? "没有可显示的条目" : "QQ 音乐网盘里还没有歌曲。"}</div>`;

      return;
    }

    const frag = document.createDocumentFragment();

    for (const [i, row] of list.entries()) {
      const { item, song } = row;
      const el = h("div", "row cloud-row");

      el.innerHTML = `
        <span class="idx">${i + 1}</span>
        <span class="rthumb">${item.hasCover && song ? `<img src="${coverUrl(song, 150)}" alt="" loading="lazy"/>` : ""}</span>
        <span class="rmeta">
          <span class="rt">${escHtml(item.title || item.fileName)}</span>
          <span class="ra">${escHtml(item.artist || (song ? songArtists(song) : "") || "未知歌手")}</span>
          <span class="ral">${escHtml(item.album || "未知专辑")}</span>
        </span>
        <span class="cloud-tags">
          <i class="cloud-pill${item.playable ? " ok" : ""}">${
            item.playable ? (item.matched === 2 ? "原文件" : "曲库匹配") : "不可播放"
          }</i>
          ${item.coverManual ? `<i class="cloud-pill">封面</i>` : ""}
          ${item.lyricImport ? `<i class="cloud-pill">导入歌词</i>` : ""}
          ${item.editedMeta ? `<i class="cloud-pill">已校正</i>` : ""}
          ${item.scrapedAt > 0 ? `<i class="cloud-pill">已刮削</i>` : ""}
          ${item.hasLyric ? `<i class="cloud-pill">歌词</i>` : ""}
        </span>`;

      if (song) {
        el.title = "双击播放";
        el.ondblclick = () => player.playList([song], 0);
        bindSongMenu(el, () => {
          const all = visibleSongs();

          return { song, list: all, index: all.indexOf(song) };
        });
      } else {
        el.title = item.playbackError || "该文件缺少微云 file_id，无法播放";
      }

      frag.append(el);
    }

    rowsBox.append(frag);
    // 与本地音乐/我喜欢同一套口径：工具条重画列表后补一次高亮刷新（微云行是自绘行，
    // 没有 data-songkey 时不匹配任何行，调用是无害的，但保持「重画后必调」这条不变量）。
    player.markActive();
  };

  // 工具条：本地搜索 + 排序（与本地音乐/我喜欢同一套组件）。原序 = 微云返回顺序。
  const tools = songListTools({
    source: () => rows,
    hint: "在微云网盘中搜索",
    paint: (list: any[], st) => paintRows(list, st),
  });

  sticky.right.append(tools.el);

  const playAll = playAllButton(visibleSongs);

  sticky.right.append(playAll.el);

  const setMeta = (lib: CloudLibrary) => {
    const stats = lib.stats;

    metaEl.textContent = `${stats.total} 个文件 · ${stats.playable} 首可播放`;

    if (nameEl) nameEl.textContent = stats.playable ? `微云音乐网盘 · ${stats.playable} 首` : "微云音乐网盘";
  };

  const authPanel = (): HTMLElement | null => {
    if (!status || status.configured) return null;

    const el = h("div", "cloud-auth");
    const copy = h("div", "cloud-auth-copy");

    copy.innerHTML = status.hasQqCredential
      ? "<strong>还需要一次微云授权</strong><span>QQ 音乐令牌不能直接读取微云文件。授权只用于定位并播放微云里的音乐原文件。</span>"
      : "<strong>请先登录 QQ 音乐</strong><span>登录后再完成一次微云授权，才能读取网盘文件。</span>";
    el.append(copy);

    const actions = h("div", "cloud-auth-actions");
    const start = button("开始授权", "cloud-auth-primary");

    start.onclick = async () => {
      start.disabled = true;

      try {
        const r = await postJson<{ url: string }>("/weiyun/auth/start", {});

        authURL = r.url;
        openExternal(authURL);
        render();
      } catch (e) {
        toast(errText(e), "err");
        start.disabled = false;
      }
    };

    actions.append(start);

    if (authURL) {
      const open = button("重新打开授权页");

      open.onclick = () => openExternal(authURL);
      actions.append(open);

      const done = button("我已完成授权", "cloud-auth-primary");

      done.onclick = async () => {
        done.disabled = true;

        try {
          await postJson("/weiyun/auth/poll", {});
          toast("微云授权已连接");
          authURL = "";
          await load();
        } catch (e) {
          toast(errText(e), "err");
          done.disabled = false;
        }
      };

      actions.append(done);
    }

    el.append(actions);

    return el;
  };

  /** 库快照落地：重建授权面板/动作条/刮削状态，再把曲目表交给工具条重画。 */
  const render = () => {
    panel.replaceChildren();

    if (!library) {
      panel.innerHTML = `<div class="muted">正在读取 QQ 音乐网盘…</div>`;
      rowsBox.replaceChildren();

      return;
    }

    const auth = authPanel();

    if (auth) panel.append(auth);

    const stats = library.stats;
    const bar = h("div", "cloud-actions");
    const scrapeRunning = library.scrape.running;

    const scrape = button(scrapeRunning
      ? `刮削中… ${library.scrape.processed}/${library.scrape.total}`
      : "刮削未匹配");

    scrape.disabled = !stats.total || scrapeRunning;
    scrape.onclick = async () => {
      scrape.disabled = true;

      try {
        await postJson("/cloud/scrape", {});
        invalidateCloudLibrary();
        toast("已开始刮削");
        await load();
      } catch (e) {
        toast(errText(e), "err");
        scrape.disabled = false;
      }
    };

    bar.append(scrape);

    const rescrape = button("重新刮削全部");

    rescrape.disabled = !stats.total || scrapeRunning;
    rescrape.onclick = async () => {
      rescrape.disabled = true;

      try {
        await postJson("/cloud/scrape", { all: true, force: true });
        invalidateCloudLibrary();
        toast("已开始重新刮削");
        await load();
      } catch (e) {
        toast(errText(e), "err");
        rescrape.disabled = false;
      }
    };

    bar.append(rescrape);
    panel.append(bar);

    if (scrapeRunning || library.scrape.lastError) {
      const statusLine = h("div", "cloud-scrape-status muted");

      statusLine.textContent = scrapeRunning
        ? `刮削中：${library.scrape.processed}/${library.scrape.total}，匹配 ${library.scrape.matched}`
        : `上次刮削：匹配 ${library.scrape.matched}，未匹配 ${library.scrape.unmatched}，失败 ${library.scrape.failed}`;

      if (library.scrape.lastError) statusLine.title = library.scrape.lastError;
      panel.append(statusLine);
    }

    setMeta(library);
    rows = library.items.map(rowOf);
    tools.repaint();
  };

  const stopPolling = () => {
    if (pollTimer == null) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    if (pollTimer != null) return;
    pollTimer = window.setInterval(() => { void load(true); }, 900);
  };

  const load = async (quiet = false) => {
    try {
      const [lib, st] = await Promise.all([
        // 云端页要如实显示刮削进度；缓存只给播放器兜底匹配用，页面本身每次都取新快照。
        loadCloudLibrary(true),
        quiet ? Promise.resolve(status) : api<WeiyunStatus>("/weiyun/status").catch(() => null),
      ]);

      library = lib;
      status = st;

      if (lib.scrape.running) startPolling();
      else stopPolling();

      render();
    } catch (e) {
      if (!quiet) panel.innerHTML = `<div class="muted">${escHtml(errText(e))}</div>`;
    }
  };

  const onCloudChanged = (e: Event) => {
    if (!(e instanceof CustomEvent)) return;
    invalidateCloudLibrary();
    // SAFETY: cloud.ts is the only producer of this private event and always sends {key:string}.
    const key = String((e.detail as CloudChangedDetail | null)?.key ?? "");

    if (!key) {
      void load();

      return;
    }

    const item = library?.items.find((x) => x.key === key);

    player.patchCloudSong(key, item
      ? {
          hasCover: item.hasCover,
          lyricImport: item.lyricImport,
          importFormat: item.importFormat,
        }
      : {});
    void load();
  };

  window.addEventListener("quaver:cloud-changed", onCloudChanged);

  // 先画缓存快照，页面不再白屏等一次完整上游列表；新快照到了原地替换。
  const cached = peekCloudLibrary();

  if (cached) {
    library = cached;
    render();
  }

  await load();

  return () => {
    stopPolling();
    window.removeEventListener("quaver:cloud-changed", onCloudChanged);
    sticky.off();
  };
}
