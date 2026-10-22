// QRCKana —— QRC 逐字歌词的「振假名注音」（[kana: ...] 标签）解析与对齐
//
// 算法移植自 SPlayer-Dev/lyric-kit（AGPL-3.0）`src/utils/kana.ts`（对齐口径 v0.6.1）+
// QRC 解析器（`src/parse/qrc.ts`）里对 `[kana:...]` 元数据标签的处理，只取 **QRCKana
// 这一套系统**：KRC/YRC/LyS/SRT/ASS 等其余格式的解析、序列化、语言推断一概不引入。
// 移植而非加依赖的理由：宿主只需要这一小块纯函数，拖进整个 lyric-kit 会把用不上的
// 解析器一起打进包。移植的两处有意保留的差异：
//   ① 标签前缀匹配放宽成 `/^\[kana:/i`（上游只认小写；大小写混写的文件确实存在）；
//   ② 不做 `cleanKangxi`（康熙部首归一化）—— 宿主这条管线不引那个步骤，注音基础字符判定
//      因此按原文字符走，与上游未开该选项时一致。
// 行为口径由 scripts/verify-kana.ts 守住：黄金样例取自上游 tests/kana.spec.ts，
// 并在本地装有 lyric-kit 时与上游实现做逐字节差分对照。
//
// 这套系统在解决什么问题：QQ 音乐（以及酷狗）的逐字歌词文件里，日文歌的汉字上方那行
// 小假名（振假名 / ふりがな）**不在歌词正文里**，而是附在一条独立的 `[kana: ...]` 标签行里，
// 形如 `[kana:2かい1つ3ほん...]` —— 数字 = 这段读音覆盖几个汉字，紧跟的假名 = 读音，
// `(起始,时长)` = 假名自己也被切了逐字时间轴（用于让注音跟着字一起扫色）。
// 歌词正文（`[st,dur]字(st,dur)…`）里只有汉字，所以注音必须按「第几个可注音字符」对齐回去。
//
// 与「音译（roma）」的边界（红线，别混）：
//   - `roma` / `romanLyric` = romaji/拼音那一路**行级**辅助行，位置在歌词**下方**，与翻译
//     共用一行（见 src/lyric.ts:pickAux 的档位规则）。
//   - 本文件的 ruby = 日文振假名，**词上方**的逐词注音，带自己的时间轴，与档位规则无关。
//   两者数据来源、版面位置、语义都不同：音译永远不该挂到这里，振假名也不该被档位挑走。
//
// 零依赖、零 DOM —— 纯函数，可直接在 Node 里跑单测（scripts/verify-kana.ts）。

/** 注音片段时间轴；结构上等同 SDK 的 SparkleKaraokeRuby 与 AMLL 的 LyricWordBase */
export interface KanaRubySpan {
  word: string;
  /** 毫秒 */
  startTime: number;
  /** 毫秒 */
  endTime: number;
}

/** 本模块认得的「可注音的词」最小形状（SparkleKaraokeWord / AMLL LyricWord 都满足） */
export interface KanaRubyWord extends KanaRubySpan {
  /** 词级注音（振假名）；对齐结果写在这里 */
  ruby?: KanaRubySpan[];
}

/** 可注音的行（只要 words 就行，不挑具体类型） */
export interface KanaRubyLine {
  words: KanaRubyWord[];
}

/** 一条 `[kana: ...]` 里的单个注音单元 */
export interface KanaUnit {
  /** 对应的连续可注音字符数量（标签里的数字） */
  kanjiCount: number;
  /** 注音纯文本 */
  kanaText: string;
  /** 假名自身带 `(start,dur)` 细分时间轴时的片段；没有则 undefined */
  spans?: KanaRubySpan[];
}

/** 可被振假名注音的「基础字符」：CJK 统一表意文字（含扩展 A）+ 叠字符 々 + 〆。
 *  平/片假名自己不算（它们是注音的素材，不是被注音的对象），拉丁与空格也不算。 */
const KANA_BASE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3005\u3006]/;

/** 需要「按 token 而不是按字符」计数的数字（半角与全角）：歌词里的「22/7」这类
 *  计数读法（にじゅうに／さんさん）是一整个数字串对一个注音，逐字符数会把后面的
 *  假名整体往后挤位。移植上游 v0.6.1 的口径：连续数字串 = 一个基字符位。 */
const DIGIT_REGEX = /[0-9０-９]/;

