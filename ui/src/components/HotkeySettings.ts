// Quaver — 设置页「热键」面板（外观/播放/通用/Sparkle 之外的第五个选项卡）。
//
// 两组清单：全局热键（系统级，窗口失焦也生效）与焦点内热键（仅窗口聚焦时生效）。
// 每行一枚绑定按钮，点击进入录制态（捕获 keydown）；Esc 取消、退格/删除键清除（停用）。
// 写入统一走 prefs.setHotkey → quaver.conf：
//   • Focus 段：渲染层 keydown（lib/hotkeys.ts）实时读内存快照，天然即时生效；
//   • Global 段：主进程在 quaver:config 落盘后自动重注册（Linux 门户 = 关旧会话再建，
//     桌面端可能重弹授权框；win/mac 反注册旧的再登记新的）。
// 录制态与 lib/hotkeys.ts 的焦点热键分发互斥（hotkeyRecorder.active），否则录 Ctrl+P
// 会顺手把歌切了。
import { configInfo } from "../lib/config";
import {
  acceleratorFromEvent, getHotkey, setHotkey,
  GLOBAL_HOTKEY_ACTIONS, FOCUS_HOTKEY_ACTIONS, HOTKEY_LABELS,
  type HotkeyAction, type HotkeyScope,
} from "../lib/prefs";
import { hotkeyRecorder } from "../lib/hotkeys";

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const emptyText = () => "未设置";

export function mountHotkeysPanel(host: HTMLElement): () => void {
  const conf = configInfo();

  const group = (scope: HotkeyScope, title: string, note: string, actions: HotkeyAction[], hint: string) => {
    const g = document.createElement("div");
    g.className = "set-group";
    g.innerHTML = `
      <div class="set-label">${title} <span class="set-note-inline">${note}</span></div>
      <p class="muted set-hint" data-hint>${esc(hint)}</p>`;
    for (const action of actions) {
      const row = document.createElement("div");
      row.className = "set-row";
      row.innerHTML = `
        <span class="set-row__label">${esc(HOTKEY_LABELS[action])}</span>
        <div class="set-row__ctrl"><button class="hk-btn" type="button" data-scope="${scope}" data-action="${action}"></button></div>`;
      g.append(row);
    }
    return g;
  };

  const globalHint = conf.bridged
    ? isMac
      ? "经系统 API 注册，与其他应用冲突时会注册失败并提示。空 = 停用。"
      : "Windows / macOS 经系统 API 注册；Linux 经 XDG 桌面门户注册（应用 ID red.0w0.quaver，部分桌面会弹授权确认，改绑定可能要求再次确认）。空 = 停用。"
    : "浏览器 dev 态没有壳层，全局热键不生效（焦点内热键可正常试用）。";

  host.append(
    group("Global", "全局热键", "系统级：窗口失焦也生效", GLOBAL_HOTKEY_ACTIONS, globalHint),
    group("Focus", "焦点内热键", "仅窗口聚焦时生效", FOCUS_HOTKEY_ACTIONS,
      "上一曲 / 下一曲 / 音量在输入框内不触发（避免与 Ctrl+方向 的文本编辑冲突）。空 = 停用。"),
  );

  // 门户注册现状（Linux + Electron 壳层）：一行实时状态，排障用
  const portalLine = host.querySelector<HTMLElement>('[data-hint]')!; // 全局组的第一条 hint
  if (conf.bridged && !isMac && (window as any).quaverHotkeys?.info) {
    void Promise.resolve((window as any).quaverHotkeys.info()).then((info: { state?: string; reason?: string } | null) => {
      if (!info?.state || ["idle", "ready"].includes(info.state)) return;
      portalLine.textContent = globalHint + `（当前门户状态：${info.state}${info.reason ? " — " + info.reason : ""}）`;
    }).catch(() => {});
  }

  // —— 录制态：同一时刻至多一枚按钮在录 ——
  let recording: HTMLButtonElement | null = null;
  let recordLabel = "";

  const paint = () => {
    host.querySelectorAll<HTMLButtonElement>(".hk-btn").forEach((btn) => {
      const accel = getHotkey(btn.dataset.scope as HotkeyScope, btn.dataset.action as HotkeyAction);
      if (btn === recording) { btn.textContent = recordLabel; btn.classList.add("capturing"); btn.classList.toggle("empty", !accel); }
      else {
        btn.classList.remove("capturing");
        btn.textContent = accel || emptyText();
        btn.classList.toggle("empty", !accel);
        btn.title = accel ? "点击修改绑定；录制中 Esc 取消，退格/删除键清除" : "点击设置绑定（组合键需带 Ctrl/Alt/Shift/Super 修饰键）";
      }
    });
  };

  const groupHint = (scope: HotkeyScope): HTMLElement =>
    host.querySelector<HTMLElement>(`.hk-btn[data-scope="${scope}"]`)!
      .closest(".set-group")!.querySelector<HTMLElement>("[data-hint]")!;
  const baseHints = new Map<HotkeyScope, string>();
  for (const scope of ["Global", "Focus"] as HotkeyScope[]) baseHints.set(scope, groupHint(scope).textContent ?? "");
  const hintTimers = new Map<HotkeyScope, number>(); // 每组各一个：共用会把别组待恢复的定时器清掉
  const flashHint = (scope: HotkeyScope, msg: string) => {
    const el = groupHint(scope);
    el.textContent = msg;
    window.clearTimeout(hintTimers.get(scope));
    hintTimers.set(scope, window.setTimeout(() => { el.textContent = baseHints.get(scope) ?? ""; }, 3200));
  };

  const clearHints = () => {
    for (const t of hintTimers.values()) window.clearTimeout(t);
    for (const [scope, base] of baseHints) groupHint(scope).textContent = base;
    hintTimers.clear();
  };

  const stopRecording = () => {
    if (!recording) return;
    recording = null;
    hotkeyRecorder.active = false;
    window.removeEventListener("keydown", onRecordKey, true);
    paint();
  };

  const onRecordKey = (e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const scope = recording.dataset.scope as HotkeyScope;
    const action = recording.dataset.action as HotkeyAction;
    if (e.key === "Escape") { stopRecording(); return; }
    // 退格/删除（不带修饰）：清除绑定 = 停用该热键
    if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Backspace" || e.key === "Delete")) {
      setHotkey(scope, action, "");
      stopRecording();
      return;
    }
    const accel = acceleratorFromEvent(e);
    if (!accel) { flashHint(scope, "录不上：需要「修饰键 + 键名」组合（Ctrl / Alt / Shift / Super，Super 在 Mac 上是 ⌘）"); return; }
    setHotkey(scope, action, accel);
    stopRecording();
  };

  host.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".hk-btn");
    if (!btn) return;
    if (btn === recording) { stopRecording(); return; } // 再点一次 = 取消
    stopRecording();
    recording = btn;
    recordLabel = "按下新组合键…";
    hotkeyRecorder.active = true;
    window.addEventListener("keydown", onRecordKey, true);
    paint();
  });

  paint();
  return () => { stopRecording(); clearHints(); }; // 视图卸载收尾（录制监听 + 闪现的提示一并清掉）
}
