// Quaver — 重排庇护（纯逻辑，零依赖）：写确认后的整单新顺序在读侧滞后期内校正读数。
//
// 歌单（songlist-detail.ts）与「我喜欢」（player.ts）共用：上游 SeqSonglist 写确认后
// 读侧可能还回旧顺序（与增删同族的滞后），期内所有读路径按已确认顺序重排；
// 他端并发改序的收敛交给庇护过期后的整单回源。持久化由各调用方自己做
// （两边 localStorage 键不同），这里只管「怎么排」。

export interface OrderMark {
  /** 写确认时的整单 mid 序列（重复 mid 允许：歌单顺序表按 songId 记，同曲可出现两次） */
  mids: string[];
  at: number;
}

/** 按庇护顺序重排读数：名单里的 mid 按记录顺序占前排（缺席的跳过），
 *  名单外的歌（他端新加/本地未知名单）保持读侧相对顺序缀在后面。
 *  重复 mid 保序配对：第 k 次出现的 mid 领走读侧第 k 个同名行，不会互相顶掉。 */
export function applyOrderMark<T extends { mid?: string }>(mark: OrderMark, songs: T[]): T[] {
  const wanted = new Set(mark.mids);
  const byMid = new Map<string, T[]>();

  for (const s of songs) {
    const mid = String(s?.mid ?? "");

    if (!wanted.has(mid)) continue; // 名单外：不参与配对（收尾统一按读侧相对顺序缀后）
    const bucket = byMid.get(mid);

    if (bucket) bucket.push(s);
    else byMid.set(mid, [s]);
  }

  const out: T[] = [];

  for (const mid of mark.mids) {
    const row = byMid.get(mid)?.shift();

    if (row) out.push(row);
  }

  // 读侧多出的同名行（第 k+1 个重复）与名单外的歌一起，按读侧相对顺序缀后
  const claimed = new Set(out);

  for (const s of songs) if (!claimed.has(s)) out.push(s);

  return out;
}

/** 截断列表（「我喜欢」LOVED_MAX）不能拿可见前缀当整单提交 —— 部分提交会打乱
 *  未提交歌曲的顺序。可见数 < 服务端总数时重排必须整体禁用（视图据此关掉起拖）。 */
export const orderComplete = (visible: number, total: number): boolean =>
  visible > 0 && visible >= total;
