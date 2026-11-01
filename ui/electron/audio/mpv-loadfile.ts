// Quaver — mpv loadfile 的参数布局与版本判据。
//
// 单独成模块的原因：这两条是纯逻辑，verify-mpv 直接在 node 里跑；
// 放进 engine.ts 会把 electron 值导入拖进测试进程。
import type { MpvValue } from "./mpv-ipc.ts";

/** 从 "mpv v0.41.0" / "mpv 0.38.0-27-gabcdef" 取主次版本；认不出返回 null。 */
export function parseMpvVersion(version: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(String(version ?? ""));

  if (!m) return null;

  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** mpv 0.38 起 loadfile 多了一个 index 占位参数：
 *  旧布局 loadfile <url> [<flags> [<options>]]
 *  新布局 loadfile <url> [<flags> [<index> [<options>]]]
 *  带 start= 起播时布局猜错会被 mpv 直接回 invalid parameter。 */
export function mpvLoadfileWantsIndex(version: string): boolean {
  const v = parseMpvVersion(version);

  if (!v) return false; // 认不出先按旧版发；invalid parameter 时调用方会换布局重试

  return v.major > 0 || v.minor >= 38;
}

/** 拼 loadfile 参数；纯函数，便于单测覆盖 0.38 前后的布局。 */
export function loadfileArgs(url: string, startAt: number, wantIndex: boolean): MpvValue[] {
  const at = Math.max(0, Number(startAt) || 0);

  if (!(at > 0)) return ["loadfile", url, "replace"];

  const opts = `start=${at}`;

  return wantIndex
    ? ["loadfile", url, "replace", -1, opts]
    : ["loadfile", url, "replace", opts];
}
