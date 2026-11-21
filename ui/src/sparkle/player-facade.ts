// Sparkle — 播放器只读门面（插件能看到的播放态）
//
// 单独成模块的原因：门面同时被 SparkleContext（host.ts）与走带控件挂载（transport.ts）
// 消费。放进 host.ts 会让 transport 反向依赖 host → shell → PlayerBar → transport 成环；
// 这里只 import player，零 UI 依赖，两边都安全。
import type { SparklePlayerFacade } from "@quaver/sparkle";
import { player } from "../player";
import { spectrumFacade } from "../lib/spectrum-controller";

export const sparklePlayerFacade: SparklePlayerFacade = {
  get current() {
    const s = player.current;

    return s ? { mid: s.mid, name: s.name, singer: s.singer, album: s.album, interval: s.interval } : null;
  },
  get time() { return player.time; },
  get paused() { return player.paused; },
  on(cb) { return player.on(cb); },
  spectrum: () => spectrumFacade.frame(),
  onSpectrum: (cb) => spectrumFacade.onFrame(cb),
};
