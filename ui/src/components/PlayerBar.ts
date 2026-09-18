// 底部播放条（常驻壳层）：Verse PlayerBar 结构（v-player），逻辑沿用 player。
// 进度 = 上边框 rail（2px，悬停 4px + 拇指），控制组左侧显示当前时间 / 总时长。
// 右组 = 音质扩展（outline tag 按钮 + 共用右下浮窗 FloatWindow）· 队列 · 音量（mute + 内联 volume slider）。
import { player } from "../player";
import { coverUrl, getLastStream, getStreamTiers, getSessionQuality, effectiveQuality, QUALITY_SHORT, QUALITIES, type Quality } from "../lib/api";
import { icon } from "../verse/icons";
import { formatTime } from "../verse/format";
import { FloatWindow } from "./FloatWindow";

const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const clamp01 = (f: number) => Math.max(0, Math.min(1, f));

export function PlayerBar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "v-player";
  el.id = "player-bar";
  el.innerHTML = `
    <div class="v-player__rail" id="pb-rail" role="slider" tabindex="0" aria-label="播放进度"
      aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="--:-- / --:--">
      <div class="v-player__fill" id="pb-fill" style="width: 0%"></div>
      <div class="v-player__knob" id="pb-knob" style="left: 0%"></div>
    </div>
    <div class="v-player__now">
      <img class="v-player__cover" id="pb-cover-img" src="${TRANSPARENT}" alt="">
      <div class="v-player__meta">
        <div class="v-player__title" id="pb-title">未在播放</div>
        <div class="v-player__artist" id="pb-sub">点一首歌试试</div>
      </div>
      <button type="button" class="v-iconbtn v-iconbtn--sm" id="pb-love" aria-label="收藏" title="收藏"></button>
    </div>
    <div class="v-player__center"><div class="v-player__transport">
      <div class="v-player__transport-side v-player__transport-side--before">
        <span class="v-player__time" id="pb-time" aria-hidden="true">--:-- / --:--</span>
        <button type="button" class="v-iconbtn" id="pb-prev" aria-label="上一首" title="上一首">${icon("prev")}</button>
      </div>
      <button type="button" class="v-iconbtn v-iconbtn--lg v-iconbtn--play" id="pb-play" aria-label="播放" title="播放"></button>
      <div class="v-player__transport-side v-player__transport-side--after">
        <button type="button" class="v-iconbtn" id="pb-next" aria-label="下一首" title="下一首">${icon("next")}</button>
        <button type="button" class="v-iconbtn v-iconbtn--sm" id="pb-loop" aria-label="循环模式" title="循环模式"></button>
      </div>
    </div></div>
    <div class="v-player__right">
      <button type="button" class="v-tag v-tag--outline v-tagbtn" id="pb-quality" aria-haspopup="dialog" aria-expanded="false" title="音质（本会话生效，不保存）">…</button>
      <button type="button" class="v-iconbtn v-iconbtn--sm" id="pb-queue" aria-label="播放列表" aria-expanded="false" title="播放列表">${icon("list", 16)}</button>
      <button type="button" class="v-iconbtn v-iconbtn--sm" id="pb-mute" aria-label="音量 / 静音" title="音量 / 静音"></button>
      <div class="v-slider v-slider--volume" id="pb-volwrap">
        <div class="v-slider__rail" id="pb-volrail" role="slider" tabindex="0" aria-label="音量"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="80">
          <div class="v-slider__track"></div>
          <div class="v-slider__fill" id="pb-volfill" style="width: 80%"></div>
          <div class="v-slider__thumb" id="pb-volthumb" style="left: 80%"></div>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const rail = $("pb-rail"), fill = $("pb-fill"), knob = $("pb-knob"), time = $("pb-time");
  const coverImg = el.querySelector<HTMLImageElement>("#pb-cover-img")!;
  const title = $("pb-title"), sub = $("pb-sub");
  const play = $("pb-play"), loop = $("pb-loop"), love = $("pb-love");
  const queueBtn = $<HTMLButtonElement>("pb-queue");
  const mute = $("pb-mute");
  const volRail = $("pb-volrail"), volFill = $("pb-volfill"), volThumb = $("pb-volthumb");

  // 时间读数是绝对定位（.v-player__transport-side--before），窗口变窄时先压住爱心、再压住歌名/歌手。
  // 压到爱心就 display:none 掉 meta（爱心左靠到封面旁，永远可点）。隐藏态下爱心仍可量，
  // 用隐藏前爱心的右缘（zoneRight）继续判断；恢复显示要多留 8px 间隙（迟滞，防边界抖动）。
  let zoneRight = 0;
  let lastTitle = "", lastSub = "";
  const updateOverlap = () => {
    const t = time.getBoundingClientRect();
    if (t.width <= 0) return;
    if (el.classList.contains("is-meta-hidden")) {
      if (zoneRight > 0 && t.left > zoneRight + 8) el.classList.remove("is-meta-hidden");
      return;
    }
    const lr = love.getBoundingClientRect();
    if (lr.width > 0) zoneRight = lr.right;
    el.classList.toggle("is-meta-hidden", lr.width > 0 && t.left < lr.right && t.right > lr.left);
  };
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => updateOverlap());
    ro.observe(el);
    ro.observe(love);
    ro.observe(time);
  }

  // 封面点击 = 展开/收起正在播放页（无歌时强制回退，防卡死）
  coverImg.style.cursor = "pointer";
  coverImg.onclick = () => {
    if (!player.current) { player.expanded = false; player.notifyPublic(); return; }
    player.expanded = !player.expanded;
    player.notifyPublic();
  };

  $("pb-prev").onclick = () => player.prev();
  play.onclick = () => player.toggle();
  $("pb-next").onclick = () => player.next(false);
  loop.onclick = () => player.cycleMode();
  love.onclick = () => player.toggleLove(player.current);
  queueBtn.onclick = () => { player.queueOpen = !player.queueOpen; player.notifyPublic(); };
  mute.onclick = () => player.toggleMute();

  // —— 进度 rail：拖拽 seek（只做视觉预览，松手提交）；键盘 ←/→ 5 秒、Home/End ——
  let dragging = false;
  let scrubFrac = 0;
  const fracOf = (clientX: number) => {
    const r = rail.getBoundingClientRect();
    return clamp01((clientX - r.left) / Math.max(1, r.width));
  };
  const paintRail = (frac: number) => {
    const pct = `${(frac * 100).toFixed(2)}%`;
    fill.style.width = pct;
    knob.style.left = pct;
    const d = player.duration || 0;
    rail.setAttribute("aria-valuemax", String(Math.round(d)));
    rail.setAttribute("aria-valuenow", String(Math.round(frac * d)));
    rail.setAttribute("aria-valuetext", `${formatTime(frac * d)} / ${formatTime(d)}`);
    time.textContent = player.current
      ? `${formatTime(frac * d)} / ${formatTime(d)}`
      : "--:-- / --:--";
    updateOverlap();
  };
  rail.addEventListener("pointerdown", (e) => {
    if (!player.duration) return;
    dragging = true;
    try { rail.setPointerCapture(e.pointerId); } catch { /* 合成事件降级 */ }
    scrubFrac = fracOf(e.clientX);
    paintRail(scrubFrac);
    e.preventDefault();
  });
  rail.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    scrubFrac = fracOf(e.clientX);
    paintRail(scrubFrac);
  });
  const endScrub = () => {
    if (!dragging) return;
    dragging = false;
    player.seek(scrubFrac * player.duration);
  };
  rail.addEventListener("pointerup", endScrub);
  rail.addEventListener("pointercancel", endScrub);
  rail.addEventListener("keydown", (e) => {
    if (!player.duration) return;
    const t = player.time;
    if (e.key === "ArrowLeft") { e.preventDefault(); player.seek(t - 5); }
    else if (e.key === "ArrowRight") { e.preventDefault(); player.seek(t + 5); }
    else if (e.key === "Home") { e.preventDefault(); player.seek(0); }
    else if (e.key === "End") { e.preventDefault(); player.seek(player.duration); }
  });

  // —— 音量 slider：点击/拖拽 + 键盘；滚轮在 Bar 上微调 ——
  const paintVolSlider = (v: number) => {
    const pct = `${Math.round(v * 100)}%`;
    volFill.style.width = pct;
    volThumb.style.left = pct;
    volRail.setAttribute("aria-valuenow", String(Math.round(v * 100)));
    volRail.setAttribute("aria-valuetext", pct);
  };
  const volOf = (clientX: number) => {
    const r = volRail.getBoundingClientRect();
    return clamp01((clientX - r.left) / Math.max(1, r.width));
  };
  let volDrag = false;
  volRail.addEventListener("pointerdown", (e) => {
    volDrag = true;
    try { volRail.setPointerCapture(e.pointerId); } catch { /* 合成事件降级 */ }
    player.setVolume(volOf(e.clientX));
    e.preventDefault();
  });
  volRail.addEventListener("pointermove", (e) => { if (volDrag) player.setVolume(volOf(e.clientX)); });
  const endVol = () => { volDrag = false; };
  volRail.addEventListener("pointerup", endVol);
  volRail.addEventListener("pointercancel", endVol);
  volRail.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); player.setVolume(player.volume - 0.05); }
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); player.setVolume(player.volume + 0.05); }
    else if (e.key === "Home") { e.preventDefault(); player.setVolume(0); }
    else if (e.key === "End") { e.preventDefault(); player.setVolume(1); }
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    player.setVolume(player.volume - Math.sign(e.deltaY) * 0.04);
  }, { passive: false });

  // —— 音质：会话级档位（不持久化），永远带 Fallback 协商 ——
  const qBtn = $<HTMLButtonElement>("pb-quality");
  const qWin: FloatWindow = FloatWindow({
    id: "pb-qpop",
    title: "音质",
    trigger: qBtn,
    dismissOnOutside: [qBtn],
    onRequestClose: () => qWin.setOpen(false),
  });
  const qPop = qWin.body;
  qPop.setAttribute("role", "menu");
  qPop.setAttribute("aria-label", "音质");
  let tierList: { id: string; label: string; locked?: number | boolean }[] = [];
  let qReady = false;
  const cur = () => effectiveQuality();
  const closeQPop = () => qWin.setOpen(false);
  function paintQ() {
    if (!qReady) { qBtn.textContent = "…"; qBtn.disabled = true; return; }
    qBtn.disabled = false;
    const ls = getLastStream();
    const want = getSessionQuality();
    const label = player.current && ls
      ? (ls.degraded ? "↓" : "") + (QUALITY_SHORT[ls.tier] ?? ls.label)
      : (QUALITY_SHORT[want ?? effectiveQuality()] ?? "音质");
    qBtn.textContent = label;
    qBtn.title = want
      ? `音质：${label}（本会话选择，不保存；关窗后回到设置页默认）`
      : "音质（点此切换，仅本会话生效不保存；高档不可及时自动回退到可播档）";
    if (!qWin.open) return;
    (qPop as any)._repaint?.();
  }
  function buildQPop() {
    qPop.innerHTML = "";
    const item = (id: string, label: string, note = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "v-menu__item";
      b.dataset.q = id;
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", cur() === id ? "true" : "false");
      b.innerHTML = `<span>${label}</span>${note ? `<span class="v-tag v-tag--outline">${note}</span>` : ""}`;
      b.onclick = () => {
        player.switchQuality(id as Quality | "auto");
        closeQPop();
      };
      qPop.append(b);
      return b;
    };
    const paintItems = () => {
      qPop.querySelectorAll<HTMLElement>(".v-menu__item").forEach((x) => {
        const on = x.dataset.q === cur();
        x.classList.toggle("sel", on);
        x.setAttribute("aria-checked", String(on));
        x.querySelector(".v-menu__check")?.remove();
        if (on) x.insertAdjacentHTML("beforeend", icon("check", 14).replace('class="v-icon"', 'class="v-icon v-menu__check"'));
      });
    };
    item("auto", "自动", "最高可播");
    for (const t of tierList) item(t.id, t.label, t.locked ? "VIP" : "");
    const note = document.createElement("p");
    note.className = "v-menu__note";
    note.textContent = "仅本会话生效，高档不可播时自动回退到可播档";
    qPop.append(note);
    (qPop as any)._repaint = paintItems;
    paintItems();
  }
  async function initQuality() {
    try {
      const t = await getStreamTiers();
      tierList = t.all_tiers;
    } catch {
      tierList = Object.entries(QUALITIES).map(([id, label]) => ({ id, label }));
    }
    qReady = true;
    buildQPop();
    paintQ();
  }
  qBtn.onclick = () => {
    if (!qReady) return void initQuality();
    qWin.setOpen(!qWin.open); // 打开时共用浮窗会请队列窗收起（互斥）
    paintQ();
  };
  void initQuality();

  // 状态绘制既用于首帧，也用于后续播放器通知。
  // Player.on 只订阅未来变化，不会回放当前状态，因此组件必须主动绘制一次。
  const paint = () => {
    const s = player.current;
    title.textContent = s?.name ?? "未在播放";
    title.classList.toggle("is-err", !!player.error && !player.loading);
    if (player.error && !player.loading) {
      sub.textContent = String(player.error);
      sub.classList.add("is-err");
    } else {
      sub.textContent = s ? (s.singer ?? []).map((x) => x.name).join(" / ") : "点一首歌试试";
      sub.classList.remove("is-err");
    }
    // 文案变了（切歌/报错/恢复）→ 先恢复显示，再用新几何重判，避免 ghost 几何过期把 meta 卡在隐藏态
    if (title.textContent !== lastTitle || sub.textContent !== lastSub) {
      lastTitle = title.textContent ?? "";
      lastSub = sub.textContent ?? "";
      el.classList.remove("is-meta-hidden");
    }
    coverImg.src = s ? coverUrl(s, 150) : TRANSPARENT;
    // 中央播放键：取链/缓冲中 pulse；常规按播放态切实心图标
    play.classList.toggle("is-loading", player.loading);
    play.innerHTML = icon(player.loading || (!player.playing && !player.error) ? "play" : player.playing ? "pause" : "play", 24);
    play.setAttribute("aria-label", player.loading ? "加载中，点击取消" : player.error ? "加载失败，点击重试" : player.playing ? "暂停" : "播放");
    paintQ();
    // 循环三态：off=常态 repeat；all=持续开启；one=持续开启 + 角标 1（颜色 Founded 不单独表意，aria 区分）
    loop.innerHTML = icon("repeat", 16);
    loop.classList.toggle("v-iconbtn--on", player.mode !== "off");
    loop.dataset.mode = player.mode === "one" ? "one" : "";
    loop.setAttribute("aria-label", player.mode === "one" ? "单曲循环" : player.mode === "all" ? "列表循环" : "循环关");
    loop.title = loop.getAttribute("aria-label")!;
    const loved = !!s && player.loved.has(s.mid);
    love.innerHTML = icon(loved ? "heartOn" : "heart", 16);
    love.classList.toggle("v-iconbtn--on", loved);
    love.setAttribute("aria-label", loved ? "取消收藏" : "收藏");
    if (!dragging) {
      const d = player.duration, t = player.time;
      paintRail(player.current && d ? Math.min(1, t / d) : 0);
    }
    const v = player.muted ? 0 : player.volume;
    if (!volDrag) paintVolSlider(v);
    mute.innerHTML = icon(player.muted || v === 0 ? "mute" : "volume", 16);
    mute.classList.toggle("v-iconbtn--on", player.muted);
    queueBtn.setAttribute("aria-expanded", String(player.queueOpen));
    updateOverlap();
    player.markActive();
  };
  player.on(paint);
  paint();
  return el;
}
