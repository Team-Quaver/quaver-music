// 顶部搜索框（常驻标题栏，不随视图切换重建）。
// Verse SearchInput 结构（v-search）+ 下拉建议（v-menu，由 verse-app.css 提供）。
// 交互：输入即联想（/search/complete，debounce）；Enter 或点联想词 → #/search?keyword=…
import { api } from "../lib/api";
import { icon, type IconName } from "../verse/icons";

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

// 联想类型 → Verse 图标（不用 emoji：列表密度下是噪声）
const KIND_ICON: Record<Suggest["kind"], IconName> = {
  song: "lyrics",
  singer: "discover",
  songlist: "list",
  album: "library",
  custom: "search",
  history: "repeat",
  hot: "heartOn",
};

export function SearchBox(): HTMLElement {
  const box = document.createElement("div");
  box.className = "v-search";
  box.style.width = "320px";
  box.innerHTML = `
    ${icon("search", 16)}
    <input id="q" type="text" placeholder="搜索歌曲、歌手、专辑" autocomplete="off" spellcheck="false" aria-label="搜索" />
    <button type="button" class="v-iconbtn v-iconbtn--sm v-search__clear" id="q-clear" aria-label="清空" title="清空" hidden>${icon("close", 14)}</button>
    <div id="drop" class="v-menu v-search__drop" hidden></div>`;
  const input = box.querySelector<HTMLInputElement>("#q")!;
  const clear = box.querySelector<HTMLButtonElement>("#q-clear")!;
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
      .map((x, i) => `<button class="v-menu__item${i === hi ? " hi" : ""}" data-i="${i}" type="button" role="option" aria-selected="${i === hi}">
          <span class="v-menu__icon">${icon(KIND_ICON[x.kind], 16)}</span><span class="ellipsis">${esc(x.label)}</span>
        </button>`)
      .join("");
    drop.hidden = false;
    drop.querySelectorAll<HTMLElement>(".v-menu__item").forEach((b) => {
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
    clear.hidden = false;
    close();
    input.blur();
    location.hash = `#/search?keyword=${encodeURIComponent(k)}`;
  }

  input.addEventListener("input", () => {
    clear.hidden = input.value === "";
    window.clearTimeout(debounce);
    debounce = window.setTimeout(suggest, 220);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    close();
    input.focus();
  });
  input.addEventListener("focus", suggest);
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(hi >= 0 && items[hi] ? items[hi].keyword : input.value);
    } else if (e.key === "Escape") {
      // 有字 = 清空（SearchInput 契约）；无字 = 失焦
      if (input.value) { input.value = ""; clear.hidden = true; close(); }
      else { close(); input.blur(); }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (drop.hidden) return;
      e.preventDefault();
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      renderDrop();
    }
  });

  return box;
}
