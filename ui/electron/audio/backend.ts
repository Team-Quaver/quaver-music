// Quaver — 主进程音频后端选择（默认 mpv；Liino 是 quaver.conf 里的实验原生模式）。
//
// Liino 是显式打开的实验后端（设置 → 播放 → Liino（实验性原生模式））。
//
// 回退口径：选了 Liino 但**库没能真的 dlopen**，就地回落 mpv —— 这条判断必须在 init 之前做完，
// 因为 ipcMain.handle("quaver:audio") 一个进程只能有一个主人：先到先得，后到的静默失败，
// 用户看到的就是「点了播放没声」。
import { type BrowserWindow } from "electron";
import { audioEngine, type AudioEngine, type EngineLog } from "./engine.ts";
import { liinoEngine, type LiinoEngine } from "./liino-engine.ts";
import { selectedBackend } from "./liino-runtime.ts";

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

export function audioBackendName(): string {
  return active?.kind ?? "mpv";
}

/** 诊断专用：直接读当前活跃引擎；调用方不得用它替代命令面。 */
export function getAudioEngine(): AnyAudioEngine {
  return active ?? audioEngine;
}

/**
 * 按启动快照/排障开关选后端，并完成 init（幂等：重复调用只刷新 baseUrl/窗口引用）。
 * Liino 需要显式选择 **且** dlopen 成功；否则老实回到 mpv 并写进日志。
 */
export async function bootAudioEngine(boot: AudioEngineBoot): Promise<AnyAudioEngine> {
  const want = selectedBackend(process.env.QUAVER_AUDIO_BACKEND ?? boot.backendPreference);

  if (want === "liino") {
    const ok = await liinoEngine.probe();

    if (ok) {
      liinoEngine.init(boot);
      active = liinoEngine;
      const runtime = liinoEngine.describe();

      boot.log("[quaver] audio backend = liino", liinoEngine.liino?.version ?? "", runtime.path, `source=${runtime.source}`, runtime.note);

      return liinoEngine;
    }

    boot.log("[quaver] Liino 后端不可用，回落 mpv：", liinoEngine.describe().note);
  }

  // mpv 引擎的 init 里已经带 baseUrl/getWin/log；重复调用安全
  audioEngine.init(boot);
  active = audioEngine;

  return audioEngine;
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
