// 底部播放条（常驻于 SPA 壳层，切视图不销毁；悬浮窗底）
// 左：封面（点击展开/收起「正在播放」页）+ 歌名/歌手
// 中：上一首 · 播放/暂停 · 下一首；右：静音 · 循环 · 红心 · 队列 · 展开
// 进度：整个 Bar 按下去即可拖拽 seek（拖中圆点/时间跟手，松手才真正提交），顶边细线只是视觉指示
// 音量：浮窗形式 —— 悬停/点击静音按钮弹出玻璃小窗，静音图标 + 滑杆 + 读数一体
//      浮窗锚在音量钮正上方（跟着钮走，不跟着 Bar 右缘走）；滚轮在整条上 = 微调音量
import { player, type Mode } from "../player";
import { getPrevBehavior, setDesktopLyrics } from "../lib/prefs";
import { coverUrl, getLastStream, getStreamTiers, getSessionQuality, effectiveQuality, QUALITY_SHORT, QUALITIES, songMissingTiers, songTitle, type Quality } from "../lib/api";
// getLastStream 仍由 paintQ 使用（胶囊显示实际已应用档位）
import { fmtDur } from "../lyric";
import { icons } from "../lib/icons";

const clamp01 = (f: number) => Math.max(0, Math.min(1, f));

