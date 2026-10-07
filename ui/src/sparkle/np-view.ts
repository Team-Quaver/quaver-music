// Sparkle — 正在播放页整页接管视图的宿主实现（ctx 工厂 + 挂载生命周期）
//
// 为什么单独一个模块：NowPlaying.ts 是「默认布局」的 owner，让它 import 一堆
// 接管相关的状态查询会把默认路径也搅进来。这里的职责只有三件：
//   ① npViewCtx()  —— 把 player / lib-api 折成 SDK 的 SparkleNpViewCtx（只读闭包
//      读到的永远是当前态；写侧逐个转发到 player，不绕过任何既有语义）；
//   ② 档位表 —— /stream/tiers 只拉一次，供 ctx.qualityTiers() 同步读；拉回后主动
//      notify 一次（否则插件要等下一个播放事件才知道档位到了）；
//   ③ syncNpView() —— 正在播放页 notify 里调：按 enabled() 决定接管与否，维护
//      「同一 view 只挂一次」的引用计数式重挂，以及 body.np-takeover（隐藏播放条）。
//
// 停用插件时 registry 的 teardown 把 view 摘掉；正在播放页下一次 notify 就会
// 卸载插件视图、恢复默认布局 —— 不需要额外的反向通道。
import type { SparkleNpView, SparkleNpViewCtx, SparkleQualityTier, SparkleSongSnapshot } from "@quaver/sparkle";
import { player, type Song } from "../player";
import {
  effectiveQuality, getLastStream, getStreamTiers, QUALITY_SHORT, songMissingTiers,
  songTitle, stripEm, type Quality,
} from "../lib/api";
import { sparkleKaraokeProvider, sparkleNpView } from "./registry";

// —— 档位表（/stream/tiers；一次拉回，全插件共用）——

let tierCache: SparkleQualityTier[] | null = null;
let tierFlight: Promise<void> | null = null;

function loadTiers() {
  if (tierCache) return;
  tierFlight ??= getStreamTiers()
    .then((t) => { tierCache = t.all_tiers.map((x) => ({ id: x.id, label: x.label, locked: !!x.locked })); })
    .catch(() => { tierCache = []; })
    .finally(() => {
      tierFlight = null;
      // 档位是异步到的：主动广播一次，插件不必等下一个播放事件
      if (tierCache) player.notifyPublic();
    });
}
void loadTiers();

/** 可选档位：过滤掉当前曲无源的（与播放条音质浮窗同口径），locked 档照常列出 */
function availableTiers(): SparkleQualityTier[] {
  loadTiers();
  if (!tierCache?.length) return [];
  const missing = songMissingTiers(player.current);
  if (!missing) return tierCache;
  return tierCache.filter((t) => !missing.has(t.id as Quality));
}

// —— 曲目快照 ——

const snapshot = (s: Song | undefined | null): SparkleSongSnapshot | null => {
  if (!s) return null;
  return {
    mid: s.mid,
    name: songTitle(s) || "未知歌曲",
    // mid 一定要带上：「跳转歌手」这类动作需要它拼路由参数，只给名字的话插件做不了
    singer: (s.singer ?? []).map((x) => ({ name: stripEm(x.name ?? ""), mid: x.mid })).filter((x) => !!x.name),
    album: s.album ? { name: stripEm(s.album.name ?? ""), mid: s.album.mid, pmid: s.album.pmid } : undefined,
    interval: Number(s.interval ?? 0) || 0,
  };
};

// —— ctx 工厂 ——

/**
 * 接管视图的实时状态与控制面。读侧全是闭包现读（notify 4Hz 或自驱 rAF 都能拿到
 * 最新值）；写侧逐条转发 player，**不新造语义** —— prev 走 force（封面点上一首
 * 是明确跳转，不该被「重放当前曲」设置改写成重播）、seek 走 player.seek 的钳位、
 * 切档走 player.switchQuality（带 Fallback 协商 + 从当前进度续播）。
 */
