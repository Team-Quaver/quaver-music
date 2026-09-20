// LRC 歌词解析（含可选翻译行，按序号对齐）
export interface LyricLine {
  t: number; // 秒
  text: string;
  trans?: string;
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

export function parseLrc(lrc: string, trans?: string): LyricLine[] {
  const base = parseBlock(lrc ?? "");
  const tr = parseBlock(trans ?? "");
  // 翻译行按时间就近对齐；对不上就不显示
  const map = new Map<number, string>();
  for (const line of tr) {
    let best: LyricLine | undefined;
    let bd = 1.5; // 秒差容忍
    for (const b of base) {
      const d = Math.abs(b.t - line.t);
      if (d < bd) { bd = d; best = b; }
    }
    if (best && !map.has(best.t)) map.set(best.t, line.text);
  }
  for (const b of base) b.trans = map.get(b.t);
  return base;
}

export const fmtDur = (sec: number) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
