// Quaver — 浏览器侧 API 封装（全部走同源 /api 中继 → Python sidecar :3200）
// 响应信封：{code:0,msg:"ok",data:...}；错误 {code:-1,msg:...} + HTTP 状态。
import { getFallbackSort } from "./prefs";
import { cfg, cfgSet } from "./config";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const api = async <T = any>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch("/api" + path, init);
  let j: any = null;
  try {
    j = await r.json();
  } catch {
    throw new ApiError(r.status, `HTTP ${r.status} ${path}`);
  }
  if (!r.ok || (typeof j?.code === "number" && j.code !== 0)) {
    throw new ApiError(r.status, j?.msg ?? `HTTP ${r.status} ${path}`);
  }
  return j.data as T;
};

export const postJson = <T = any>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const songArtists = (s: any) => (s.singer ?? []).map((x: any) => x.name).join(" / ");

/** 收藏写接口（PlaylistDetailWrite）的 songType 与读接口 Song.type 不是同一套枚举，
 *  别直接透传：普通歌曲读侧 type=1，写侧必须发 0 —— 发 1 时上游 retCode=0、result.dirId=0，
 *  即「静默成功但什么都没发生」（实测 like/unlike 都会变成空操作，歌单不动、无从察觉）。
 *  写 0 才真正生效（约 1-2s 后即可从 /user/liked 读到）。
 *  其它类型按同一偏移推断（上游没有公开映射表），下限 0。 */
export const writeSongType = (type?: number) => Math.max(0, Number(type ?? 1) - 1);

// —— 展示名/副标题 ——
// 上游的 Song.name 只是**主名**，版本后缀（Studio Live / (Half-acoustic Ver.) / Live On MTV…）
// 挂在 title 上（= name + 后缀，实测：name「半梦」/ title「半梦 (Studio Live)」）。列表只读 name 的话，
// 同一首歌的不同版本在界面上长得一模一样 —— 故展示一律走 songTitle()。
// subtitle 是另一回事：它是「《小时代》电影主题曲」这类一句话说明，与 title 上的括号后缀不重叠，
// 展示时作为标题行的次级文本追加（见 songs.ts 的 .rt-sub）。
/** 剥掉 search 接口 highlight=true 漏进任意字符串字段的 <em> 标签 */
export const stripEm = (s: unknown) => String(s ?? "").replace(/<\/?em>/gi, "");

/** 歌曲展示名：title 优先（= 主名 + 版本后缀），退化到 name */
export function songTitle(s: any): string {
  const name = stripEm(s?.name).trim();
  const title = stripEm(s?.title).trim();
  return title || name;
}

/** 歌曲副标题（歌曲说明，可为空） */
export const songSubtitle = (s: any) => stripEm(s?.subtitle).trim();

/** 歌曲分享链接（QQ 音乐网页版详情页，与官方「复制链接」同格式） */
export const songShareUrl = (mid: string) =>
  `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(String(mid ?? ""))}`;

/** 写剪贴板：优先异步 Clipboard API；非安全上下文/权限被拒时回落 execCommand。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 继续走回落 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const coverUrl = (s: any, size = 300) => {
  const pmid: string = s.album?.pmid ?? "";
  const base = pmid ? pmid.split("_")[0] : (s.album?.mid ?? "");
  return base ? `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${base}.jpg` : "";
};

// 上游 picUrl 常是 http，https 同域可用则升级
export const upPic = (u?: string) => (u ?? "").replace(/^http:/, "https:");

export const fmtTime = (sec: number) => {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

// 身份徽章（侧栏/我的页共用）：会员只展示最高档（超级会员 > 豪华绿钻 > 绿钻），
// 音乐人（IsSinger 认证）独立一枚蓝色徽章；非音乐人不展示。
// 配色约定：绿=豪华绿钻/绿钻，橙=超级会员，蓝=音乐人（.badge.green/.orange/.blue）。
export function identityBadges(me: any, vip: any): string {
  const badges: string[] = [];
  if (vip?.svip) badges.push(`<i class="badge orange">超级会员</i>`);
  else if (vip?.identity?.huge_vip) badges.push(`<i class="badge green">豪华绿钻</i>`);
  else if (vip?.identity?.vip) badges.push(`<i class="badge green">绿钻</i>`);
  if (me?.base_info?.is_singer) badges.push(`<i class="badge blue">音乐人</i>`);
  return badges.join("");
}

// 音质档位 = Typhoeus TierId（vendor/Typhoeus/typhoeus/quality.py；后端按会员门控+回退协商）
// 旧整数表（128/320/flac → file_type）随 /song/urls 直连路径保留兼容，播放主链路已走 /stream/*。
export const QUALITIES = {
  "128": "标准音质",
  "320": "高品质 HQ",
  flac: "无损 SQ",
  "640ogg": "无损 SQ (OGG)",
  atmos2: "臻品音质",
  atmos51: "臻品全景声",
  master: "臻品母带",
} as const;
export type Quality = keyof typeof QUALITIES;

// 默认音质存在 quaver.conf 的 [Quality] DefaultQuality（Auto｜128｜320｜flac｜640ogg｜atmos2｜atmos51｜master）
export function getQuality(): Quality | "auto" {
  const q = cfg("Quality.DefaultQuality", "Auto");
  return q && q !== "Auto" && q in QUALITIES ? (q as Quality) : "auto";
}
export function setQuality(q: Quality | "auto") {
  cfgSet({ "Quality.DefaultQuality": q === "auto" ? "Auto" : q });
}

// —— 播放条音质切换：会话级覆盖（不写入 localStorage；重启回到设置页默认）。
//    选择永远带 Fallback（auto_downgrade）：高档不可及就沿回退链降到最优可播档，绝不 403 卡死播放链路。
let sessionQuality: Quality | "auto" | null = null;
export const getSessionQuality = () => sessionQuality;
export const setSessionQuality = (q: Quality | "auto" | null) => { sessionQuality = q; };
/** 当前生效档位：播放条会话选择 > 设置页默认 */
export const effectiveQuality = (): Quality | "auto" => sessionQuality ?? getQuality();

