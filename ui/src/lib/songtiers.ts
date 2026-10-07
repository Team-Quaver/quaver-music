// Quaver — 单曲音质档位存在性（纯逻辑，零依赖：Node strip-types 可直接加载做真单测）。
//
// 上游歌曲对象的 file 元数据声明了这首歌有哪些音质：128/320/flac 有命名字段，
// 臻品系（含 OGG 320/640）打包在 size_new 数组里。数组位置上游无文档 —— 位置语义经
// 实测对账（2026-10：取全档位真实链接后 HEAD 实际字节数，与数组逐位吻合，三首歌交叉验证；
// size==0 ⇔ 该档取链被上游拒绝 result=104003，含「无明文 FLAC 却有母带」的组合）：
//   [0]=master(AI00) [1]=atmos2(Q000) [2]=atmos51(Q001) [3]=320ogg(O800)
//   [5]=640ogg(O801) [6]=atmos71(Q003)；其余位置属未入档位表的形态（NAC/DTS…），不消费。
//
// 消费方：播放条音质选择器（PlayerBar）—— 这首歌没有的档位直接隐藏，换曲即重建；
// auto 永远保留。会员锁定档不算「无源」：照样展示标 🔒，交给自动回退协商。
// 全景声不受「回退臻品全景声」开关影响：检测到有源就展示 —— 那个开关只管自动回退链
// 的落点排序（resolve 的 deprioritize），不管档位在不在。

/** size_new 位置 → 档位 id（其余档位用 file 上的命名字段） */
const SIZE_NEW_INDEX: Record<string, number> = {
  master: 0, atmos2: 1, atmos51: 2, "320ogg": 3, "640ogg": 5, atmos71: 6,
};

/** 命名 size 字段 → 档位 id */
const SIZE_FIELD: Record<string, string> = {
  "128": "size_128mp3", "320": "size_320mp3", flac: "size_flac",
};

/** 判定这首歌需要隐藏的档位（上游元数据确认无源），返回档位 id 集合。
 *  qualities = 档位全集（调用方给，通常是 QUALITIES 的键）；file = 上游歌曲对象的 file 元数据。
 *  size==0 ⇒ 无源 ⇒ 隐藏；字段缺席 ⇒ 无从判定 ⇒ 不隐藏（resolve 的自动回退兜底）。
 *  一个 size 字段都不认识（旧版会话存档只留了 media_mid / 上游改了结构）⇒ 返回 null，
 *  调用方回退全量列表。 */
export function missingTiersOf(qualities: readonly string[], file: any): Set<string> | null {
  if (!file) return null;
  const sn = Array.isArray(file.size_new) ? file.size_new : null;
  const hide = new Set<string>();
  let seen = false; // 至少认识一个 size 字段才下结论
  for (const q of qualities) {
    const idx = SIZE_NEW_INDEX[q];
    const v: unknown = idx === undefined ? file[SIZE_FIELD[q] ?? ""] : sn?.[idx];
    if (typeof v !== "number") continue;
    seen = true;
    if (v <= 0) hide.add(q);
  }
  return seen ? hide : null;
}

/** 档位存在性判定消费的 file 字段（会话存档瘦身据此决定留哪些，见 lib/session.ts） */
export const SONG_TIER_SIZE_KEYS = ["size_128mp3", "size_320mp3", "size_flac", "size_new"] as const;
