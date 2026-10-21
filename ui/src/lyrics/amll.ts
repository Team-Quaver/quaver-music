// Quaver —— 内置歌词引擎：Apple Music-like Lyrics（AMLL）
//
// **正在播放页的默认歌词渲染器**，从「预装 Sparkle 插件」升格为宿主内置功能：
// 逐字（QQ 音乐 QRC —— 含上游 qrc=1 返回的 XML 信封、纯文本 QRC、TTML）与行级（普通 LRC）
// 都交给 @applemusic-like-lyrics/core 的 DomLyricPlayer 渲染；LRC 没有词级时间轴，
// 按「整行一个音节」喂进去，由 AMLL 自己的行级扫色 / 滚动 / 弹簧排版接管。
//
// 为什么内置而不是插件：宿主本来就没有第二套完整歌词渲染，把唯一实现做成「可停用的插件」
// 只能靠 required 标志 + 中央闸口 + 设置页锁开关这三层补丁去维持「摘不掉」，
// 而「摘不掉的插件」本身就是矛盾的抽象。现在它是宿主能力，注册表把它放在**兜底位**：
// 插件仍可用 registerKaraokeProvider 覆盖内置引擎（SDK 的歌词能力一条没减，
// 未来移植 folia-major 那类播放器效果就走这条路），没插件时内置 AMLL 恒在。
//
// 数据侧另有一件事：QQ/KG 的日文逐字歌词把振假名放在独立的 `[kana: ...]` 标签里
// （QRCKana 系统，移植自 SPlayer-Dev/lyric-kit，见 ./qrc-kana.ts）。本模块负责
// 把它解出来挂成词级 `ruby`，AMLL 原生就在词上方渲染注音。
//
// 上游 roma 字段是音译（romaji/拼音，词级 QRC 与行级 LRC 都可能）：归一成行级 romanLyric，
// 与翻译共用歌词**下方**的子行（Apple Music 的排版没有「词上方 romaji」）。两路各存一份，
// 上屏的那一路由宿主「翻译选项」决定 —— 规则只有 src/lyric.ts:pickAux 一份，这里直接复用，
// 不再像插件时代那样在 vendor/Sparkle 里抄第二份。音译与振假名是两回事：前者进子行、
// 后者进 ruby，互不串门。
//
// 无独立配置面：逐字扫色恒开，注音随数据出现；翻译/音译档位与「歌词延迟」都归宿主 ⋮ 菜单，
// 经 render ctx 的闭包（lyricAux() / lyricDelay()）透传进来，本模块不接受构造参数、不碰存储。
// 延迟口径：正 = 歌词更晚出现 —— 驱动时钟取 time() − lyricDelay()（延迟是用户按曲微调，
// 不属于宿主对传输延迟的固定补偿，故不掺进 time()，由渲染方自己扣；契约见 SDK 注释）。
//
// 上游 qrc=1 的 lyric 字段是 3DES+zlib 解密后的 QRC XML：
//   <?xml …><QrcInfos>…<Lyric_1 Lyrics="[st,dur]词(st,dur)…&#10;…"/>…</QrcInfos>
// AMLL 的 parseQrc 只认纯文本 QRC（行首 [st,dur]），所以 XML 信封要先抽 Lyrics 属性
// 并解码 HTML 实体；QRC 本身不带翻译，翻译（普通 LRC）按行起始时间就近对齐。
import { parseLrc, parseQrc, parseTTML, type LyricLine as AmlLyricLine } from "@applemusic-like-lyrics/lyric";
import { LayoutAlignAnchor, LayoutReason, LyricPlayer, type LyricLine as CoreLyricLine } from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";
import type { SparkleKaraokeLine, SparkleKaraokeProvider, SparkleKaraokeRenderCtx } from "@quaver/sparkle";
import type { LyricAuxMode } from "../lib/prefs";
import { cleanAuxText, extractQrcPayload, pickAux } from "../lyric";
import { applyKanaToLines, extractKanaTag, stripKanaTag } from "./qrc-kana";

// —— 解析 ——

/** 逐字行的内部表示：就是 SDK 的 SparkleKaraokeLine。AMLL 的 lyric 包解析出的行与它
 *  结构兼容，唯一的差别是 lyric 的类型声明里没有 `ruby` —— 振假名注音由 QRCKana 在对齐时
 *  写进词上（core 的 LyricWord 有 ruby，渲染侧认这个字段），所以转换只在这一处发生。 */