export function npViewCtx(): SparkleNpViewCtx {
  return {
    expanded: () => player.expanded,
    gallery: () => player.gallery,
    collapse: () => {
      if (!player.expanded) return;
      player.expanded = false;
      player.notifyPublic(); // 退全屏由 NowPlaying 的 expanded 迁移统一做
    },

    current: () => snapshot(player.current),
    prevSong: () => snapshot(player.queue[player.neighbors().prev]),
    nextSong: () => snapshot(player.queue[player.neighbors().next]),
    // 按播放顺序偏移取（随机播放时走当日洗牌序）—— 插件自己算 index±1 会指错歌
    songAt: (offset) => snapshot(player.songAtOffset(offset)),
    queueLength: () => player.queue.length,

    time: () => player.time,
    duration: () => player.duration,
    paused: () => player.paused,
    loading: () => player.loading,
    error: () => player.error,

    lyrics: () => player.lyrics.map((l) => ({ t: l.t, text: l.text, trans: l.trans })),
    lyricState: () => player.lyricState,
    showTrans: () => player.showTrans,
    // 逐字行**不复制**：一行几十个词、整首上千个，4Hz 每次 notify 重建一份纯属白烧；
    // 视图只读不改。口径与 NowPlaying 的 karaModeNow() 一致 —— 有数据 + 提供器在位且启用，
    // 否则视图回退行级歌词（提供器被关时 player.karaoke 可能还留着上一次的解析结果）。
    karaoke: () => player.karaoke,
    karaokeActive: () => {
      const provider = sparkleKaraokeProvider();
      return player.karaoke.length > 0 && !!provider && (provider.enabled?.() ?? true);
    },

    volume: () => player.volume,
    muted: () => player.muted,

    quality: () => effectiveQuality(),
    qualityLabel: () => {
      const ls = getLastStream();
      return player.current && ls
        ? (ls.degraded ? "↓" : "") + (QUALITY_SHORT[ls.tier] ?? ls.label)
        : (QUALITY_SHORT[effectiveQuality()] ?? "音质");
    },
    lastStream: () => getLastStream(),
    qualityTiers: () => availableTiers(),

    onNotify: (cb) => player.on(cb),

    toggle: () => player.toggle(),
    seek: (sec) => player.seek(sec),
    next: () => player.next(false),
    prev: () => player.prev(true),
    jumpTo: (offset) => player.jumpToOffset(offset),
    setVolume: (v) => player.setVolume(v),
    toggleMute: () => player.toggleMute(),
    switchQuality: (id) => player.switchQuality(id as Quality | "auto"),
    toggleTrans: () => player.toggleTrans(),
    loved: (mid) => player.loved.has(mid),
    toggleLove: () => {
      const s = player.current;
      if (!s) return false;
      player.toggleLove(s);
      return player.loved.has(s.mid);
    },
  };
}

// —— 挂载生命周期 ——

/** 当前挂着的 view（null = 走默认布局）。按 view 对象身份比对，不按 id：
 *  插件停用后重新启用是**新**的 view 对象，必然重挂（内层的旧状态不留）。 */
let mounted: { view: SparkleNpView; host: HTMLElement; cleanup: (() => void) | null } | null = null;

/** body 上的接管标记：宿主样式用它把底部播放条收起来（插件自绘控制） */
const setBodyFlag = (on: boolean) => {
  document.body.classList.toggle("np-takeover", on);
};

/**
 * 正在播放页 notify 里调（幂等）。返回「本次调用后是否处于接管态」，让调用方
 * 跳过默认布局的绘制（歌词 DOM / 逐字挂载 / 背景模糊 / 右侧信息列 —— 接管时
 * 全由插件负责，宿主只留外壳与转场）。
 *
 * **挂载与生效是两件事**（2026-10-07 修）：
 *   · mounted = 有插件视图挂上了（由注册表驱动，停用/启用即时反映）；
 *   · active  = 本帧真的在接管 = mounted && 正在播放页展开。
 * 之前把两者合成一个 `!!mounted` 当返回，于是**插件一启用就把播放条藏了**，
 * 且因为 syncNpView 只在 player.on 里调（没在播放时永不推送），用户可能再也
 * 看不到播放条。播放条是全站常驻控件，藏它必须以「np 此刻真的开着」为前提。
 */
export function syncNpView(npRoot: HTMLElement, host: HTMLElement): boolean {
  const view = sparkleNpView();
  const want = view && (view.enabled?.() ?? true) ? view : null;

  if (mounted && mounted.view !== want) {
    try { mounted.cleanup?.(); } catch (e) { console.warn("[sparkle] np 视图清理失败", e); }
    mounted.host.remove();
    mounted = null;
  }
  if (want && !mounted) {
    const box = document.createElement("div");
    box.className = "np-view-root";
    box.dataset.plugin = want.id;
    host.append(box);
    try {
      // render 返回 undefined 是合法的（插件声明「无清理」）——用「抛没抛」判定成败，
      // 不要拿返回值 truthy 当成功标志（那会把无清理的正常插件误判成失败）。
      const cleanup = want.render(box, npViewCtx()) ?? null;
      mounted = { view: want, host: box, cleanup };
    } catch (e) {
      // 渲染抛错 = 这个视图不接管：摘掉半截 DOM，退回默认布局，不把整页画死
      console.error(`[sparkle] np 视图 ${want.id} 渲染失败`, e);
      box.remove();
      npRoot.classList.remove("np-taken-over");
      setBodyFlag(false);
      return false;
    }
  }
  // 生效 = 挂上了 **且** 正在播放页展开（收起时插件视图留着但不接管，播放条照常）
  const active = !!mounted && player.expanded;
  npRoot.classList.toggle("np-taken-over", active);
  setBodyFlag(active);
  return active;
}