/** 档位短标签（播放条音质胶囊用） */
export const QUALITY_SHORT: Record<string, string> = {
  auto: "自动", "128": "标准", "320": "HQ", "320ogg": "HQ·Ogg", flac: "SQ", "640ogg": "SQ·Ogg",
  atmos2: "臻品", atmos51: "全景", master: "母带",
};

// —— Typhoeus 播放流：resolve 协商（会员门控 403 / 加密档 451 / 回退降级 degraded）→ token 中继 ——
interface StreamResolved { token: string; path: string; tier: string; tier_label: string; degraded: boolean; mime: string; size: number }
interface StreamTierView { id: string; label: string; rank: number; hi_res: boolean; locked?: boolean; requires?: number }
interface StreamTiers { membership: number; membership_label: string; tiers: StreamTierView[]; all_tiers: StreamTierView[]; max: string | null }

let tiersCache: StreamTiers | null = null;
export async function getStreamTiers(force = false): Promise<StreamTiers> {
  if (!tiersCache || force) tiersCache = await api<StreamTiers>("/stream/tiers");
  return tiersCache;
}
export const invalidateStreamTiers = () => (tiersCache = null);

// 最近一次「已应用」协商结果（播放条音质徽章数据源；由 player 在真正挂到 audio.src 时写入，
// 预加载命中但未播放的不算）
export interface LastStream { tier: string; label: string; degraded: boolean }
let lastStream: LastStream | null = null;
export const getLastStream = () => lastStream;
export const setLastStream = (s: LastStream | null) => { lastStream = s; };

export interface StreamResult extends LastStream { url: string }

const RESOLVE_TIMEOUT_MS = 12000; // 上游取链+嗅探偶发挂起：超时报错，让 UI 出可重试的错误态而不是永久转圈

async function postResolve(body: { mid: string; media_mid: string; tier: string; auto: boolean; deprioritize: string[] }): Promise<StreamResolved> {
  try {
    return await api<StreamResolved>("/stream/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ApiError(408, "取链超时（上游无响应），请重试或换音质");
    }
    throw e;
  }
}

/** 协商一条可播流：永远带 Fallback（auto_downgrade）——高档被会员/加密/无源挡住时沿回退链
 *  降到最优可播明文档，degraded 标记实际降档；配合播放条音质胶囊（会话级、不持久化）。 */
export async function resolveStreamUrl(song: any, quality: Quality | "auto" = effectiveQuality()): Promise<StreamResult> {
  const mediaId: string = song.file?.media_mid ?? song.media_mid ?? song.mid;
  let tier = quality as string;
  if (tier === "auto") tier = (await getStreamTiers()).max ?? "128";
  // 回退排序开关（设置页）：默认不把「臻品全景声」当作优先降档落点（压到链尾兜底）
  const deprioritize = getFallbackSort() === "no-atmos" ? ["atmos51"] : [];
  try {
    const r = await postResolve({ mid: song.mid, media_mid: mediaId, tier, auto: true, deprioritize });
    return { url: "/api" + r.path, tier: r.tier, label: r.tier_label, degraded: r.degraded };
  } catch (e: any) {
    // 目标档本身取不到（会员/加密在 auto 模式已被后端裁剪，走到这里多为无源/网络）→ 兜底标准档
    if (tier !== "128") {
      const r = await postResolve({ mid: song.mid, media_mid: mediaId, tier: "128", auto: true, deprioritize });
      return { url: "/api" + r.path, tier: "128", label: "标准音质", degraded: true };
    }
    throw e;
  }
}

export async function getPlayUrl(song: any, quality: Quality | "auto" = effectiveQuality()): Promise<string> {
  return (await resolveStreamUrl(song, quality)).url;
}
