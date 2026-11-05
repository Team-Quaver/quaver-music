// Quaver — 本地音乐「音乐源与扫描」浮窗（添加文件夹 / NAS·WebDAV、重新扫描、路径管理）。
//
// 以前这些控件内联在 /local 页顶部；页面改成虚拟歌单形态（封面 + 标题 + 曲目表）之后，
// 源管理收进 body 常驻层的模态浮窗 —— 壳与更新弹窗同源（.upd-overlay/.upd-dialog +
// .leaving 离场门闩），玻璃底片、进出场、reduced-motion 全部复用 dialog.css。
//
// 数据真相仍全在 lib/local.ts（同源 /api/local/*）。本弹窗同时是「进度观察窗」：
// 订阅 onLocalLibraryChange，扫描/刮削轮询落地时只重画状态与源清单，**不动表单区**
// （否则每 900ms 的一次刷新会把用户正在填的 WebDAV 字段清空）。
import "./dialog.css";
import { escHtml } from "../lib/api";
import {
  addFolderSource, addWebdavSource, loadLocalLibrary, localSnapshot, onLocalLibraryChange,
  removeLocalSource, scanSummary, scrapeSummary, triggerLocalScan, triggerScrape,
} from "../lib/local.ts";
import type { LibrarySnapshot } from "../lib/local.ts";
import { toast } from "../lib/toast";
import { errText } from "../views/_shared";

let layer: HTMLElement | null = null;

const button = (label: string, cls = "ghost-btn") => {
  const b = document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = label;

  return b;
};

