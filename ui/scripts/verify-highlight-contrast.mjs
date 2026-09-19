// 高亮态校验：把 style.css 里的实际取值抠出来，按色相/底色全扫取最坏值。
//
// 背景（两个真缺陷）：
//   1. --cvg-accent / --cvg-glow 由封面染色产生（lib/color.ts:toUiColors），色相任意、
//      HSL 亮度固定（0.5 / 0.62），但 **sRGB 相对亮度随色相从 0.05（纯蓝）漂到 0.93（纯黄）**。
//      把裸 accent 当前景色，遇到同亮度的底就塌（实测最坏 1.02:1，等于隐形）。
//      → 前景色的亮度必须锚在主题 token 上（--ink / 遮罩底色），accent 只贡献色相。
//   2. 亮度比不能用来判「两个面色分不分得开」—— accent 描边 vs 条的亮度比只有 1.0~1.1，
//      但色相/彩度差很大（ΔE 39~147）。→ 面色之间的判据一律 ΔE（>2.3 可察觉，>10 清晰可辨）。
//
// 设计约束（写死成断言，防止手滑改回去）：
//   **控制条那一排是「裸图标 + 一个实心主按钮」，次级按钮不得带底片/描边** ——
//   给它们加底就等于把这一排的语言改成 chip 组，与其他控件对不上。
//   所以 .pb-ghost.on 只许改 color；.pb-q.active 的底必须保持 --ph2 不变。
//
// 用法：node scripts/verify-highlight-contrast.mjs   （纯算术，不需要浏览器）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css"), "utf8");

function hex(s) {
  s = s.replace("#", "");
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
function hsl2rgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
function over(a, al, b) { return a.map((v, i) => v * al + b[i] * (1 - al)); }
// color-mix(in srgb, A p%, B) —— 预乘 alpha 语义
function cmix(A, p, B) {
  const al = p * (A.a ?? 1) + (1 - p) * (B.a ?? 1);
  if (!al) return { c: [0, 0, 0], a: 0 };
  return { c: A.c.map((v, i) => (p * v * (A.a ?? 1) + (1 - p) * B.c[i] * (B.a ?? 1)) / al), a: al };
}
const solid = (c) => ({ c, a: 1 });
const flatten = (f, bg) => over(f.c, f.a, bg);
function lum(c) { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); }
function rgb2lab(c) {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function dE(a, b) { const [l1, a1, b1] = rgb2lab(a), [l2, a2, b2] = rgb2lab(b); return Math.hypot(l1 - l2, a1 - a2, b1 - b2); }
const f2 = (n) => n.toFixed(2);
const f1 = (n) => n.toFixed(1);

// —— 封面采样：glow 与 accent 同色相（同一张封面），L 分别 0.62 / 0.5 ——
const COVERS = [];
for (let h = 0; h < 360; h += 10) for (const s of [0.18, 0.5, 1.0]) {
  COVERS.push({ glow: hsl2rgb(h, Math.min(1, s * 1.05), 0.62), accent: hsl2rgb(h, s, 0.5) });
}
COVERS.push({ glow: hex("#19c2d8"), accent: hex("#2f7d5c") }); // 主题兜底色（未播放 / 中继不可用）
COVERS.push({ glow: hex("#19c2d8"), accent: hex("#19c2d8") });

const TOK = {
  浅色: { ink: hex("#1f2329"), bg: hex("#f7f7f8"), bar: hex("#f0f0f1"), ph2: hex("#d5d5d7"), ink2: hex("#6b7280"), ink3: hex("#3c4048") },
  深色: { ink: hex("#e6e8ec"), bg: hex("#131417"), bar: hex("#1a1c21"), ph2: hex("#34373e"), ink2: hex("#a6adb8"), ink3: hex("#c3c8d0") },
};
const SCRIM = hex("#0b0e19");

let fails = 0;
const check = (name, vals, need, kind) => {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo < need) fails++;
  console.log(`${lo >= need ? "PASS" : "FAIL"} ${name}  最坏 ${f2(lo)}:1 / 最好 ${f2(hi)}:1  (门槛 ${need}，${kind})`);
};
const checkE = (name, vals, need) => {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo < need) fails++;
  console.log(`${lo >= need ? "PASS" : "FAIL"} ${name}  最坏 ΔE ${f1(lo)} / 最好 ${f1(hi)}  (门槛 ${need}，清晰可辨)`);
};
const hx = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
// 点名最坏样本：只看一个数字不知道该怎么调，得知道是哪个色相塌的
const worstOf = (label, fn) => {
  let wi = 0, wv = Infinity;
  COVERS.forEach((p, i) => { const v = fn(p); if (v < wv) { wv = v; wi = i; } });
  return { accent: COVERS[wi].accent, i: wi, v: wv };
};
const note = (s) => console.log("     ↳ " + s);
const bad = (s) => { fails++; console.log("FAIL " + s); };

