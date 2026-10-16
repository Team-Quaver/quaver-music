// Quaver — 播放控制条「音量浮窗」的两条红线（源码接线 + 活体行为）。
// 跑：  node scripts/verify-volume-bar.ts   （活体段需 dev server，QBASE 缺省 http://127.0.0.1:5173）
//
// 病根一 · 滚轮不更新（用户报的「新问题」）
//   滑杆「谁在改音量」的判据原本写成 `document.activeElement === vol`。range 一被点/拖就拿到
//   焦点，而且焦点会一直留着（移开鼠标、收起浮窗都不掉）—— 于是此后所有外部改的音量
//   （滚轮 / 全局热键 / MPRIS / 设置页）都再也回不到滑杆上：条与读数冻在聚焦那一刻的值，
//   声音明明在变。判据换成「指针真的按在滑杆上」(volEditing)，松手即回到播放器真值。
//
// 病根二 · 悬浮态错位
//   浮窗原本锚在 Bar 右缘（`right: 8px`）。停靠态条铺满窗口宽，贴右缘勉强成立；
//   悬浮态（Style.ControlBar=floating）条只有 --control-bar-width（默认 680px）且在内容区居中，
//   贴右缘就把整块浮窗甩到收藏/画廊/队列那一排上面 —— 浮窗里的喇叭与条上那颗差 55px+（实测）。
//   现在锚点跟着音量钮走（.pb-volhost 是那颗钮与浮窗共用的定位锚），窄条放不下时按实测余量
//   只往左退（minWidth 760 / 半屏吸附会撞上）。
//
// 反向自证：把「回归写法」（焦点判据 / 贴右缘锚点）当输入喂给同一条筛选，确认会被逮住 ——
// 防「断言自己写错、永远为真」（本仓库踩过 verify 脚本自毁）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(join(UI, rel), "utf8");
const bar = src("src/components/PlayerBar.ts");
const css = src("src/style.css");

let pass = 0, fail = 0;
const check = (name: string, cond: unknown, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t: string) => console.log(`\n=== ${t} ===`);
/** 取某个选择器自己那条规则的规则体（`\n.sel {` 到下一个 `\n}`）；取不到返回空串 */
const ruleOf = (s: string, sel: string) => {
  const i = s.indexOf(`\n${sel} {`);
  if (i < 0) return "";
  const j = s.indexOf("\n}", i);
  return j < 0 ? "" : s.slice(i, j);
};

// ——— 源码接线：判据与锚点 ———
section("源码接线（纯 Node）");
const focusGuard = (s: string) => /document\.activeElement\s*[=!]==\s*vol\b/.test(s);
check("滑杆不再拿焦点当「用户正在编辑」的判据（焦点判据 = 滚轮/热键/MPRIS 全冻住）",
  !focusGuard(bar), bar.match(/document\.activeElement[^\n]*/)?.[0] ?? "");
check("…反向：焦点判据写法会被逮住", focusGuard("if (document.activeElement === vol) paint();"));
check("改完的判据是指针态（volEditing 由 pointerdown 起、松手/失焦收）",
  /let volEditing = false;/.test(bar)
  && /vol\.addEventListener\("pointerdown", \(\) => \{ volEditing = true; \}\)/.test(bar)
  && /window\.addEventListener\("pointerup", endVolEdit\)/.test(bar)
  && /vol\.addEventListener\("lostpointercapture", endVolEdit\)/.test(bar));
