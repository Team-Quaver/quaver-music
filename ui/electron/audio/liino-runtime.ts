// Quaver — Liino 原生音频后端的「纯逻辑层」（零 electron 值导入：裸 node 可载，verify 脚本直接跑）。
//
// 职责边界：这里只做「解析 + 映射」，不碰 FFI、不碰 IPC ——
//   libliino 放在哪、Quark EQ 模型怎么落到 Liino 的双二阶、Liino 状态机怎么回给渲染层，
//   全是可单测的纯函数；真正开播放会话的是 liino-engine.ts。
//
// 为什么 Liino 只吃 native 模式：mpv 那条 `--ao=pcm` 管道（渲染层 WebAudio 出声，
// 为的是窗口级捕获）在 Liino 里没有对应物 —— Liino 的输出是 Go 侧自己开 PipeWire/WASAPI
// 会话。别在这里假装支持 pcm：宁可让 status 说实话，渲染层据此退回 mpv 或 Blink。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform as hostPlatform } from "node:process";
import { isPassFilter, normalizeEqState } from "./eq-config.ts";
import type { EqBandType } from "./eq-config.ts";

/** 主进程音频后端：默认 mpv（生产形态），liino = 实验后端（纯 Go 管线，见 vendor/Liino）。 */
export type AudioBackendKind = "mpv" | "liino";

/** 后端选择只认一个环境变量：QUAVER_AUDIO_BACKEND=liino。
 *  刻意不进 quaver.conf —— Liino 还在实验期，不该出现在设置页里被普通用户点开。 */
export function selectedBackend(value: string | undefined): AudioBackendKind {
  return String(value ?? "").trim().toLowerCase() === "liino" ? "liino" : "mpv";
}

/** Go 的 arch 命名与 Node 不同名（amd64 vs x64），目录名按 Go 口径。 */
export function goArchName(nodeArch: string): string {
  return nodeArch === "x64" ? "amd64" : nodeArch === "ia32" ? "386" : nodeArch;
}

/** 各平台的 libliino 文件名（与 vendor/Liino/node/libliino.ts 的 NAMES 表一致）。 */
export function liinoLibraryName(targetPlatform: string = hostPlatform): string {
  if (targetPlatform === "win32") return "liino.dll";

  if (targetPlatform === "darwin") return "libliino.dylib";

  return targetPlatform === "aix" ? "" : "libliino.so";
}

/** 解析结果：path="" 表示没找到，note 是要进日志与 status.reason 的人话。 */
export interface LiinoRuntime {
  path: string;
  source: string;   // env | packaged | vendor | "" (未找到)
  note: string;
}

export interface LiinoResolveOpts {
  /** 显式覆盖（QUAVER_LIINO_DIR 或 QUAVER_LIINO_LIB）：排障时拿另一份 .so 跑 */
  override?: string;
  /** 打包态 = process.resourcesPath；开发态留空 */
  resourcesRoot?: string;
  /** 开发态 vendor/Liino/build 的绝对路径（由 liino-engine.ts 用 import.meta.url 算） */
  vendorBuildRoot?: string;
  targetPlatform?: string;
  targetArch?: string;
}

const LIB_RE = /^(libliino\.(so|dylib)|liino\.dll)$/;

/** 在一个目录里找 libliino：先按精确名，再兜同平台的其它命名（Go 交叉编译产物）。 */
function pickLibrary(dir: string, name: string): string {
  const exact = join(dir, name);

  if (existsSync(exact)) return exact;

  if (!existsSync(dir)) return "";
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && LIB_RE.test(entry.name)) return join(dir, entry.name);
  }

  return "";
}

/**
 * 找 libliino 动态库，优先级与 mpv 运行时同一套口径（见 bins.ts）：
 *   env 显式路径 > 随包 resources/liino > 开发态 vendor/Liino/build/<os>-<arch>。
 * 随包是优化不是前提：开发态没跑过 stage 脚本就回落 vendor 那份。
 */
