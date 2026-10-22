// Quaver — 顶部搜索框（常驻壳层组件，不随视图切换重建）
// 挂在内容区顶带 .content-top（独立一行，与 CSD 按钮簇同带、右缘由该带预留避让位）：renderRoute() 只重建
// #route，本组件 DOM/输入状态/联想面板在整个会话内保持不变；顶带不与页面标题同带，窄窗口下互不遮挡。
// 交互：输入即联想（/search/complete，debounce）；Enter 或点联想词 → #/search?keyword=…
//       视图内点任意联想词 = 按歌名直搜（服务端结果词面一致，忽略客户端高亮标签）。
import { api } from "../lib/api";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const untag = (s: string) => s.replace(/<\/?em>/gi, "");

const HISTORY_KEY = "quaver.search.history.v1";
const HISTORY_MAX = 10;

export function readHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");

    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  } catch {
    return [];
  }
}

export function pushHistory(kw: string) {
  const k = kw.trim();

  if (!k) return;
  const list = [k, ...readHistory().filter((x) => x !== k)].slice(0, HISTORY_MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

interface Suggest {
  kind: "song" | "singer" | "songlist" | "album" | "custom" | "history" | "hot";
  label: string; // 展示文本（纯文本；联想接口高亮标签已剥离）
  keyword: string; // 点选后实际搜索词
}

const KIND_ICON: Record<Suggest["kind"], string> = {
  song: "♪",
  singer: "🎤",
  songlist: "☰",
  album: "◈",
  custom: "🔍",
  history: "↺",
  hot: "🔥",
};

export function SearchBox(): HTMLElement {
  const box = document.createElement("div");
  box.className = "searchbar";
  box.innerHTML = `
    <span class="sb-field">
      <span class="sb-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg></span>
      <input id="q" type="search" placeholder="搜索歌曲、歌手、歌单…" autocomplete="off" spellcheck="false" aria-label="搜索" />
    </span>
    <div id="drop" class="sb-drop" hidden></div>`;
  const input = box.querySelector<HTMLInputElement>("#q")!;
  const drop = box.querySelector<HTMLElement>("#drop")!;

  let seq = 0; // 联想请求竞态：只渲染最后一次
  let items: Suggest[] = [];
  let hi = -1; // 键盘高亮 index
  let debounce = 0;

  const close = () => {
    drop.hidden = true;
    hi = -1;
  };

  function renderDrop() {
    if (!items.length) return close();
    drop.innerHTML = items
      .map((x, i) => `<button class="sb-item${i === hi ? " hi" : ""}" data-i="${i}" type="button">
          <span class="sb-kind">${KIND_ICON[x.kind]}</span><span class="sb-label">${esc(x.label)}</span>
        </button>`)
      .join("");
    drop.hidden = false;
    drop.querySelectorAll<HTMLElement>(".sb-item").forEach((b) => {
      b.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 别让 blur 先关掉面板
        const it = items[+b.dataset.i!];
        submit(it.keyword);
      });
    });
  }

  async function suggest() {
    if (document.activeElement !== input) return; // 失焦后迟到的 debounce：不再弹出面板
    const kw = input.value.trim();

    if (!kw) {
      const hist = readHistory().map((k): Suggest => ({ kind: "history", label: k, keyword: k }));

      if (!hist.length) return close();
      items = hist;

      return renderDrop();
    }

    const my = ++seq;

    try {
      const d: any = await api(`/search/complete?keyword=${encodeURIComponent(kw)}`);

      if (my !== seq) return;
      const mapped: Suggest[] = [];

      for (const x of d?.items ?? []) {
        const label = untag(String(x.hint ?? ""));

        if (!label) continue;
        const type = Number(x.type ?? 0);
        const kind: Suggest["kind"] = type === 1 ? "singer" : type === 3 ? "songlist" : type === 2 ? "album" : "song";
        mapped.push({ kind, label, keyword: label });
      }

      if (mapped[0]?.keyword !== kw) mapped.unshift({ kind: "custom", label: kw, keyword: kw });
      items = mapped.slice(0, 8);
    } catch {
      if (my !== seq) return;
      items = [{ kind: "custom", label: kw, keyword: kw }];
    }

    renderDrop();
  }

  function submit(kw: string) {
    const k = kw.trim();

    if (!k) return;
    pushHistory(k);
    input.value = k;
    close();
    input.blur();
    location.hash = `#/search?keyword=${encodeURIComponent(k)}`;
  }

  input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(suggest, 220);
  });
  input.addEventListener("focus", suggest);
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(hi >= 0 && items[hi] ? items[hi].keyword : input.value);
    } else if (e.key === "Escape") {
      close();
      input.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (drop.hidden) return;
      e.preventDefault();
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      renderDrop();
    }
  });

  return box;
}
