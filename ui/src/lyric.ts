// LRC 歌词解析（含可选的翻译 / 音译辅助行，两路各自按时间就近对齐）
//
// 数据层只负责「把两路都挂上」，不负责选路：显示哪一路由「翻译选项」决定，
// 规则集中在 pickAux()（逐字视图用同一条规则，见 vendor/Sparkle/plugins/amll 的 pickAuxLine）。
import type { LyricAuxMode } from "./lib/prefs";

export interface LyricLine {
  t: number; // 秒
  text: string;
  /** 翻译行（上游 trans） */
  trans?: string;
  /** 音译行（上游 roma：romaji/拼音）—— 与翻译同一个位置（歌词下方那行） */
  roma?: string;
}

const TS = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]/g;

function parseBlock(src: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    TS.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TS.exec(raw))) {
      const ms = m[3] ? Number(("0." + m[3]).slice(0, 4)) : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + ms);
    }
    const text = raw.replace(TS, "").trim();
    // 跳过占位行（上游翻译常用 "//" 占位、歌词站用 空/纯符号行）
    if (!times.length || !text || text === "//") continue;
    for (const t of times) out.push({ t, text });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 辅助行（翻译 / 音译同一套路）按时间就近对齐到主歌词行；对不上就不显示 */
function attachAux(base: LyricLine[], src: string | undefined, field: "trans" | "roma") {
  if (!base.length) return;
  const aux = parseBlock(src ?? "");
  if (!aux.length) return;
  const map = new Map<number, string>();
  for (const line of aux) {
    let best: LyricLine | undefined;
    let bd = 1.5; // 秒差容忍
    for (const b of base) {
      const d = Math.abs(b.t - line.t);
      if (d < bd) { bd = d; best = b; }
    }
    if (best && !map.has(best.t)) map.set(best.t, line.text);
  }
  for (const b of base) {
    const text = map.get(b.t);
    if (text) b[field] = text;
  }
}

export function parseLrc(lrc: string, trans?: string, roman?: string): LyricLine[] {
  const base = parseBlock(lrc ?? "");
  attachAux(base, trans, "trans");
  attachAux(base, roman, "roma");
  return base;
}

/**
 * 辅助行取哪一路：翻译档优先翻译、音译档优先音译，本行缺哪一路就回落到另一路；
 * off = 空串（不显示）。两路永远共用同一行位置，绝不会同时上屏。
 */
export function pickAux(line: Pick<LyricLine, "trans" | "roma">, mode: LyricAuxMode): string {
  if (mode === "off") return "";
  const prefer = (mode === "romanization" ? line.roma : line.trans) ?? "";
  const fallback = (mode === "romanization" ? line.trans : line.roma) ?? "";
  return prefer.trim() || fallback.trim();
}

export const fmtDur = (sec: number) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