export function resolveLiinoLibrary(opts: LiinoResolveOpts = {}): LiinoRuntime {
  const targetPlatform = opts.targetPlatform ?? hostPlatform;
  const name = liinoLibraryName(targetPlatform);

  if (!name) return { path: "", source: "", note: `Liino 不支持当前平台（${targetPlatform}）` };
  const dir = goArchName(opts.targetArch ?? process.arch);

  const override = String(opts.override ?? "").trim();

  if (override) {
    const candidate = isDirectory(override) ? pickLibrary(override, name) : (existsSync(override) ? override : "");

    if (candidate) return { path: candidate, source: "env", note: "" };

    return { path: "", source: "env", note: `QUAVER_LIINO 指向的路径里没有 ${name}（${override}）` };
  }

  const roots: Array<{ root: string; source: string }> = [];

  if (opts.resourcesRoot) {
    roots.push({ root: join(opts.resourcesRoot, "liino", `${targetPlatform}-${dir}`), source: "packaged" });
    roots.push({ root: join(opts.resourcesRoot, "liino"), source: "packaged" });
  }

  if (opts.vendorBuildRoot) {
    roots.push({ root: join(opts.vendorBuildRoot, `${targetPlatform}-${dir}`), source: "vendor" });
  }

  for (const { root, source } of roots) {
    const hit = pickLibrary(root, name);

    if (hit) return { path: hit, source, note: "" };
  }

  return {
    path: "", source: "",
    note: `未找到 ${name}（跑 vendor/Liino/scripts/build-capi.sh，或设 QUAVER_LIINO 指向库/目录）`,
  };
}

/** 传目录还是传文件：目录按名字找库，文件直接用（env 顶掉是排障刚需，两种写法都认）。 */
function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

type JsonLeaf = string | number | boolean | null;

/** Liino 侧可消费的 JSON 值域（FFI 回包永远是 JSON；catch 可能抛出的也就是这个或 Error）。 */
export type RemoteJson = JsonLeaf | RemoteJson[] | { [key: string]: RemoteJson };

// —— catch 边界的统一收口 —————————————————————————————————
// catch 进来的都是 unknown；只认 Error 形状的 message。断言集中在这一个出口
// （SAFETY 注释贴这里），调用点不再各自写 `as Error`。

/** catch 边界收口的最小契约：只声明 caught 会消费的字段。 */
export interface RemoteException {
  message?: string;
}

/** catch 进来的 e 是否带 message 字段（两张脸：Error、或被抛的裸 JSON 对象）。 */
const hasMessage = (e: unknown): e is RemoteException => {
  // SAFETY: 谓词是类型收口的正主（unknown → RemoteException 的唯一通道）；字段级判定，
  // 不做构成探测（in 只看字段在不在，不猜类型）。
  if (typeof e === "object" && e !== null && "message" in e) {
    return true;
  }

  return false;
};

/** catch 边界专用：unknown/Error → 可读字符串；字段缺失兜原值文本，不留 undefined。 */
export function caught(e: unknown): string {
  if (hasMessage(e)) return String(e.message ?? "");

  return e === undefined || e === null ? "" : String(e);
}

// —— Quark EQ → Liino 双二阶 ————————————————————————————————————
// Liino 的 dsp.Config 只有 peaking / lowshelf / highshelf（shelf=""即 peaking）。
// 我们模型里的 LP/HP 目前没有对应实现：如实报「丢弃数」，不许悄悄冒充（同 APO 导入的口径）。

export interface LiinoEqBand {
  freq: number;
  q: number;
  gain: number;
  shelf: string; // "" | "lowshelf" | "highshelf"
}

export interface LiinoEqPlan {
  bands: LiinoEqBand[];
  /** 前级增益（dB）。Liino 没有独立前级，折进主增益线性值。 */
  preamp: number;
  /** EQ 关闭 = 整链旁通（setBypass），不能留旧滤镜 —— 与 mpv 的 af="" 同一语义。 */
  bypass: boolean;
  /** 无法映射到 Liino 的节点数（LP/HP）。 */
  dropped: number;
}

function shelfFor(type: EqBandType): string {
  if (type === "lowShelf") return "lowshelf";

  if (type === "highShelf") return "highshelf";

  return "";
}

/** IPC 边界统一走 normalizeEqState：越界夹紧、未知类型落 bell、段数封顶，再映射成 Liino 带型。 */
export function liinoEqPlan(input: unknown): LiinoEqPlan {
  const state = normalizeEqState(input);
  const bands: LiinoEqBand[] = [];

  let dropped = 0;

  if (state.enabled) {
    for (const band of state.bands) {
      if (isPassFilter(band.type)) { dropped++; continue; }

      bands.push({ freq: band.freq, q: band.q, gain: band.gain, shelf: shelfFor(band.type) });
    }
  }

  return { bands, preamp: state.enabled ? state.preamp : 0, bypass: !state.enabled, dropped };
}

