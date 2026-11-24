// Quaver — 听歌识曲弹窗：系统声音/麦克风采集 → AFP 指纹 → 网易云匹配 → QQ 候选展示。
import { recognizeAudio, type RecognitionPhase, type RecognitionSource } from "../lib/song-recognition";
import { recognitionSong, type RecognitionSong } from "../lib/recognition-candidate";
import { escHtml, coverUrl, songTitle, upPic } from "../lib/api";
import { icons } from "../lib/icons";
import { playNowWithToast } from "./SongMenu";
import { player } from "../player";

const PHASE_TEXT: Record<RecognitionPhase, string> = {
  idle: "准备识别",
  capturing: "正在聆听…",
  fingerprinting: "计算指纹…",
  matching: "匹配歌曲…",
  done: "识别完成",
  error: "识别失败",
};

const SOURCE_LABEL: Record<RecognitionSource, string> = {
  system: "系统声音",
  microphone: "麦克风",
};

/** 识曲弹窗只保留一份；重复触发复用同一实例 */
let dialog: { root: HTMLElement; close: () => void } | null = null;

/** 使用现有播放链路；只有拿到 QQ song mid 才直接播放，否则跳 QQ 搜索。 */
function playCandidate(candidate: RecognitionSong): void {
  if (candidate.song.mid) {
    playNowWithToast(candidate.song);

    return;
  }

  location.hash = `#/search?keyword=${encodeURIComponent(candidate.keyword || candidate.song.name)}`;
}

/** 识曲候选行 */
function candidateHtml(candidate: RecognitionSong, cover: string, index: number): string {
  const art = cover || coverUrl(candidate.song, 300);

  return `
    <button class="rec-item" type="button" data-rec="${index}">
      <span class="rec-art">${art ? `<img src="${escHtml(art)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <span class="rec-meta">
        <span class="rec-title">${escHtml(songTitle(candidate.song))}</span>
        <span class="rec-artist">${escHtml((candidate.song.singer ?? []).map((a) => a.name).join(" / "))}</span>
      </span>
      <span class="rec-play" aria-hidden="true">${icons.play}</span>
    </button>`;
}

export function openSongRecognition(): void {
  if (dialog) return;

  const root = document.createElement("div");
  root.className = "upd-overlay";
  root.innerHTML = `
    <div class="upd-dialog rec-panel" role="dialog" aria-modal="true" aria-label="听歌识曲">
      <div class="upd-head">
        <h3>听歌识曲 <span class="upd-badge">Recognition</span></h3>
        <span class="muted upd-meta">用系统声音或麦克风采集 8 秒，本地计算指纹后匹配歌曲。</span>
      </div>
      <div class="upd-notes rec-body">
        <div class="rec-stage" aria-live="polite">
          <div class="rec-ring"><span></span><span></span><span></span></div>
          <p class="rec-status">准备识别</p>
        </div>
        <div class="rec-sources" role="group" aria-label="声音来源">
          <button class="rec-source" type="button" data-source="system" aria-pressed="true">
            <span>系统声音</span>
            <small>正在播放的音频</small>
          </button>
          <button class="rec-source" type="button" data-source="microphone" aria-pressed="false">
            <span>麦克风</span>
            <small>周围环境的声音</small>
          </button>
        </div>
        <div class="rec-results" hidden></div>
      </div>
      <div class="upd-foot rec-foot">
        <span class="muted rec-note">音频只在本机转成指纹，指纹仅用于匹配歌曲。</span>
        <span class="upd-spacer"></span>
        <button class="ghost-btn rec-dismiss" type="button">关闭</button>
        <button class="ghost-btn rec-cancel" type="button" hidden>取消</button>
        <button class="upd-primary rec-start" type="button">开始识别</button>
      </div>
    </div>`;
  document.body.append(root);

  const status = root.querySelector<HTMLElement>(".rec-status")!;
  const start = root.querySelector<HTMLButtonElement>(".rec-start")!;
  const cancel = root.querySelector<HTMLButtonElement>(".rec-cancel")!;
  const dismiss = root.querySelector<HTMLButtonElement>(".rec-dismiss")!;
  const results = root.querySelector<HTMLElement>(".rec-results")!;
  const stage = root.querySelector<HTMLElement>(".rec-stage")!;
  const sources = root.querySelector<HTMLElement>(".rec-sources")!;
  const sourceButtons = [...root.querySelectorAll<HTMLButtonElement>(".rec-source")];
  const controller = new AbortController();
  let source: RecognitionSource = "system";
  let closing = false;

  function close() {
    if (closing) return;

    closing = true;
    controller.abort();
    document.removeEventListener("keydown", onKeyDown);
    dialog = null;

    // 与更新/Credits 弹窗同一套离场门闩：动画播完再摘节点，reduced-motion 靠超时兜底。
    const fin = () => root.remove();

    root.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    root.classList.add("leaving");
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") close();
  }

  const paintPhase = (phase: RecognitionPhase) => {
    status.textContent = phase === "capturing" ? `正在聆听${SOURCE_LABEL[source]}…` : PHASE_TEXT[phase] ?? PHASE_TEXT.idle;
    stage.classList.toggle("busy", phase === "capturing" || phase === "fingerprinting" || phase === "matching");
    sources.hidden = phase !== "idle";
    start.hidden = phase !== "idle" && phase !== "done";
    start.textContent = phase === "done" ? "重新识别" : "开始识别";
    cancel.hidden = phase === "idle" || phase === "done";
    dismiss.hidden = phase !== "idle" && phase !== "done";
    results.hidden = phase !== "done";
  };

  for (const button of sourceButtons) {
    button.addEventListener("click", () => {
      source = button.dataset.source === "microphone" ? "microphone" : "system";

      for (const item of sourceButtons) item.setAttribute("aria-pressed", String(item === button));
    });
  }

  dismiss.addEventListener("click", close);
  cancel.addEventListener("click", close);
  root.addEventListener("mousedown", (event) => { if (event.target === root) close(); });
  document.addEventListener("keydown", onKeyDown);

  start.addEventListener("click", () => {
    if (controller.signal.aborted) return;
    results.innerHTML = "";
    const resumePlayback = !player.paused && !!player.current;

    if (resumePlayback) player.pause();
    void (async () => {
      try {
        const r = await recognizeAudio(controller.signal, paintPhase, source);

        if (closing) return;

        if (r.phase === "error") {
          paintPhase("idle");
          status.textContent = r.message;

          return;
        }

        paintPhase("done");

        const candidates = r.candidates.map((candidate, index) => ({
          ...recognitionSong(candidate, index),
          cover: upPic(candidate.cover ?? ""),
        }));

        if (!candidates.length) {
          status.textContent = "没有识别到结果";

          return;
        }

        results.innerHTML = candidates.map((candidate, index) => candidateHtml(candidate, candidate.cover, index)).join("");
        results.querySelectorAll<HTMLElement>(".rec-item").forEach((button) => {
          const candidate = candidates[Number(button.dataset.rec ?? "-1")];

          if (candidate) {
            button.addEventListener("click", () => {
              close();
              playCandidate(candidate);
            });
          }
        });
      } finally {
        if (resumePlayback) player.resume();
      }
    })().catch((error) => {
      if (closing) return;
      paintPhase("idle");

      // SAFETY: catch 边界只读取错误 message，不信任其余字段
      const message = (error as Error)?.message;

      status.textContent = String(message ?? error ?? "识别失败");
    });
  });

  dialog = { root, close };
  start.focus();
}
