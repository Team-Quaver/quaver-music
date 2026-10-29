// Quaver — 歌名/歌手匹配（纯逻辑，零运行期依赖）。
//
// 用途：QQ 曲目在曲库侧不可播时，按曲名/歌手到本地库与微云库里找同一首歌。
// 这里的保守程度比搜索刮削更高：宁可找不到，也不能把同名的另一首歌接上去。
// 歌名必须精确或包含（至少 4 个归一化字符）；两边都有歌手时，歌手还必须沾边。

const PUNCT = /[\s\u3000·、,，.。\-_—–~!！?？()（）[\]【】{}《》'"“”‘’/\\|:&;]/g;

export function normSongText(value: string): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(PUNCT, "");
}

/** 去掉末尾的版本括号/方括号：「歌名 (Live)」→「歌名」。只用于次级匹配。 */
export function baseSongTitle(value: string): string {
  let s = (value ?? "").trim();

  for (;;) {
    const next = s.replace(/\s*(?:\([^()]*\)|（[^（）]*）|\[[^[\]]*\]|【[^【】]*】)\s*$/, "").trim();

    if (next === s) return s;
    s = next;
  }
}

export function splitArtists(value: string): string[] {
  return (value ?? "")
    .split(/\s*(?:\/|、|,|，|&|＆|feat\.?|ft\.?)\s*/i)
    .map((x) => normSongText(x))
    .filter(Boolean);
}

export interface SongMatchWant {
  title: string;
  artist?: string;
  artists?: string[];
  album?: string;
}

export type SongMatchCandidate = SongMatchWant;

/** 0 = 不可接受；>=4 = 可以接上。返回分数便于调用方在多候选中取最佳。 */
export function songMatchScore(want: SongMatchWant, cand: SongMatchCandidate): number {
  const wt = normSongText(want.title);
  const ct = normSongText(cand.title);

  if (!wt || !ct) return 0;

  const wantBase = normSongText(baseSongTitle(want.title));
  const candBase = normSongText(baseSongTitle(cand.title));
  let score = 0;

  if (wt === ct) score = 5;
  else if (wantBase && wantBase === candBase) score = 4;
  else {
    const shorter = wt.length < ct.length ? wt : ct;

    if (shorter.length >= 4 && (wt.includes(ct) || ct.includes(wt))) score = 2;
    else return 0;
  }

  const wa = [...new Set([...(want.artists ?? []), ...splitArtists(want.artist ?? "")])];
  const ca = [...new Set([...(cand.artists ?? []), ...splitArtists(cand.artist ?? "")])];

  if (wa.length && ca.length) {
    if (wa.some((a) => ca.includes(a))) score += 3;
    else if (wa.some((a) => ca.some((b) => a.includes(b) || b.includes(a)))) score += 1;
    else return 0;
  }

  const wAlbum = normSongText(want.album ?? "");
  const cAlbum = normSongText(cand.album ?? "");

  if (wAlbum && cAlbum && (wAlbum === cAlbum || wAlbum.includes(cAlbum) || cAlbum.includes(wAlbum))) score += 0.5;

  return score;
}
