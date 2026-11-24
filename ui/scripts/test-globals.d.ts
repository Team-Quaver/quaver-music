// Quaver — 校验脚本侧的 ambient 声明（只进 tsconfig.scripts，随包代码看不见它）。
//
// 这些 `window.__x` 是脚本经 page.evaluate / addInitScript 注入或读取的**测试钩子**：
// 事实源在脚本自己手里（渲染层只负责挂出来），类型却跨了进程边界，tsc 看不到。
// 与其在每个 evaluate 回调里 `as any`（噪声大、还挡不住拼错键名之外的错误），
// 不如在这里一次性登记，形状统一按 any —— 与本工程对 scripts/** 放宽 noImplicitAny
// 的取向一致：断言工具的 correctness 来自跑绿，不来自类型。
// 需要真类型的桥（preload 暴露的 quaverUpdate / quaverSparkle …）留在 src/globals.d.ts。
interface Window {
  /** 播放内核测试桥（src 侧挂载）：state / play / pause / seek / … */
  __quaverPlayer?: any;
  /** 同上的别名，早期脚本用的名字 */
  __player: any;
  /** 配置读写测试桥 */
  __cfg: any;
  /** 曲库同步测试桥：src/lib/playlists.ts 声明了同名钩子，scripts 工程经 verify 脚本
   *  间接 import 到它 —— 全局 Window 合并要求两处类型逐字一致，这里直接引那份类型
   *  （本文件其余钩子仍是 any：它们没有随包声明，不存在合并冲突）。 */
  __quaverSonglists?: import("../src/lib/playlists").QuaverSonglistsBridge;
  /** 搜索框测试桥 */
  __sb: any;
  /** 「添加本地插件」流程的桩：消息记录 + 选择结果 */
  __installLocalMsg: any;
  __installed: any;
  __pickResult: any;
  /** 进度条拖拽/能力探测用 */
  __seekCap: any;
  /** 探针计数与时间轴 */
  __probeCalls: any;
  __probeArm: any;
  __testTime: any;
  __pa: any;
  __T: any;
  /** CSP 内联脚本命中检测 */
  __cspInlineScript: any;
  __cspInlineHit: any;
  /** 歌曲行探针（scripts/probe-song-rows.ts）注入的夹具与计数 */
  __box: HTMLElement;
  __calls: string[];
  __mk: (n: number) => Array<{ mid: string; id: number; title: string; interval: number; singer: Array<{ mid: string; name: string }>; album: { mid: string; name: string } }>;
  __hooks: { showAlbum: boolean; onPlay: (song: { mid: string }, index: number, all: unknown[]) => void; onLove: (song: { mid: string }, loved: boolean) => void };
  __songs: { renderSongRows: (box: HTMLElement, songs: unknown[], hooks: import("../src/lib/songs").RowHooks) => void };
  __lw: { row: number; box: number; other: number };
  /** 插件探针 / 释放钩子（verify-sparkle 系列脚本） */
  __quaverSparkleProbe: any;
  __dispose: any;
  /** 主进程桥在渲染层的名字（浏览器 dev 下由脚本自己造假对象） */
  quaverMpris: any;
  quaverConfig: any;
  quaverRedflag: any;
}
