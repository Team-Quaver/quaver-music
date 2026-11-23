// Quaver — 听歌识曲指纹：在 Node/Electron 主进程加载随包 AFP（Shazam v2 兼容）指纹库。
// 渲染层只负责采集 8 kHz 单声道 PCM；WASM 不进页面，避免 CSP 为识曲单独放开 wasm-unsafe-eval。
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

type AfpModule = { GenerateFP?: (pcm: Float32Array) => Promise<string> };

/** 随包 AFP 资产目录：打包态 extraResources/afp，开发态 ui/resources/afp。 */
function resolveAfpDir(): string | null {
  const candidates: string[] = [];
  const override = process.env.QUAVER_AFP_DIR?.trim();

  if (override) candidates.push(override);
  // 打包态：app.asar/electron/../../afp = resources/afp（extraResources）
  candidates.push(fileURLToPath(new URL("../../afp", import.meta.url)));
  // 开发/preview：ui/electron/../resources/afp
  candidates.push(fileURLToPath(new URL("../resources/afp", import.meta.url)));

  for (const dir of candidates) {
    if (existsSync(dir + "/afp.mjs") && existsSync(dir + "/afp.wasm.mjs")) return dir;
  }

  return null;
}

let afpPromise: Promise<AfpModule | null> | null = null;

function loadAfp(): Promise<AfpModule | null> {
  if (afpPromise) return afpPromise;

  const dir = resolveAfpDir();

  if (!dir) return (afpPromise = Promise.resolve(null));

  afpPromise = import(pathToFileURL(dir + "/afp.mjs").href)
    .then((mod: AfpModule) => (mod?.GenerateFP instanceof Function ? mod : null))
    .catch(() => null);

  return afpPromise;
}

/** AFP 资产是否可用（缺失时识曲在指纹阶段给出明确提示）。 */
export function isAfpAvailable(): boolean {
  return resolveAfpDir() !== null;
}

/**
 * 对 8 kHz 单声道 PCM 计算 AFP 指纹。
 * @param pcm - 采样点（-1..1）
 * @returns 指纹字符串；资产缺失或计算失败时返回 null
 */
export async function fingerprintPcm(pcm: Float32Array): Promise<string | null> {
  if (!pcm.length) return null;
  const afp = await loadAfp();

  if (!afp?.GenerateFP) return null;

  try {
    const fingerprint = await afp.GenerateFP(pcm);

    return fingerprint || null;
  } catch {
    return null;
  }
}
