// Quaver — 本地曲目「重新设置刮削信息」对话框（曲名/歌手/专辑三字段手校正）。
//
// 样式门道与本地插件警告弹窗同源（.upd-overlay/.upd-dialog + .leaving 离场门闩），
// 视觉上它是「系统级小表单」而不是页面内联块 —— 右键菜单发起、跨视图（播放条/正在播放页
// 也能改），所以走 body 常驻层。Esc/点遮罩/取消 = 放弃（resolve null）。
//
// 语义提醒（写进提示文案，用户须知）：这份校正是「刮削用 + 展示用」的权威值 ——
// 之后在线匹配只借 qqMid 拿词/封面，不再回填覆盖这三个字段；撤销只能再改一次。
let layer: HTMLElement | null = null;

export interface LocalMetaEdit {
  title: string;
  artist: string;
  album: string;
}

export function showLocalMetaDialog(init: LocalMetaEdit): Promise<LocalMetaEdit | null> {
  if (layer) return Promise.resolve(null); // 同屏只留一层

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `
    <div class="upd-dialog" role="dialog" aria-modal="true" aria-label="重新设置刮削信息">
      <div class="upd-head">
        <h3>重新设置刮削信息</h3>
        <span class="upd-meta muted">这份校正将成为搜索与展示的权威值，在线匹配不再回填覆盖</span>
      </div>
      <div class="lmd-body">
        <label class="lmd-row"><span>曲名</span><input type="text" data-k="title" spellcheck="false" maxlength="200"/></label>
        <label class="lmd-row"><span>歌手</span><input type="text" data-k="artist" spellcheck="false" maxlength="200" placeholder="多位歌手用 / 分隔"/></label>
        <label class="lmd-row"><span>专辑</span><input type="text" data-k="album" spellcheck="false" maxlength="200"/></label>
        <div class="lmd-hint muted">留空的字段保持原值；保存后会自动用「曲名 歌手」重新搜索刮削一次</div>
      </div>
      <div class="upd-foot">
        <button class="ghost-btn" data-act="cancel" type="button">取消</button>
        <span class="upd-spacer"></span>
        <button class="ghost-btn" data-act="save" type="button">保存并重刮</button>
      </div>
    </div>`;

  const inputs = [...layer.querySelectorAll<HTMLInputElement>(".lmd-body input")];
  const fieldOf = (inp: HTMLInputElement): keyof LocalMetaEdit =>
    inp.dataset.k === "artist" ? "artist" : inp.dataset.k === "album" ? "album" : "title";
  for (const inp of inputs) inp.value = String(init[fieldOf(inp)] ?? "");
  const saveBtn = layer.querySelector<HTMLButtonElement>('[data-act="save"]')!;

  let closing = false;
  let resolveFn: (v: LocalMetaEdit | null) => void = () => {};
  const promise = new Promise<LocalMetaEdit | null>((res) => (resolveFn = res));
  const close = (result: LocalMetaEdit | null) => {
    if (closing) return;
    closing = true;
    window.removeEventListener("keydown", onKey);
    const el = layer;
    layer = null;
    resolveFn(result);
    if (!el) return;
    const fin = () => el.remove();
    el.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    el.classList.add("leaving");
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close(null);
    if (e.key === "Enter" && (e.target as HTMLElement)?.tagName === "INPUT") { e.preventDefault(); saveBtn.click(); }
  };
  window.addEventListener("keydown", onKey);
  layer.addEventListener("mousedown", (e) => { if (e.target === layer) close(null); });
  layer.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.onclick = () => close(null);
  saveBtn.onclick = () => {
    const out: LocalMetaEdit = { title: "", artist: "", album: "" };
    for (const inp of inputs) out[fieldOf(inp)] = inp.value.trim();
    if (!out.title && !out.artist && !out.album) close(null); // 全空 = 什么都不改，等价取消
    else close(out);
  };

  document.body.append(layer);
  inputs[0]?.focus();
  return promise;
}
