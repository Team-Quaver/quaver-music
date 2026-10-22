// Quaver — 歌词繁简转换（OpenCC 词典，opencc-js 按方向惰性分包）。
//
// 档位是 [Lyrics] ChineseConvert（off/simplified/traditional），真相在 quaver.conf，本模块只做
// 「档位 → 转换函数」的惰性装载与缓存。词典体积不对称：繁→简以字符级映射为主（~110KB），
// 简→繁要带短语级歧义处理（头发/頭發 vs 發财，~1MB）—— 所以两个方向各自动态 import，
// vite 各自切 chunk，只有用户真选了那一档、歌词里真见了汉字，才付出网络与解析成本。
//
// 转换只发生在「歌词文本进入播放器」的那一刻（src/player.ts 各拉取通路调 cjkConvert）：
// 磁盘缓存 / 手动导入 / 侧车 LRC 的原文一律不动，关掉档位即回原样。
// 对 QRC XML / TTML 整段文本做转换是安全的：标签、属性、时间戳、实体全是 ASCII，词典碰不到；
// 短语匹配也不会跨标签粘连 —— ASCII 段不构成词典词，边界天然断开。
//
// 转换范围：歌词正文 + 翻译（两档都跟着走）；音译（romaji/拼音）属拉丁转写，不碰。
import { getChineseConvert } from "./prefs";

type Converter = (s: string) => string;

// CJK 汉字面（含扩展 A 与兼容表意文字）：不含就跳过转换，也别为纯英文/纯假名歌加载词典。
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

let cachedMode = "";
let cached: Converter | null = null;
let pending: { mode: string; p: Promise<Converter | null> } | null = null;

/** 档位换了/重置了：丢缓存，下次用到再按新档惰性装载（不预热 —— 没人看歌词就不该拉词典）。 */
export function resetCjkConverter(): void {
  cachedMode = "";
  cached = null;
  pending = null;
}

/** 文本是否值得进转换器（含汉字才转；纯 ASCII/假名直接原样）。 */
export function cjkConvertRelevant(text: string): boolean {
  return CJK_RE.test(text);
}

function ensure(mode: string): Promise<Converter | null> {
  if (mode === "off") return Promise.resolve(null);

  if (cached && cachedMode === mode) return Promise.resolve(cached);

  if (pending && pending.mode === mode) return pending.p;

  const loader = (async (): Promise<Converter | null> => {
    try {
      if (mode === "traditional") {
        const { Converter } = await import("opencc-js/cn2t");
        cached = Converter({ from: "cn", to: "t" });
      } else {
        const { Converter } = await import("opencc-js/t2cn");
        cached = Converter({ from: "t", to: "cn" });
      }

      cachedMode = mode;

      return cached;
    } catch (e) {
      console.warn("quaver: 繁简词典加载失败，本曲按原文显示", e);

      return null;
    }
  })();

  pending = { mode, p: loader };
  // 落定后只撤「仍在途的就是这一个」：等待间可能已 reset/换档挂上新的，不能误清
  const settle = () => { if (pending && pending.p === loader) pending = null; };

  void loader.then(settle, settle);

  return loader;
}

/** 按当前档位转换一段歌词文本。off / 无汉字 / 词典加载失败 → 原样返回（永不阻断歌词链路）。 */
export async function cjkConvert(text: string): Promise<string> {
  if (!text) return text;
  const mode = getChineseConvert();

  if (mode === "off" || !cjkConvertRelevant(text)) return text;
  const fn = await ensure(mode);

  // 双保险：await 期间档位可能又切走了，按当前值说话
  if (!fn || getChineseConvert() !== mode) return text;

  return fn(text);
}
