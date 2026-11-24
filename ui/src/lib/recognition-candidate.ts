// Quaver — 听歌识曲候选 → 播放器 Song 的纯映射：
// 识别中继给的是扁平候选，弹窗和播放链路要的是 Song；这层转换单测可直接跑。
import type { Song } from "../player";
import type { RecognitionCandidate } from "./song-recognition";

export type RecognitionSong = {
  key: string;
  song: Song;
  keyword: string;
};

/**
 * 把识别候选转成现有播放/搜索链路认识的 Song。
 * 无 QQ songmid 时 song.mid 保持空串，调用方据此走搜索而不是直接起播。
 * @param candidate - /api/recognition/match 归一化后的候选
 * @param index - 候选顺序，用于稳定 DOM key
 * @returns 播放器 Song 与搜索关键词
 */
export function recognitionSong(candidate: RecognitionCandidate, index: number): RecognitionSong {
  return {
    key: `${candidate.id || candidate.mid || candidate.title}#${index}`,
    song: {
      mid: candidate.mid ?? "",
      name: candidate.title,
      singer: candidate.artists.map((name) => ({ name })),
      album: { name: candidate.album ?? "", mid: "", pmid: "" },
      interval: 0,
    },
    keyword: [candidate.title, ...candidate.artists].filter(Boolean).join(" "),
  };
}