export function PlayerBar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "player";
  el.id = "player-bar";
  el.innerHTML = `
    <div class="pb-fill-clip"><div class="pb-fill" id="pb-fill"></div></div>
    <div class="pb-left">
      <button class="pb-cover" id="pb-cover" title="展开歌词 / 正在播放"></button>
      <div class="now">
        <div class="t" id="pb-title">未在播放</div>
        <div class="s" id="pb-sub">点一首歌试试</div>
      </div>
    </div>
    <div class="pb-mid">
      <button class="pb-btn" id="pb-prev" title="上一首" aria-label="上一首">${icons.prev}</button>
      <button class="pb-btn pb-play" id="pb-play" title="播放/暂停" aria-label="播放/暂停">${icons.play}</button>
      <button class="pb-btn" id="pb-next" title="下一首" aria-label="下一首">${icons.next}</button>
    </div>
    <div class="pb-right">
      <span class="pb-time" id="pb-time">0:00 / 0:00</span>
      <!-- 音量钮 + 音量浮窗共用一个定位锚（.pb-volhost）：浮窗锚在钮的正上方，
           不锚在 Bar 右缘 —— 见 style.css 的 .pb-volpop 那段 -->
      <div class="pb-volhost">
        <button class="pb-btn pb-ghost" id="pb-mute" title="音量 / 静音" aria-label="音量 / 静音"></button>
        <!-- 音量浮窗：静音控制 + 滑杆 + 读数 -->
        <div class="pb-volpop" id="pb-volpop" role="group" aria-label="音量">
          <button class="pb-btn pb-ghost" id="pb-mute2" title="静音" aria-label="静音"></button>
          <input class="pb-vol" id="pb-vol" type="range" min="0" max="100" step="1" value="80" aria-label="音量" />
          <span class="pb-volnum" id="pb-volnum">80%</span>
          <button class="pb-eq-shortcut" id="pb-eq-shortcut" type="button" title="打开 Quark EQ（原生 / 兼容）" aria-label="打开 Quark EQ">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 15h3l2-7 3 11 3-15 2 11h5"/>
            </svg>
          </button>
        </div>
      </div>
      <button class="pb-btn pb-ghost" id="pb-loop" title="播放模式" aria-label="播放模式" aria-haspopup="menu" aria-expanded="false"></button>
      <button class="pb-q" id="pb-quality" title="音质" aria-label="音质"></button>
      <button class="pb-btn pb-ghost" id="pb-love" title="收藏" aria-label="收藏">${icons.heart}</button>
      <button class="pb-btn pb-ghost" id="pb-gallery" title="画廊模式" aria-label="画廊模式"></button>
      <button class="pb-btn pb-ghost" id="pb-dl" title="桌面歌词" aria-label="桌面歌词"></button>
      <button class="pb-btn pb-ghost" id="pb-queue" title="播放队列" aria-label="播放队列">${icons.queue}</button>
    </div>
    <!-- 播放模式浮窗：循环三档 + 随机播放（每日一套顺序） -->
    <div class="pb-lpop" id="pb-lpop" role="menu" aria-label="播放模式"></div>
    <!-- 音质浮窗：会话级档位（不持久化），永远带 Fallback 协商 -->
    <div class="pb-qpop" id="pb-qpop" role="menu" aria-label="音质"></div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const cover = $("pb-cover"), title = $("pb-title"), sub = $("pb-sub");
  const time = $("pb-time"), fill = $("pb-fill");
  const play = $("pb-play"), prev = $<HTMLButtonElement>("pb-prev"), loop = $<HTMLButtonElement>("pb-loop"), love = $("pb-love");
  const queueBtn = $<HTMLButtonElement>("pb-queue");
  const gallery = $("pb-gallery");
  const mute = $("pb-mute"), mute2 = $("pb-mute2");
  const pop = $("pb-volpop");
  const vol = el.querySelector<HTMLInputElement>("#pb-vol")!;
  const volnum = $("pb-volnum");
  const eqShortcut = $<HTMLButtonElement>("pb-eq-shortcut");

  const toggleExpand = () => {
    if (!player.current) { player.expanded = false; player.notifyPublic(); return; } // 页内无收起按钮：无歌时强制回退，防卡死

    player.expanded = !player.expanded;
    player.notifyPublic();
  };

  cover.onclick = toggleExpand;

  prev.onclick = () => player.prev();
  // replay 档：单击重放当前曲（click 已处理），双击跳到队列里的上一首 —— 双击的头一击已 seek(0)，跳走前听不出痕迹；
  // previous 档单击本就是跳转、连点逐首回退（与连点下一首同语义），dblclick 再跳会多退一首，故只在 replay 档接管。
  prev.addEventListener("dblclick", () => { if (getPrevBehavior() === "replay") player.prev(true); });
  play.onclick = () => player.toggle();
  $("pb-next").onclick = () => player.next(false);
  love.onclick = () => player.toggleLove(player.current);
  queueBtn.onclick = () => {
    if (player.radioActive) return;
    player.queueOpen = !player.queueOpen;
    player.notifyPublic();
  };

  // —— 桌面歌词开关 ——
  // 写路走偏好（quaver.conf 的 DesktopLyrics.Enabled）：主进程 config 落盘口看到该段键变更
  // 即 syncFromConf() 开/关覆盖层，与设置页同一扇门；按钮亮灭只认主进程回推的**窗口真相**
  // （dl-active 广播 + 启动 sendSync），不是本地内存 —— 托盘/✕ 关窗等旁路改动能立刻反映。
  const dl = $("pb-dl");
  dl.innerHTML = icons.desktopLyricOff; // 初始画「关」态，paintDl 再按主进程真相修正
  const dlBridge = window.quaverDesktopLyrics;

  if (!dlBridge) dl.remove(); // 浏览器 dev 没有覆盖层窗：藏钮（与「打开位置」按钮同款处置）
  else {
    let dlOpen = false;

    const paintDl = (open: boolean) => {
      if (open === dlOpen && dl.classList.contains("on") === open) return;
      dlOpen = open;
      dl.classList.toggle("on", open);
      dl.innerHTML = open ? icons.desktopLyric : icons.desktopLyricOff;
      dl.dataset.tooltip = open ? "桌面歌词：开" : "桌面歌词：关";
      dl.setAttribute("aria-label", dl.dataset.tooltip);
      dl.setAttribute("aria-pressed", String(open));
    };

    try { paintDl(!!dlBridge.activeSync?.()?.open); } catch { /* handler 未就位：等广播 */ }

    dlBridge.onActive?.((s) => paintDl(!!s?.open));
    dl.onclick = () => setDesktopLyrics(!dlOpen);
  }

  // 画廊模式开关（运行时态）：开 = 展开正在播放页并进全屏；再点 = 收起并还原窗口。
  // 无歌不开页（与封面钮同口径）；收起本页的其它路径（ESC/封面钮/跳转）由 NowPlaying
  // 的 expanded 迁移统一退全屏并清 gallery。
  gallery.innerHTML = icons.gallery;
  gallery.onclick = () => {
    if (player.gallery) { player.gallery = false; player.expanded = false; }
    else { if (!player.current) return; player.gallery = true; player.expanded = true; }

    player.notifyPublic();
  };

  mute.onclick = () => player.toggleMute();
  mute2.onclick = () => player.toggleMute();

  // —— 播放模式菜单：循环两档 + 随机播放 ——
  // 按钮不再自己轮转，改成开菜单（循环只有两档 + 随机一共三项，轮转要多点几次且看不出当前档）。
  // 图标口径：随机开 → 画随机图标（一眼看出洗牌生效）；关 → 画当前循环档图标。
  // 勾选态同时进 title/aria-label：「列表循环/单曲循环」光看图标只差一个 9px 的「1」。
  const lPop = $("pb-lpop");

  const LOOP_MODES: { id: Mode; label: string; icon: string; note: string }[] = [
    { id: "all", label: "列表循环", icon: icons.loopAll, note: "循环整列" },
    { id: "one", label: "单曲循环", icon: icons.loopOne, note: "重复当前" },
  ];

  function buildLPop() {
    lPop.innerHTML = "";

    for (const m of LOOP_MODES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lp-i";
      b.dataset.mode = m.id;
      b.innerHTML = `<span class="lp-ic">${m.icon}</span><span class="lp-tx">${m.label}</span><i class="muted">${m.note}</i>`;
      b.onclick = () => { player.setMode(m.id); closeLPop(); };

      lPop.append(b);
    }

    const sep = document.createElement("div");
    sep.className = "lp-sep";
    lPop.append(sep);
    const sh = document.createElement("button");
    sh.type = "button";
    sh.className = "lp-i";
    sh.dataset.shuffle = "1";
    sh.innerHTML = `<span class="lp-ic">${icons.shuffle}</span><span class="lp-tx">随机播放</span><i class="muted">每日一套顺序</i>`;
    sh.onclick = () => { player.toggleShuffle(); closeLPop(); };

    lPop.append(sh);
  }

  function syncLPop() {
    lPop.querySelector<HTMLElement>('[data-mode="all"]')?.classList.toggle("sel", player.mode === "all");
    lPop.querySelector<HTMLElement>('[data-mode="one"]')?.classList.toggle("sel", player.mode === "one");
    lPop.querySelector<HTMLElement>('[data-shuffle]')?.classList.toggle("sel", player.shuffle);
  }

  const closeLPop = () => {
    el.classList.remove("lp-open");
    loop.setAttribute("aria-expanded", "false");
  };

  buildLPop();
  loop.onclick = () => {
    const open = el.classList.toggle("lp-open");
    loop.setAttribute("aria-expanded", String(open));

    if (open) syncLPop();
  };

  // 音量滑杆（拖动即时生效；拉到 0 静音态，调回自动取消静音）
  // 「谁在改音量」只认指针真的按在滑杆上，**不认焦点**：range 一被点/拖就拿到焦点，而且
  // 焦点会一直留着（移开鼠标、收起浮窗都不掉）。拿 document.activeElement 当「用户正在编辑」
  // 的判据，等于此后所有外部改的音量（滚轮 / 全局热键 / MPRIS / 设置页）都再也回不到滑杆上 ——
  // 条与读数冻在聚焦那一刻的值，声音明明在变，看着就是「音量条不跟滚轮走」。
  // 编辑期间仍然以滑杆自己为准：拖中不被 notify 的 4Hz 回写打断（松手即回到播放器真值）。
  let volEditing = false;

  const endVolEdit = () => {
    if (!volEditing) return;
    volEditing = false;
    // 松手立刻回到播放器真值：拖中若被滚轮/热键改过音量，这里补上那一截，不留 94 vs 98 的假读数
    vol.value = String(Math.round((player.muted ? 0 : player.volume) * 100));
    paintVol();
  };

  vol.addEventListener("pointerdown", () => { volEditing = true; });
  window.addEventListener("pointerup", endVolEdit);
  window.addEventListener("pointercancel", endVolEdit);
  // 兜底：指针在窗外松开时 pointerup 未必收得到 —— range 拖拽自带隐式指针捕获，
  // 释放时必发 lostpointercapture；焦点被抢走时 blur 同样收尾（漏掉一次就又是「冻住」）
  vol.addEventListener("lostpointercapture", endVolEdit);
  vol.addEventListener("blur", endVolEdit);
  vol.addEventListener("input", () => { paintVol(); player.setVolume(Number(vol.value) / 100); });
  // 音量浮窗右侧的 Quark EQ 快捷入口：按需拉浮窗模块，别把曲线/APO 解析塞进首屏。
  eqShortcut.onclick = () => {
    el.classList.remove("vol-open");
    void import("./EqualizerDialog").then((m) => m.openEqualizer());
  };

  // 音量浮窗：悬停静音按钮显示；移开短暂宽限；点击条外关闭
  let hideTimer = 0;

  // 越界修正：锚点交给 CSS（浮窗压在音量钮正上方），但窄条时「钮左缘 + 整块浮窗」会顶出条的
  // 右缘 —— 悬浮态条只有 --control-bar-width，半屏吸附/minWidth 760 下实测溢出 30~40px，
  // 读数会被切在窗口边上。与 SongMenu 同一套路：显示前量一次，只往左退，且不退过条的左内缘。
  const clampVolPop = () => {
    pop.style.left = ""; // 先退回 CSS 锚点原位，量的才是「没退过」的盒子
    const pr = pop.getBoundingClientRect(), br = el.getBoundingClientRect();
    const over = pr.right - (br.right - 10); // 10 = 1px 描边 + 9px 与条右缘的呼吸位
    const room = pr.left - (br.left + 10);   // 退到条的左内缘为止

    if (over > 0.5) pop.style.left = `${-13 - Math.min(over, Math.max(0, room))}px`;
  };

  const showPop = () => { window.clearTimeout(hideTimer); clampVolPop(); el.classList.add("vol-open"); };
  const queueHide = () => { window.clearTimeout(hideTimer); hideTimer = window.setTimeout(() => el.classList.remove("vol-open"), 220); };

  for (const t of [mute, pop]) {
    t.addEventListener("pointerenter", showPop);
    t.addEventListener("pointerleave", queueHide);
  }

  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;

    if (!el.contains(t) || !t.closest("#pb-mute, #pb-volpop")) el.classList.remove("vol-open");

    if (!el.contains(t) || !t.closest("#pb-quality, #pb-qpop")) el.classList.remove("q-open");

    if (!el.contains(t) || !t.closest("#pb-loop, #pb-lpop")) closeLPop();
  });

  // —— 音质切换（音频控制区右侧、收藏红心之前）——
  // 先拉 /stream/tiers 拿到会员可及档位，再渲染胶囊与浮窗（未就绪时画占位，避免闪出错误档位）。
  // 浮窗列表按当前曲过滤：这首歌没有的档位直接隐藏（songMissingTiers），换曲即重建。
  const qBtn = $<HTMLButtonElement>("pb-quality"), qPop = $("pb-qpop");
  let tierList: { id: string; label: string; locked?: number | boolean }[] = [];
  let qReady = false;
  let qSig = "";

  function paintQ() {
    if (!qReady) {
      if (qSig !== "…") { qSig = "…"; qBtn.textContent = "…"; qBtn.disabled = true; }

      return;
    }

    qBtn.disabled = false;
    const ls = getLastStream();
    const want = getSessionQuality();

    // 有已应用的流 → 实际档位（↓=被回退降档）；否则显示当前生效选择（未选=设置页默认）
    const fallback = player.playbackFallback;
    const label = fallback?.local
      ? "本地"
      : fallback?.directUrl
      ? "微云"
      : player.current?.directUrl
      ? "微云"
      : player.current && ls
      ? (ls.degraded ? "↓" : "") + (QUALITY_SHORT[ls.tier] ?? ls.label)
      : (QUALITY_SHORT[want ?? effectiveQuality()] ?? "音质");

    const sig = label + "|" + (want ?? "");

    if (sig === qSig) return;
    qSig = sig;
    qBtn.textContent = label;
    qBtn.dataset.tooltip = want ? `音质：${label}` : "音质";
    qBtn.setAttribute("aria-label", qBtn.dataset.tooltip);
    qBtn.classList.toggle("active", !!want);

    if (el.classList.contains("q-open")) syncSel();
  }

  const cur = () => effectiveQuality();

  const syncSel = () => qPop.querySelectorAll<HTMLElement>(".qp-q")
    .forEach((x) => x.classList.toggle("sel", x.dataset.q === cur()));

  function buildQPop() {
    qPop.innerHTML = "";

    // 本地/NAS/微云直链：文件本身就是那一档，没有在线档位阶梯可换
    if (player.current && ((player.current as { local?: unknown }).local || player.current.directUrl || player.playbackFallback)) {
      const ls = getLastStream();
      const source = player.playbackFallback?.local
        ? "本地库同曲文件"
        : player.playbackFallback?.directUrl
        ? "微云同曲原文件"
        : ls?.label ?? "本地文件";
      qPop.innerHTML = `<div class="qp-note">${source}：无在线档位可切（音质即文件本身）</div>`;

      return;
    }

    const item = (id: string, label: string, note = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "qp-q" + (cur() === id ? " sel" : "");
      b.dataset.q = id;
      b.innerHTML = `<span>${label}</span>${note ? `<i class="muted">${note}</i>` : ""}`;
      b.onclick = () => {
        player.switchQuality(id as Quality | "auto");
        el.classList.remove("q-open");
      };

      qPop.append(b);
    };

    item("auto", "自动", "最高可播");
    // 只列这首歌实际有源的档位（上游 file 元数据判定；元数据缺失回退全量）。
    // 会员锁定的档不算「无源」：照常展示并标 🔒（选择后走自动回退）。
    const missing = songMissingTiers(player.current);

    for (const t of missing ? tierList.filter((x) => !missing.has(x.id as Quality)) : tierList)
      item(t.id, t.label, t.locked ? "🔒 自动回退" : "");

    if (el.classList.contains("q-open")) syncSel();
  }

  async function initQuality() {
    try {
      const t = await getStreamTiers();
      // 档位表以后端为准（dts/atmosdb/vinyl 已在后端裁撤：dtsx tag ffmpeg 不识别、
      // AC-4 播放端无解码器、黑胶从未放行——见 typhoeus/quality.go 裁撤注释）
      // ?? [] 兜底：sidecar 残了回 {code:0,data:{}} 时不让 for..of undefined 炸穿渲染层
      tierList = t.all_tiers ?? [];
    } catch {
      tierList = Object.entries(QUALITIES).map(([id, label]) => ({ id, label }));
    }

    qReady = true;
    buildQPop();
    paintQ();
  }

  qBtn.onclick = () => {
    if (!qReady) return void initQuality();
    const open = el.classList.toggle("q-open");

    if (open) syncSel();
  };

  void initQuality();

  // 滚轮在 Bar 上 = 微调音量。音质/播放模式浮窗例外：
  // 浮窗上把滚轮还给菜单自身的 overflow-y 滚动（这里 preventDefault 会杀掉原生滚动）；
  // 胶囊/按钮上无内容可滚也不该动音量，吞掉即可（.frame overflow:hidden，吞掉不会漏滚页面）。
  el.addEventListener("wheel", (e) => {
    const t = e.target as HTMLElement;

    if (t.closest("#pb-qpop, #pb-lpop")) return;
    e.preventDefault();

    if (t.closest("#pb-quality, #pb-loop")) return;
    player.setVolume(player.volume - Math.sign(e.deltaY) * 0.04);
  }, { passive: false });

  // —— 整条拖拽 seek：pointerdown 于 Bar 任意非控件处起拖；拖中只做视觉预览，松手提交 ——
  let dragging = false;
  let scrubFrac = 0;

  const fracOf = (clientX: number) => {
    const r = el.getBoundingClientRect(); // fill 贴紧 border 内侧两端：坐标映射同几何（1px 内缩）

    return clamp01((clientX - r.left - 1) / (r.width - 2));
  };

  const paintScrub = () => {
    el.style.setProperty("--pf", String(scrubFrac)); // 无单位：fill 宽度 = calc((100% - 2px) * --pf)
    time.textContent = `${fmtDur(scrubFrac * player.duration)} / ${fmtDur(player.duration)}`;
  };

  el.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;

    if (t.closest("button, input, .pb-volpop, .pb-qpop, .pb-lpop")) return; // 控件区不吞点击

    if (!player.duration) return;
    dragging = true;
    el.classList.add("scrubbing");

    try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件降级 */ }

    scrubFrac = fracOf(e.clientX);
    paintScrub();
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    scrubFrac = fracOf(e.clientX);
    paintScrub();
  });

  const endScrub = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("scrubbing");
    player.seek(scrubFrac * player.duration);
    player.seekSettled();
  };

  el.addEventListener("pointerup", endScrub);
  el.addEventListener("pointercancel", endScrub);

  // 音量浮窗绘制（滑杆填充 --v + 图标档位 + 读数）；图标 innerHTML 按档位守卫
  let lastVolIcon = "";

  function paintVol() {
    const v = volEditing ? Number(vol.value) / 100 : player.muted ? 0 : player.volume;
    vol.style.setProperty("--v", `${Math.round(v * 100)}%`);
    const num = `${Math.round(v * 100)}%`;

    if (volnum.textContent !== num) volnum.textContent = num;
    vol.classList.toggle("off", player.muted || v === 0);
    const ic = player.muted || v === 0 ? icons.volMute : v < 0.5 ? icons.volLow : v < 0.99 ? icons.volMid : icons.volHigh;

    if (ic !== lastVolIcon) {
      lastVolIcon = ic;
      mute.innerHTML = ic;
      mute2.innerHTML = ic;
    }

    mute.classList.toggle("on", player.muted);
    mute2.classList.toggle("on", player.muted);
  }

  // 进度条染色已移交 lib/tint.ts（全应用唯一的染色来源，:root 上的 --cvg-bar-fill / --cvg-bar-line）。
  // 原先这里自己从封面取色，等于绕过「高亮颜色」设置 —— 选了固定青色，界面高亮变了、进度条还在跟封面跑。

  // 订阅状态。notify 是 ~4Hz 的位置广播：所有 DOM 写入先比对签名再落，
  // 否则每帧重建 <img>/SVG 会反复触发图片重解码与 GC，把 V8 堆顶在高位。
  let lastTitle = "", lastSub = "", lastCover = "", lastPlaySig = "", lastLoop = "", lastLove = "", lastErr = "";
  let lastCanPrev: boolean | null = null;
  let lastRadioUi: boolean | null = null;
  let lastMarkKey: string | undefined;
  player.on(() => {
    const s = player.current;
    const titleText = s ? songTitle(s) : "未在播放";

    if (titleText !== lastTitle) { title.textContent = titleText; lastTitle = titleText; }

    // 错误条与歌手行共用 sub：签名含错误文案，出现/变化/消失各重画一次
    const singerLine = s ? (s.singer ?? []).map((x) => x.name).join(" / ") : "点一首歌试试";
    const subSig = player.error && !player.loading ? "ERR:" + player.error : singerLine;

    if (subSig !== lastSub) {
      lastSub = subSig;

      if (player.error && !player.loading) {
        const e = document.createElement("i");
        e.className = "pb-err";
        e.textContent = player.error;
        sub.innerHTML = "";
        sub.append(e);
      } else sub.innerHTML = singerLine;
    }

    const pic = s ? coverUrl(s, 150) : "";

    if (pic !== lastCover) { lastCover = pic; cover.innerHTML = pic ? `<img src="${pic}" alt=""/>` : ""; }

    // 中央按钮三态：取链/缓冲=spinner（点击=取消）；出错=重试图标；常规=播放/暂停
    el.classList.toggle("loading", player.loading);
    const playSig = player.loading ? "load" : player.error ? "err" : player.playing ? "play" : "pause";

    if (playSig !== lastPlaySig) {
      lastPlaySig = playSig;
      play.innerHTML = player.loading ? icons.spinner : player.error ? icons.retry : player.playing ? icons.pause : icons.play;
      play.dataset.tooltip = player.loading ? "加载中，点击取消" : player.error ? "加载失败，点击重试" : "播放/暂停";
      play.setAttribute("aria-label", play.dataset.tooltip);
    }

    paintQ();
    const canPrev = player.canPrev;

    if (canPrev !== lastCanPrev) {
      lastCanPrev = canPrev;
      prev.disabled = !canPrev;
      prev.dataset.tooltip = canPrev ? "上一首" : "无限电台只向前播放";
      prev.setAttribute("aria-label", prev.dataset.tooltip);
    }

    if (player.radioActive !== lastRadioUi) {
      lastRadioUi = player.radioActive;
      queueBtn.hidden = player.radioActive;
      queueBtn.disabled = player.radioActive;
      queueBtn.dataset.tooltip = "播放队列";
      queueBtn.setAttribute("aria-label", queueBtn.dataset.tooltip);

      if (player.radioActive) closeLPop();
    }

    // 播放模式按钮：随机开 → 随机图标；关 → 当前循环档图标。
    // 签名含 shuffle / 电台态：只切随机或进出电台时也得重画（图标与禁用态换了）。
    const loopSig = `${player.mode}|${player.shuffle}|${player.radioActive ? "radio" : "normal"}`;

    if (loopSig !== lastLoop) {
      lastLoop = loopSig;
      const loopName = player.mode === "all" ? "列表循环" : "单曲循环";
      loop.innerHTML = player.shuffle ? icons.shuffle : player.mode === "all" ? icons.loopAll : icons.loopOne;
      loop.disabled = player.radioActive;
      // 「列表循环」与「单曲循环」的图形只差一个 9px 的「1」，光看图标分不出来 —— 模式名
      // 挂 data-tooltip / aria-label；自绘层认 data-tooltip，运行时更新不会回退原生提示。
      const shufNote = player.shuffle ? "随机播放 开" : "随机播放 关";
      loop.dataset.tooltip = player.radioActive ? "循环模式" : `${loopName} · ${shufNote}`;
      loop.setAttribute("aria-label", loop.dataset.tooltip);

      if (el.classList.contains("lp-open")) syncLPop();
    }

    const loveSig = (s?.mid ?? "") + (s && player.loved.has(s.mid) ? "1" : "0");

    if (loveSig !== lastLove) {
      lastLove = loveSig;
      love.innerHTML = s && player.loved.has(s.mid) ? icons.heartFill : icons.heart;
      love.classList.toggle("on", !!s && player.loved.has(s.mid));
    }

    // 画廊模式按钮点亮 = 正在播放页正处于全屏画廊会话
    const galleryOn = player.gallery && player.expanded;
    gallery.classList.toggle("on", galleryOn);
    const galleryTip = galleryOn ? "退出画廊模式" : player.current ? "画廊模式" : "画廊模式（先播放一首歌）";

    if (gallery.dataset.tooltip !== galleryTip) {
      gallery.dataset.tooltip = galleryTip;
      gallery.setAttribute("aria-label", galleryTip);
      gallery.setAttribute("aria-pressed", String(galleryOn));
    }

    if (!dragging) {
      const d = player.duration, t = player.time;
      const frac = player.current && d ? Math.min(1, t / d) : 0; // 无当前曲：分数归零，染色条不残留
      el.style.setProperty("--pf", String(frac));
      time.textContent = `${fmtDur(t)} / ${fmtDur(d)}`;
    }

    if (!volEditing) vol.value = String(Math.round((player.muted ? 0 : player.volume) * 100));
    const muteTip = player.muted ? "取消静音" : "静音";

    if (mute.dataset.tooltip !== muteTip) {
      mute.dataset.tooltip = muteTip;
      mute.setAttribute("aria-label", muteTip);
    }

    if (mute2.dataset.tooltip !== muteTip) {
      mute2.dataset.tooltip = muteTip;
      mute2.setAttribute("aria-label", muteTip);
    }

    paintVol();

    // 行高亮只需在换曲时重扫（视图重画处会显式调 markActive，见 views/songs）；
    // 音质浮窗同刻重建：列表只含新歌有源的档位（见 buildQPop）
    if (s?.mid !== lastMarkKey) { lastMarkKey = s?.mid; player.markActive(); buildQPop(); }
  });

  return el;
}
