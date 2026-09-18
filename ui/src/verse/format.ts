// Verse 数字格式：时长一律 mm:ss（零填充），配 tabular-nums 的等宽数字列。
// 与 bundle 里 formatTime 同构；替代 lyric.fmtDur（"1:41" 非零填充，不合规范）。

export function formatTime(sec: number): string {
  if (sec == null || isNaN(sec)) return "--:--";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? "0" + m : "" + m) + ":" + (r < 10 ? "0" + r : "" + r);
}
