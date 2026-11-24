// 默认正在播放页封面中心翻转：方向纯逻辑真单测 + 宿主/SDK 接线静态断言。
//
// 口径（用户可见）：上一首 = 左到右，下一首 = 右到左；中心翻转，
// 新面转正时带一点惯性过冲；只在默认布局播放；同曲换封面候选/展开收起不翻；
// 插件可经 player.flipCover() 回放，接管视图 no-op。
//
// 用法：node scripts/verify-np-cover-flip.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let fails = 0;
let checks = 0;

const ok = (name, cond, note = "") => {
  checks++;

  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ===================== 真单测：中心翻转 + 惯性 =====================
const { coverFlipFrames, COVER_FLIP_MS } = await import("../src/lib/np-cover-flip.ts");

const next = coverFlipFrames("next");
const prev = coverFlipFrames("prev");
const tx = (frame) => Number(/translateX\((-?[\d.]+)px\)/.exec(frame.transform)?.[1] ?? NaN);
const angle = (frame) => Number(/rotateY\((-?[\d.]+)deg\)/.exec(frame.transform)?.[1] ?? NaN);

ok("下一首（右到左）：新面从右侧转入，旧面往左转出",
  tx(next.incoming[0]) > 0 && angle(next.incoming[0]) > 0
  && tx(next.outgoing[1]) < 0 && angle(next.outgoing[1]) < 0);

ok("上一首（左到右）：新面从左侧转入，旧面往右转出",
  tx(prev.incoming[0]) < 0 && angle(prev.incoming[0]) < 0
  && tx(prev.outgoing[1]) > 0 && angle(prev.outgoing[1]) > 0);

ok("42% 处两面都在侧棱（交换点不闪）",
  next.incoming[1].offset === 0.42 && Math.abs(angle(next.incoming[1])) === 90
  && next.outgoing[1].offset === 0.42 && Math.abs(angle(next.outgoing[1])) === 90);

ok("新面转正后带惯性：过冲 12°，再用长缓动缓慢回正 0°",
  angle(next.incoming[2]) === 0
  && angle(next.incoming[3]) === -12 && tx(next.incoming[3]) === -9
  && angle(next.incoming[4]) === 0
  && next.incoming[2].offset === 0.62
  && next.incoming[3].offset === 0.72
  && next.incoming[4].offset === 1
  && angle(prev.incoming[3]) === 12 && tx(prev.incoming[3]) === 9);

ok("方向互为镜像（next 与 prev 的翻转符号相反）",
  tx(next.incoming[0]) === -tx(prev.incoming[0]) && angle(next.incoming[0]) === -angle(prev.incoming[0]));

ok("时长足够翻完并柔和收住惯性", COVER_FLIP_MS >= 600 && COVER_FLIP_MS <= 900, `${COVER_FLIP_MS}ms`);

// ===================== 静态断言：播放器来向 =====================
const player = read("src/player.ts");
const np = read("src/components/NowPlaying.ts");
const css = read("src/style.css");
const types = read("../vendor/Sparkle/sdk/types.ts");
const facade = read("src/sparkle/player-facade.ts");
const guide = read("../vendor/Sparkle/docs/plugin-author-guide.md");
const playerCode = noComments(player);
const npCode = noComments(np);

ok("player: 记录切歌来向并暴露只读 getter",
  /private switchDir: CoverFlipDirection = "next";/.test(playerCode)
  && /get coverFlipDirection\(\): CoverFlipDirection/.test(playerCode));

ok("player: next/prev/jumpToOffset 显式传方向（随机下一首可能落到更小下标，不能只看下标）",
  /jump\(firstNew, "next"\)/.test(playerCode)
  && /jump\(i, "next"\)/.test(playerCode)
  && /jump\(this\.index - 1, "prev"\)/.test(playerCode)
  && /jump\(i, "prev"\)/.test(playerCode)
  && /jump\(i, offset > 0 \? "next" : "prev"\)/.test(playerCode));

ok("player: jump 的缺省来向按目标下标前后判（点队列行）",
  /jump\(i: number, dir\?: CoverFlipDirection\)/.test(playerCode)
  && /this\.switchDir = dir \?\? \(i < this\.index \? "prev" : "next"\)/.test(playerCode));

// ===================== 静态断言：NowPlaying 动画 =====================
ok("np: 只在 mid 真变化时翻（同曲候选降级/展开换档不翻）",
  /const switched = coverSeen && !!mid && !!lastCoverMid && mid !== lastCoverMid;/.test(npCode)
  && /if \(!switched && pic === lastCover\) return;/.test(npCode));

ok("np: 换曲且展开时按 player.coverFlipDirection 翻，收起/换图直接画",
  /if \(switched && open\) \{\s*flipCover\(player\.coverFlipDirection, \(\) => paintNpCover\(pic\)\);/.test(npCode)
  && /if \(switched \|\| !open\) clearCoverFlip\(\);/.test(npCode));

ok("np: 旧图克隆成 .np-cover-ghost，主封面 DOM 仍只有当前 img",
  /const ghost = cover\.cloneNode\(true\) as HTMLElement;/.test(npCode)
  && /ghost\.classList\.add\("np-cover-ghost"\)/.test(npCode)
  && /cover\.animate\(frames\.incoming, options\)/.test(npCode)
  && /ghost\.animate\(frames\.outgoing, options\)/.test(npCode));

ok("np: 插件回放入口已接、接管视图/收起/无曲不播",
  /bindNpCoverFlip\(\(dir\) => flipCover\(dir, null\)\)/.test(npCode)
  && /player\.expanded && !!player\.current && !el\.classList\.contains\("np-taken-over"\)/.test(npCode));

ok("np: prefers-reduced-motion 直接换图",
  /prefers-reduced-motion: reduce/.test(npCode) && /!reduceMotion\(\)/.test(npCode));

// ===================== 静态断言：CSS / SDK =====================
ok("css: 两面绕中心转、隐藏背面，ghost 绝对定位盖在封面上",
  /\.np-cover \{[^}]*transform-origin: 50% 50%; backface-visibility: hidden;/.test(css)
  && /\.np-cover-ghost \{[^}]*position: absolute; inset: 0;[^}]*transform-origin: 50% 50%; backface-visibility: hidden;/.test(css)
  && !/\.np-cover-card/.test(css));

ok("sdk: 播放器门面暴露可缺省的 flipCover(prev|next)",
  /flipCover\?\(direction: SparkleCoverFlipDirection\): void;/.test(types)
  && /flipCover: \(direction\) => requestNpCoverFlip\(direction\)/.test(facade));

ok("docs: 作者指南写明 flipCover 与默认布局限制",
  /flipCover\?\.\("prev"\|"next"\)/.test(guide) && /收起态或插件整页接管时无操作/.test(guide));

console.log(`\n${checks - fails}/${checks} passed`);

if (fails) process.exit(1);
