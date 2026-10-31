// Quaver — 主进程音频后端门面（默认 mpv；Liino 是实验原生后端）。
//
// 与旧版最大的区别：`ipcMain.handle("quaver:audio")` **只在门面注册一次**，命令按当前
// `active` 转发。Electron 同一通道只能有一个 handler（先到先得、后到的静默失败），
// 两个引擎各自注册的结果就是「切了后端却还是旧引擎在答话」——渲染层看到 status 说
// Liino，声音却仍然由 mpv 出（或反过来）。门面持有 handler 之后，运行时切换才可能：
//   { cmd: "backend", value: "MPV" | "MPVCompat" | "Liino" | "Chromium" }
// 先按值拆掉旧引擎、再把新引擎 init 成唯一主人，最后回一份新的 status。
//
// 回退口径：选了 Liino 但**库没能真的 dlopen**，就地回落 mpv —— 这条判断必须在 init 之前
// 做完（同上：一个通道只能有一个主人），并在日志与 status.reason 里说实话。
import { ipcMain, type BrowserWindow } from "electron";
import { audioEngine, type AudioEngine, type EngineLog } from "./engine.ts";
import { liinoEngine, type LiinoEngine } from "./liino-engine.ts";
import { caught, selectedBackend, type AudioBackendKind } from "./liino-runtime.ts";

/** 两个后端共享的命令面（渲染层只看这一层，不关心底下是 mpv 还是 Liino）。 */
export type AnyAudioEngine = AudioEngine | LiinoEngine;

/** 打包态用 resourcesPath/liino，开发态用 vendor/Liino/build —— 两边都由 LiinoEngine 自己解析。 */
export interface AudioEngineBoot {
  baseUrl?: string;
  getWin: () => BrowserWindow | null;
  log: EngineLog;
  /** quaver.conf 的 [Playing] Backend 快照：MPV / MPVCompat / Liino / Chromium；空值走 MPV。 */
  backendPreference?: string;
}

/** 当前生效的后端（boot 之前为 null；诊断面板与信号收尾路径都读它）。 */
let active: AnyAudioEngine | null = null;
/** 最近一次 boot 的窗口引用/日志/baseUrl：运行时切换要拿同一套参数重建另一个引擎。 */
let bootState: AudioEngineBoot | null = null;
/** handler 只注册一次；重复 init（窗口重建）不能重复 handle。 */
let wired = false;
/** 切换串行化：连续点两档后端时，后一笔必须等前一笔把旧引擎拆干净。 */
let switchTail: Promise<unknown> = Promise.resolve();

export function audioBackendName(): string {
  return active?.kind ?? "mpv";
}

/** 诊断专用：直接读当前活跃引擎；调用方不得用它替代命令面。 */
export function getAudioEngine(): AnyAudioEngine {
  return active ?? audioEngine;
}

/** 主进程侧唯一的 `quaver:audio` 路由：普通命令交给 active，backend 命令先换引擎。 */
function wireAudioIpc(): void {
  if (wired) return;
  wired = true;
  ipcMain.handle("quaver:audio", (_e, cmd) => {
    // SAFETY: 渲染层传来的就是结构化克隆后的普通对象；cmd 是否为 backend 只做字段级判断
    if (cmd && typeof cmd === "object" && cmd.cmd === "backend") {
      return switchAudioBackend(String(cmd.value ?? "")).catch((e) => ({ ok: false, error: String(caught(e)) }));
    }

    return (active ?? audioEngine).onInvoke(cmd).catch((e) => ({ ok: false, error: String(caught(e)) }));
  });
}

/** 切换前的可用性预检（不启动会话）：目标不可用时保留当前后端，而不是先拆掉再发现没人接手。 */
async function targetAvailable(want: AudioBackendKind): Promise<{ ok: boolean; reason: string }> {
  if (want === "liino") {
    const ok = await liinoEngine.probe();

    return { ok, reason: ok ? "" : liinoEngine.describe().note };
  }

  // SAFETY: 走 status 分支；字段按可选值读取，缺了就当不可用
  const st = await audioEngine.onInvoke({ cmd: "status" }) as { ok?: boolean; available?: boolean; reason?: string };

  return { ok: !!st?.ok && !!st.available, reason: String(st?.reason ?? "mpv 不可用") };
}

