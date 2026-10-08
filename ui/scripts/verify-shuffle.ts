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
const { dayKey, daySeed, shuffleOrder, step, walk } = await import("../src/lib/shuffle.ts");

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

// —— walk：一次走 N 步（封面流的 ±2 槽位用它取「下下首 / 上上曲」）
// 回归点：多步前进必须**每步从上一步的落点继续**。曾经的宿主实现是循环调用
// 上面那个 step，而它的起点恒为「当前曲」→ 走 N 步仍停在第一跳，
// songAtOffset(-2) 取回的是 -1 那首，封面流左右各出现一对重复封面。
const id5 = [0, 1, 2, 3, 4];      // 顺序播放时的「播放顺序数组」= 恒等序
eq("walk：顺序序上走 1 步", walk(id5, 2, 1, -1, false), 1);
eq("walk：顺序序上走 2 步（≠ 1 步，这是 ±2 的语义）", walk(id5, 2, 2, -1, false), 0);
eq("walk：正向走 2 步", walk(id5, 2, 2, 1, false), 4);
eq("walk：走 3 步越界（wrap=false 到末尾就停）", walk(id5, 2, 3, 1, false), -1);
eq("walk：中间越界即返回 -1（不硬凑）", walk(id5, 4, 2, 1, false), -1);
eq("walk：wrap=true 回绕继续走", walk(id5, 4, 2, 1, true), 1);
eq("walk：0 步 = 原地", walk(id5, 3, 0, 1, true), 3);
eq("walk：洗牌序上走 2 步 ≠ 走 1 步", walk(o, 3, 2, 1, false), 4);
// o = [3,0,4,1,2]：从 3 出发 → 0 → 4，所以 +2 是 4（而不是又回到 0）
eq("walk：洗牌序上走 2 步落点", walk(o, 3, 2, 1, true), 4);
eq("walk：空序列 → -1", walk([], 0, 2, 1, true), -1);
// 步数爆炸：插件可能传天文数字（offset 来自路由/用户），线性空转会转死主线程。
// 夹紧后 wrap 取模、不 wrap 最多 n 步，语义不变。
eq("walk：超大 wrap 步数按取模（1e9 % 5 = 0 → 原地）", walk(id5, 2, 1e9, 1, true), 2);
eq("walk：超大不 wrap 步数直接判定越界（不空转）", walk(id5, 2, 1e9, 1, false), -1);
eq("walk：正好一圈 = 原地", walk(id5, 3, 5, -1, true), 3);

// ===================== 静态断言：接线不许被改坏 =====================
const player = read("src/player.ts");
const shuffleSrc = read("src/lib/shuffle.ts");
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
ok("player：播完收尾判定在步进原语里（随机时末尾≠队尾），next() 不自己判", /return step\(this\.orderOf\(\), this\.index, dir, wrap\)/.test(player) && /if \(!wrap\) return -1;/.test(shuffleSrc) && !/onEnded[\s\S]{0,200}queue\.length - 1/.test(player));
// 多步前进必须走 walk（每步从上一步的落点继续）。曾经的写法是循环调 stepInOrder ——
// 它永远从 this.index 出发，循环 N 次只走一步：songAtOffset(±2) === ±1，封面流左右
// 各出现一对重复封面，jumpToOffset(±2) 也只跳一首。
ok("player：songAtOffset/jumpToOffset 走 walk（别再循环调「从当前走一步」）", /const i = walk\(this\.orderOf\(\), this\.index, Math\.abs\(offset\), dir, false\);/.test(player) && /const i = walk\(this\.orderOf\(\), this\.index, Math\.abs\(offset\), dir, true\);/.test(player) && !/this\.stepInOrder\(dir,/.test(player));
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
// 玻璃底/描边/模糊已收敛到 style.css 的「浮层菜单的玻璃」共享规则（一处定义、七处消费）——
// 这里只卡「.pb-lpop 在那条共享规则的选择器表里，且那条规则真的带模糊」，不再要求它自己写一份
// （各菜单各写一份正是「菜单看着没有模糊」的病根，见 scripts/verify-menu-glass.ts）。
ok("css：模式浮窗吃到共享的菜单玻璃（不再各写一份 backdrop-filter）",
  /\.ctx-menu, \.pb-qpop, \.pb-lpop, \.pb-volpop, \.tint-pop, \.np-menu, \.np-qinfo \{[\s\S]*?backdrop-filter: var\(--menu-filter\)/.test(css)
  && /\.player\.lp-open \.pb-lpop \{ opacity: 1; pointer-events: auto;/.test(css));
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
