// Quaver — 会话存档（退出时保留播放列表与进度）
//
// 存什么：队列 + 指针 + 位置 + 循环模式。启动时读回，**挂流但不自动播** ——
// 播放条/进度条/歌词都停在退出前那一刻，按下播放键即从原处继续。
//
// 为什么在 localStorage 而不是 quaver.conf：这是「本地会话数据」而非「用户设置」，
// 与收藏（quaver.loved.v1）同类。打包态页面跑在固定端口（main.ts:STABLE_PORT），
// origin 稳定 → localStorage 跨启动延续；配置目录被 app.setPath("userData") 钉死，
// 所以清缓存之外不会莫名丢档。
//
// 队列要瘦身：上游的 song 对象带 file/vs/vi/vf/pay 等大数组（单首几百字节到几 KB），
// 整队列原样序列化会顶到 localStorage 配额。只留渲染与重放需要的字段。
import type { Mode, Song } from "../player";
import { SONG_TIER_SIZE_KEYS } from "./songtiers";
import { isJsonArray, isJsonObject, jsonBoolean, jsonNumber, jsonString, type JsonObject, type JsonValue } from "./json-value.ts";
import type { CloudSongFingerprint } from "./cloud";
import type { LocalSongFingerprint } from "./local";

const KEY = "quaver.session.v1";

/** 队列存档上限：超长队列只留指针附近的一段，避免单条记录撑爆配额 */
const MAX_QUEUE = 500;

/** 来源页 hash 的最小校正：只认 `#/` 开头的路由串（旧存档没有这项 / 脏数据一律当没有）。 */
function sourceHash(v: string | null | undefined): string | null {
  const h = String(v ?? "").trim();

  return h.startsWith("#/") ? h : null;
}

export interface SessionSnapshot {
  queue: Song[];
  index: number;
  /** 当前曲目位置（秒） */
  position: number;
  /** 播放模式：顺序 off / 列表循环 all / 单曲循环 one */
  mode: Mode;
  /** 随机播放（每日一套顺序，种子=本地日期）：与 mode 同一生命周期，退出前开着则重进仍开着。
   *  缺字段（旧存档）按 false 读，不阻断还原。 */
  shuffle?: boolean;
  /** 退出时是否仍处于猜你喜欢无限电台。广播态照常恢复，但冷启动仍不自动出声。 */
  radio?: boolean;
  /** 当前电台轮次的末曲下标；旧存档或窗口重建期间的临时快照可能缺省。 */
  radioEnd?: number;
  /** 队列来源页 hash（播放条封面右键「跳转至歌单」）；旧存档没有这一项。 */
  source?: string | null;
  /** 每一首自己的来源页，与 queue 同下标（插队进来的歌来源各不相同）；旧存档没有这一项。 */
  sources?: (string | null)[];
  /** 播放条会话音质覆盖（Quality | "auto" | 未覆盖=null）。
   *  只在窗口重建接管时恢复 —— 冷启动仍回设置页默认（会话级语义不变） */
  quality?: string | null;
  /** 最近一次「已应用」的流档位（播放条音质胶囊数据源），与 quality 同步存取 */
  lastStream?: { tier: string; label: string; degraded: boolean } | null;
  /** 存档时刻（仅排障用） */
  at: number;
}

/** 队列里的歌瘦身成「够渲染 + 够取链」的最小集。
 *  注意 file.media_mid 必须留：高档位取链用的是 media_mid，很多歌它与 mid 不同
 *  （实测「半梦」两首：media_mid=003QHjC33I7gpx / mid=004XX53V27j2m9），
 *  丢了它重挂流会拿错误的文件名去请求。file 里其余 size_* 数组才是要扔的大头 ——
 *  但档位存在性判定消费的几个要留（键名清单见 lib/songtiers.ts），否则还原的会话
 *  在音质选择器里只能回退全量列表。 */
function slim(s: Song): Song | null {
  if (!s?.mid) return null;
  const f = s.file;
  const mediaMid = f?.media_mid;

  const keptFile: Song["file"] = f
    ? Object.fromEntries(SONG_TIER_SIZE_KEYS.flatMap((k) => (f[k] === undefined ? [] : [[k, f[k]]])))
    : undefined;

  const file: Song["file"] = mediaMid ? { ...keptFile, media_mid: mediaMid } : keptFile;
  const keepFile = file && Object.keys(file).length ? file : undefined;

  return {
    mid: s.mid,
    id: s.id,
    type: s.type,
    // 本地曲目指纹必须随存档走：kind/hasCover/path 供冷启动后取流、封面与右键菜单（缺了它本地歌恢复成坏 QQ 歌）
    local: s.local,
    // 微云直链必须随存档走；URL 是稳定的同源中继路径，sidecar 每次请求会重新换取短链。
    directUrl: s.directUrl,
    cloud: s.cloud,
    name: s.name,
    title: s.title,
    subtitle: s.subtitle,
    interval: s.interval,
    _key: s._key,
    file: keepFile,
    singer: (s.singer ?? []).map((x) => ({ mid: x.mid, name: x.name, pmid: x.pmid })),
    album: s.album
      ? { mid: s.album.mid, pmid: s.album.pmid, name: s.album.name }
      : undefined,
  };
}