/** 按一个后端偏好启动引擎：Liino 需要 dlopen 成功，否则明确回落 mpv。 */
async function bootOne(want: AudioBackendKind, boot: AudioEngineBoot): Promise<AnyAudioEngine> {
  if (want === "liino") {
    const ok = await liinoEngine.probe();

    if (ok) {
      liinoEngine.init(boot);
      const runtime = liinoEngine.describe();

      boot.log("[quaver] audio backend = liino", liinoEngine.liino?.version ?? "", runtime.path, `source=${runtime.source}`, runtime.note);

      return liinoEngine;
    }

    boot.log("[quaver] Liino 后端不可用，回落 mpv：", liinoEngine.describe().note);
  }

  // mpv 引擎的 init 里已经带 baseUrl/getWin/log；重复调用安全
  audioEngine.init(boot);

  return audioEngine;
}

/**
 * 启动时按快照/排障开关选后端，并完成 init（幂等：同一后端重复调用只刷新 baseUrl/窗口引用）。
 * Liino 需要显式选择 **且** dlopen 成功；否则老实回到 mpv 并写进日志。
 */
export async function bootAudioEngine(boot: AudioEngineBoot): Promise<AnyAudioEngine> {
  bootState = boot;
  wireAudioIpc();

  const want = selectedBackend(process.env.QUAVER_AUDIO_BACKEND ?? boot.backendPreference);

  // 窗口重建/二次 boot：引擎已经在跑，只刷新引用，别把它拆掉
  if (active?.kind === want) {
    active.init(boot);

    return active;
  }

  if (active) { try { active.shutdown(); } catch { /* 换后端失败不该拦住新后端 */ } }

  active = await bootOne(want, boot);

  return active;
}

/**
 * 运行时切换后端（设置页 radio）。返回切换后的 status 回包，渲染层据此重建 transport。
 * 拆旧 → 建新 严格串行；Liino 不可用时如实回落 mpv（status.backend 会说 mpv）。
 */
export async function switchAudioBackend(preference: string): Promise<Record<string, unknown>> {
  const want = selectedBackend(preference);

  let note = "";

  const run = switchTail.catch(() => {}).then(async () => {
    if (active?.kind === want) return active;

    const boot = bootState;

    if (!boot) throw new Error("音频引擎尚未初始化（缺少 boot 参数）");

    const prev = active;
    const avail = await targetAvailable(want);

    // 目标不可用：保留正在出声的旧后端（先拆再失败 = 把用户正在听的歌掐掉）
    if (!avail.ok && prev) {
      note = `目标后端不可用，已保留当前后端：${avail.reason}`;

      return prev;
    }

    if (prev) { try { prev.shutdown(); } catch { /* 旧引擎收尾失败不阻止换后端 */ } }

    active = null;
    // 运行时切换以用户选择为准：QUAVER_AUDIO_BACKEND 只是启动排障口，不能把切换顶回去
    active = await bootOne(want, { ...boot, backendPreference: preference });

    return active;
  });

  switchTail = run;
  const engine = await run;
  const st = await engine.onInvoke({ cmd: "status" });

  return note ? { ...st, note } : st;
}

/** 收尾（will-quit / 信号路径）：只关真被选中的那个，另一个从没 init 过、也没有会话。 */
export function shutdownAudioEngine(): void {
  try { (active ?? audioEngine).shutdown(); } catch { /* 退出路径不报错 */ }

  active = null;
}

/** 外部进程账（内存面板）：mpv 是子进程，Liino 是同进程 FFI —— 后者没有 pid 可报。 */
export function audioExternalPids(): { pid: number | null; tag: string }[] {
  if (active?.kind === "liino") return [];

  const engine = active?.kind === "mpv" ? active : audioEngine;

  return [
    { pid: engine.mpv?.child?.pid ?? null, tag: "外部 · mpv（音频）" },
    { pid: engine.watchdog?.pid ?? null, tag: "外部 · mpv 看门狗" },
  ];
}
