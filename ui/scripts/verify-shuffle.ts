// 每日随机播放：纯逻辑跑真单测，接线/样式/存档/MPRIS 跑静态断言
//
// 修的是「随机」这件事的语义边界，三条都钉在这里：
//  ① 种子只由**本地日期**决定 → 同一天内顺序必须完全一致（反复开关 / 退出重进都是同一套）。
//     真随机（每次 Math.random）会把用户刚记住的听感打散，反复开关就换一批歌。
//  ② 跨本地零点换序、跨队列变更换序；缓存键 = 队列版本 + 日期键，漏一个就会顺序错位。
//  ③ 「顺序播放」的自然结束要收尾，不能像手动点「下一首」那样回绕到队首；
//     且随机开时「末尾」是当日顺序的末尾，不是队列的末尾。
//
// 用法：node scripts/verify-shuffle.ts
import { execFileSync } from "node:child_process";
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
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ===================== 真单测：日期种子与洗牌 =====================
// Node ≥22.18 默认开启类型剥离，零依赖 .ts 可直接 import。
const { dayKey, daySeed, shuffleOrder, step } = await import("../src/lib/shuffle.ts");

// —— 日期键：本地时区（不是 UTC），否则晚上 8 点前后的用户会觉得换序来得莫名其妙
eq("日期键：本地 2026-10-04", dayKey(new Date(2026, 9, 4, 12, 0, 0)), "2026-10-04");
eq("日期键：月份/日补零", dayKey(new Date(2026, 0, 9)), "2026-01-09");
eq("日期键：同一天不同时刻同键", dayKey(new Date(2026, 9, 4, 0, 0, 1)), dayKey(new Date(2026, 9, 4, 23, 59, 59)));
ok("日期键：跨本地零点换键", dayKey(new Date(2026, 9, 4, 23, 59, 59)) !== dayKey(new Date(2026, 9, 5, 0, 0, 1)));
// 跨时区回归：日界必须跟着本地时区走。构造不出「同一构造参数、不同 TZ」的 Date
// （Date 构造器本来就吃本地时区），所以钉死 TZ 起子进程来测 ——
// 若实现偷懒用 toISOString()（UTC 日界），下面两行会给出同一个 key，红。
{
  const probe = `
    const { dayKey } = await import(${JSON.stringify(new URL("../src/lib/shuffle.ts", import.meta.url).href)});
    // 同一个绝对时刻：2026-10-04T17:00:00Z —— UTC+8 是当地 10/05 凌晨，UTC-5 是当地 10/04 中午
    console.log(dayKey(new Date("2026-10-04T17:00:00Z")));
  `;
  const keyIn = (tz) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    }).trim();
  eq("日期键：TZ=Asia/Shanghai 下 2026-10-04T17Z 算作 10/05", keyIn("Asia/Shanghai"), "2026-10-05");
  eq("日期键：TZ=America/New_York 下同一时刻算作 10/04", keyIn("America/New_York"), "2026-10-04");
}

// —— 种子：同键必得同种子（这是「当天稳定」的地基）
eq("种子：同键同种子", daySeed("2026-10-04"), daySeed("2026-10-04"));
ok("种子：不同日期不同种子", daySeed("2026-10-04") !== daySeed("2026-10-05"));
ok("种子：落在 32 位无符号区间", daySeed("2026-10-04") >= 0 && daySeed("2026-10-04") <= 0xffffffff);
ok("种子：近日期不易撞（FNV-1a 扩散）", new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map(daySeed)).size === 4);

