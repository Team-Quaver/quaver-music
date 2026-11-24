// Quaver — 桌面歌词桥的线契约（只给 preload 用）。
//
// 为什么不在 preload 里直接 import `src/lib/desktop-lyrics-protocol.ts`：那份契约带
// `@quaver/sparkle` 的歌词类型，会把 vendor/Sparkle 拖进 tsconfig.node.json 的 nodenext
// 工程（相对导入无扩展名，工程内会报 TS2835）。preload 只搬运数据、不解释歌词，
// 这里按「结构化克隆能过的字段」复述一遍即可；渲染层消费侧仍以 protocol 那份为准。

export type DlTrack = {
  v: 1;
  key: string;
  mid: string;
  title: string;
  artist: string;
  cover: string;
  lyricState: "idle" | "loading" | "ok" | "none";
  lyricRevision: number;
  durationSec: number;
  karaoke: readonly unknown[];
  lines: ReadonlyArray<{ t: number; text: string; trans?: string; roma?: string }>;
  accent: string | null;
  systemAccent: string | null;
};

export type DlSync = {
  v: 1;
  posMs: number;
  clockCompMs?: number;
  playing: boolean;
  buffering?: boolean;
  delayMs: number;
  durationSec: number;
  canPrev: boolean;
  canNext: boolean;
};

export type DlState = {
  open: boolean;
  enabled: boolean;
  locked: boolean;
  canLock: boolean;
};

export type DlControlMsg = { op: "get-state" } | { op: "set-enabled"; on: boolean };

export type DlControlResult =
  | { ok: true; open: boolean; enabled: boolean; scale: number; locked: boolean; canLock: boolean }
  | { ok: false; error: string };

export type DlCommand =
  | { cmd: "playpause" }
  | { cmd: "prev" }
  | { cmd: "next" }
  | { cmd: "seek"; ms: number }
  | { cmd: "delay"; op: "step" | "zero"; dir?: 1 | -1 }
  | { cmd: "scale"; dir?: 1 | -1 }
  | { cmd: "weight"; op: "cycle" };

export type DlWindowAction =
  | { op: "resize-by"; dx: number; dy: number }
  | { op: "resize-end" }
  | { op: "close" }
  | { op: "lock"; on: boolean };
