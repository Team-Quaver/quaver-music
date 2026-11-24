// Quaver — 听歌识曲匹配端点：网易云官方 AFP 音频指纹匹配 + QQ 曲库补 songmid。
// AFP 运行时与网易云 Chrome 扩展同源；匹配结果再按标题/歌手回查 QQ 曲库，
// 拿到 songmid 后候选就能直接走现有播放链路，拿不到则回退到搜索页。

const NETEASE_MATCH_URL = "https://interface.music.163.com/api/music/audio/match";
const MATCH_TIMEOUT_MS = 5000;
const SEARCH_TIMEOUT_MS = 2500;
const MIN_DURATION_SEC = 2;
const MAX_DURATION_SEC = 16;
const MAX_QQ_SEARCH = 5;

type NeteaseArtist = { name?: string };

type NeteaseSong = {
  id?: number | string;
  name?: string;
  artists?: NeteaseArtist[];
  album?: { name?: string; picUrl?: string };
  duration?: number;
  score?: number;
};

type NeteaseResultItem = {
  song?: NeteaseSong;
  startTime?: number;
  score?: number;
};

type NeteaseMatch = {
  code?: number;
  data?: { result?: NeteaseResultItem[] };
};

type QQArtist = { name?: string };

type QQSearchSong = {
  mid?: string;
  name?: string;
  title?: string;
  singer?: QQArtist[];
  album?: { name?: string; mid?: string; pmid?: string };
};

/** 中继给渲染层的归一化候选：QQ 结果带 songmid。 */
export type RecognitionMatchCandidate = {
  song: {
    id?: number | string;
    mid?: string;
    name: string;
    artists: Array<{ name: string }>;
    album: { name: string; picUrl: string };
  };
  startTime: number;
  score: number;
  order: number;
};

/** 浏览器扩展同款请求头；网易云接口不做签名，只按普通网页请求放行。 */
const MATCH_HEADERS = {
  accept: "application/json",
  referer: "https://music.163.com/",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** sidecar 地址按调用时读取：开发态要先 spawn 再 import，模块加载时读会拿到空值。 */
function sidecarBase(): string {
  return String(process.env.QUAVER_API ?? "http://127.0.0.1:3200").replace(/\/+$/, "");
}

/** 网易云识曲只接受 2–16 秒的窗口；非有限值退到最短窗口。 */
function clampDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec)) return MIN_DURATION_SEC;

  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, Math.round(durationSec)));
}

/**
 * 调网易云官方 AFP 匹配接口
 * @param fingerprint - 8 kHz PCM 生成的 AFP 指纹（Base64 文本）
 * @param durationSec - 采样片段时长
 * @returns 匹配结果原始 JSON；空结果或网络失败返回 null
 */
export async function matchFingerprint(fingerprint: string, durationSec: number): Promise<NeteaseMatch | null> {
  if (!fingerprint) return null;

  const url = new URL(NETEASE_MATCH_URL);
  url.searchParams.set("sessionId", crypto.randomUUID().replaceAll("-", "").slice(0, 16));
  url.searchParams.set("algorithmCode", "shazam_v2");
  url.searchParams.set("duration", String(clampDuration(durationSec)));
  url.searchParams.set("rawdata", fingerprint);
  url.searchParams.set("times", "1");
  url.searchParams.set("decrypt", "1");

  try {
    const r = await fetch(url, {
      headers: MATCH_HEADERS,
      signal: AbortSignal.timeout(MATCH_TIMEOUT_MS),
    });

    if (!r.ok) {
      console.warn(`[recognition] 网易云匹配 HTTP ${r.status}`);

      return null;
    }

    // SAFETY: 网易云返回固定 JSON 信封，解析后按协议字段收敛
    const parsed = await r.json() as NeteaseMatch;
    const results = parsed?.data?.result;

    return Array.isArray(results) && results.length ? parsed : null;
  } catch (e) {
    console.warn("[recognition] 网易云匹配失败", e);

    // 超时/断网 = 本次没有结果；由渲染层继续滑窗，不把网络抖动升级成 502。
    return null;
  }
}

/**
 * 网易云结果 → 渲染层候选。
 * 这里只保留展示所需字段；QQ songmid 由 resolveQQMatches 异步补齐。
 * @param result - 匹配接口结果
 * @returns 稳定顺序的候选数组
 */
export function normalizeMatchResults(result: NeteaseMatch | null): RecognitionMatchCandidate[] {
  const items = result?.data?.result ?? [];
  const out: RecognitionMatchCandidate[] = [];

  items.forEach((item, index) => {
    const song = item?.song;
    const name = String(song?.name ?? "").trim();

    if (!name) return;

    const artists = Array.isArray(song?.artists) ? song.artists : [];

    const candidate: RecognitionMatchCandidate = {
      song: {
        name,
        artists: artists.flatMap((artist) => {
          const artistName = String(artist?.name ?? "");

          return artistName ? [{ name: artistName }] : [];
        }),
        album: {
          name: String(song?.album?.name ?? ""),
          picUrl: String(song?.album?.picUrl ?? ""),
        },
      },
      startTime: Number(item?.startTime) > 0 ? Math.round(Number(item.startTime) / 1000) : 0,
      score: Number(item?.score ?? song?.score) || 0,
      order: index,
    };

    if (song?.id !== undefined) candidate.song.id = song.id;
    out.push(candidate);
  });

  return out;
}

