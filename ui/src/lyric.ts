// LRC 歌词解析（含可选的翻译 / 音译辅助行，两路各自按时间就近对齐）
//
// 数据层只负责「把两路都挂上」，不负责选路：显示哪一路由「翻译选项」决定，
// 规则集中在 pickAux()：行级视图与**内置歌词引擎**（src/lyrics/amll.ts）共用这一份实现。
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

/** 辅助行可见文本：上游常用 `//` 表示这一行没有翻译/音译，不能当成正文上屏。 */
export function cleanAuxText(value: string | undefined): string {
  const text = (value ?? "").trim();
  return /^\/+$/.test(text) ? "" : text;
}

function parseTimedBlock(src: string, keepEmpty: boolean): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    TS.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TS.exec(raw))) {
      const ms = m[3] ? Number(("0." + m[3]).slice(0, 4)) : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + ms);
    }
    const text = cleanAuxText(raw.replace(TS, ""));
    // 主歌词跳过占位；辅助源保留空文本，用来明确标记「本行没有翻译/音译」。
    if (!times.length || (!keepEmpty && !text)) continue;
    for (const t of times) out.push({ t, text });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const parseBlock = (src: string) => parseTimedBlock(src, false);

/** 辅助源按时间解析；`//`/空行保留为空串，供匹配时阻断邻近行借文本。 */
export function parseTimedAux(src: string): LyricLine[] {
  return parseTimedBlock(src ?? "", true);
}

/** 辅助行（翻译 / 音译同一套路）一对一挂到主歌词行。
 *  每条辅助源最多匹配一行，每行最多接收一条；显式空占位也参与匹配，
 *  所以上一行的翻译不会被借给没有翻译的下一行。 */
function attachAux(base: LyricLine[], src: string | undefined, field: "trans" | "roma") {
  if (!base.length) return;
  const aux = parseTimedAux(src ?? "");
  if (!aux.length) return;
  const matched = new Map<LyricLine, { d: number; text: string }>();
  for (const line of aux) {
    let best: LyricLine | undefined;
    let bd = 1.5; // 秒差容忍
    for (const b of base) {
      const d = Math.abs(b.t - line.t);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) continue;
    const prev = matched.get(best);
    // 同一主行有多条候选时取时间最近的一条；等距时占位（空串）优先阻断。
    if (!prev || bd < prev.d || (bd === prev.d && !line.text && prev.text)) {
      matched.set(best, { d: bd, text: line.text });
    }
  }
  for (const [b, hit] of matched) if (hit.text) b[field] = hit.text;
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
export function pickAux(line: Pick<LyricLine, "text" | "trans" | "roma">, mode: LyricAuxMode): string {
  if (mode === "off") return "";
  const original = cleanAuxText(line.text);
  const prefer = (mode === "romanization" ? line.roma : line.trans) ?? "";
  const fallback = (mode === "romanization" ? line.trans : line.roma) ?? "";
  const aux = cleanAuxText(prefer) || cleanAuxText(fallback);
  // 上游偶尔把原文回填进 trans/roma；与主行相同就不是辅助文本，直接不显示。
  return aux && aux !== original ? aux : "";
}

export const fmtDur = (sec: number) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

// —— 导入歌词的宿主兜底转换（用户手动导入 QRC/TTML 而内置引擎解不动时）——
// 内置 AMLL 在场就走它的 parse（词级时间轴全保留）；这里只保证「行级也一定有词」：
// 把 TTML <p begin=…> 或 QRC [st,dur]<w …> 拍平成 LRC 文本，再喂给 parseLrc。
const ENT: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: " " };

function decodeEnt(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(\w+);/g, (m, k) => ENT[k] ?? m);
}

/** 上游 QRC XML 信封里的歌词属性。
 *
 * 不能写成 `"([^"]*)"`：QQ 的 `LyricContent` 是伪 XML，正文里的英文引号不一定实体化。
 * 例如 Starboy 的 `Martin "Doc" McKinney` 原样塞在属性值里，按普通属性匹配会在第一个 `"Doc"`
 * 处截断，最后只剩片头四行制作名单。这里只在「引号后是标签结束 / 下一个属性」时收口。 */
const QRC_ENVELOPE_ATTR = /\b(?:Lyrics|LyricContent)\s*=\s*"([\s\S]*?)"(?=\s*(?:\/>|>|[A-Za-z_:][\w:.-]*\s*=))/gi;

/** 抽出 QRC XML 信封中的全部歌词正文并还原实体；不是信封时返回空串。 */
export function extractQrcPayload(src: string): string {
  return [...String(src ?? "").matchAll(QRC_ENVELOPE_ATTR)].map((m) => decodeEnt(m[1])).join("\n");
}

function toTs(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `[${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}]`;
}

/** TTML/AMLL 歌词时间：`hh:mm:ss.SSS` / `mm:ss.SS` / `12.5s` / `12500ms` / 裸秒。 */
function ttmlSec(v: string | undefined): number {
  const t = String(v ?? "").trim();
  if (!t) return NaN;
  const colon = /^(\d+):(\d{1,2})(?::(\d{1,2}))?([.\d]*)$/.exec(t);
  if (colon) {
    const h = t.split(":").length === 3 ? Number(colon[1]) : 0;
    const m = t.split(":").length === 3 ? Number(colon[2]) : Number(colon[1]);
    const s = t.split(":").length === 3 ? Number(colon[3]) : Number(colon[2]);
    const frac = Number(t.split(":").length === 3 ? colon[4] : colon[3]) || 0;
    return h * 3600 + m * 60 + s + frac;
  }
  if (/ms$/.test(t)) return Number(t.slice(0, -2)) / 1000;
  if (/s$/.test(t)) return Number(t.slice(0, -1));
  return Number(t);
}

export function ttmlToLrc(src: string): string {
  const out: string[] = [];
  for (const m of src.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const begin = /begin\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    const t = ttmlSec(begin);
    if (!Number.isFinite(t)) continue;
    const text = decodeEnt(m[2].replace(/<[^>]*>/g, "").split("\n").map((x) => x.trim()).filter(Boolean).join(" ")).trim();
    if (text) out.push(`${toTs(t)}${text}`);
  }
  out.sort((a, b) => Number(a.slice(1, a.indexOf(":"))) - Number(b.slice(1, b.indexOf(":"))));
  return out.join("\n");
}

/** QRC（XML 信封或纯文本 [st,dur] 行）→ 行级 LRC：词标记拍平成整行文本。 */
export function qrcToLrc(src: string): string {
  let body = src;
  if (/<LyricContent\s*=|Lyrics\s*=/i.test(src)) {
    body = extractQrcPayload(src);
  }
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
    if (line) {
      const text = decodeEnt(line[3].replace(/<\/?[wW]\b[^>]*>/g, "")).trim();
      if (text) out.push(`${toTs(Number(line[1]) / 1000)}${text}`);
    } else {
      const qq = /^\[(\d+),(\d+)\]/.test(raw.trim()); // 纯行时间戳的假 QRC 元数据行：丢
      if (!qq && /^\[\d{1,2}:\d{2}/.test(raw.trim())) out.push(raw.trim());
    }
  }
  return out.join("\n");
}

/** 按格式把导入文本拍平成 parseLrc 读得懂的 LRC；format=lrc/未知格式原样返回。 */
export function coerceLyricToLrc(raw: string, format: string): string {
  if (!raw || !format || format === "lrc") return raw;
  if (format === "ttml") return ttmlToLrc(raw);
  if (format === "qrc") return qrcToLrc(raw);
  return raw;
}
