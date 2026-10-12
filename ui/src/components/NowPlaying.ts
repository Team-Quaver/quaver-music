// 「正在播放 / 歌词」全屏覆盖页：点击播放条封面展开/收起（唯一入口；播放条不放开关按钮）。
// 无标题栏 CSD：np 铺满整窗，右上角窗口按钮簇（z-index 更高）在其上。
// 画廊模式（player.gallery 运行时态，不持久化）：播放条按钮开 = 展开本页并进窗口全屏
// （沉浸看歌词/封面），再点 = 收起并还原；收起本页的任何路径同样退出。全屏能力在
// src/lib/fullscreen.ts（Electron 原生 / 浏览器 Fullscreen API），与 WM 手势互不打架靠
// npFullscreen 标记「这轮全屏是不是本页带的」。ESC 收起本页。
// 歌词 = 整首列表：当前句居中、清晰、白色（染色版可读性差，已弃）；其余行模糊渐隐。
// 滚轮可自由翻阅全文（翻阅期间暂停自动跟随，播放进度追上行号后恢复跟随）。
// 翻阅是为了读别的行：浏览期间整列去模糊提亮（.browse），回跟随态平滑雾回。
// 字号/行距 = ⋮ 菜单「歌词大小」−/+（或歌词上 Ctrl+滚轮、触控板捏合）调 --np-ly-scale：
// 行内排版全走 em，字号与行距随同一系数缩放；改 font-size 不用 transform，任何档位都锐利。
// 系数持久化在 Style.LyricScale；逐字（QRC/AMLL）模式有 AMLL 自己的排版，菜单行自动隐藏。
// 逐字歌词（歌曲带 QRC 且开关开启）：Sparkle 逐字提供器（官方 amll 插件 = AMLL 渲染）
// 接管同一列位（.np-kara-host），宿主只管容器与重建时机；停用插件即自动回退行级歌词。
// 开关在插件的设置区（Sparkle tab → Apple Music-like Lyrics）；无逐字数据 / 无提供器 /
// 开关关闭时维持原有行级高亮。
// 右侧 = 封面在上，歌名 / 「歌手 - 专辑」在下，文本右对齐且与封面右缘齐平；
// 信息列下缘挂 ⋮ 更多选项（同名搜索 / 跳转歌手 / 跳转专辑 / 翻译 Switch 开关 /
// 歌词大小 −/+ 步进，仅行级歌词时出现；也可在歌词上 Ctrl+滚轮/触控板捏合直接调）。
// 背景 = 当前封面高斯模糊放大铺满（双层交叉淡化：新图解码完成后才淡入，换曲不闪主页面）
// + 深色渐变压暗 + .np 固体底色兜底；进度与控制由常驻播放条承担。
import { player, type Song } from "../player";
import { coverUrl, songTitle, stripEm, QUALITY_SHORT, effectiveQuality, getLastStream } from "../lib/api";
import {
  probeStreamInfo, cachedStreamInfo, fmtSampleRate, fmtBitDepth, fmtBitrate, fmtChannels,
  type StreamInfo,
} from "../lib/streaminfo";
import { icons } from "../lib/icons";
import { getLyricScale, setLyricScale, LYRIC_SCALE_MAX, LYRIC_SCALE_MIN, LYRIC_SCALE_STEP } from "../lib/prefs";
import { isFullscreen, setFullscreen, onFullscreenChange } from "../lib/fullscreen";
import type { SparkleKaraokeProvider } from "@quaver/sparkle";
import { sparkleKaraokeProvider, onSparkleChange, sparkleNpMenuItems } from "../sparkle/registry";
import { syncNpView } from "../sparkle/np-view";
export function NowPlaying(): HTMLElement {
  const el = document.createElement("div");
  el.className = "np";
  el.id = "now-playing";
  el.innerHTML = `
    <div class="np-bg" id="np-bg"></div>
    <div class="np-bg np-bg2" id="np-bg2"></div>
    <div class="np-scrim"></div>
    <div class="np-inner">
      <div class="np-lyrics" id="np-lyrics"></div>
      <div class="np-kara-host" id="np-karaoke"></div>
      <div class="np-side">
        <div class="np-cover" id="np-cover"></div>
        <div class="np-meta">
          <div class="np-title np-marquee" id="np-title"><span class="mt">未在播放</span></div>
          <div class="np-artist np-marquee" id="np-artist"><span class="mt"></span></div>
          <div class="np-morewrap">
            <button class="np-qpill" id="np-quality" type="button" aria-haspopup="dialog" aria-expanded="false" title="音质"></button>
            <button class="np-more" id="np-more" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" title="更多操作">${icons.more}</button>
            <div class="np-menu" id="np-menu"></div>
            <div class="np-qinfo" id="np-qinfo" role="dialog" aria-label="音频流信息"></div>
          </div>
        </div>
      </div>
    </div>
    <!-- Sparkle 插件小部件槽（左下角浮层；展开态才显示，不参与 np-inner 布局以免扰动歌词列） -->
    <div class="np-widgets" id="np-plugin-widgets"></div>
    <!-- Sparkle 整页接管容器：默认空，插件 np 视图挂在这里（见 sparkle/np-view.ts） -->
    <div class="np-view" id="np-view"></div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const lyrics = $("np-lyrics"), cover = $("np-cover");
  const bgA = $("np-bg"), bgB = $("np-bg2");
  const karaHost = $("np-karaoke");
  const npViewHost = $("np-view");

  // 共享 marquee：容器宽 < 文本宽才启用滚动；--mx 行程在溢出量外再补偿两端渐隐遮罩 ±12px，
  // 保证每一字符都能完整滚进清晰区（右对齐文本溢出在左，故正向平移）。
  // 文本没变不动 class/变量（notify 每帧跑，防止动画被重启）；ResizeObserver 覆盖窗口缩放重测。
  function marquee(boxId: string) {
    const box = $(boxId);
    const inner = box.querySelector<HTMLElement>(".mt")!;
    let sig = "";
    function measure() {
      if (!sig) return;
      const over = inner.scrollWidth - box.clientWidth;
      box.classList.toggle("over", over > 1);
      if (over > 1) {
        // 溢出在右：终点 = -(over+10)，让尾字完整滚进右缘清晰区（起点的 +10 见 CSS）
        box.style.setProperty("--mx", `${-(over + 10)}px`);
        box.style.setProperty("--md", `${Math.max(5, Math.round((over + 20) / 32))}s`);
      }
    }
    new ResizeObserver(measure).observe(box);
    return (text: string) => {
      if (text === sig) return;
      sig = text;
      inner.textContent = text;
      box.classList.remove("over");
      measure();
    };
  }
  const setTitle = marquee("np-title");
  const setArtist = marquee("np-artist");

  // —— 更多选项（⋮）：同名搜索 / 跳转歌手 / 跳转专辑 / 翻译开关 ——
  // 每次打开按当前歌曲现算（曲目可能缺歌手/专辑信息，逐项禁用；多歌手逐项列出，
  // 口径同 SongMenu 的 artistItems/albumItems）。翻译行是 Switch 开关，直接驱动 player.toggleTrans。
  // 开合是 class 驱动的缩放动画（.np-menu，锚在按钮圆心上）；跳转类动作先播收拢动画再走 hash。
  const moreBtn = $("np-more");
  const moreMenu = $("np-menu");
  let transSw: HTMLInputElement | null = null;
  const menuOpen = () => moreMenu.classList.contains("open");
  // 与 CSS 收拢过渡时长（.13s）对齐：跳转前留出动画时间，视觉上是「缩回去 → 落到目标页」
  const MENU_CLOSE_MS = 140;

  function onDocDownMore(e: PointerEvent) {
    const t = e.target as Node;
    if (!moreMenu.contains(t) && !moreBtn.contains(t)) closeMoreMenu();
  }
  function onEscMore(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); closeMoreMenu(); }
  }
  function closeMoreMenu() {
    if (!menuOpen()) return;
    moreMenu.classList.remove("open");
    moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocDownMore, true);
    document.removeEventListener("keydown", onEscMore, true);
  }
  /** 跳转类菜单项：先收拢（带动画）再跳目标页 —— 菜单原地消失/瞬间跳页都显得突兀。
   *  关键：正在播放页是铺满全窗的常驻悬浮层（player.expanded 驱动），只在底下换路由
   *  它仍盖在最上面 —— 必须把页面一起收起（同播放条收起钮的 expanded=false + notify）。 */
  function collapseThenRun(run: () => void) {
    closeMoreMenu();
    window.setTimeout(() => {
      player.expanded = false;
      player.notifyPublic();
      run();
    }, MENU_CLOSE_MS);
  }
  function menuRow(label: string, disabled: boolean, run?: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "np-menu-item";
    b.textContent = label;
    b.disabled = disabled;
    if (run) b.onclick = () => collapseThenRun(run);
    return b;
  }
  /** 逐字模式是否接管中（有逐字数据 + 提供器在位且启用）——菜单的歌词大小行据此显隐 */
  const karaModeNow = () => {
    const provider = sparkleKaraokeProvider();
    return player.karaoke.length > 0 && !!provider && (provider.enabled?.() ?? true);
  };
  function openMoreMenu() {
    const s = player.current;
    moreMenu.innerHTML = "";
    if (s) {
      const name = songTitle(s) || "这首歌";
      // 同名搜索
      moreMenu.append(menuRow("同名搜索", false, () => {
        location.hash = `#/search?keyword=${encodeURIComponent(stripEm(s.name) || name)}`;
      }));
      // 跳转歌手：多歌手逐项列出
      const singers = (s.singer ?? []).filter((a) => !!a?.mid);
      if (!singers.length) moreMenu.append(menuRow("跳转歌手", true));
      for (const a of singers) {
        moreMenu.append(menuRow(singers.length > 1 ? `跳转歌手：${stripEm(a.name) || "未知歌手"}` : "跳转歌手", false, () => {
          location.hash = `#/singer?mid=${encodeURIComponent(a.mid!)}&name=${encodeURIComponent(stripEm(a.name) || "歌手")}`;
        }));
      }
      // 跳转专辑
      const alb = s.album;
      const hasAlb = !!(alb?.mid || alb?.pmid);
      moreMenu.append(menuRow("跳转专辑", !hasAlb, () => {
        const base = String(alb!.pmid || alb!.mid).split("_")[0];
        location.hash = `#/album?mid=${encodeURIComponent(alb!.mid ?? base)}&name=${encodeURIComponent(stripEm(alb!.name) || "专辑")}`;
      }));
    } else {
      const empty = document.createElement("div");
      empty.className = "np-menu-empty";
      empty.textContent = "未在播放";
      moreMenu.append(empty);
    }
    // 翻译：Switch 开关（checkbox 只做语义与焦点，视觉由 .np-sw 承担）
    const row = document.createElement("label");
    row.className = "np-menu-switch";
    row.innerHTML = `<span>翻译</span><input type="checkbox"><span class="np-sw" aria-hidden="true"></span>`;
    transSw = row.querySelector<HTMLInputElement>("input")!;
    transSw.checked = player.showTrans;
    transSw.addEventListener("change", () => {
      if (transSw && transSw.checked !== player.showTrans) player.toggleTrans();
    });
    moreMenu.append(row);
    // 歌词大小：−/+ 步进（仅行级歌词就位时；逐字模式有 AMLL 自己的排版，不出现）。
    // 菜单开着时 Ctrl+滚轮缩放 → zoomLyric 里的 syncSizeRow 会原地更新读数与禁用态。
    if (!karaModeNow() && lineEls.length > 0) {
      const size = document.createElement("div");
      size.className = "np-menu-size";
      size.title = "也可在歌词上按住 Ctrl 滚轮（触控板捏合）调节";
      size.innerHTML = `<span>歌词大小</span><div class="np-menu-size-ctl">
        <button type="button" class="np-size-dec" aria-label="缩小歌词" title="缩小歌词">−</button>
        <span class="np-size-val">${Math.round(lyScale * 100)}%</span>
        <button type="button" class="np-size-inc" aria-label="放大歌词" title="放大歌词">+</button></div>`;
      size.querySelector<HTMLButtonElement>(".np-size-dec")!.onclick = () => zoomLyric(-1);
      size.querySelector<HTMLButtonElement>(".np-size-inc")!.onclick = () => zoomLyric(1);
      moreMenu.append(size);
      syncSizeRow(); // 先入树再同步：禁用态要在行上生效（syncSizeRow 查的是 moreMenu 内的行）
    }
    // Sparkle 插件追加项（⋮ 是扁平列表：label / disabled / run / danger / note 生效，
    // sub 与缩略图在这个面上不渲染 —— 契约见 SDK 的 SparkleNpMenuCtx）。
    // ctx 每次打开现算，带的是当时那首曲的只读快照（没在播时是 null）。
    for (const it of sparkleNpMenuItems({ song: s ?? null })) {
      const b = menuRow(it.label, it.disabled === true, it.run);
      if (it.note) b.title = it.note;
      if (it.danger) b.classList.add("danger");
      moreMenu.append(b);
    }
    moreMenu.classList.add("open");
    moreBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDocDownMore, true);
    document.addEventListener("keydown", onEscMore, true);
  }
  moreBtn.addEventListener("click", () => (menuOpen() ? closeMoreMenu() : openMoreMenu()));

  // —— 音质胶囊 + 音频流信息浮窗（⋮ 旁）：胶囊显示最后实际应用的档位（lastStream，未播放
  //     时回落当前设置，同播放条口径）；点击弹出以胶囊为锚的浮窗，现场对当前播放流取头
  //     字节探测 编码格式/采样率/采样精度/码率/声道（lib/streaminfo，结果按流 URL 缓存）。
  //     浮窗只展示不切换：切档在播放条胶囊的音质菜单里做。 ——
  const qPill = $("np-quality"), qInfo = $("np-qinfo");
  const qinfoOpen = () => qInfo.classList.contains("open");
  let lastQLabel = ""; // 胶囊文案签名（4Hz notify 里防重复写 DOM）
  let qFillSig = "";   // 浮窗内容签名
  function onDocDownQ(e: PointerEvent) {
    const t = e.target as Node;
    if (!qInfo.contains(t) && !qPill.contains(t)) closeQInfo();
  }
  function onEscQ(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); closeQInfo(); }
  }
  function closeQInfo() {
    if (!qinfoOpen()) return;
    qInfo.classList.remove("open");
    qPill.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocDownQ, true);
    document.removeEventListener("keydown", onEscQ, true);
  }
  function qiRow(label: string, value: string) {
    const d = document.createElement("div");
    d.className = "qi-row";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("b");
    v.textContent = value;
    d.append(l, v);
    return d;
  }
  function qiEmpty(text: string) {
    const d = document.createElement("div");
    d.className = "qi-empty";
    d.textContent = text;
    return d;
  }
  function qiHead(): HTMLElement {
    const d = document.createElement("div");
    d.className = "qi-title";
    const t = document.createElement("span");
    t.textContent = "音频流信息";
    d.append(t);
    const ls = getLastStream();
    if (player.current && ls) {
      const tier = document.createElement("span");
      tier.className = "qi-tier";
      tier.textContent = ls.degraded ? `${ls.label}（已回退）` : ls.label;
      d.append(tier);
    }
    return d;
  }
  function fillQInfo(url: string, info: StreamInfo | null | "none" | "pending") {
    const sig = url + "|" + (typeof info === "string" ? info
      : info ? `${info.codec}|${info.sampleRate ?? ""}|${info.bitDepth ?? ""}|${Math.round(info.bitrate ?? 0)}|${info.channels ?? ""}` : "null");
    if (sig === qFillSig && qInfo.childElementCount) return; // notify 4Hz：内容没变不重建 DOM
    qFillSig = sig;
    qInfo.innerHTML = "";
    qInfo.append(qiHead());
    if (info === "none") { qInfo.append(qiEmpty(player.current ? "等待播放流…" : "未在播放")); return; }
    if (info === "pending") { qInfo.append(qiEmpty("探测中…")); return; }
    if (!info) { qInfo.append(qiEmpty("流信息不可用")); return; }
    qInfo.append(
      qiRow("编码格式", info.codec),
      qiRow("采样率", fmtSampleRate(info.sampleRate)),
      qiRow("采样精度", fmtBitDepth(info.bitDepth)),
      qiRow("码率", fmtBitrate(info)),
      qiRow("声道", fmtChannels(info.channels)),
    );
  }
  /** 打开/刷新浮窗内容：先画即时态，探测回来后（仍开着且还是同一条流）再落最终行 */
  async function syncQInfo() {
    const url = player.streamUrl;
    if (!player.current || !url) { fillQInfo("", "none"); return; }
    const cached = cachedStreamInfo(url);
    if (cached) {
      const info = await cached;
      if (qinfoOpen() && player.streamUrl === url) fillQInfo(url, info);
      return;
    }
    fillQInfo(url, "pending");
    const info = await probeStreamInfo(url, { duration: player.duration });
    if (qinfoOpen() && player.streamUrl === url) fillQInfo(url, info);
  }
  qPill.addEventListener("click", () => {
    if (qinfoOpen()) { closeQInfo(); return; }
    closeMoreMenu(); // 两个浮窗同锚区：只开一个
    qInfo.classList.add("open");
    qPill.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDocDownQ, true);
    document.addEventListener("keydown", onEscQ, true);
    void syncQInfo();
  });

  // —— ESC 收起本页（画廊模式下顺路退出全屏，联动在 notify 的 expanded 迁移里）——
  // 菜单开着时由它自己的捕获监听（stopPropagation）接管，走不到这里；搜索框/列表工具
  // 输入框里的 ESC 只清输入不收页；队列拖拽的 ESC 已 preventDefault，同样不抢。
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
    if (!player.expanded) return;
    player.expanded = false;
    player.notifyPublic();
  });

  let lastMid = "";        // 歌词行 DOM 只在换曲/状态迁移时重建
  let lastLyricState = "";
  let lastIdx = -1;        // 高亮行索引（避免每帧改 class）
  let lastCover: string | null = null; // 封面 img 的 src 签名（4Hz notify 里防 <img> 重建/重解码）
  let lineEls: HTMLElement[] = [];

  // —— 逐字歌词（Sparkle 逐字提供器接管 .np-kara-host）——
  // notify 只有 4Hz，逐字扫色要逐帧时间：逐帧时钟/播放态/翻译显隐/收起冻结全部由
  // provider 的 render 自理（经 render ctx 闭包读到的永远是当前态）；宿主只管在
  // 换曲/歌词状态/逐字开关/提供器身份变化时清容器重挂。
  let lastKaraMode = false;
  let karaProvider: SparkleKaraokeProvider | null = null;
  let karaCleanup: (() => void) | null = null;

  function disposeKara() {
    if (karaCleanup) { try { karaCleanup(); } catch (e) { console.warn("[np] 逐字渲染清理失败", e); } }
    karaCleanup = null;
    karaProvider = null;
    karaHost.innerHTML = ""; // 容器内容整个交给 provider，清理时兜底清空
  }
  function buildKara() {
    disposeKara();
    const provider = sparkleKaraokeProvider();
    if (!provider) return;
    karaProvider = provider;
    karaCleanup = provider.render(karaHost, player.karaoke, {
      time: () => (player.time + 0.2) * 1000, // +0.2s 与行级高亮同一处时间补偿
      paused: () => player.paused,
      expanded: () => player.expanded,
      showTrans: () => player.showTrans,
      seek: (ms) => { player.seek(ms / 1000); setBrowse(false); },
      onNotify: (cb) => player.on(cb),
    }) ?? null;
  }

  // —— 滚轮翻阅：浏览模式暂停自动跟随；3s 无操作回到跟随，或点击任意行立刻跟随该句 ——
  // 浏览态给列表挂 .browse：整列去模糊提亮（翻阅是为了读，雾化只属于跟随态的氛围）。
  let browsing = false;
  let browseTimer = 0;
  const setBrowse = (v: boolean) => {
    browsing = v;
    lyrics.classList.toggle("browse", v);
    if (!v) window.clearTimeout(browseTimer);
  };
  const enterBrowse = () => {
    window.clearTimeout(browseTimer);
    setBrowse(true);
    browseTimer = window.setTimeout(() => {
      setBrowse(false);
      followCurrent(); // 回到跟随态：立刻把当前句滚回中心
    }, 3000);
  };
  lyrics.addEventListener("wheel", (e) => { if (!e.ctrlKey) enterBrowse(); }, { passive: true });
  lyrics.addEventListener("pointerdown", enterBrowse, { passive: true });

  // —— LRC 字号/行距缩放（--np-ly-scale）：字号与行距（em 排版）随同一系数缩放，改的是
  //    font-size 而非 transform，任何档位文字都锐利。⋮ 菜单「歌词大小」−/+ 与歌词上
  //    Ctrl+滚轮（触控板捏合同）共用一档；系数持久化 Style.LyricScale。菜单每次打开现建
  //    行 DOM（读数/禁用态即最新）；菜单开着时缩放（如 Ctrl+滚轮）由 syncSizeRow 原地跟随。
  //    逐字（AMLL）模式有自己的排版变量，菜单行不出现。 ——
  let lyScale = getLyricScale();
  el.style.setProperty("--np-ly-scale", lyScale.toFixed(2));
  function syncSizeRow() {
    const val = moreMenu.querySelector<HTMLElement>(".np-size-val");
    if (!val) return;
    val.textContent = `${Math.round(lyScale * 100)}%`;
    const dec = moreMenu.querySelector<HTMLButtonElement>(".np-size-dec");
    const inc = moreMenu.querySelector<HTMLButtonElement>(".np-size-inc");
    if (dec) dec.disabled = lyScale <= LYRIC_SCALE_MIN + 1e-9;
    if (inc) inc.disabled = lyScale >= LYRIC_SCALE_MAX - 1e-9;
  }
  function zoomLyric(dir: 1 | -1) {
    const clamped = Math.min(LYRIC_SCALE_MAX, Math.max(LYRIC_SCALE_MIN, Math.round((lyScale + dir * LYRIC_SCALE_STEP) * 100) / 100));
    if (clamped === lyScale) return;
    lyScale = clamped;
    setLyricScale(lyScale);
    el.style.setProperty("--np-ly-scale", lyScale.toFixed(2));
    syncSizeRow();
    if (!browsing) followCurrent(); // 行高变了：把当前句重新带回中心
  }
  let lastZoomAt = 0;
  lyrics.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return; // 普通滚轮走翻阅（上面的 passive 监听）
    e.preventDefault();     // 先顶掉浏览器页面缩放；节流只影响步进不影响拦截
    const now = performance.now();
    if (now - lastZoomAt < 100) return; // 触控板捏合事件密集，节流成可控的档位步进
    lastZoomAt = now;
    zoomLyric(e.deltaY < 0 ? 1 : -1);   // 上滚放大
  }, { passive: false });

  function followCurrent() {
    const line = lineEls[lastIdx];
    if (line) lyrics.scrollTo({ top: line.offsetTop + line.offsetHeight / 2 - lyrics.clientHeight / 2, behavior: "smooth" });
  }

  function buildLyricDom(s: Song | undefined) {
    lastMid = s?.mid ?? "";
    lastIdx = -1;
    setBrowse(false);
    if (!s) { lyrics.innerHTML = `<div class="np-ly-empty">未在播放</div>`; lineEls = []; return; }
    if (player.lyricState === "loading" || (player.lyricState === "idle" && !player.lyrics.length)) { lyrics.innerHTML = `<div class="np-ly-empty">歌词加载中…</div>`; lineEls = []; return; }
    if (!player.lyrics.length) { lyrics.innerHTML = `<div class="np-ly-empty">暂无歌词</div>`; lineEls = []; return; }
    lyrics.innerHTML = "";
    for (const line of player.lyrics) {
      const d = document.createElement("div");
      d.className = "np-ly-line";
      d.innerHTML = `<span class="l1">${escapeHtml(line.text)}</span>${line.trans ? `<span class="l2">${escapeHtml(line.trans)}</span>` : ""}`;
      d.onclick = () => { player.seek(line.t); setBrowse(false); }; // 点击跳回该行并恢复跟随
      lyrics.append(d);
    }
    lineEls = [...lyrics.querySelectorAll<HTMLElement>(".np-ly-line")];
  }

  // —— 背景交叉淡化（双层 .np-bg：A 垫底 / B 淡入）——
  // 直接换 backgroundImage 会有「旧图已清、新图未解码」的透明窗口：np 遮罩只做轻度压暗，
  // 底下的主页面（Content View）会透出来 —— 正在播放页切歌「闪一下 Content View」的根源。
  // 分工：A = 垫底层，恒显不透明（B 完全淡出后可见）；B = 淡入层（DOM 序在 A 之上，
  // **不许碰 z-index** —— np-inner 是 z1、scrim 是 z-auto，背景层一旦提到 z1 就会盖住
  // scrim 的歌词列渐变蒙版，逐字模式的可读性背光直接消失）。时序：新图经 Image() 预载，
  // 解码完成后写到 B 淡入盖住 A 的旧图；过渡结束把 A 原地换成新图（在不透明的 B 底下换，
  // 肉眼不可见）再让 B 退场 —— 任何时刻可见面 = 新图或旧图，从无透明缝隙。
  // notify 是 4Hz 高频调用：同封面幂等返回，慢 onload 以 bgWant 判最新防旧图顶掉新图。
  let bgHold = "";   // A 层内容（B 透明时用户看到的图）
  let bgFade = "";   // B 层正在淡入的内容
  let bgWant = "";   // 最近一次请求的封面 URL
  let bgFailed = ""; // 加载失败过的封面 URL：notify 4Hz 会反复进来，别对着 404 封面刷请求
  let bgSettle = 0;  // 淡入完成后的收尾定时器（A 换新图 + B 退场）
  const settleBg = (pic: string) => {
    bgHold = pic;
    bgFade = "";
    bgA.style.backgroundImage = `url("${pic}")`;
    bgA.classList.add("show");
    bgB.classList.remove("show");
    bgB.style.backgroundImage = ""; // 释放 B 上的位图（A 已接管）
  };
  function applyBg(pic: string) {
    bgWant = pic;
    if (!pic) {
      window.clearTimeout(bgSettle);
      bgHold = bgFade = "";
      bgA.classList.remove("show");
      bgA.style.backgroundImage = "";
      bgB.classList.remove("show");
      bgB.style.backgroundImage = "";
      return;
    }
    if (pic === bgHold || pic === bgFade || pic === bgFailed) return; // 已在屏 / 已在淡入 / 已知失败（不动进行中的收尾）
    window.clearTimeout(bgSettle); // 真要换图：作废上一轮收尾，避免它把新图当旧图换掉
    const img = new Image();
    img.onload = () => {
      if (bgWant !== pic) return; // 预载期间又换曲了
      bgFade = pic;
      bgB.style.backgroundImage = `url("${pic}")`;
      bgB.classList.add("show"); // .45s 淡入（CSS 过渡），盖在 A 的旧图上
      bgSettle = window.setTimeout(() => settleBg(pic), 520);
    };
    img.onerror = () => { if (bgWant === pic) { bgFailed = pic; applyBg(""); } }; // 封面 404：回到无背景态（固体底色兜底）
    img.src = pic;
  }

  // —— 画廊模式（player.gallery，运行时态；开关在播放条按钮）——
  // npFullscreen 标记「当前全屏是本页带起来的」：只有这种情况收起本页才退全屏；
  // 用户经 WM 手势自己进的全屏（gallery 关着）不归本页管，收起时不去抢窗口态。
  let lastExpanded = player.expanded;
  let npFullscreen = false;
  onFullscreenChange((on) => {
    // 回同步：外部退出（WM/最大化钮）→ 画廊会话结束、本页不再认领；
    // 外部进入且画廊开着且本页开着 → 视作本页接管
    if (!on) {
      npFullscreen = false;
      if (player.gallery) {
        player.gallery = false;
        player.notifyPublic(); // 立即释放 idle 抑制并熄灭播放条按钮
      }
    }
    else if (player.expanded && player.gallery) npFullscreen = true;
  });

  player.on(() => {
    const s = player.current;
    const open = player.expanded;
    // 画廊模式联动。放在早退之前：无歌收起也要能退出全屏。
    //  - 展开迁移：画廊开着 → 进全屏；收起 → 画廊会话结束，本页带的全屏随之退出
    //  - 无展开迁移但 gallery 刚被播放条置真（本页已开着）→ 立即进全屏
    if (open !== lastExpanded) {
      lastExpanded = open;
      // 顶栏随播放页展开而隐藏：释放搜索焦点，让候选关闭、ESC 交回播放页。
      const focused = document.activeElement;
      if (open && focused instanceof HTMLElement && focused.closest(".content-top")) focused.blur();
      if (open && player.gallery && !isFullscreen()) { npFullscreen = true; setFullscreen(true); }
      else if (!open) {
        player.gallery = false;
        if (npFullscreen) { npFullscreen = false; setFullscreen(false); }
        closeQInfo();
      }
    } else if (player.gallery && open && !npFullscreen && !isFullscreen()) {
      npFullscreen = true;
      setFullscreen(true);
    }
    el.classList.toggle("open", open);
    el.classList.toggle("no-trans", !player.showTrans);
    // 菜单开着时同步翻译开关的选中态（toggleTrans 之外的改法 — 如设置页 — 也能跟上）
    if (transSw && menuOpen()) transSw.checked = player.showTrans;
    // 音质胶囊：直接显示最后实际应用的档位（lastStream；未在播放时回落到当前设置）——
    // 与播放条胶囊同口径，↓ = 该流是被回退降档的
    const ls = getLastStream();
    const qLabel = player.current && ls
      ? (ls.degraded ? "↓" : "") + (QUALITY_SHORT[ls.tier] ?? ls.label)
      : (QUALITY_SHORT[effectiveQuality()] ?? "音质");
    if (qLabel !== lastQLabel) {
      lastQLabel = qLabel;
      qPill.textContent = qLabel;
      qPill.title = `音质：${qLabel}${player.current && ls ? "（实际档位）" : "（当前设置）"}；点看这条流的采样率/位深/编码/码率/声道`;
    }
    if (qinfoOpen()) void syncQInfo();

    // —— Sparkle 整页接管（np-view.ts）：插件自绘整页，宿主默认布局整块让位。
    //    必须**在**逐字/歌词/背景之前早退：接管态下这些 DOM 一个都不该再被碰。
    //    倒逐字渲染是必须的 —— 否则 amll 的 rAF 循环会脱离 expanded 判定一直跑。
    //    也必须在「无歌收起」早退**之前**算：body.np-takeover 是全局标记，
    //    漏算一次就等于播放条再也回不来。
    if (syncNpView(el, npViewHost)) {      disposeKara();
      lastKaraMode = false;
      lastLyricState = "";
      lastMid = "";
      lastIdx = -1;
      bgWant = bgHold = bgFade = bgFailed = "";
      bgA.classList.remove("show"); bgA.style.backgroundImage = "";
      bgB.classList.remove("show"); bgB.style.backgroundImage = "";
      return;
    }
    if (!open && !s) return;

    // 背景：封面模糊放大（交叉淡化，见 applyBg）；侧栏封面同一张图。
    // 封面 img 按 src 守卫：notify 是 4Hz 广播，无条件重建 <img> 会反复触发重解码
    const pic = s ? coverUrl(s, 300) : "";
    applyBg(pic);
    if (pic !== lastCover) { lastCover = pic; cover.innerHTML = pic ? `<img src="${pic}" alt=""/>` : `<div class="np-cover-ph">${icons.disc ?? ""}</div>`; }

    // 换曲 / 歌词状态迁移 / 逐字模式切换（loading→ok/none 时行 DOM 需要重建，否则占位/歌词丢失）
    const st: "idle" | "loading" | "ok" | "none" = player.lyrics.length ? "ok" : player.lyricState;
    const karaMode = karaModeNow();
    el.classList.toggle("kara", karaMode);
    if (s?.mid !== lastMid || st !== lastLyricState || karaMode !== lastKaraMode || (karaMode && sparkleKaraokeProvider() !== karaProvider)) {
      lastKaraMode = karaMode;
      if (karaMode) { lastMid = s?.mid ?? ""; lastIdx = -1; buildKara(); }
      else { disposeKara(); buildLyricDom(s); }
    }
    lastLyricState = st;
    setTitle(s ? songTitle(s) : "未在播放");
    const albumName = (s as any)?.album?.name ?? "";
    setArtist(s ? [(s.singer ?? []).map((x) => x.name).join(" / "), albumName].filter(Boolean).join(" - ") : "");

    // 高亮当前歌词行 + 滚动居中（翻阅模式暂停自动跟随；3s 静默或点击行号恢复；逐字模式由渲染器接管）
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

  // —— 插件启用/停用的即时反映（不依赖「恰好在播放」）——
  // syncNpView 平时挂在 player.on 上（4Hz 位置广播），但**没在播放时 player 不推事件**：
  // 那样「装好 Flowscape → 打开正在播放页」会赶不上挂载（要等用户先播一首歌），
  // 「停用插件」也摘不掉它已渲染的 DOM。注册表变化是准实时事件，这里补一刀。
  // 收起状态下也要调：摘除得掉，且 active=false 保证不会误挂 np-takeover。
  onSparkleChange(() => {
    if (syncNpView(el, npViewHost)) {
      disposeKara();
      lastKaraMode = false;
      lastLyricState = "";
      lastMid = "";
      lastIdx = -1;
    }
  });

  return el;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