type KaraLine = SparkleKaraokeLine;
/** 整形行级时用得上的最小形状（AMLL 行与 KaraLine 都满足） */
interface RawLine { startTime: number; words: Array<{ word: string }>; isBG?: boolean; isDuet?: boolean }

function tryParseQrc(src: string): KaraLine[] | null {
  try {
    const lines = parseQrc(src) as unknown as KaraLine[];
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

/** 普通 LRC（[mm:ss.xx] 行级）。AMLL 的 parseLrc 给每行一个覆盖整行的单音节，
 *  词级时间轴为空 —— 正是行级渲染要的形状。 */
function tryParseLrc(src: string): AmlLyricLine[] | null {
  try {
    const lines = parseLrc(src);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

/** 视为「有逐字时间轴」：至少一行存在时长非零的词（纯行级时间轴的假 QRC 不算） */
const hasWordTiming = (lines: KaraLine[]) =>
  lines.some((l) => l.words.some((w) => w.endTime > w.startTime));

/** 行级收尾时长：末行没有「下一行」可用，给一段自然时长的整行扫色收尾。
 *  parseLrc 给末行的是 MAX 时间戳（≈16.6h），照单全收会让扫色慢到几乎静止。 */
const LINE_TAIL_MS = 4000;
/** 单行整行扫色的时长上限：长间奏里一行唱完后停在亮态，别拖成慢镜头 */
const LINE_MAX_MS = 12000;

/** 把任意行列表整形为**行级**（每行一个覆盖整行的音节）：普通 LRC，或没有词级时间轴
 *  的伪 QRC 都走这里。行结束 = 下一行开始（末行给固定收尾），再对超长行设上限。 */
function toLineLevel(lines: RawLine[]): SparkleKaraokeLine[] {
  const sorted = [...lines].sort((a, b) => a.startTime - b.startTime);
  return sorted.map((l, i) => {
    const text = l.words.map((w) => w.word).join("");
    const next = sorted[i + 1]?.startTime;
    let end = next ?? l.startTime + LINE_TAIL_MS;
    if (end - l.startTime > LINE_MAX_MS) end = l.startTime + LINE_MAX_MS;
    end = Math.max(end, l.startTime + 1);
    return {
      words: [{ word: text, startTime: l.startTime, endTime: end }],
      startTime: l.startTime,
      endTime: end,
      isBG: l.isBG,
      isDuet: l.isDuet,
    };
  });
}

/** 辅助源（翻译 / 音译两路）：可能是普通 LRC，音译还可能是词级 QRC 或上游 qrc=1 的
 *  XML 信封。取「整行文本」用不上词级时间轴，但必须先认得这些形状 —— 否则 parseLrc
 *  读不懂 QRC/XML，音译档就永远是空的。 */
const QRC_WORD_LINE = /^\[\d+,\d+\]/m; // 纯文本 QRC 的行首：[起始,时长]

/** 从上游 QRC 文本（可能是 XML 信封）里抽出**纯文本 QRC 正文**；不是信封就原样返回。
 *  注意：信封解出的正文里可能带着 `[kana: ...]` 注音标签 —— 那是逐字歌词的附属数据，
 *  必须在交给 parseQrc 之前摘出来（正文与注音标签共用同一套 `[...]` 行首形状）。 */
function qrcPayload(src: string): { text: string; kanaTag: string } {
  const c = (src ?? "").trim();
  if (!c) return { text: "", kanaTag: "" };
  if (/<QrcInfos|<LyricInfo/i.test(c)) {
    // QRC XML 信封：抽出全部歌词正文属性（实测为 LyricContent="…"，旧格式为 Lyrics="…"，
    // 属性内以原文换行/&#10; 分行）。提取器与宿主行级兜底共用，QQ 正文里未转义的引号也不能截断。
    const payload = extractQrcPayload(c);
    return { text: payload, kanaTag: extractKanaTag(payload) };
  }
  return { text: c, kanaTag: extractKanaTag(c) };
}

/** 逐字形态的辅助源（XML 信封 / 纯文本 QRC）；普通 LRC 返回 null，交回 parseLrc */
function parseQrcAuxSource(src: string): KaraLine[] | null {
  const c = (src ?? "").trim();
  if (!c) return null;
  const { text } = qrcPayload(c);
  if (!text.trim()) return null;
  if (/<QrcInfos|<LyricInfo/i.test(c)) return tryParseQrc(stripKanaTag(text));
  return QRC_WORD_LINE.test(text) ? tryParseQrc(stripKanaTag(text)) : null;
}

/** 辅助源 → 行列表：先按逐字解，解不出来退回行级 LRC；空源给空表 */
function auxLines(src: string): KaraLine[] {
  const c = (src ?? "").trim();
  if (!c) return [];
  const q = parseQrcAuxSource(c);
  if (q?.length) return q;
  try { return parseLrc(c); } catch { return []; }
}

/** 按行起始时间就近取辅助文本（1.5s 容忍，同宿主 src/lyric.ts 的口径）。
 *  `//` 是上游的「本行无译文/音译」占位：跳过它再找最近的真文本，不能让它上屏，
 *  也不能让一条占位挡住同时间附近的真实辅助行。 */
function nearestAuxText(aux: RawLine[], line: { startTime: number }): string {
  let best = "";
  let bd = 1500;
  for (const t of aux) {
    const text = cleanAuxText(t.words.map((w) => w.word).join(""));
    if (!text) continue;
    const d = Math.abs(t.startTime - line.startTime);
    if (d < bd) { bd = d; best = text; }
  }
  return best;
}

/** 翻译与音译都挂成**行级**辅助文本（translatedLyric / romanLyric），显示哪一路交给档位。
 *  音译不挂词上 Ruby：romaji/拼音是「整行换一套读音」，Apple Music 的排版里它和翻译共用
 *  歌词下方那一行子行（AMLL 的 lyricSubLine）；词上方的 Ruby 是日文振假名那种逐词注音
 *  （= QRCKana 的产物，见 ./qrc-kana），语义不同，别把两路混进同一个位置。 */
function alignAux(
  lines: Array<{ startTime: number; translatedLyric?: string; romanLyric?: string }>,
  translation: string,
  romanization: string,
) {
  const tr = auxLines(translation);
  const ro = auxLines(romanization);
  if (!tr.length && !ro.length) return;
  for (const l of lines) {
    if (tr.length) { const t = nearestAuxText(tr, l); if (t) l.translatedLyric = t; }
    if (ro.length) { const r = nearestAuxText(ro, l); if (r) l.romanLyric = r; }
  }
}

/** 原始歌词 → AMLL 行；认不出的格式返回 null。
 *
 *  逐字形态（XML 信封 / TTML / 纯文本 QRC）**有词级时间轴**时直接返回逐字行；
 *  否则按行级处理：普通 LRC（本体就是 [mm:ss.xx]）整形成单音节覆盖整行，交给 AMLL
 *  的行级渲染；没有词级时间轴的伪 QRC 同样折成行级，行为与老宿主行级视图一致。
 *
 *  QRC 的 `[kana: ...]` 注音在两条分支都挂回词上（行级分支里退化成「整行一条注音」，
 *  因为整形后每行只剩一个覆盖全行的音节 —— 时间与位置仍然正确，只是不再逐字）。 */
function parseKaraoke(content: string, translation: string, romanization = ""): SparkleKaraokeLine[] | null {
  const c = (content ?? "").trim();
  if (!c) return null;
  const kanaTag = extractKanaTag(c); // 纯文本 QRC：标签就在正文里
  // ① 逐字候选：XML 信封 / TTML / 纯文本 QRC
  let word: KaraLine[] | null = null;
  let envelopeKana = kanaTag;
  if (/<QrcInfos|<LyricInfo/i.test(c)) {
    const { text, kanaTag: k } = qrcPayload(c);
    envelopeKana = k;
    if (text.trim()) word = tryParseQrc(stripKanaTag(text));
  } else if (/<tt[\s>]/i.test(c)) {
    try {
      const r = parseTTML(c);
      word = r?.lines?.length ? r.lines : null;
    } catch {
      word = null;
    }
  } else {
    word = tryParseQrc(stripKanaTag(c));
  }
  const kana = kanaTag || envelopeKana;
  if (word?.length && hasWordTiming(word)) {
    if (kana) applyKanaToLines(word, kana);
    alignAux(word, translation, romanization);
    return word;
  }
  // ② 行级：优先普通 LRC，其次是没有词级时间轴的伪 QRC
  const lrc = tryParseLrc(stripKanaTag(c));
  const lineLevel = toLineLevel(lrc?.length ? lrc : (word ?? []));
  if (!lineLevel.length) return null;
  if (kana && !lrc?.length) applyKanaToLines(lineLevel, kana); // 只有 QRC 本体才带注音标签
  alignAux(lineLevel, translation, romanization);
  return lineLevel;
}

// —— 渲染 ——

/** 辅助行取哪一路：档位规则与行级视图**共用** src/lyric.ts 的 pickAux（唯一一份实现）。 */
const pickAuxLine = (l: SparkleKaraokeLine, mode: LyricAuxMode): string =>
  pickAux({ trans: l.translatedLyric, roma: l.romanLyric }, mode);

/** SDK 行 → core 渲染行（显式补齐 core 必填字段）。
 *  辅助行只占**一格**：挑好的一路写进第一子行 translatedLyric，romanLyric 恒空。
 *  AMLL 两个子行同样式、空则塌缩，固定用一格 → 切档时辅助行不上下跳，也不会两路同时上屏。
 *  逐字行原样喂进去（QRC/TTML 的词级时间轴驱动逐词扫色；LRC 本就是单音节覆盖整行），
 *  词级 `ruby`（QRCKana 的振假名）一并透传 —— core 原生在词上方渲染注音。 */
function toCoreLines(lines: SparkleKaraokeLine[], mode: LyricAuxMode): CoreLyricLine[] {
  return lines.map((l) => ({
    words: l.words.map((w) => {
      const core: CoreLyricLine["words"][number] = {
        word: w.word, startTime: w.startTime, endTime: w.endTime, romanWord: "",
      };
      if (w.ruby?.length) core.ruby = w.ruby.map((r) => ({ word: r.word, startTime: r.startTime, endTime: r.endTime }));
      return core;
    }),
    startTime: l.startTime,
    endTime: l.endTime,
    translatedLyric: pickAuxLine(l, mode),
    romanLyric: "",
    isBG: !!l.isBG,
    isDuet: !!l.isDuet,
  }));
}

/** 渲染中的 host → LyricPlayer 实例对照表。
 *  SDK 契约只给 render/cleanup 两件事，但宿主集成方（桌面歌词窗）需要按场景调
 *  **排版旋钮**（setAlignPosition / setHidePassedLines —— AMLL 实例方法，不在 SDK 里）。
 *  与其让集成方复制一份渲染实现（口径必然漂移），不如从这一处把实例递出去 ——
 *  渲染主体仍是唯一一份，桌面歌词与正在播放页永远吃同一个引擎。 */
export const amllPlayerByHost = new WeakMap<HTMLElement, LyricPlayer>();

/** 接管歌词容器：DomLyricPlayer + 自驱 rAF 时钟。
 *  宿主 notify 只有 4Hz，逐字扫色要逐帧时间；播放态/翻译开关/展开收起每帧轮询
 *  ctx 闭包（读到的永远是当前态），收起时停表冻结、展开即恢复。 */
function renderAmll(host: HTMLElement, lines: SparkleKaraokeLine[], ctx: SparkleKaraokeRenderCtx): () => void {
  const player = new LyricPlayer();
  amllPlayerByHost.set(host, player);
  const el = player.getElement();
  el.style.position = "absolute";
  el.style.inset = "0";
  el.style.fontFamily = "inherit";
  host.append(el);
  player.setEnableBlur(true);   // 非当前行距离模糊，对齐行级视图的模糊语言
  player.setEnableScale(true);

  // 隐藏已播放行：由宿主按设置透传；滚轮浏览时宿主会临时关掉，行不会从布局里消失。
  let hidePassed = ctx.hidePassedLines?.() ?? false;
  player.setHidePassedLines(hidePassed);

  // 隐藏已播放行时，当前行顶边对齐封面顶边。锚位由宿主按实际几何算出（0..1）；
  // 缺省 / null 时保持 AMLL 原本的居中锚定，桌面歌词窗等其它宿主不受影响。
  let alignTop: number | null = null;
  const applyTopAnchor = () => {
    const want = ctx.lyricTopAnchor?.();
    const next = typeof want === "number" && Number.isFinite(want)
      ? Math.max(0, Math.min(1, want)) : null;
    if (next === null && alignTop === null) return;
    if (next !== null && alignTop !== null && Math.abs(next - alignTop) < 0.002) return;
    alignTop = next;
    if (next === null) {
      player.setAlignAnchor(LayoutAlignAnchor.Center);
      player.setAlignPosition(0.35);
    } else {
      player.setAlignAnchor(LayoutAlignAnchor.Top);
      player.setAlignPosition(next);
    }
    player.calcLayout(LayoutReason.ConfigChange);
  };

  // 按歌曲「歌词延迟」（ctx 透传，宿主必给；旧宿主语义下缺省 0 = 不调整）
  const delayMs = () => ctx.lyricDelay?.() ?? 0;
  let shownMode = ctx.lyricAux();
  player.setLyricLines(toCoreLines(lines, shownMode), ctx.time() - delayMs());
  applyTopAnchor();

  // —— 时钟去抖 ——
  // 引擎传输的 position 是外推时钟（~4Hz 快照重同步），重同步瞬间可能回跳几十毫秒；
  // AMLL 对任何倒退都无条件按跳转处理（间奏点/滚动全重置）→ 小幅倒退钳平为原值，
  // 只有超过阈值（真·回退 seek）才放行倒退。
  let lastFedMs = -1;
  let lastDelay = delayMs();
  const feedTime = (): number => {
    const d = delayMs();
    const raw = ctx.time() - d;
    // 用户在 ⋮ 菜单调延迟（±0.1s 一档）是**意图性**的时钟挪动：直接重锚并重喂，
    // 不能让它落进下面那条「重同步回跳」的钳平带 —— 0.1s 倒退会被钳成原地不动，
    // 歌词时钟先卡住 ~0.5s 再原样续跑，调了等于没调。
    if (d !== lastDelay) { lastDelay = d; lastFedMs = raw; return raw; }
    if (lastFedMs >= 0 && raw < lastFedMs && raw > lastFedMs - 250) return lastFedMs;
    lastFedMs = raw;
    return raw;
  };
  // 播放态只在变化时同步（每帧反复 pause/resume 会持续扰动 AMLL 的跳转推算）
  let lastPaused: boolean | null = null;
  const applyPlayState = () => {
    const p = ctx.paused();
    if (p === lastPaused) return;
    lastPaused = p;
    if (p) player.pause(); else player.resume();
  };
  applyPlayState();

  const ac = new AbortController();
  player.addEventListener("line-click", (e: Event) => {
    const ce = e as MouseEvent & { line: { getLine(): { startTime: number } } | undefined };
    // 歌词行自己的时间轴没被动过，动的是驱动时钟（− delay）：要点「屏幕上这行」就得把
    // delay 加回去换回真实播放位（口径同宿主行级视图的行点击；ctx.seek 收真实毫秒）
    const ms = ce.line?.getLine()?.startTime ?? 0;
    if (Number.isFinite(ms)) ctx.seek(Math.max(0, ms + delayMs()));
  }, { signal: ac.signal });

  let raf = 0;
  let lastFrame = 0;
  let running = false;
  function tick(now: number) {
    raf = 0;
    if (!ctx.expanded()) { running = false; lastFrame = 0; return; } // 收起：冻结渲染循环
    const dt = lastFrame ? Math.min(now - lastFrame, 50) : 16.7;    // 帧增量钳制（标签页切回等）
    lastFrame = now;
    const wantMode = ctx.lyricAux();
    if (wantMode !== shownMode) {                                    // 翻译/音译选项变化：重建行表
      shownMode = wantMode;
      player.setLyricLines(toCoreLines(lines, shownMode), feedTime());
    }
    const wantHide = ctx.hidePassedLines?.() ?? false;
    if (wantHide !== hidePassed) {
      hidePassed = wantHide;
      player.setHidePassedLines(wantHide);
    }
    applyPlayState();
    player.setCurrentTime(feedTime());
    player.update(dt);
    raf = window.requestAnimationFrame(tick);
  }
  function syncRunning() {
    // 收起时 tick 自停；重新展开必须由宿主 notify 唤醒（否则 AMLL 永久冻结：
    // 时间不跟、歌词不刷，seek 后滚动状态错乱）
    if (ctx.expanded() && !running) { running = true; lastFrame = 0; raf = window.requestAnimationFrame(tick); }
  }
  syncRunning();
  const onHostNotify = () => {
    syncRunning();
    applyTopAnchor();
  };
  const offNotify = ctx.onNotify(onHostNotify);
  const anchorObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => applyTopAnchor()) : null;
  anchorObserver?.observe(host);
  const cover = host.closest(".np")?.querySelector<HTMLElement>(".np-cover");
  if (cover) anchorObserver?.observe(cover);

  return () => {
    anchorObserver?.disconnect();
    amllPlayerByHost.delete(host);
    offNotify();
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    ac.abort();
    player.dispose();
    el.remove();
  };
}

/** 宿主内置的歌词提供器（注册表把它放在插件之后：**没有插件覆盖时**由它渲染歌词）。
 *  不注册 `enabled()` —— 内置引擎没有「关掉」这一档；想换渲染器由插件注册自己的提供器顶掉它。 */
export const builtinKaraokeProvider: SparkleKaraokeProvider = {
  parse: parseKaraoke,
  render: renderAmll,
};