export function saveSession(snap: {
  queue: Song[]; index: number; position: number; mode: Mode; shuffle?: boolean;
  radio?: boolean; radioEnd?: number;
  source?: string | null;
  sources?: (string | null)[];
  quality?: string | null;
  lastStream?: { tier: string; label: string; degraded: boolean } | null;
}): void {
  try {
    // 来源与队列按同下标配对后再丢无效条目，否则 slim 过滤掉一首就让后面的来源整体错位。
    const entries = snap.queue.map((s, i) => ({ song: slim(s), origin: sourceHash(snap.sources?.[i]) }));
    const valid = entries.filter((e): e is { song: Song; origin: string | null } => !!e.song);
    const queue = valid.map((e) => e.song);
    const origins = valid.map((e) => e.origin);
    // 队列过长：保住指针所在的窗口，其余丢弃（指针与来源同步平移）
    let index = snap.index;
    let kept = queue;
    let keptOrigins = origins;
    let from = 0;

    if (queue.length > MAX_QUEUE) {
      const half = Math.floor(MAX_QUEUE / 2);
      from = Math.max(0, Math.min(index - half, queue.length - MAX_QUEUE));
      kept = queue.slice(from, from + MAX_QUEUE);
      keptOrigins = origins.slice(from, from + MAX_QUEUE);
      index -= from;
    }

    const radio = snap.radio === true;

    const rawRadioEnd = Number.isFinite(snap.radioEnd) && Number(snap.radioEnd) >= 0
      ? Number(snap.radioEnd) - from
      : kept.length - 1;

    const radioEnd = radio && kept.length ? Math.max(0, Math.min(rawRadioEnd, kept.length - 1)) : -1;

    const payload: SessionSnapshot = {
      queue: kept,
      index: kept.length ? Math.max(0, Math.min(index, kept.length - 1)) : -1,
      position: Number.isFinite(snap.position) && snap.position > 0 ? snap.position : 0,
      mode: snap.mode,
      shuffle: !!snap.shuffle,
      radio,
      radioEnd,
      source: sourceHash(snap.source),
      sources: keptOrigins,
      quality: snap.quality ?? null,
      lastStream: snap.lastStream ?? null,
      at: Date.now(),
    };

    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch { /* 配额/隐私模式：本次会话不存档，不影响播放 */ }
}

/** 存档里的 file 元数据：只认档位存在性判定与取链真正消费的键。 */
function parseStoredFile(value: JsonObject): Song["file"] {
  const sizeNew = isJsonArray(value.size_new)
    ? value.size_new.flatMap((entry) => (jsonNumber(entry, Number.NaN) >= 0 ? [jsonNumber(entry)] : []))
    : undefined;

  const file: NonNullable<Song["file"]> = {
    media_mid: jsonString(value.media_mid) || undefined,
  };

  for (const key of SONG_TIER_SIZE_KEYS) {
    if (key === "size_new") continue;
    const size = jsonNumber(value[key], Number.NaN);

    if (Number.isFinite(size)) file[key] = size;
  }

  if (sizeNew) file.size_new = sizeNew;

  return file;
}

/** 存档里的本地曲目指纹。 */
function parseStoredLocal(value: JsonObject): LocalSongFingerprint | undefined {
  const id = jsonString(value.id);

  if (!id) return undefined;

  return {
    id,
    kind: value.kind === "webdav" ? "webdav" : "folder",
    hasCover: jsonBoolean(value.hasCover),
    path: jsonString(value.path),
    sourceName: jsonString(value.sourceName),
    qqMid: jsonString(value.qqMid),
    lyricImport: jsonBoolean(value.lyricImport),
  };
}

/** 存档里的微云指纹。 */
function parseStoredCloud(value: JsonObject): CloudSongFingerprint | undefined {
  const key = jsonString(value.key);

  if (!key) return undefined;

  return {
    key,
    hasCover: jsonBoolean(value.hasCover),
    lyricImport: jsonBoolean(value.lyricImport),
    importFormat: jsonString(value.importFormat),
  };
}

/** 存档里的一首歌：只认「有非空 mid」的对象，其余（旧档/脏数据）逐条丢弃。 */
function parseStoredSong(value: JsonValue | undefined): Song | null {
  if (!isJsonObject(value)) return null;
  const mid = jsonString(value.mid);

  if (!mid) return null;

  const singer = isJsonArray(value.singer)
    ? value.singer.flatMap((entry) => {
      if (!isJsonObject(entry)) return [];
      const name = jsonString(entry.name);

      return name ? [{ mid: jsonString(entry.mid), name, pmid: jsonString(entry.pmid) }] : [];
    })
    : undefined;

  const album = isJsonObject(value.album)
    ? { mid: jsonString(value.album.mid), pmid: jsonString(value.album.pmid), name: jsonString(value.album.name) }
    : undefined;

  const file = isJsonObject(value.file) ? parseStoredFile(value.file) : undefined;
  const local = isJsonObject(value.local) ? parseStoredLocal(value.local) : undefined;
  const cloud = isJsonObject(value.cloud) ? parseStoredCloud(value.cloud) : undefined;
  const id = jsonNumber(value.id, Number.NaN);
  const type = jsonNumber(value.type, Number.NaN);
  const interval = jsonNumber(value.interval, Number.NaN);
  const directUrl = jsonString(value.directUrl);
  const key = jsonString(value._key);
  const title = jsonString(value.title);
  const subtitle = jsonString(value.subtitle);

  const song: Song = {
    mid,
    name: jsonString(value.name),
  };

  if (Number.isFinite(id)) song.id = id;

  if (Number.isFinite(type)) song.type = type;

  if (title) song.title = title;

  if (subtitle) song.subtitle = subtitle;

  if (singer) song.singer = singer;

  if (album) song.album = album;

  if (file) song.file = file;

  if (Number.isFinite(interval)) song.interval = interval;

  if (key) song._key = key;

  if (local) song.local = local;

  if (directUrl) song.directUrl = directUrl;

  if (cloud) song.cloud = cloud;

  return song;
}

export function loadSession(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);

    if (!raw) return null;
    const parsed: JsonValue = JSON.parse(raw);

    if (!isJsonObject(parsed) || !isJsonArray(parsed.queue)) return null;

    const radio = jsonBoolean(parsed.radio);
    const rawSources = isJsonArray(parsed.sources) ? parsed.sources : [];
    // 过滤器会丢条目，来源按同一判据保留，否则下标整体错位。
    const kept: number[] = [];

    const queue = parsed.queue.flatMap((entry, i) => {
      const song = parseStoredSong(entry);

      if (song === null) return [];
      kept.push(i);

      return [song];
    });

    const sources = kept.map((i) => sourceHash(jsonString(rawSources[i], "")));

    const lastStream = isJsonObject(parsed.lastStream) && jsonString(parsed.lastStream.tier)
      ? { tier: jsonString(parsed.lastStream.tier), label: jsonString(parsed.lastStream.label), degraded: jsonBoolean(parsed.lastStream.degraded) }
      : null;

    const rawRadioEnd = jsonNumber(parsed.radioEnd, -1) >= 0 ? jsonNumber(parsed.radioEnd, -1) : queue.length - 1;
    const rawIndex = jsonNumber(parsed.index, 0);
    const quality = jsonString(parsed.quality);

    // 普通空队列没有可恢复内容；电台态例外：首轮还在路上就退出时，至少把电台会话保留下来。
    if (!queue.length && !radio) return null;
    // 旧存档可能是已移除的「off（顺序播放）」：一律落回列表循环
    const mode: Mode = parsed.mode === "one" ? "one" : "all";
    const radioEnd = radio && queue.length ? Math.max(0, Math.min(rawRadioEnd, queue.length - 1)) : -1;

    return {
      queue,
      index: queue.length ? Math.max(0, Math.min(rawIndex, queue.length - 1)) : -1,
      position: Math.max(0, jsonNumber(parsed.position)),
      mode,
      shuffle: jsonBoolean(parsed.shuffle),
      radio,
      radioEnd,
      source: sourceHash(jsonString(parsed.source)),
      sources,
      quality: quality || null,
      lastStream,
      at: jsonNumber(parsed.at),
    };
  } catch {
    return null;
  }
}

/** 丢弃存档：退出登录前调用。之后新页面可能自然写入空档；空档在 loadSession 里不可恢复 */
export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}