// ================= 抠值 + 结构断言 =================
const blockOf = (sel) => {
  const m = css.match(new RegExp(sel.replace(/[.#]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  if (!m) { bad(`找不到规则 ${sel}`); return ""; }
  return m[1];
};
const pct = (b, what) => {
  const m = b.match(/color-mix\(in srgb,[\s\S]*?(\d+)%/);
  if (!m) { bad(`${what}：取不到 color-mix 比例`); return NaN; }
  return parseFloat(m[1]) / 100;
};

const ghost = blockOf(".pb-ghost.on");
const love = blockOf(".pb-ghost#pb-love.on");
const pill = blockOf(".pb-q.active");
const npOn = blockOf(".np-trans.on");

console.log("=== style.css 实际取值 ===");
const F_GHOST = pct(ghost, ".pb-ghost.on 前景");
const F_PILL = pct(pill, ".pb-q.active 前景");
const W_NP = pct(npOn, ".np-trans.on 洗底");
const veilM = npOn.match(/#ffffff([0-9a-f]{2})/i);
if (!veilM) bad(".np-trans.on 白纱锚点取不到");
const A_NP = veilM ? parseInt(veilM[1], 16) / 255 : NaN;
console.log(`  ghost 前景 accent ${F_GHOST}　胶囊 前景 accent ${F_PILL}　np 白纱 accent ${W_NP} + #ffffff${veilM ? veilM[1] : "??"}`);

// —— 结构断言 ——
if (/background\s*:/.test(ghost)) bad(".pb-ghost.on 带了 background —— 控制条是裸图标排，次级按钮不许加底");
if (/box-shadow\s*:/.test(ghost)) bad(".pb-ghost.on 带了 box-shadow（描边/底片）—— 控制条次级按钮不许加");
if (!ghost.includes("var(--ink)")) bad(".pb-ghost.on 前景没锚到 --ink（裸 accent 会随色相漂）");
if (/background\s*:/.test(pill)) bad(".pb-q.active 改了 background —— 胶囊的底必须保持 --ph2");
if (!pill.includes("var(--ink)")) bad(".pb-q.active 前景没锚到 --ink");
if (!/border-color:\s*var\(--cvg-accent/.test(pill)) bad(".pb-q.active 描边不是实心 accent");
if (love.replace(/\s/g, "") !== "color:#e8465a;") bad(`.pb-ghost#pb-love.on 应保持原样 color:#e8465a（固定色本就够对比），现为：${love.trim()}`);
if (!npOn.includes("color: #0b0e19")) bad(".np-trans.on 前景没锚到遮罩底色（本页恒深，不能用 --ink）");
// np 胶囊不加描边：实测那圈对轮廓的贡献还不如洗底自己，属于多余元件
if (/box-shadow\s*:/.test(npOn)) bad(".np-trans.on 又加描边了 —— 实测它不贡献轮廓（单看最坏 ΔE 11.6 vs 洗底 18.9），别加");
if (fails) { console.log("\n结构不对，先修 CSS 再跑对比度"); process.exit(1); }

// ================= 控制条 =================
for (const [tn, T] of Object.entries(TOK)) {
  console.log(`\n=== 控制条 · ${tn} ===`);
  const fgGhost = (p) => mix(p.accent, T.ink, F_GHOST);
  const fgPill = (p) => mix(p.accent, T.ink, F_PILL);

  check("循环/静音 · 图标 vs 播放条底（非文字）", COVERS.map((p) => ratio(fgGhost(p), T.bar)), 3.0, "图形 3.0");
  check("音质胶囊 · 文字 vs --ph2（11px 小字，底未变）", COVERS.map((p) => ratio(fgPill(p), T.ph2)), 4.5, "小字 4.5");
  // 只改色时，得看「开」与「关」到底靠什么分开。注意通道不止一个：
  //   循环/静音的关态图标自带 opacity=".45" 的笔画与斜杠，开态是满不透明 —— 图形通道本来就在；
  //   胶囊的开/关是同一个字串「母带」，图形通道没有，靠的是实心 accent 描边（ΔE 30 起）。
  // 所以颜色通道门槛取「可察觉」而不是「强烈可辨」：它只需与字形通道合力，不必独扛。
  const wG = worstOf("ghost", (p) => dE(fgGhost(p), T.ink3));
  const wP = worstOf("pill", (p) => dE(fgPill(p), T.ink2));
  checkE("循环/静音 · 色彩通道：开态图标 vs 关态图标（--ink3）", COVERS.map((p) => dE(fgGhost(p), T.ink3)), 5);
  note(`   最坏样本：封面 accent ${hx(wG.accent)} → 开态 ${hx(fgGhost(COVERS[wG.i]))} vs 关态 ${hx(T.ink3)}，ΔE ${f1(wG.v)}（鲜艳封面最好 ${f1(Math.max(...COVERS.map((p) => dE(fgGhost(p), T.ink3))))}）`);
  checkE("音质胶囊 · 色彩通道：开态文字 vs 关态文字（--ink2）", COVERS.map((p) => dE(fgPill(p), T.ink2)), 5);
  note(`   最坏样本：封面 accent ${hx(wP.accent)} → 开态 ${hx(fgPill(COVERS[wP.i]))} vs 关态 ${hx(T.ink2)}，ΔE ${f1(wP.v)}`);
  checkE("音质胶囊 · 图形通道：实心 accent 描边 vs --ph2（这个独扛，门槛高）", COVERS.map((p) => dE(p.accent, T.ph2)), 20);
  note(`   低饱和（灰/银）封面下 --cvg-accent 本身就没有彩度（toUiColors 对灰封面刻意保留灰调），`);
  note(`   色彩通道必然弱 —— 这是封面染色系统的全局性质，进度条/侧栏/标签同理，不是控制条能单独解决的。`);
  check("红心 · 固定色 vs 播放条底", [ratio(hex("#e8465a"), T.bar)], 3.0, "图形 3.0");

  // 安全上限
  const capF = (base, need) => {
    let best = 0;
    for (let F = 0.02; F <= 1.0001; F += 0.02) if (Math.min(...COVERS.map((p) => ratio(mix(p.accent, T.ink, F), base))) >= need) best = F;
    return Math.round(best * 100) / 100;
  };
  const capIcon = capF(T.bar, 3.0), capText = capF(T.ph2, 4.5);
  note(`安全上限：ghost 前景 ≤ ${capIcon}（现 ${F_GHOST}）　胶囊前景 ≤ ${capText}（现 ${F_PILL}）`);
  if (F_GHOST > capIcon + 0.021) bad(`.pb-ghost.on 的 accent 占比 ${F_GHOST} 越界，应 ≤ ${capIcon}`);
  if (F_PILL > capText + 0.021) bad(`.pb-q.active 的 accent 占比 ${F_PILL} 越界，应 ≤ ${capText}`);

  const before = COVERS.map((p) => ratio(p.accent, T.bar));
  note(`对照·改前「裸 accent 图标 vs 播放条底」最坏 ${f2(Math.min(...before))}:1 ／ 改后同一口径 ${f2(Math.min(...COVERS.map((p) => ratio(fgGhost(p), T.bar))))}:1`);
  note(`对照·改前「裸 accent 文字 vs --ph2」最坏 ${f2(Math.min(...COVERS.map((p) => ratio(p.accent, T.ph2))))}:1 ／ 改后 ${f2(Math.min(...COVERS.map((p) => ratio(fgPill(p), T.ph2))))}:1`);
}

// ================= 正在播放页（底色恒深；二维扫描 封面亮度 × 遮罩透明度）=================
console.log("\n=== 正在播放页 · 翻译胶囊（底色恒深，与明暗主题无关）===");
const SURFACES = [];
for (let g = 0; g <= 255; g += 15) for (const a of [0.35, 0.45, 0.55]) SURFACES.push(over([g, g, g], a, SCRIM));
const onFill = (p, s) => flatten(cmix(solid(p.accent), W_NP, { c: [255, 255, 255], a: A_NP }), s);
const offFill = (s) => over([255, 255, 255], 0.12, s);

check("近黑字 vs 洗底（12px 粗体）", COVERS.flatMap((p) => SURFACES.map((s) => ratio(SCRIM, onFill(p, s)))), 4.5, "小字 4.5");
checkE("开态底 vs 关态底", COVERS.flatMap((p) => SURFACES.map((s) => dE(onFill(p, s), offFill(s)))), 10);
// 边界判「亮洗底 vs 页面底」：洗底是浅纱，压在亮封面上时亮度天然趋同，
// 但它是 80% 白锚的纱，比关态的 12% 白纱强得多，轮廓由它自己划出来（无描边）。
checkE("开态轮廓 · 亮洗底 vs 页面底（按轮廓门槛 15：形状边界，不是要读的字）",
  COVERS.flatMap((p) => SURFACES.map((s) => dE(onFill(p, s), s))), 15);
{
  let capW = 0;
  for (let W = 0.05; W <= 1.0001; W += 0.01) {
    if (COVERS.every((p) => SURFACES.every((s) => ratio(SCRIM, flatten(cmix(solid(p.accent), Math.round(W * 100) / 100, { c: [255, 255, 255], a: A_NP }), s)) >= 4.5))) capW = W;
  }
  capW = Math.round(capW * 100) / 100;
  note(`安全上限：白纱 accent 占比 ≤ ${capW}（现 ${W_NP}）　白纱不透明度 ${Math.round(A_NP * 100)}%`);
  if (W_NP > capW + 0.011) bad(`.np-trans.on 的 accent 占比 ${W_NP} 越界，应 ≤ ${capW}`);
}
note(`扫描面：封面灰度 0-255 × 遮罩 0.35/0.45/0.55 = ${SURFACES.length} 种底色 × ${COVERS.length} 色相`);

// ================= 「软洗底 + accent 系前景 + accent 描边」这一类高亮态 =================
// 口径（本仓库「次级开关 / 选中」那一套）：**前景只把亮度锚到 --ink**，accent 只贡献色相；
// 底色是 glow 的低比例洗底（压在页面底 --bg 上）。所以要比的是「前景 vs 洗底之后的实际底色」。
// 为什么不能铺实心 accent + 白字：see 下面的回归对照（最坏 1.07:1）。
const MIX_CASES = [
  { sel: ".lt-sg.on", name: "列表工具条 · 排序胶囊", px: "12.5px" },
  { sel: ".login-wrap .tag.sel", name: "登录页 · 登录方式标签", px: "13px" },
];
for (const C of MIX_CASES) {
  console.log(`\n=== ${C.name} ${C.sel}（软洗底 + accent 系前景）===`);
  const block = blockOf(C.sel);
  const pctOf = (re, what) => {
    const m = block.match(re);
    if (!m) { bad(`${C.sel} ${what} 取不到 color-mix 比例`); return NaN; }
    return parseFloat(m[1]) / 100;
  };
  const WASH = pctOf(/background:\s*color-mix\(in srgb,[\s\S]*?(\d+)%/, "洗底");
  // 注意别被 `border-color:` 抢匹配：它排在 color 前面，`/color:/` 会命中它
  const FG = pctOf(/(?<![-\w])color:\s*color-mix\(in srgb,[\s\S]*?(\d+)%/, "前景");
  const BD = pctOf(/border-color:\s*color-mix\(in srgb,[\s\S]*?(\d+)%/, "描边");
  // 结构：底不许是实心 accent（那会退化成「白字 + 裸 accent」那套），前景必须锚到 --ink
  if (/background:[^;]*var\(--cvg-accent/.test(block)) bad(`${C.sel} 的底用了实心 accent —— 亮色相封面/浅色 accent 下前景会塌`);
  if (!/background:[^;]*transparent/.test(block)) bad(`${C.sel} 的底不是洗底（应 mix 到 transparent）`);
  if (!block.includes("var(--ink)")) bad(`${C.sel} 前景没锚到 --ink（裸 accent 的亮度会随色相漂）`);
  if (!block.includes("var(--acc)")) bad(`${C.sel} 没给 --acc 兜底（未播放/中继不可用时要有色）`);
  console.log(`  取值：洗底 glow ${WASH}　前景 accent ${FG}　描边 accent ${BD}`);
  for (const [tn, T] of Object.entries(TOK)) {
    const washBg = (p) => over(p.glow, WASH, T.bg);   // 洗底压在页面底上
    const fg = (p) => mix(p.accent, T.ink, FG);       // 前景只把亮度锚回 token
    check(`${tn} · 选中文字 vs 洗底（${C.px} 小字）`, COVERS.map((p) => ratio(fg(p), washBg(p))), 4.5, "小字 4.5");
    // 图形通道：底色开/关（洗底 vs 页面底）+ 文字开/关，两条都在 → 门槛取「可察觉」即可
    checkE(`${tn} · 底色开/关（洗底 vs 页面底）`, COVERS.map((p) => dE(washBg(p), T.bg)), 2.3);
    checkE(`${tn} · 文字色开/关（accent 掺色 vs --ink2）`, COVERS.map((p) => dE(fg(p), T.ink2)), 5);
    let cap = 0;
    for (let F = 0.02; F <= 1.0001; F += 0.02) {
      if (COVERS.every((p) => ratio(mix(p.accent, T.ink, F), washBg(p)) >= 4.5)) cap = Math.round(F * 100) / 100;
    }
    const w = worstOf(C.sel, (p) => ratio(fg(p), washBg(p)));
    note(`安全上限：前景 accent ≤ ${cap}（现 ${FG}）　洗底 glow ${WASH}（只影响底，不参与上限）`);
    note(`最坏样本：封面 accent ${hx(w.accent)} → 文字 ${hx(fg(COVERS[w.i]))} vs 洗底 ${hx(washBg(COVERS[w.i]))}`);
    if (FG > cap + 0.021) bad(`${C.sel} 前景 accent 占比 ${FG} 越界，应 ≤ ${cap}`);
  }
}

// ================= 回归对照（本次未动，仅记录）=================
console.log("\n=== 回归对照（未改动，仅记录数值）===");
const raw = COVERS.map((p) => ratio(p.accent, [255, 255, 255]));
console.log(`  「白字 + 裸 accent 实心」= .tag.sel / .stab.sel / .opt-card.sel 现有口径\n       最坏 ${f2(Math.min(...raw))}:1 / 最好 ${f2(Math.max(...raw))}:1`);
if (Math.min(...raw) < 3) console.log("       ← 亮色相封面下不可读。要收敛就同样把底色锚到 --ink（如 color-mix(in srgb, accent 34%, var(--ink))）");

console.log(fails ? `\n${fails} 项未达标` : "\nALL PASS");
process.exit(fails ? 1 : 0);
