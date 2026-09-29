// Quaver — 配置层：quaver.conf（INI）在渲染层的门面。
//
// 桌面端（Electron）走 preload 暴露的 quaverConfig 桥，读写主进程管理的同一份文件；
// 浏览器 dev（无 preload，直接开 vite dev server）回落 localStorage —— 同一套页面脚本两种环境都能跑。
//
// 关键点：配置在启动时一次性读进内存（loadConfig），之后所有 getter 都是**同步**的。
// 所以 main.ts 必须在 applyTheme/applyFonts 之前 await loadConfig()。
// （旧实现直接把 localStorage 当真相来源，打包态每次启动都是新 origin → 设置全丢。）

/** 拍平的配置表：键为 "Section.Key"，值恒为字符串（与 electron/config.mjs 的 schema 对齐）。 */
export type ConfigSnapshot = Record<string, string>;

const LS_KEY = "quaver.conf.v1";

// 与 electron/config.mjs 的 SCHEMA 默认值保持一致（浏览器 dev 兜底 / 文件缺键时用；
// 桌面端主进程 readValues() 已补齐全量，这里只是不让两种环境的行为分叉）。改一处要改两处。
const FALLBACK: ConfigSnapshot = {
  "Style.Style": "dark",
  "Style.DefaultUIFonts": "Source Han Sans,Microsoft Yahei UI",
  "Style.DefaultLyricsFonts": "Source Han Serif",
  "Style.ShowTranslation": "True",
  "Window.Decor": "csd",
  "Window.CloseAction": "tray",
  "Window.SidebarCollapsed": "False",
  "Window.SidebarWidth": "",
  "Window.QueueWidth": "",
  "Playing.Backend": "MPV",
  "Playing.AudioDevice": "auto",
  "Playing.Fade": "normal",
  "Playing.Volume": "0.8",
  "Playing.Muted": "False",
  "Quality.DefaultQuality": "Auto",
  "Quality.FallbackToQMAtmos": "False",
  // [Security] 只有主进程读（凭证存储走 electron/keyring.mjs），渲染层没有对应 getter ——
  // 列在这里只是为了与 SCHEMA 的默认值保持一一对应，别让两种环境的取值表分叉。
  "Security.CredentialStore": "auto",
  "Security.KeyringBackend": "auto",
};

let values: ConfigSnapshot = { ...FALLBACK };
let info = { dir: "", path: "", bridged: false, writable: true };

const bridge = (): any => (window as any).quaverConfig;

function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(values)); } catch { /* 隐私模式/配额满：只在本次会话内生效 */ }
}

function adopt(r: any): boolean {
  if (!r?.ok || !r.values) return false;
  values = { ...FALLBACK, ...r.values };
  info = { dir: r.dir ?? "", path: r.path ?? "", bridged: true, writable: r.writable !== false };
  return true;
}

// ——— 启动装载（同步）———
// 桌面端：preload 已经用 sendSync 取好了快照（见 electron/preload.cjs），这里直接吃。
// 浏览器 dev：没有桥，退回 localStorage（也是同步的）。
// 为什么必须同步：ESM 静态 import 提升 —— player 的实例化、各模块对 cfg() 的读取都发生在
// 任何 await 之前；异步装载会让启动期全部落在默认值上（音量、后端、歌词开关…），
// 那不是「慢一点」，是「读到错的值」。
(function boot() {
  const b = bridge();
  if (b?.boot && adopt(b.boot)) return;
  try {
    values = { ...FALLBACK, ...(JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as ConfigSnapshot) };
  } catch { /* 坏 JSON：用默认值 */ }
})();

/** 重新从磁盘装载（dev 钩子 / 手动刷新用）。启动路径不需要它。 */
export async function loadConfig(): Promise<void> {
  const b = bridge();
  if (b?.all) {
    try {
      const r = await b.all();
      if (adopt(r)) return;
      console.warn("quaver: 配置文件读取失败，保持当前值", r?.error);
      return;
    } catch (e) {
      console.warn("quaver: 配置桥不可用，保持当前值", e);
    }
  }
  try {
    values = { ...FALLBACK, ...(JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as ConfigSnapshot) };
  } catch { /* 忽略 */ }
}

/** 读一项（同步）。未配置时返回默认值。 */
export const cfg = (key: string, fallback = ""): string => values[key] ?? fallback;

/** 内存先行：只把真正变化的键挑出来（值没变就别产生一次写盘）。 */
function applyPatch(patch: ConfigSnapshot): ConfigSnapshot | null {
  const changed: ConfigSnapshot = {};
  for (const [k, v] of Object.entries(patch)) {
    if (values[k] === v) continue;
    values[k] = v;
    changed[k] = v;
  }
  return Object.keys(changed).length ? changed : null;
}

function flush(patch: ConfigSnapshot) {
  const b = bridge();
  if (b?.set) {
    // 不 await：UI 不该等磁盘。失败只记日志 —— 配置丢一项不影响这次会话的使用。
    void Promise.resolve(b.set(patch)).catch((e: unknown) => console.warn("quaver: 配置写入失败", e));
  } else {
    saveLocal();
  }
}

/** 写一项或多项：内存立即生效，随即落盘。 */
export function cfgSet(patch: ConfigSnapshot): void {
  const changed = applyPatch(patch);
  if (changed) flush(changed);
}

// 高频项（音量拖拽等）：内存立即生效，落盘合并成一次。关页面时补一次，别把最后一格滚轮吃掉。
let pending: ConfigSnapshot = {};
let timer: number | null = null;

function flushPending() {
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
  const p = pending;
  pending = {};
  if (Object.keys(p).length) flush(p);
}

export function cfgSetSoon(patch: ConfigSnapshot, ms = 250): void {
  const changed = applyPatch(patch);
  if (!changed) return;
  Object.assign(pending, changed);
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(flushPending, ms);
}

window.addEventListener("pagehide", flushPending);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPending(); });

/** 配置文件位置（设置页展示用）。bridged=false 表示当前跑在浏览器里。 */
export const configInfo = () => info;

/** 在系统文件管理器里定位 quaver.conf。 */
export async function revealConfig(): Promise<void> {
  await bridge()?.reveal?.();
}

/** 用模板重建配置文件（设置回默认值，凭证文件不动）。调用方负责刷新界面。 */
export async function resetConfig(): Promise<void> {
  const b = bridge();
  if (b?.reset) {
    const r = await b.reset();
    if (r?.ok) values = { ...FALLBACK, ...(r.values ?? {}) };
    return;
  }
  values = { ...FALLBACK };
  saveLocal();
}

// dev 钩子：e2e / 调试可直接读写配置。生产构建不含。
// 注意这是**唯一**能改到内存快照的入口 —— 配置在启动时装载一次，往 localStorage 里塞值
// 不会影响当前会话（下次启动才读），改完要 reload 才行。
if (import.meta.env.DEV) {
  (window as any).__cfg = {
    all: () => ({ ...values }),
    get: cfg,
    set: cfgSet,
    info: configInfo,
    reload: loadConfig,
  };
}