// —— 洗牌：必须是 0..n-1 的一个排列，且同种子结果一致
const ord = shuffleOrder(50, daySeed("2026-10-04"));
ok("洗牌：长度等于 n", ord.length === 50, `len=${ord.length}`);
ok("洗牌：恰好是 0..n-1 的排列", new Set(ord).size === 50 && ord.every((v, i) => ord.includes(i)) && Math.min(...ord) === 0 && Math.max(...ord) === 49);
ok("洗牌：同种子两次结果完全一致（当天稳定）", JSON.stringify(shuffleOrder(50, daySeed("2026-10-04"))) === JSON.stringify(ord));
ok("洗牌：不同日期结果不同（明天换一套）", JSON.stringify(shuffleOrder(50, daySeed("2026-10-05"))) !== JSON.stringify(ord));
ok("洗牌：确实洗过了（不该恰好等于原序）", JSON.stringify(ord) !== JSON.stringify(Array.from({ length: 50 }, (_, i) => i)));
ok("洗牌：相邻不重复（不该连着放同一首的两遍）", ord.every((v, i) => i === 0 || v !== ord[i - 1]));
eq("洗牌：n=0 → 空", shuffleOrder(0, 1).length, 0);
eq("洗牌：n=1 → [0]", JSON.stringify(shuffleOrder(1, 1)), "[0]");
// 分布健全性：排列内部的每个下标出现次数必然相等（那是排列的定义，测了没信息量），
// 真正该查的是「某个**位置**上的取值是否铺开」—— 只查全局直方图会让任何洗牌都通过。
const slot0 = new Array(20).fill(0);
for (let s = 0; s < 4000; s++) slot0[shuffleOrder(20, s)[0]]++;
ok("洗牌：首位取值在 20 首间铺开（200 次 ±80），没退化成固定开头", slot0.every((c) => c >= 120 && c <= 280), `min=${Math.min(...slot0)} max=${Math.max(...slot0)}`);
const slotLast = new Array(20).fill(0);
for (let s = 0; s < 4000; s++) slotLast[shuffleOrder(20, s)[19]]++;
ok("洗牌：末位取值同样铺开（两轮洗牌法若写反会全压在一个值上）", slotLast.every((c) => c >= 120 && c <= 280), `min=${Math.min(...slotLast)} max=${Math.max(...slotLast)}`);

// —— step：沿当日顺序走
const o = [3, 0, 4, 1, 2];
eq("step：下一首", step(o, 3, 1, true), 0);
// o = [3,0,4,1,2] → 0 在位的第 1 位，上一首即位的第 0 位 = 3
eq("step：上一首", step(o, 0, -1, false), 3);
eq("step：wrap=true 末位回绕到首位", step(o, 2, 1, true), 3);
eq("step：wrap=true 首位的上一首回绕到末位", step(o, 3, -1, true), 2);
eq("step：wrap=false 末位的下一首 = -1（顺序播放收尾）", step(o, 2, 1, false), -1);
eq("step：wrap=false 首位的上一首 = -1", step(o, 3, -1, false), -1);
eq("step：空序列 → -1", step([], 0, 1, true), -1);
// cur 不在当日顺序里（用户从列表直接点了一首不在序的歌 / 队列刚换过）：
// 沿 dir 取第一个仍在序里的元素，而不是把整列打乱
ok("step：cur 不在序里 → 沿方向取最近的仍在序元素", step(o, 2, 1, true) === 3 && step(o, 2, -1, true) === 1);
eq("step：cur=-1（还没在播）→ 取序里第一首", step(o, -1, 1, true), 3);
eq("step：cur 比序里所有下标都大且 wrap=false → -1", step(o, 99, 1, false), -1);
eq("step：cur 比序里所有下标都大且 wrap=true → 回绕首位", step(o, 99, 1, true), 3);

// ===================== 静态断言：接线不许被改坏 =====================
const player = read("src/player.ts");
const bar = read("src/components/PlayerBar.ts");
const sess = read("src/lib/session.ts");
const mpris = read("src/mpris.ts");
const css = read("src/style.css");