/** 元数据标签行：`[key:value]`（大小写不敏感的 key），kana 只是其中一种 */
const META_TAG_RE = /^\[([a-zA-Z]+):(.*?)]$/;

/** 从歌词文本里取 `[kana: ...]` 标签（可能有主歌词与 XML 信封解出的多种形状）。
 *  返回**最后**一条命中的标签原文（含 `[kana:` 前后缀），没有则空串。 */
export function extractKanaTag(text: string): string {
  let found = "";

  for (const raw of (text ?? "").split(/\r?\n/)) {
    const trimmed = raw.trim();

    if (!trimmed.startsWith("[kana:") && !trimmed.startsWith("[KANA:")) continue;
    const m = META_TAG_RE.exec(trimmed);

    if (m && m[1].toLowerCase() === "kana") found = trimmed;
  }

  return found;
}

/** 把 `[kana: ...]` 标签行从歌词正文里摘掉：它不是歌词，留着会被逐字解析器当成噪声行。 */
export function stripKanaTag(text: string): string {
  if (!text) return text;

  if (!/\[kana:/i.test(text)) return text;

  return text
    .split(/\r?\n/)
    .filter((raw) => {
      const trimmed = raw.trim();
      const m = META_TAG_RE.exec(trimmed);

      return !(m && m[1].toLowerCase() === "kana");
    })
    .join("\n");
}

/**
 * 解析 `[kana: ...]` 标签内容为注音单元序列。
 *
 * 语法（与 lyric-kit 一致）：`[kana:` 之后是若干段「`1-9` 的数字 + 假名文本」，
 * 数字表示这段读音覆盖几个可注音字符；假名文本里可以插 `(起始毫秒,时长毫秒)`，
 * 表示**前面那个假名**自己的时间轴（多个假名各自带括号 → 整段注音被切成多个 span）。
 * 非假名的其他字符（空格、标点）原样进 kanaText。数字只认单个字符（覆盖 10 个字以上
 * 的情况在真实数据里不存在，宁可不猜也别把正文吃掉）。
 */
export function parseKanaUnits(rawKanaTag: string): KanaUnit[] {
  const content = (rawKanaTag ?? "").replace(/^\[kana:/i, "").replace(/\]$/, "");
  const units: KanaUnit[] = [];
  let charIndex = 0;

  while (charIndex < content.length) {
    const currentChar = content[charIndex];

    if (currentChar >= "1" && currentChar <= "9") {
      const kanjiCount = parseInt(currentChar, 10);
      charIndex++;
      let kanaText = "";
      const spans: KanaRubySpan[] = [];

      while (charIndex < content.length) {
        const nextChar = content[charIndex];

        if (nextChar >= "1" && nextChar <= "9") break;

        if (nextChar === "(") {
          const closeParenIndex = content.indexOf(")", charIndex);

          if (closeParenIndex !== -1) {
            const timeSlice = content.slice(charIndex + 1, closeParenIndex);
            const commaIndex = timeSlice.indexOf(",");

            if (commaIndex !== -1) {
              const startMs = parseInt(timeSlice.slice(0, commaIndex), 10);
              const durationMs = parseInt(timeSlice.slice(commaIndex + 1), 10);

              if (!Number.isNaN(startMs) && !Number.isNaN(durationMs)) {
                // 括号属于**紧挨在它前面那个假名**的时间轴
                const targetChar = kanaText[kanaText.length - 1] || "";
                spans.push({ word: targetChar, startTime: startMs, endTime: startMs + durationMs });
              }
            }

            charIndex = closeParenIndex + 1;
            continue;
          }
        }

        kanaText += nextChar;
        charIndex++;
      }

      units.push({ kanjiCount, kanaText, spans: spans.length > 0 ? spans : undefined });
    } else {
      charIndex++;
    }
  }

  return units;
}

/**
 * 把 `[kana: ...]` 的注音按「第几个可注音字符」对齐挂到各行词上（原地写 `word.ruby`）。
 *
 * 对齐是**跨行**单向游标：标签里的数字序列描述的是整首歌的可注音字符流，
 * 所以先把所有行的所有字符扫成一条「可注音字符位置」列表，再按单元顺序消费。
 * 三种落点（同 lyric-kit）：
 *   ① 单元自带 `(start,dur)` 细分 → 把 spans 挂到该单元覆盖到的**第一个词**上；
 *   ② 单元只覆盖一个字符 → 若该词是多字符，按字符数线性插值出这一小段的时间；
 *   ③ 单元覆盖多个字符 → 一条注音跨 first.startTime … last.endTime，挂在第一个词上。
 * 空读音（`kanaText` 为空）也要**消费掉**对应数量的字符位（上游就是这么做的：
 * 那是「这几个字没有注音」，不是「这里什么都没发生」，错位会让后面的注音全串位）。
 */
export function applyKanaToLines(lines: KanaRubyLine[], rawKanaTag: string, timingOffset = 0): void {
  if (!rawKanaTag?.includes("[kana:")) return;
  const units = parseKanaUnits(rawKanaTag);

  if (units.length === 0) return;

  interface KanjiLocation { charIndexInWord: number; charLength: number; wordRef: KanaRubyWord }

  const kanjiLocations: KanjiLocation[] = [];

  for (const line of lines) {
    for (const wordRef of line.words) {
      const wordText = wordRef.word;
      let charIndex = 0;

      while (charIndex < wordText.length) {
        if (KANA_BASE_REGEX.test(wordText[charIndex])) {
          kanjiLocations.push({ charIndexInWord: charIndex, charLength: 1, wordRef });
          charIndex++;
          continue;
        }

        // 连续数字串只占一个基字符位（「22/7」= 两个 token，不是三个字符）
        if (DIGIT_REGEX.test(wordText[charIndex])) {
          const firstNumberIndex = charIndex;

          while (charIndex < wordText.length && DIGIT_REGEX.test(wordText[charIndex])) charIndex++;
          kanjiLocations.push({ charIndexInWord: firstNumberIndex, charLength: charIndex - firstNumberIndex, wordRef });
          continue;
        }

        charIndex++;
      }
    }
  }

  if (kanjiLocations.length === 0) return;

  let pointer = 0;

  for (const unit of units) {
    if (pointer >= kanjiLocations.length) break;
    const matchCount = Math.min(unit.kanjiCount, kanjiLocations.length - pointer);
    const targetKanjiLocs = kanjiLocations.slice(pointer, pointer + matchCount);
    pointer += matchCount;

    if (!unit.kanaText) continue;

    if (unit.spans && unit.spans.length > 0) {
      const primaryWord = targetKanjiLocs[0].wordRef;
      // 标签内的音节时间轴是绝对毫秒；只有「外部注音」那类调用才需要整体平移（timingOffset）
      (primaryWord.ruby ??= []).push(...unit.spans.map((span) => ({
        ...span,
        startTime: Math.max(0, span.startTime + timingOffset),
        endTime: Math.max(0, span.endTime + timingOffset),
      })));
      continue;
    }

    if (targetKanjiLocs.length === 1) {
      const singleLoc = targetKanjiLocs[0];
      const targetWord = singleLoc.wordRef;
      const totalChars = targetWord.word.length;
      let rubyStartTime = targetWord.startTime;
      let rubyEndTime = targetWord.endTime;

      if (totalChars > 1 && rubyEndTime > rubyStartTime) {
        const charDuration = (rubyEndTime - rubyStartTime) / totalChars;
        rubyStartTime = Math.round(targetWord.startTime + singleLoc.charIndexInWord * charDuration);
        rubyEndTime = Math.round(targetWord.startTime + (singleLoc.charIndexInWord + singleLoc.charLength) * charDuration);
      }

      (targetWord.ruby ??= []).push({ word: unit.kanaText, startTime: rubyStartTime, endTime: rubyEndTime });
    } else {
      const firstLoc = targetKanjiLocs[0];
      const lastLoc = targetKanjiLocs[targetKanjiLocs.length - 1];
      const targetWord = firstLoc.wordRef;
      const rubyStartTime = firstLoc.wordRef.startTime;
      const rubyEndTime = lastLoc.wordRef.endTime;
      (targetWord.ruby ??= []).push({ word: unit.kanaText, startTime: rubyStartTime, endTime: Math.max(rubyEndTime, rubyStartTime) });
    }
  }
}

/** 一行里是否有注音（渲染方据此决定要不要给词上方留高度） */
export const lineHasRuby = (line: KanaRubyLine): boolean =>
  line.words.some((w) => (w.ruby?.length ?? 0) > 0);

/** 整首的注音词数量（诊断/断言用） */
export const countRubyWords = (lines: KanaRubyLine[]): number =>
  lines.reduce((n, l) => n + l.words.filter((w) => (w.ruby?.length ?? 0) > 0).length, 0);
