// Quaver — 全局热键管理（系统级；窗口失焦也生效）。
//
// 平台分叉（调用方主进程只认 apply/destroy，平台细节收在这里）：
//   Windows / macOS —— Electron globalShortcut（系统级按键钩子），acc 即配置里的规范串。
//   Linux —— XDG 桌面门户 GlobalShortcuts（xdg-portal.ts）：不能抢系统级的 X11 grab，
//   Wayland 下那本来也行不通；门户语义 = 建会话 → Bind（桌面端可弹授权框）→ 收 Activated。
//   应用身份靠 app ID（red.0w0.quaver）与桌面文件对应，门户按它归档快捷键。
//
// 动作不在本模块执行：播放器活在渲染层，这里只把动作经 sendToRenderer 转发
// （quaver:hotkey 通道，payload { t: "action" | "status" | "failed", … }）。
// 配置变更由主进程在 quaver:config 落盘后调 apply() —— 门户重绑 = 关旧会话再建，
// GNOME 上授权框会重弹一次，属门户语义。
import { PortalShortcuts } from "./xdg-portal.ts";
import { isHotkey } from "./config.ts";

/** Global 段有份的动作（quit 只作为焦点内热键，不进系统级）。 */
export const GLOBAL_ACTIONS = ["toggle", "prev", "next", "volup", "voldown"];

/** 动作 → schema 键名。VolUp/VolDown 是多词键，首字母大写法（volup→Volup）会拼错，
 *  必须显式列全 —— 与 src/lib/prefs.ts 的 HOTKEY_KEY_NAMES 逐字一致（verify-hotkeys 交叉比对）。 */
export const GLOBAL_CONF_KEYS = {
  toggle: "Hotkeys.Global.Toggle",
  prev: "Hotkeys.Global.Prev",
  next: "Hotkeys.Global.Next",
  volup: "Hotkeys.Global.VolUp",
  voldown: "Hotkeys.Global.VolDown",
};

const ACTION_LABELS = {
  toggle: "暂停 / 播放",
  prev: "上一曲",
  next: "下一曲",
  volup: "音量加大",
  voldown: "音量减小",
};

// 规范 accelerator（Ctrl+Alt+F5）→ XDG 快捷键串（CTRL+ALT+F5；字母小写 = XKB 基础层
// 的那个键，大写字母是 Shift 层的另一个 keysym，不能混用）。
const TRIGGER_KEYS = {
  Space: "space", Enter: "Return", Backspace: "BackSpace", PageUp: "Page_Up", PageDown: "Page_Down",
  Minus: "minus", Equal: "equal", Comma: "comma", Period: "period",
};
const TRIGGER_MODS = { Ctrl: "CTRL", Alt: "ALT", Shift: "SHIFT", Super: "LOGO" };

export function acceleratorToPortalTrigger(accel) {
  const parts = String(accel ?? "").trim().split("+").filter(Boolean);
  if (!parts.length) return "";
  const key = parts.pop();
  const mods = parts.map((m) => TRIGGER_MODS[m] ?? "");
  if (mods.some((m) => !m)) return "";
  let k = TRIGGER_KEYS[key] ?? key;
  if (/^[A-Z]$/.test(k)) k = k.toLowerCase();
  return [...mods, k].join("+");
}

/**
 * @param opts.log 日志
 * @param opts.readBindings () => { toggle: "Ctrl+Alt+F5", … }（只含全局动作；空串 = 停用）
 * @param opts.sendToRenderer (payload) => void —— win 必须已就绪，调用方自行兜底
 * @param opts.globalShortcut Electron 的 globalShortcut 模块（win/mac 用；注入便于单测）
 */