check("paintVol 与 notify 回写都读指针态",
  /const v = volEditing \? Number\(vol\.value\) \/ 100 :/.test(bar)
  && /if \(!volEditing\) vol\.value = String\(Math\.round\(/.test(bar));
check("松手立刻回到播放器真值（拖中被滚轮改过也不留假读数）",
  /volEditing = false;[\s\S]{0,240}?vol\.value = String\(Math\.round\(\(player\.muted \? 0 : player\.volume\) \* 100\)\);\s*\n\s*paintVol\(\);/.test(bar));

const volpopRule = ruleOf(css, ".pb-volpop");
check(".pb-volpop 规则取得到（防失配让下面全绿）", volpopRule.length > 80, String(volpopRule.length));
const rightAnchor = (r: string) => /(^|[;{\s])right:\s*\d/.test(r);
check("浮窗不再锚在 Bar 右缘（贴右缘 = 悬浮态甩到队列那一排上）",
  !rightAnchor(volpopRule), volpopRule.replace(/\s+/g, " ").slice(0, 120));
check("…反向：旧的 right: 8px 锚点会被逮住",
  rightAnchor(ruleOf("\n.pb-volpop {\n  position: absolute; right: 8px; bottom: calc(100% + 10px);\n}", ".pb-volpop")));
check("浮窗锚在音量钮上方（left 负一个内边距 = 1px 描边 + 12px 内边距，喇叭正好压准）",
  /position: absolute; left: -13px;/.test(volpopRule));
check("竖向余量按 --control-bar-height 算（锚点换成钮后 100% 不再是条高，漏了会压住条顶）",
  /bottom: calc\(100% \+ \(var\(--control-bar-height, 64px\) - 100%\) \/ 2 \+ 10px\)/.test(volpopRule),
  volpopRule.replace(/\s+/g, " ").slice(0, 200));
check("定位锚 .pb-volhost 存在且就是一条定位规则",
  /\.pb-volhost \{ position: relative; display: flex; \}/.test(css));
check("DOM：音量浮窗是 .pb-volhost 里音量钮的兄弟（锚点跟着钮走）",
  /<div class="pb-volhost">\s*<button[^>]*id="pb-mute"[\s\S]*?<div class="pb-volpop" id="pb-volpop"/.test(bar));
check("DOM：整条 .player 下只有一份浮窗节点（不再另挂在条上）",
  (bar.match(/class="pb-volpop"/g) ?? []).length === 1);
check("越界修正：显示前量一次余量，只往左退、不退过条的左内缘",
  /const clampVolPop = \(\) => \{[\s\S]*?pop\.style\.left = "";[\s\S]*?pr\.right - \(br\.right - 10\)[\s\S]*?pr\.left - \(br\.left \+ 10\)/.test(bar)
  && /const showPop = \(\) => \{ window\.clearTimeout\(hideTimer\); clampVolPop\(\);/.test(bar));
check("玻璃仍走共享规则（浮窗自己不许写 background/backdrop-filter —— verify-menu-glass 同一条）",
  !/backdrop-filter/.test(volpopRule) && !/background:/.test(volpopRule));

// ——— 活体：位置与滚轮 ———
const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { default: puppeteer } = await import("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

/** 打开某档尺寸/停靠态，把指针悬到音量钮上（走真实的 pointerenter → showPop → clampVolPop） */
async function hoverVolume(w: number, h: number, mode: string) {
  await page.setViewport({ width: w, height: h });
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  await page.evaluate((m) => {
    // 浏览器 dev 没有桌面歌词桥 → 那颗钮会被 remove()；补一颗同尺寸的，让右侧按钮排与 Electron 一致
    if (!document.querySelector("#pb-dl")) {
      const dl = document.createElement("button");
      dl.className = "pb-btn pb-ghost"; dl.id = "pb-dl"; dl.textContent = "▣";
      dl.style.cssText = "width:34px;height:34px;border:0;background:transparent;color:inherit;font:inherit";
      const q = document.querySelector("#pb-queue")!;
      q.parentNode!.insertBefore(dl, q);
    }
    document.body.style.setProperty("--side-w", "222px"); // 与真机默认档同宽（拖拽过的用户会另有一档）
    document.body.dataset.controlBar = m;
    document.body.classList.toggle("control-bar-floating", m === "floating");
  }, mode);
  await sleep(500);
  const m = await page.evaluate(() => {
    const r = document.querySelector("#pb-mute")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(m.x - 80, m.y - 80);
  await page.mouse.move(m.x, m.y);
  await sleep(350);
  return page.evaluate(() => {
    const g = (s: string) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    };
    return {
      open: document.querySelector(".player")!.classList.contains("vol-open"),
      player: g(".player"), pop: g(".pb-volpop"), mute: g("#pb-mute"), mute2: g("#pb-mute2"),
      win: { w: innerWidth, h: innerHeight },
    };
  });
}

section("活体 · 浮窗位置（停靠/悬浮 × 宽窄）");
const SIZES: [number, number][] = [[1536, 864], [1280, 800], [1000, 720], [900, 700], [780, 600], [760, 560]];
for (const mode of ["bottom", "floating"]) {
  for (const [w, h] of SIZES) {
    const label = `${mode} ${w}x${h}`;
    const r = await hoverVolume(w, h, mode);
    check(`${label}：悬停音量钮即开浮窗`, r.open);
    const inBar = r.pop.x >= r.player.x - 1 && r.pop.right <= r.player.right + 1;
    check(`${label}：浮窗完整落在控制条横向范围内（读数不被裁在窗口边）`, inBar,
      `pop=[${r.pop.x.toFixed(1)},${r.pop.right.toFixed(1)}] bar=[${r.player.x.toFixed(1)},${r.player.right.toFixed(1)}]`);
    check(`${label}：浮窗不越出视口`, r.pop.x >= 0 && r.pop.right <= r.win.w);
    // 浮窗底缘要在**整条**上方留出呼吸位（锚点换成钮之后，漏掉竖向余量会压住条顶 5px）
    check(`${label}：浮窗开在整条上方且不压条`, r.pop.bottom <= r.player.y - 8 && r.pop.bottom >= r.player.y - 16,
      `popBottom=${r.pop.bottom.toFixed(1)} barTop=${r.player.y.toFixed(1)}`);
    const delta = r.mute2.cx - r.mute.cx;
    // 窄条放不下整块浮窗时是「贴条右缘」退位态（clampVolPop 退到 br.right - 10），此时不苛求压准
    const clamped = Math.abs(r.pop.right - (r.player.right - 10)) < 1;
    check(`${label}：浮窗喇叭压在条上那颗的正上方（悬浮态不再甩到右边）`,
      clamped ? delta <= 1.5 : Math.abs(delta) <= 1.5,
      `Δ=${delta.toFixed(1)}px${clamped ? "（窄条已往左退位）" : ""}`);
  }
}

section("活体 · 滚轮/外部改音量要跟着更新（悬浮态）");
const read = () => page.evaluate(() => {
  const vol = document.querySelector("#pb-vol") as HTMLInputElement;
  return {
    pv: Math.round((window as unknown as { __player: { volume: number } }).__player.volume * 100),
    val: Number(vol.value),
    css: parseInt(vol.style.getPropertyValue("--v"), 10),
    num: parseInt((document.querySelector("#pb-volnum") as HTMLElement).textContent ?? "", 10),
    active: document.activeElement?.id || document.activeElement?.tagName,
  };
});
type Snap = Awaited<ReturnType<typeof read>>;
const agrees = (r: Snap) => r.pv === r.val && r.val === r.css && r.css === r.num;
const at = (sel: string, dx = 0) => page.evaluate((s: string, off: number) => {
  const r = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
  return { x: (s === ".player" ? r.x + off : r.x + r.width / 2), y: r.y + r.height / 2 };
}, sel, dx);
const wheelAt = async (pt: { x: number; y: number }, dy: number) => {
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel({ deltaY: dy });
  await sleep(160);
};
await hoverVolume(1536, 864, "floating");
const barPoint = await at(".player", 150);
const sliderPoint = await at("#pb-vol");
const rehover = async () => {
  const m = await at("#pb-mute");
  await page.mouse.move(m.x - 80, m.y - 80); await sleep(260);
  await page.mouse.move(m.x, m.y); await sleep(260);
  await page.evaluate(() => (window as unknown as { __player: { setVolume(v: number): void } }).__player.setVolume(0.5));
};
await rehover();

for (const [name, focus] of [["未聚焦", false], ["滑杆已聚焦（回归点）", true]] as [string, boolean][]) {
  await page.evaluate((f) => {
    const v = document.querySelector("#pb-vol") as HTMLInputElement;
    if (f) v.focus(); else v.blur();
  }, focus);
  const before = await read();
  await wheelAt(barPoint, -120);
  const after = await read();
  check(`${name}：在条上滚一格 → 播放器/滑杆/填充/读数四者一致且 +4`,
    agrees(after) && after.pv === before.pv + 4, JSON.stringify({ before, after }));
  await rehover();
  const b2 = await read();
  await wheelAt(sliderPoint, 120);
  const a2 = await read();
  check(`${name}：在浮窗滑杆上滚一格 → 同样四者一致且 -4`,
    agrees(a2) && a2.pv === b2.pv - 4, JSON.stringify({ b2, a2 }));
  await rehover();
}
{
  const before = await read();
  await page.evaluate(() => (window as unknown as { __player: { setVolume(v: number): void } }).__player.setVolume(0.15));
  await sleep(160);
  const after = await read();
  check("外部直接 setVolume（热键 / MPRIS / 设置页同一条 notify）→ 滑杆与读数跟上",
    agrees(after) && after.pv === 15, JSON.stringify({ before, after }));
}
{
  // 拖动期间滑杆说了算（不被 notify 的 4Hz 回写打断）；松手立刻回到播放器真值
  const s = await at("#pb-vol");
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(s.x + 40, s.y); // 从中间往右拖一格多，离上下限都远（免得钳位把断言演砸）
  await sleep(150);
  const mid = await read();
  await page.mouse.wheel({ deltaY: 120 }); // 拖中滚轮：音量真的在变，但视觉跟着指针，不被拽回去
  await sleep(150);
  const held = await read();
  await page.mouse.up();
  await sleep(150);
  const released = await read();
  check("拖动手势期间以滑杆为准（填充跟手，不被回写抢走）",
    agrees(mid) && mid.pv > 50 && mid.pv < 95, JSON.stringify(mid));
  check("拖中滚轮改的是播放器，不动正在跟手的滑杆", held.pv === mid.pv - 4 && held.val === mid.val,
    JSON.stringify({ mid, held }));
  check("松手即回到播放器真值（不留 94 vs 98 那种假读数）", agrees(released) && released.pv === held.pv,
    JSON.stringify({ held, released }));
}

section("活体 · 无脚本错误");
check("全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-volume-bar: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
