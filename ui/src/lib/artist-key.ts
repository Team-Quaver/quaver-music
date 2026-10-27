// Quaver — 歌手名归一键（繁简统一，不跟随歌词显示档位）。
//
// 歌手分类必须把「周杰倫」与「周杰伦」认成同一个人。这里固定走 OpenCC 的
// 繁→简词典，而不是读 [Lyrics] ChineseConvert：歌词显示档位可以关掉或切成繁体，
// 但分类索引不能因此一分为二。
//
// t2cn 词典约 110KB，opencc-js 按需动态 import；只有真正打开「歌手分类」时才拉取。
import type { ConverterFunction } from "opencc-js";

export interface ArtistIdentity {
  /** 归并键：简体 + NFKC + 空白折叠 + 小写 */
  key: string;
  /** 展示名：简体，保留拉丁字母大小写与原始空白节奏 */
  name: string;
}

const cache = new Map<string, Promise<ArtistIdentity>>();
let converter: ConverterFunction | null = null;
let converterFlight: Promise<ConverterFunction | null> | null = null;

function loadConverter(): Promise<ConverterFunction | null> {
  if (converter) return Promise.resolve(converter);

  if (converterFlight) return converterFlight;

  converterFlight = (async () => {
    try {
      const { Converter } = await import("opencc-js/t2cn");
      converter = Converter({ from: "t", to: "cn" });

      return converter;
    } catch (e) {
      console.warn("quaver: 歌手名繁简词典加载失败，按原文分类", e);

      return null;
    } finally {
      converterFlight = null;
    }
  })();

  return converterFlight;
}

const keyOf = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");

/** 把一个歌手署名转成稳定身份。失败时退回原文，分类仍可用，只是不跨繁简归并。 */
export function artistIdentity(raw: string): Promise<ArtistIdentity> {
  const name = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  const hit = cache.get(name);

  if (hit) return hit;

  const pending = (async (): Promise<ArtistIdentity> => {
    const fn = await loadConverter();
    const converted = fn ? fn(name).trim().replace(/\s+/g, " ") : name;

    return { key: keyOf(converted), name: converted };
  })();

  cache.set(name, pending);

  return pending;
}
