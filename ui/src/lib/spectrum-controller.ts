// Quaver — 频谱的宿主控制面：偏好 + 内置/插件模式表 + Sparkle 门面。
// 分析器与内置绘制器都按需动态加载：频谱默认关闭，不该为它付首屏下载/解析成本。
import type {
  SparkleNpSpectrumMode,
  SparkleSpectrumFacade,
  SparkleSpectrumStatus,
} from "@quaver/sparkle";
import { player } from "../player";
import { getSpectrumEnabled, getSpectrumMode, setSpectrumEnabled, setSpectrumMode } from "./prefs";
import { sparkleNpSpectrumModes } from "../sparkle/registry";

const BUILTIN = [
  { id: "bars", label: "柱状" },
  { id: "mirror", label: "镜像" },
  { id: "wave", label: "波形" },
] as const;

type Runtime = typeof import("./audio-spectrum");
type Renderer = typeof import("./spectrum-render");

let runtime: Runtime | null = null;
let runtimeFlight: Promise<Runtime | null> | null = null;
let renderer: Renderer | null = null;
let rendererFlight: Promise<Renderer | null> | null = null;
let styleFlight: Promise<void> | null = null;
let status: SparkleSpectrumStatus = "idle";

function loadRuntime(): Promise<Runtime | null> {
  if (runtime) return Promise.resolve(runtime);
  runtimeFlight ??= import("./audio-spectrum")
    .then((m) => { runtime = m; status = m.audioSpectrum.status(); return m; })
    .catch((e) => { console.warn("[spectrum] 分析器加载失败", e); status = "unavailable"; return null; })
    .finally(() => { runtimeFlight = null; });
  return runtimeFlight;
}

/** 频谱的 DOM 样式只在功能真正被打开/菜单展开时加载，避免默认关闭时进首屏 CSS。 */
export function loadSpectrumStyles(): Promise<void> {
  styleFlight ??= import("./spectrum.css")
    .then(() => {})
    .catch((e) => { console.warn("[spectrum] 样式加载失败", e); })
    .finally(() => { styleFlight = null; });
  return styleFlight;
}

function loadRenderer(): Promise<Renderer | null> {
  void loadSpectrumStyles();
  if (renderer) return Promise.resolve(renderer);
  rendererFlight ??= import("./spectrum-render")
    .then((m) => { renderer = m; return m; })
    .catch((e) => { console.warn("[spectrum] 绘制器加载失败", e); return null; })
    .finally(() => { rendererFlight = null; });
  return rendererFlight;
}

export function spectrumModes(): { id: string; label: string }[] {
  return [
    ...BUILTIN.map((m) => ({ ...m })),
    ...sparkleNpSpectrumModes().map((m) => ({ id: m.id, label: m.label })),
  ];
}

/** 当前形态：持久化值不存在（插件被停用/卸载）时回落 bars。 */
export function currentSpectrumMode(): string {
  const id = getSpectrumMode();
  return spectrumModes().some((m) => m.id === id) ? id : "bars";
}

/** 取模式实现：内置模式在动态渲染块里，插件模式直接来自注册表。 */
export async function spectrumMode(id: string): Promise<SparkleNpSpectrumMode | null> {
  void loadSpectrumStyles();
  const plugin = sparkleNpSpectrumModes().find((m) => m.id === id);
  if (plugin) return plugin;
  const r = await loadRenderer();
  return r?.builtinSpectrumModes.find((m) => m.id === id) ?? null;
}

export const spectrumFacade: SparkleSpectrumFacade = {
  enabled: () => getSpectrumEnabled(),
  setEnabled: (on) => {
    if (on === getSpectrumEnabled()) return;
    setSpectrumEnabled(on);
    if (on) { void loadSpectrumStyles(); void loadRuntime(); }
    player.notifyPublic();
  },
  status: () => {
    if (runtime) status = runtime.audioSpectrum.status();
    return status;
  },
  mode: () => currentSpectrumMode(),
  modes: () => spectrumModes(),
  setMode: (id) => {
    if (!spectrumModes().some((m) => m.id === id)) return;
    if (id === getSpectrumMode()) return;
    setSpectrumMode(id);
    player.notifyPublic();
  },
  frame: () => {
    if (!runtime) { status = "starting"; void loadRuntime(); return null; }
    status = runtime.audioSpectrum.status();
    return runtime.audioSpectrum.frame();
  },
  onFrame: (cb) => {
    let unsub: (() => void) | null = null;
    let canceled = false;
    status = "starting";
    void loadRuntime().then((r) => {
      if (canceled || !r) return;
      unsub = r.audioSpectrum.onFrame(cb);
      status = r.audioSpectrum.status();
    });
    return () => {
      canceled = true;
      unsub?.();
      unsub = null;
    };
  },
};
