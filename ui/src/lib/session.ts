// Quaver — 会话存档（退出时保留播放列表与进度）
//
// 存什么：队列 + 指针 + 位置 + 循环模式。启动时读回，**挂流但不自动播** ——
// 播放条/进度条/歌词都停在退出前那一刻，按下播放键即从原处继续。
//
// 为什么在 localStorage 而不是 quaver.conf：这是「本地会话数据」而非「用户设置」，
// 与收藏（quaver.loved.v1）同类。打包态页面跑在固定端口（main.mjs:STABLE_PORT），
// origin 稳定 → localStorage 跨启动延续；配置目录被 app.setPath("userData") 钉死，
// 所以清缓存之外不会莫名丢档。
//
// 队列要瘦身：上游的 song 对象带 file/vs/vi/vf/pay 等大数组（单首几百字节到几 KB），
// 整队列原样序列化会顶到 localStorage 配额。只留渲染与重放需要的字段。
import type { Mode, Song } from "../player";

const KEY = "quaver.session.v1";
/** 队列存档上限：超长队列只留指针附近的一段，避免单条记录撑爆配额 */
const MAX_QUEUE = 500;

export interface SessionSnapshot {
  queue: Song[];
  index: number;
  /** 当前曲目位置（秒） */
  position: number;
  mode: Mode;
  /** 存档时刻（仅排障用） */
  at: number;
}

/** 队列里的歌瘦身成「够渲染 + 够取链」的最小集。
 *  注意 file.media_mid 必须留：高档位取链用的是 media_mid，很多歌它与 mid 不同
 *  （实测「半梦」两首：media_mid=003QHjC33I7gpx / mid=004XX53V27j2m9），
 *  丢了它重挂流会拿错误的文件名去请求。file 里其余 size_* 数组才是要扔的大头。 */
function slim(s: Song): Song | null {
  if (!s?.mid) return null;
  const mediaMid = (s as any).file?.media_mid;
  return {
    mid: s.mid,
    id: s.id,
    type: s.type,
    name: s.name,
    title: (s as any).title,
    subtitle: (s as any).subtitle,
    interval: s.interval,
    _key: s._key,
    file: mediaMid ? { media_mid: mediaMid } : undefined,
    singer: (s.singer ?? []).map((x: any) => ({ mid: x?.mid, name: x?.name, pmid: x?.pmid })),
    album: s.album
      ? { mid: (s.album as any).mid, pmid: (s.album as any).pmid, name: (s.album as any).name }
      : undefined,
  } as Song;
}

export function saveSession(snap: { queue: Song[]; index: number; position: number; mode: Mode }): void {
  try {
    const queue = snap.queue.map(slim).filter((s): s is Song => !!s);
    // 队列过长：保住指针所在的窗口，其余丢弃（指针同步平移）
    let index = snap.index;
    let kept = queue;
    if (queue.length > MAX_QUEUE) {
      const half = Math.floor(MAX_QUEUE / 2);
      const from = Math.max(0, Math.min(index - half, queue.length - MAX_QUEUE));
      kept = queue.slice(from, from + MAX_QUEUE);
      index -= from;
    }
    const payload: SessionSnapshot = {
      queue: kept,
      index: Math.max(0, Math.min(index, kept.length - 1)),
      position: Number.isFinite(snap.position) && snap.position > 0 ? snap.position : 0,
      mode: snap.mode,
      at: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch { /* 配额/隐私模式：本次会话不存档，不影响播放 */ }
}

export function loadSession(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SessionSnapshot;
    if (!Array.isArray(d?.queue) || !d.queue.length) return null;
    const queue = d.queue.filter((s) => s && typeof s.mid === "string" && s.mid);
    if (!queue.length) return null;
    const mode: Mode = d.mode === "one" || d.mode === "off" ? d.mode : "all";
    return {
      queue,
      index: Number.isFinite(d.index) ? Math.max(0, Math.min(d.index, queue.length - 1)) : 0,
      position: Number.isFinite(d.position) ? Math.max(0, d.position) : 0,
      mode,
      at: Number(d.at) || 0,
    };
  } catch {
    return null;
  }
}

/** 丢弃存档（目前无人调用：清空队列会自然存成空档） */
export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}