/** 主增益 = 用户音量 × 淡入淡出包络 × 前级（dB→线性）；静音给 0（Liino 自己也有 mute，但包络要乘在前级上）。 */
export function liinoMasterGain(volume: number, fadeLevel: number, preampDb: number, muted: boolean): number {
  if (muted) return 0;
  const linear = Math.max(0, Number(volume) || 0) * Math.max(0, Math.min(1, fadeLevel || 1));
  const preamp = 10 ** ((Number.isFinite(preampDb) ? preampDb : 0) / 20);

  return Math.round(linear * preamp * 1000) / 1000;
}

// —— Liino 状态机 → 渲染层的 {paused, buffering, idle} ——————————————
// Liino: idle/loading/ready/playing/paused/buffering/ended/stopped/failed/closed
// mpv 引擎对外只给这四个布尔；语义对齐：idle = 没挂流，buffering = 还没真出声。

export interface LiinoStateFields {
  paused: boolean;
  buffering: boolean;
  idle: boolean;
}

export function liinoStateFields(state: string, pausedIntent = false): LiinoStateFields {
  switch (state) {
    case "playing": return { paused: false, buffering: false, idle: false };
    case "buffering": return { paused: false, buffering: true, idle: false };
    case "loading": return { paused: pausedIntent, buffering: true, idle: false };
    case "ready": return { paused: pausedIntent, buffering: !pausedIntent, idle: false };
    case "paused": return { paused: true, buffering: false, idle: false };
    case "ended": return { paused: true, buffering: false, idle: true };
    default: return { paused: true, buffering: false, idle: true }; // stopped/failed/closed/idle
  }
}

/** 终态：曲末与失败都必须让渲染层看到 ended/error，否则起播看门狗只能靠超时。 */
export function liinoIsFailureState(state: string): boolean {
  return state === "failed" || state === "closed";
}

// —— 设备列表 ————————————————————————————————————————————————

export interface LiinoDeviceEntry {
  id: string;
  desc: string;
}

export interface LiinoDevicePlan {
  current: string;
  devices: LiinoDeviceEntry[];
}

interface RawLiinoDevice {
  ID?: string;
  Driver?: string;
  Name?: string;
  Default?: boolean;
}

/** Liino JSON 字段共用收口：只认字符串字段，其它一律落到默认值。 */
const str = (v: string | undefined, dflt = ""): string => (v === undefined ? dflt : v);

/** JSON.parse 拒绝空文本；payload 侧统一给 "{}" 兜底。 */
function sanitized(payload: string | null): string {
  const text = String(payload ?? "").trim();

  return text.length ? text : "{}";
}

/** `liino_devices()` 的 JSON（Go 导出大写字段）→ 渲染层的 {id, desc} 列表。
 *  null/坏 JSON 一律落到空列表：设备枚举失败不该让播放页崩。 */
export function liinoDevicePlan(payload: string | null, active = ""): LiinoDevicePlan {
  const devices: LiinoDeviceEntry[] = [];

  let fallbackCurrent = "";

  try {
    // SAFETY: payload 来自 libliino 自己的 JSON 序列化（Go capi 层）；解析失败即空列表。
    const devicesDoc = JSON.parse(sanitized(payload)) as { devices?: RawLiinoDevice[] };
    const list = Array.isArray(devicesDoc.devices) ? devicesDoc.devices : [];

    for (const item of list) {
      // SAFETY: 逐项在下面用 str() 收口，非对象条目会得到空 id 直接跳过
      const d = item as RawLiinoDevice;
      const id = str(d.ID);

      if (!id) continue;
      const name = str(d.Name, id);
      const driver = str(d.Driver);

      devices.push({ id, desc: driver ? `${name}（${driver}）` : name });

      if (d.Default === true && driver !== "null" && !fallbackCurrent) fallbackCurrent = id;
    }
  } catch { /* 空列表兜底：见上 */ }

  return { current: active || fallbackCurrent || "auto", devices };
}
