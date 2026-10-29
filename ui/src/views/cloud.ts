// Quaver — 微云音乐网盘（只做音乐，不做通用文件管理）。
//
// 列表来自 QQ 音乐 GetMatchAudio；该接口的条目只有 file_id，没有 pdir_key。
// 播放时由 sidecar 递归索引微云目录反查 pdir_key，再换取下载链接并流式解密
// QMCv1。渲染层永远不接触微云 Cookie / 短链。
import "./cloud.css";
import { api, postJson, coverUrl, escHtml, songArtists } from "../lib/api";
import { toast } from "../lib/toast";
import { player, type Song } from "../player";
import { cloudItemToSong, invalidateCloudLibrary, loadCloudLibrary, type CloudLibrary } from "../lib/cloud";
import { errText, h, mountStickyBar } from "./_shared";
import { bindSongMenu } from "../components/SongMenu";

interface CloudChangedDetail { key?: string }

interface WeiyunStatus {
  configured: boolean;
  hasQqCredential: boolean;
}

const button = (label: string, cls = "ghost-btn") => {
  const b = document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = label;

  return b;
};

export default async function cloudView(root: HTMLElement) {
  root.classList.add("cloud-page");
  root.append(h("h1", "page-title", "微云音乐网盘"));
  root.append(h("p", "page-note muted", "QQ 音乐网盘里的歌曲，包括未匹配曲库的原文件。文件定位与解密由后端完成。"));

  const sticky = mountStickyBar(root, { name: "微云音乐网盘" });
  const box = h("div", "cloud-music");
  root.append(box);

  let library: CloudLibrary | null = null;
  let status: WeiyunStatus | null = null;
  let songs: Song[] = [];
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

  const authPanel = (): HTMLElement | null => {
    if (!status || status.configured) return null;

    const panel = h("div", "cloud-auth");
    const copy = h("div", "cloud-auth-copy");
    copy.innerHTML = status.hasQqCredential
      ? "<strong>还需要一次微云授权</strong><span>QQ 音乐令牌不能直接读取微云文件。授权只用于定位并播放微云里的音乐原文件。</span>"
      : "<strong>请先登录 QQ 音乐</strong><span>登录后再完成一次微云授权，才能读取网盘文件。</span>";
    panel.append(copy);

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

    panel.append(actions);

    return panel;
  };

  const render = () => {
    box.replaceChildren();

    if (!library) {
      box.innerHTML = `<div class="muted">正在读取 QQ 音乐网盘…</div>`;

      return;
    }

    const auth = authPanel();

    if (auth) box.append(auth);

    const stats = library.stats;
    const bar = h("div", "cloud-actions");
    bar.append(h("span", "cloud-stat", `${stats.total} 个文件 · ${stats.playable} 首可播放`));

    songs = library.items.map(cloudItemToSong).filter((s): s is Song => !!s);
    const playAll = button(`播放全部（${songs.length}）`);
    playAll.disabled = !songs.length;
    playAll.onclick = () => player.playList(songs, 0);
    bar.append(playAll);

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
    box.append(bar);

    if (scrapeRunning || library.scrape.lastError) {
      const statusLine = h("div", "cloud-scrape-status muted");

      statusLine.textContent = scrapeRunning
        ? `刮削中：${library.scrape.processed}/${library.scrape.total}，匹配 ${library.scrape.matched}`
        : `上次刮削：匹配 ${library.scrape.matched}，未匹配 ${library.scrape.unmatched}，失败 ${library.scrape.failed}`;

      if (library.scrape.lastError) statusLine.title = library.scrape.lastError;
      box.append(statusLine);
    }

    if (!library.items.length) {
      box.append(h("div", "muted cloud-empty", "QQ 音乐网盘里还没有歌曲。"));

      return;
    }

    const rows = h("div", "rows");

    for (const [i, item] of library.items.entries()) {
      const song = cloudItemToSong(item);
      const row = h("div", "row cloud-row");
      row.innerHTML = `
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
        row.title = "双击播放（后端定位微云文件并解密）";
        row.ondblclick = () => player.playList([song], 0);
        bindSongMenu(row, () => ({ song, list: songs, index: songs.indexOf(song) }));
      } else {
        row.title = item.playbackError || "该文件缺少微云 file_id，无法播放";
      }

      rows.append(row);
    }

    box.append(rows);
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
      if (!quiet) box.innerHTML = `<div class="muted">${escHtml(errText(e))}</div>`;
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

  await load();

  return () => {
    stopPolling();
    window.removeEventListener("quaver:cloud-changed", onCloudChanged);
    sticky.off();
  };
}