export function createGlobalHotkeys({ log = () => {}, readBindings = () => ({}), sendToRenderer = () => {}, globalShortcut = null } = {}) {
  const mode = process.platform === "linux" ? "portal" : "shortcut";
  let registered = new Map(); // accel → action（shortcut 模式的当前登记）
  let portal = null;
  let portalStatus = { state: "idle", reason: "" };

  const notify = (payload) => {
    try { sendToRenderer(payload); } catch (e) { log("[hotkeys] send failed:", String(e)); }
  };

  function applyShortcut(bindings) {
    if (!globalShortcut) return;
    const want = new Map(); // accel → action
    for (const action of GLOBAL_ACTIONS) {
      const accel = String(bindings[action] ?? "").trim();
      if (accel) want.set(accel, action);
    }
    const failed = [];
    // 先退掉不再要的 / 换了动作的
    for (const [accel, action] of registered) {
      if (want.get(accel) === action) continue;
      try { globalShortcut.unregister(accel); } catch { /* 退出竞态：忽略 */ }
      registered.delete(accel);
    }
    for (const [accel, action] of want) {
      if (registered.get(accel) === action) continue;
      if (registered.has(accel)) { try { globalShortcut.unregister(accel); } catch { /* 同上 */ } registered.delete(accel); }
      // 格式判定用 config.ts 的 isHotkey（与 schema 值域同一语法）——
      // Electron 的 globalShortcut 上没有 isAccelerator 这类探测 API，调了就是 TypeError。
      if (!isHotkey(accel)) { failed.push({ action, accel, why: "格式不合法" }); continue; }
      let ok = false;
      try { ok = globalShortcut.register(accel, () => notify({ t: "action", action })); } catch (e) { log("[hotkeys] register threw:", String(e)); }
      if (ok) registered.set(accel, action);
      else failed.push({ action, accel, why: "可能已被其他应用占用" });
    }
    if (failed.length) {
      log("[hotkeys] 全局热键注册失败:", failed.map((f) => `${f.action}(${f.accel}): ${f.why}`).join(", "));
      notify({ t: "failed", items: failed });
    }
  }

  function applyPortal(bindings) {
    const shortcuts = [];
    for (const action of GLOBAL_ACTIONS) {
      const accel = String(bindings[action] ?? "").trim();
      if (!accel) continue; // 空值 = 该动作不注册
      const trigger = acceleratorToPortalTrigger(accel);
      if (!trigger) { log("[hotkeys] 无法转成门户触发串，跳过:", accel); continue; }
      shortcuts.push({ id: action, description: ACTION_LABELS[action] ?? action, trigger });
    }
    if (!portal) {
      portal = new PortalShortcuts({
        log,
        onAction: (id) => notify({ t: "action", action: id }),
        onStatus: (st) => {
          portalStatus = st;
          log(`[hotkeys] portal status: ${st.state}${st.reason ? ` — ${st.reason}` : ""}`);
          if (st.state === "partial" && Array.isArray(st.missing) && st.missing.length) {
            // 桌面端丢弃了冲突的首选触发串：把没绑上的动作报给渲染层提示
            notify({ t: "partial", items: st.missing.map((id) => ({ action: id, label: ACTION_LABELS[id] ?? id })) });
          } else if (st.state !== "ready" && st.state !== "connecting" && st.state !== "idle") {
            notify({ t: "status", state: st.state, reason: st.reason });
          }
        },
      });
    }
    portalStatus = { state: "connecting", reason: "" };
    portal.start(shortcuts);
  }

  return {
    mode,
    /** 当前门户状态（设置页查询用；shortcut 模式恒 ready） */
    info() {
      return mode === "portal" ? { mode, ...portalStatus } : { mode, state: registered.size ? "ready" : "idle", reason: "" };
    },
    /** 读最新配置并重注册（幂等；启动时与配置变更后各调一次） */
    apply() {
      let bindings = {};
      try { bindings = readBindings() ?? {}; } catch (e) { log("[hotkeys] readBindings failed:", String(e)); return; }
      if (mode === "portal") applyPortal(bindings);
      else applyShortcut(bindings);
    },
    destroy() {
      if (portal) { try { portal.destroy(); } catch { /* noop */ } portal = null; }
      if (globalShortcut && registered.size) {
        try { globalShortcut.unregisterAll(); } catch { /* noop */ }
        registered = new Map();
      }
    },
  };
}
