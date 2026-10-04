// Quaver — 热键分发（渲染层）。
//
// 两路汇到同一个执行入口 applyHotkeyAction（播放器是唯一事实源）：
//   • 全局热键：主进程注册（win/mac = Electron globalShortcut；Linux = XDG 桌面门户），
//     动作经 quaverHotkeys 桥送回这里 —— 窗口失焦也生效。
//   • 焦点内热键：window keydown 捕获阶段现读配置内存快照匹配 —— 设置页改完立即生效，
//     不需要任何注册/重载。Ctrl+P（浏览器默认打印）等一律 preventDefault。
// 浏览器 dev（无 preload 桥）：全局热键自然缺失；焦点内热键照常可用（quit 无桥则 no-op）。
import { player } from "../player";
import { toast } from "../components/SongMenu";
import { acceleratorFromEvent, getHotkey, FOCUS_HOTKEY_ACTIONS, type HotkeyAction } from "./prefs";

/** 音量步进：与播放条滚轮微调（0.04）不同档，键盘是离散的明确动作，5% 一格。 */
const VOLUME_STEP = 0.05;

/** 设置页录制组合键时置真：焦点热键分发让位，否则录 Ctrl+P 会顺手把歌切了。 */
export const hotkeyRecorder = { active: false };

/** 输入类控件：方向/音量键的热键在这里让位（Ctrl+←/→ 是逐词移动光标的编辑键）。 */
const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable]"));

export function applyHotkeyAction(action: HotkeyAction): void {
  switch (action) {
    case "toggle": player.toggle(); break;
    case "prev": player.prev(); break;
    case "next": player.next(); break; // 与 MPRIS/系统媒体键同一语义（不跳过单曲循环）
    case "volup": {
      player.setVolume(player.volume + VOLUME_STEP);
      toast(`音量 ${Math.round(player.volume * 100)}%`);
      break;
    }
    case "voldown": {
      player.setVolume(player.volume - VOLUME_STEP);
      toast(`音量 ${Math.round(player.volume * 100)}%`);
      break;
    }
    case "quit": (window as any).quaverCSD?.quit?.(); break; // 浏览器 dev 无壳层桥：no-op
  }
}

export function startHotkeysBridge(): void {
  // —— 全局热键回程（Electron 壳层才有桥）——
  const hk = (window as any).quaverHotkeys;
  if (hk?.onEvent) {
    hk.onEvent((payload: { t?: string; action?: HotkeyAction; state?: string; reason?: string; items?: { action: string; accel: string; label?: string; why?: string }[] }) => {
      if (payload?.t === "action" && payload.action) applyHotkeyAction(payload.action);
      else if (payload?.t === "failed" && payload.items?.length) {
        toast("全局热键注册失败：" + payload.items.map((x) => `${x.accel}（${x.why ?? "未知原因"}）`).join("、"), "err");
      } else if (payload?.t === "partial" && payload.items?.length) {
        toast("部分全局热键未生效（可能被其他应用占用，可在设置里换键）：" + payload.items.map((x) => x.label ?? x.action).join("、"), "err");
      } else if (payload?.t === "status" && payload.state === "failed") {
        toast("全局快捷键会话中断：" + (payload.reason || "未知原因"), "err");
      }
      // status=unsupported（桌面环境没有门户）在设置页有静态说明，不弹打扰式 toast
    });
  }

  // —— 焦点内热键：捕获阶段拦截，先于浏览器默认行为（Ctrl+P 打印等）——
  window.addEventListener(
    "keydown",
    (e) => {
      if (hotkeyRecorder.active) return; // 录制中：全部按键归设置页的捕获器
      const accel = acceleratorFromEvent(e);
      if (!accel) return;
      for (const action of FOCUS_HOTKEY_ACTIONS) {
        if (getHotkey("Focus", action) !== accel) continue;
        // 切歌/音量与文本编辑冲突 → 输入类控件内让位；暂停与退出无此冲突，全程生效
        if (action !== "toggle" && action !== "quit" && isEditable(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        applyHotkeyAction(action);
        return;
      }
    },
    { capture: true },
  );
}
