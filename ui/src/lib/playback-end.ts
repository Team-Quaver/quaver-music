// Quaver — 自然曲末的一次性闸门。
//
// PCM 会先发 `ending`（本地还有尾音），再在旧 sink 排空后发一次迟到的 `ended`；
// native 只发 `ended`。两路共用同一个闸门，保证一首歌只推进一次队列。
//
// 这里刻意**不掺 loading 状态**：起播后的 `waiting` 也会把 loading 置真，
// 拿它判重会把真实曲末吞掉，队列就停在这一首。

/** 当前曲的自然曲末是否已经消费；`reset()` 由新曲真正出声或主动打断时调用。 */
export class PlaybackEndGate {
  private consumed = false;

  /** 首次调用返回 true；同一曲后续重复事件返回 false。 */
  consume(): boolean {
    if (this.consumed) return false;
    this.consumed = true;

    return true;
  }

  /** 新曲起播/主动换曲：允许下一次自然曲末再次推进。 */
  reset(): void {
    this.consumed = false;
  }
}
