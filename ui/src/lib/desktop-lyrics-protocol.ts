// Quaver — 桌面歌词的**线协议**（覆盖层与主窗共用的那一纸契约）
//
// 为什么单独一个文件：覆盖层页（src/desktop-lyrics.ts）曾经从「主窗侧桥实现」那个模块里
// 只取 CLOCK_COMP_MS 和几个类型，于是把整条 player 依赖链（player/api/color/accent/vip/local
// …≈60KB）一起拖进了它的首屏 —— 一个「绝不持有播放器」的镜像窗，却在启动时 new 了一个播放器。
// 契约与实现分家后，覆盖层只解析这份零依赖的声明，主窗侧实现的依赖再重也不牵连它。
// 改这里等于改两侧的口径：字段含义请看下面各行的注释，别只改名字。
import type { SparkleKaraokeLine } from "@quaver/sparkle";


/** 歌词时钟固定补偿（秒 → 毫秒）：与 src/components/NowPlaying.ts 组 render ctx 处同源口径。 */
export const CLOCK_COMP_MS = 200;

/** 行级歌词（含翻译/音译两路原文 —— 上屏哪一路由覆盖层按档位现选，恒不在此处挑）。 */
export interface DlLine {
  t: number; // 秒
  text: string;
  trans?: string;
  roma?: string;
}

export interface DlTrackPayload {
  v: 1;
  key: string;
  mid: string;
  /** 控制条左侧曲目信息。歌名走 songTitle（含版本后缀），歌手以 " / " 连接多人。 */
  title: string;
  artist: string;
  /** 控制条小封面 URL（与播放控制条同为 coverUrl(..., 150)）；空串 = 显示占位。 */
  cover: string;
  lyricState: "idle" | "loading" | "ok" | "none";
  /** 歌词内容版本（player.lyricRevision）：状态同为 ok 的重导入也要让覆盖层重建 DOM */
  lyricRevision: number;
  durationSec: number;
  /** 逐字行（在位提供器解析产物；毫秒）—— 覆盖层交给内置 AMLL 直接渲染 */
  karaoke: SparkleKaraokeLine[];
  /** 行级兜底（player.lyrics）；karaoke 为空时覆盖层自行整形为「整行单音节」 */
  lines: DlLine[];
  /** 封面染色（toUiColors 的 accent 档，与正在播放页歌词 --cvg-accent 同源同派生）；取不到 null。
   *  「桌面歌词·颜色=封面染色」用它 —— 覆盖层不请求取色，解码永远发生在主窗这一侧。 */
  accent: string | null;
  /** 系统强调色（lib/accent.ts 现值；探测失败 null → 覆盖层回落白字） */
  systemAccent: string | null;
}

export interface DlSyncPayload {
  v: 1;
  posMs: number;
  /** 当前后端对应的歌词时钟补偿（毫秒）；缺省时覆盖层回落 CLOCK_COMP_MS。 */
  clockCompMs?: number;
  playing: boolean;
  /** 当前曲「歌词延迟」（毫秒，正=歌词延后）；覆盖层的 −/+ 遥控最终也回这里取数 */
  delayMs: number;
  durationSec: number;
  canPrev: boolean;
  canNext: boolean;
}

export interface DlStateSnapshot {
  open: boolean;
  enabled: boolean;
  /** 当前是否已经固定并让鼠标透穿 */
  locked: boolean;
  /** 当前会话是否开放该档（macOS / Windows / X11）；Wayland 为 false */
  canLock: boolean;
}

/** 覆盖层回传的控制命令（主进程只转发，执行在本模块）。 */
export type DlCmd =
  | { cmd: "playpause" }
  | { cmd: "prev" }
  | { cmd: "next" }
  | { cmd: "seek"; ms: number }
  | { cmd: "delay"; op: "step" | "zero"; dir?: 1 | -1 }
  /** 字号倍率 ±0.1 一档（0.5..2）：写 [DesktopLyrics] Scale 偏好，广播回覆盖层即时生效 */
  | { cmd: "scale"; dir?: 1 | -1 }
  /** 控制条单键循环标准字重（300/400/…/900）：写 [DesktopLyrics] Weight 偏好 */
  | { cmd: "weight"; op: "cycle" };

/** 主窗侧对覆盖层窗口的控制（ipc quaver:dl-control；成功时带回主进程真相快照）。 */
export type DlControl = { op: "get-state" } | { op: "set-enabled"; on: boolean };

export type DlControlReply =
  | { ok: true; open: boolean; enabled: boolean; scale: number; locked: boolean; canLock: boolean }
  | { ok: false; error: string };

/** 覆盖层的窗口级动作（electron/desktop-lyrics.ts handleWindowOp 的同名 op 表）。 */
export type DlWindowOp =
  | { op: "resize-by"; dx: number; dy: number }
  | { op: "resize-end" }
  | { op: "close" }
  | { op: "lock"; on: boolean };

declare global {
  interface Window {
    quaverDesktopLyrics?: {
      // 主窗侧
      sendTrack(payload: DlTrackPayload): void;
      sendSync(payload: DlSyncPayload): void;
      control(msg: DlControl): Promise<DlControlReply>;
      activeSync(): DlStateSnapshot | null;
      onActive(cb: (s: DlStateSnapshot) => void): void;
      onCmd(cb: (msg: DlCmd) => void): void;
      // 覆盖层侧
      onTrack(cb: (p: DlTrackPayload) => void): void;
      onSync(cb: (p: DlSyncPayload) => void): void;
      sendCmd(msg: DlCmd): void;
      /** 窗口级动作：边缘缩放、关窗、锁定 —— 挪窗走 CSD 拖拽区，不经桥 */
      windowOp(msg: DlWindowOp): void;
    };
  }
}