// —— player：当日顺序的缓存键必须同时含「队列版本」和「日期键」
ok("player：shuffle 是公开状态（UI/MPRIS 读得到）", /^\s*shuffle = false;/m.test(player));
ok("player：缓存记了队列版本", /shuffleCache\s*=\s*\{\s*ver:\s*this\.queueVersion/.test(player) || /c\.ver === this\.queueVersion/.test(player));
ok("player：缓存记了日期键（跨零点自动换序）", /c\.day === day/.test(player));
ok("player：顺序由 lib/shuffle 的洗牌生成", /shuffleOrder\(this\.queue\.length, daySeed\(day\)\)/.test(player));
ok("player：切歌/播完统一走 stepInOrder", /stepInOrder\(1, !auto \|\| this\.mode !== "off"\)/.test(player));
ok("player：播完收尾判定已从 next() 挪进 stepInOrder（随机时末尾≠队尾）", /!wrap && \(\(dir > 0 && i <= this\.index\) \|\| \(dir < 0 && i >= this\.index\)\)/.test(player));
ok("player：onEnded 不再自己判末曲（交给 stepInOrder）", /private onEnded\(\)[\s\S]{0,160}this\.next\(true\);/.test(player) && !/onEnded[\s\S]{0,200}queue\.length - 1/.test(player));
ok("player：坏流回退沿当日顺序走（不打乱当天听感）", /const i = this\.stepInOrder\(1, true\);/.test(player));
ok("player：菜单需要直接落档的 setter", /setMode\(m: Mode\)/.test(player));
ok("player：cycleMode 仍在（MPRIS/热键兼容）", /cycleMode\(\)/.test(player));
ok("player：toggleShuffle 存在且翻转自身", /toggleShuffle\(\)\s*\{\s*this\.shuffle = !this\.shuffle;/.test(player));

// —— 存档：随机与循环同生命周期
ok("session：快照带 shuffle", /shuffle\?: boolean;/.test(sess));
ok("session：写入 shuffle", /shuffle: !!snap\.shuffle,/.test(sess));
ok("session：读回 shuffle（旧存档缺字段按 false）", /shuffle: d\.shuffle === true,/.test(sess));
ok("player：还原时读 shuffle", /this\.shuffle = !!snap\.shuffle;/.test(player));
ok("player：存盘时带 shuffle", /shuffle: this\.shuffle,/.test(player));

// —— 播放条：按钮开菜单（不再是直接轮转）
ok("bar：循环按钮不再直接 cycleMode", !/loop\.onclick = \(\) => player\.cycleMode\(\)/.test(bar));
ok("bar：循环按钮点击开菜单", /loop\.onclick = \(\) => \{\s*const open = el\.classList\.toggle\("lp-open"\)/.test(bar));
ok("bar：菜单四档齐全（顺序/列表/单曲 + 随机）", /id: "off"[\s\S]*id: "all"[\s\S]*id: "one"/.test(bar) && /data-shuffle/.test(bar));
ok("bar：随机项调 toggleShuffle", /player\.toggleShuffle\(\); closeLPop\(\);/.test(bar));
ok("bar：循环项调 setMode（不是靠轮转猜）", /player\.setMode\(m\.id\); closeLPop\(\);/.test(bar));
ok("bar：菜单外点击关闭", /#pb-loop, #pb-lpop/.test(bar));
ok("bar：浮窗内滚轮不被音量吃掉", /#pb-qpop, #pb-lpop/.test(bar) && /if \(t\.closest\("#pb-quality, #pb-loop"\)\) return;/.test(bar));
ok("bar：seek 拖拽不吞浮窗区域", /button, input, \.pb-volpop, \.pb-qpop, \.pb-lpop/.test(bar));
ok("bar：随机开 → 画随机图标", /loop\.innerHTML = player\.shuffle \? icons\.shuffle/.test(bar));
ok("bar：重画签名含 shuffle（只切随机也要换图标）", /const loopSig = `\$\{player\.mode\}\|\$\{player\.shuffle\}`;/.test(bar));
ok("bar：菜单开着时跟随状态同步勾选（MPRIS 也能改档，菜单要跟得上）", /classList\.contains\("lp-open"\)\) syncLPop\(\)/.test(bar));
ok("bar：aria 暴露展开态", /aria-haspopup="menu" aria-expanded="false"/.test(bar) && /loop\.setAttribute\("aria-expanded", String\(open\)\)/.test(bar));
ok("bar：随机档有可读说明（每日一套顺序）", /每日一套顺序/.test(bar));
ok("icons：shuffle 图标已加", /shuffle: svg\(/.test(read("src/lib/icons.ts")));

// —— 样式：与音质浮窗同一套玻璃语言，选中态锚亮度
ok("css：模式浮窗有玻璃底/描边/动效", /\.pb-lpop \{[\s\S]*backdrop-filter: blur/.test(css) && /\.player\.lp-open \.pb-lpop \{ opacity: 1; pointer-events: auto;/.test(css));
ok("css：菜单项选中态前景锚 --ink（裸 accent 会随色相漂）", /\.lp-i\.sel \{[^}]*var\(--ink\)/.test(css));
ok("css：循环/随机之间有分隔线", /\.lp-sep \{/.test(css));
ok("css：菜单项不加底（只有 hover 态有，选中不换底）", !/\.lp-i\.sel \{[^}]*background:/.test(css));

// —— MPRIS：上报真实能力，接住总线回推
ok("mpris：shuffle 如实上报 player.shuffle", /shuffle: player\.shuffle/.test(mpris) && !/shuffle: false/.test(mpris));
ok("mpris：指纹含随机（切随机要推快照）", /player\.shuffle \? "s" : "n"/.test(mpris));
ok("mpris：setShuffle 不再是空 case", /case "setShuffle":\s*\n\s*if \(!!msg\.on !== player\.shuffle\) player\.toggleShuffle\(\);/.test(mpris));
ok("mpris：setLoop 改走 setMode（不必靠轮转凑）", /player\.setMode\(want === "Track"/.test(mpris) && !/靠循环推进/.test(mpris));

console.log(`\n${checks - fails}/${checks} 通过${fails ? `，${fails} 项失败` : ""}`);
process.exit(fails ? 1 : 0);