/** 标题/歌手归一化：去 HTML、全半角、标点与空白，避免版本后缀和大小写干扰匹配。 */
function searchKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 标题相似度：完全相同 > 前缀 > 包含；0 表示不像同一首。 */
function titleScore(want: string, got: string): number {
  const a = searchKey(want);
  const b = searchKey(got);

  if (!a || !b) return 0;

  if (a === b) return 100;

  if (a.startsWith(b) || b.startsWith(a)) return 80;

  if (a.includes(b) || b.includes(a)) return 60;

  return 0;
}

/** 歌手相似度：命中任意一位即可，同名歌手在不同平台可能有译名差异。 */
function artistScore(want: string[], got: string[]): number {
  const keys = new Set(got.flatMap((name) => {
    const key = searchKey(name);

    return key ? [key] : [];
  }));

  return want.some((name) => keys.has(searchKey(name))) ? 20 : 0;
}

/** 专辑相似度：同名 20、包含 10；用来兜住「歌手译名不同但确实是同一张碟」的情况。 */
function albumScore(want: string, got: string): number {
  const a = searchKey(want);
  const b = searchKey(got);

  if (!a || !b) return 0;

  if (a === b) return 20;

  if (a.includes(b) || b.includes(a)) return 10;

  return 0;
}

/**
 * 在 QQ 搜索结果里挑最像的一首。
 * 阈值 110：标题完全相同 + 歌手或专辑命中；部分标题重合时必须歌手与专辑一起命中。
 */
function pickQQSong(candidate: RecognitionMatchCandidate, songs: QQSearchSong[]): QQSearchSong | null {
  const wantTitle = candidate.song.name;
  const wantArtists = candidate.song.artists.map((artist) => artist.name);
  const wantAlbum = candidate.song.album.name;
  let best: { song: QQSearchSong; score: number } | null = null;

  for (const song of songs) {
    if (!song?.mid) continue;

    // QQ 的 title = name + 版本后缀；两套都算一遍，避免 Live/Remix 后缀把同曲判成不同曲。
    const names = [song.title, song.name].flatMap((name) => {
      const value = String(name ?? "");

      return value ? [value] : [];
    });

    const title = Math.max(0, ...names.map((name) => titleScore(wantTitle, name)));
    const singers = Array.isArray(song.singer) ? song.singer.map((artist) => String(artist?.name ?? "")) : [];

    const score = title
      + artistScore(wantArtists, singers)
      + albumScore(wantAlbum, String(song.album?.name ?? ""));

    if (score >= 110 && (!best || score > best.score)) best = { song, score };
  }

  return best?.song ?? null;
}

/** QQ 专辑封面：优先 pmid（带 `_1` 后缀时去掉），没有就退回专辑 mid。 */
function qqCover(song: QQSearchSong): string {
  const base = String(song.album?.pmid ?? song.album?.mid ?? "").split("_")[0];

  return base ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${base}.jpg` : "";
}

/** 用标题 + 首位歌手查 QQ 曲库；失败只返回 null，不阻断识别结果展示。 */
async function searchQQSong(candidate: RecognitionMatchCandidate): Promise<QQSearchSong | null> {
  const artist = candidate.song.artists[0]?.name ?? "";
  const keyword = [candidate.song.name, artist].filter(Boolean).join(" ");

  if (!keyword) return null;

  const url = `${sidecarBase()}/search?keyword=${encodeURIComponent(keyword)}&page=1&num=${MAX_QQ_SEARCH}`;

  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });

    if (!r.ok) return null;

    // SAFETY: sidecar 返回固定 JSON 信封，解析后只读 data.song
    const body = await r.json() as { data?: { song?: QQSearchSong[] } };
    const songs = Array.isArray(body?.data?.song) ? body.data.song : [];

    return pickQQSong(candidate, songs);
  } catch {
    return null;
  }
}

/**
 * 给网易云候选补 QQ songmid：命中则用 QQ 的标题/歌手/封面，保证点击后播放的是同一首。
 * 查不到或相似度不够时保持 mid 为空，弹窗会退到 QQ 搜索页。
 * @param candidates - 归一化后的候选（按匹配顺序）
 * @returns 原顺序候选，前几首带 mid
 */
export async function resolveQQMatches(candidates: RecognitionMatchCandidate[]): Promise<RecognitionMatchCandidate[]> {
  return Promise.all(candidates.map(async (candidate) => {
    const song = await searchQQSong(candidate);

    if (!song?.mid) return candidate;

    const name = String(song.title ?? song.name ?? candidate.song.name).replace(/<\/?em>/gi, "").trim();

    const singers = Array.isArray(song.singer)
      ? song.singer.flatMap((artist) => {
        const artistName = String(artist?.name ?? "");

        return artistName ? [{ name: artistName }] : [];
      })
      : [];

    return {
      ...candidate,
      song: {
        id: song.mid,
        mid: song.mid,
        name: name || candidate.song.name,
        artists: singers.length ? singers : candidate.song.artists,
        album: {
          name: String(song.album?.name ?? candidate.song.album.name),
          picUrl: qqCover(song) || candidate.song.album.picUrl,
        },
      },
    };
  }));
}