/** 打开音乐源管理浮窗。已有浮窗在开时忽略（与更新/校正弹窗同一条「同屏只留一层」口径）。 */
export function showLocalSourcesDialog(): void {
  if (layer) return;

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `
    <div class="upd-dialog lsd-dialog" role="dialog" aria-modal="true" aria-label="音乐源与扫描">
      <div class="upd-head">
        <h3>音乐源与扫描</h3>
        <span class="upd-meta muted">添加本机文件夹、已挂载的 NAS 目录或 WebDAV；移除只影响曲库，不动磁盘文件。</span>
      </div>
      <div class="lsd-body">
        <div class="lsd-actions"></div>
        <div class="lsd-status"></div>
        <div class="lsd-srcs"></div>
        <div class="lsd-form"></div>
        <div class="lsd-stats muted"></div>
      </div>
      <div class="upd-foot">
        <span class="upd-spacer"></span>
        <button class="upd-primary" data-act="close" type="button">完成</button>
      </div>
    </div>`;

  const el = layer;
  const actions = el.querySelector<HTMLElement>(".lsd-actions")!;
  const statusHost = el.querySelector<HTMLElement>(".lsd-status")!;
  const srcsHost = el.querySelector<HTMLElement>(".lsd-srcs")!;
  const formHost = el.querySelector<HTMLElement>(".lsd-form")!;
  const statsEl = el.querySelector<HTMLElement>(".lsd-stats")!;

  const scanBtn = button("重新扫描");
  const scrapeBtn = button("重新刮削全部");
  const addFolderBtn = button("添加文件夹");
  const addDavBtn = button("添加 NAS (WebDAV)");
  actions.append(scanBtn, scrapeBtn, addFolderBtn, addDavBtn);

  const busy = (snap: LibrarySnapshot | null) => !!snap && (snap.scan.running || snap.scrape.running);

  // —— 动作条 ——
  scanBtn.onclick = async () => {
    try {
      await triggerLocalScan();
      toast("扫描已开始");
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  scrapeBtn.onclick = async () => {
    const snap = localSnapshot();

    if (!snap) return;
    // 有未匹配的 → 只补它们；全匹配了 → 重新刮削全部（与旧页面同一口径）
    const toScrape = snap.sources.length && snap.stats.tracks ? snap.stats.tracks - snap.stats.matched : 0;

    try {
      await triggerScrape(toScrape > 0 ? {} : { all: true, force: true });
      toast(toScrape > 0 ? "已开始刮削未匹配曲目" : "已开始重新刮削");
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  // —— 添加表单（折叠式；folder=手输路径 / webdav=四字段）——
  const addForm = (kind: "folder" | "webdav"): HTMLElement => {
    const f = document.createElement("div");

    f.className = "local-form";
    f.dataset.kind = kind;

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
      } catch (e) {
        msg.textContent = errText(e).slice(0, 120);
        okBtn.disabled = false;
      }
    };

    return f;
  };

  // 同一时刻只开一张表单；再点同一个按钮 = 收起（表单区独立于进度刷新，见文件头）
  const toggleForm = (kind: "folder" | "webdav") => {
    const old = formHost.querySelector<HTMLElement>(".local-form");
    const same = old?.dataset.kind === kind;

    old?.remove();

    if (!same) formHost.append(addForm(kind));
  };

  addFolderBtn.onclick = async () => {
    // 浏览器 dev 没有原生选目录桥：退回手输路径（NAS 挂载目录本来就是路径）
    if (!window.quaverLocal) { toggleForm("folder"); return; }

    addFolderBtn.disabled = true;

    try {
      const r = await window.quaverLocal.pickFolder();

      if (!r.ok) { toast(r.error ?? "选择目录失败", "err"); return; }

      if (r.canceled || !r.path) return;
      const name = r.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || r.path;

      await addFolderSource(name, r.path);
      await triggerLocalScan();
      toast(`已添加「${name}」，扫描已开始`);
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      paint();
    }
  };

  addDavBtn.onclick = () => toggleForm("webdav");

  // —— 源清单 ——
  const paintSources = (snap: LibrarySnapshot) => {
    srcsHost.replaceChildren();

    if (!snap.sources.length) {
      const empty = document.createElement("div");

      empty.className = "muted local-src-empty";
      empty.textContent = "还没有音乐源 —— 可添加本机文件夹、已挂载的 NAS 共享目录或 WebDAV。";
      srcsHost.append(empty);

      return;
    }

    for (const src of snap.sources) {
      const card = document.createElement("div");
      const badge = `<span class="local-badge${src.kind === "webdav" ? " nas" : ""}">${src.kind === "webdav" ? "NAS·WebDAV" : "本地"}</span>`;
      const loc = escHtml(src.kind === "webdav" ? (src.url ?? "") : (src.path ?? ""));

      card.className = "local-src";
      card.innerHTML = `${badge}<span class="ls-name">${escHtml(src.name)}</span><span class="ls-path muted" title="${loc}">${loc}</span><span class="ls-count">${src.trackCount} 首</span>`;

      const ops = document.createElement("span");

      ops.className = "ls-ops";

      // 源级「打开位置」：借首个曲目 id 由主进程从库里反查目录后高亮（无曲目则不可用）
      const revealBtn = button("打开位置", "ghost-btn ghost-btn--quiet");

      if (src.kind !== "folder" || !window.quaverLocal) revealBtn.hidden = true;
      revealBtn.onclick = async () => {
        const cur = localSnapshot();
        const t = cur?.tracks.find((x) => x.sourceId === src.id);

        if (!t || !window.quaverLocal) return;
        const r = await window.quaverLocal.reveal(t.id);

        if (!r.ok) toast(r.error ?? "无法定位", "err");
      };

      const rmBtn = button("移除", "ghost-btn ghost-btn--quiet danger");

      rmBtn.onclick = async () => {
        if (!confirm(`移除「${src.name}」？曲目会从曲库与缓存中删除（磁盘文件不动），正在播放的该源曲目会停。`)) return;

        try {
          await removeLocalSource(src.id);
          toast("已移除");
        } catch (e) { toast(errText(e), "err"); }
      };

      ops.append(revealBtn, rmBtn);
      card.append(ops);
      srcsHost.append(card);
    }
  };

  // —— 进度/统计重画（不碰表单区）——
  const paint = () => {
    const snap = localSnapshot();

    if (!snap) {
      statusHost.textContent = "正在读取本地曲库…";
      srcsHost.replaceChildren();
      statsEl.textContent = "";

      for (const b of [scanBtn, scrapeBtn, addFolderBtn, addDavBtn]) b.disabled = true;

      return;
    }

    const bz = busy(snap);
    const toScrape = snap.sources.length && snap.stats.tracks ? snap.stats.tracks - snap.stats.matched : 0;

    scanBtn.textContent = snap.scan.running ? `扫描中… (${snap.scan.processed})` : "重新扫描";
    scanBtn.disabled = bz;
    scrapeBtn.textContent = snap.scrape.running
      ? `刮削中… ${snap.scrape.processed}/${snap.scrape.total}`
      : (toScrape > 0 ? `刮削未匹配 (${toScrape})` : "重新刮削全部");
    scrapeBtn.disabled = bz;
    addFolderBtn.disabled = bz;
    addDavBtn.disabled = bz;

    statusHost.replaceChildren();

    const lines = [scanSummary(snap.scan), scrapeSummary(snap.scrape)].filter(Boolean);

    if (lines.length) {
      const st = document.createElement("div");
      const tips: string[] = [];

      st.className = "local-status" + (snap.scan.errors.length ? " has-err" : "");
      st.textContent = lines.join(" ｜ ");

      if (snap.scan.errors.length) tips.push("扫描错误：\n" + snap.scan.errors.join("\n"));

      if (snap.scrape.lastError) tips.push("最近刮削错误：" + snap.scrape.lastError);

      if (tips.length) st.title = tips.join("\n");
      statusHost.append(st);
    }

    paintSources(snap);
    statsEl.textContent = snap.sources.length
      ? `${snap.stats.tracks} 首 · 已刮削 ${snap.stats.matched} · 有封面 ${snap.stats.withCover} · 有歌词 ${snap.stats.withLyric}`
      : "";
  };

  const off = onLocalLibraryChange(paint);

  // —— 关闭（Esc / 点遮罩 / 完成；与更新弹窗同一套 .leaving 门闩）——
  let closing = false;

  const close = () => {
    if (closing) return;
    closing = true;
    off();
    window.removeEventListener("keydown", onKey);
    const node = layer;

    layer = null;

    if (!node) return;
    const fin = () => node.remove();

    node.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    node.classList.add("leaving");
  };

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

  window.addEventListener("keydown", onKey);
  el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
  el.querySelector<HTMLButtonElement>('[data-act="close"]')!.onclick = close;

  document.body.append(el);
  paint();
  // 打开时对一次账：页面可能有别的入口改过库，弹窗里要看到最新源清单
  void loadLocalLibrary(true).then(paint).catch((e) => {
    statusHost.textContent = `本地曲库服务不可用：${errText(e)}`;
    statusHost.classList.add("has-err");
  });
}
