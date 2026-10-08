// 响应式布局验证：窄宽度（搜索框 vs 标题/按钮簇）、矮高度（播放条可见性）、滚动条带位置。
// 用法：QBASE=http://127.0.0.1:5173 node scripts/verify-layout-responsive.ts
import puppeteer from "puppeteer-core";
const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

const rect = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const hidden = cs.display === "none" || cs.visibility === "hidden";
  const r = el.getBoundingClientRect();
  return { hidden, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    right: Math.round(r.right), bottom: Math.round(r.bottom) };
}, sel);
const overlap = (a, b) => a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
const hitOk = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return "NO_EL";
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return "OFFSCREEN";
  const t = document.elementFromPoint(cx, cy);
  return (t === el || el.contains(t) || (t && t.contains(el))) ? "ok" : "COVERED:" + (t ? t.className || t.tagName : "none");
}, sel);

async function gotoSinger(w, h) {
  await page.setViewport({ width: w, height: h });
  await page.goto(`${BASE}/index.html#/singer?mid=0025NhlN2yWrP4&name=${encodeURIComponent("周杰伦")}`, { waitUntil: "domcontentloaded" });
  await sleep(1300);
}

const SIZES = [[1280, 840], [1000, 700], [860, 620], [780, 560], [760, 520]];

await step("窄→宽五档：搜索框与标题/歌手名/信息头零重叠", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await gotoSinger(w, h);
    const sb = await rect(page, ".searchbar");
    const name = await rect(page, ".pl-name");
    const meta = await rect(page, ".pl-meta");
    const desc = await rect(page, ".pl-desc");
    const art = await rect(page, ".pl-art");
    for (const [k, t] of [["name", name], ["meta", meta], ["desc", desc], ["art", art]]) {
      if (overlap(sb, t)) bad.push(`${w}x${h}: searchbar∩${k}`);
    }
  }
  if (bad.length) throw new Error(bad.join("; "));
  return SIZES.map((s) => s.join("×")).join(", ");
});

await step("五档：CSD 按钮簇可见、close 可点、与搜索框零重叠", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await gotoSinger(w, h);
    const wb = await rect(page, ".winbtns");
    const sb = await rect(page, ".searchbar");
    if (!wb || wb.hidden) bad.push(`${w}x${h}: winbtns hidden`);
    if (wb && wb.bottom > h || (wb && wb.right > w)) bad.push(`${w}x${h}: winbtns clipped`);
    if (overlap(wb, sb)) bad.push(`${w}x${h}: winbtns∩searchbar`);
    const hit = await hitOk(page, '[data-win="close"]');
    if (hit !== "ok") bad.push(`${w}x${h}: close hit=${hit}`);
  }
  if (bad.length) throw new Error(bad.join("; "));
  return "5 sizes";
});

await step("五档：播放条完整在视口内、播放键可点", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await gotoSinger(w, h);
    const pl = await rect(page, ".player");
    if (!pl || pl.hidden) bad.push(`${w}x${h}: player hidden`);
    else if (pl.bottom > h || pl.top_ < 0 || pl.y < 0) bad.push(`${w}x${h}: player clipped bottom=${pl.bottom}/${h}`);
    const hit = await hitOk(page, "#pb-play");
    if (hit !== "ok") bad.push(`${w}x${h}: play hit=${hit}`);
  }
  if (bad.length) throw new Error(bad.join("; "));
  return "5 sizes";
});

await step("长列表滚动：内容/滚动条永远在按钮簇下缘之下", async () => {
  await gotoSinger(1000, 620);
  const route = await rect(page, ".route");
  const wb = await rect(page, ".winbtns");
  if (route.y < wb.bottom) throw new Error(`route top ${route.y} above winbtns bottom ${wb.bottom}`);
  await page.evaluate(() => { document.querySelector(".route").scrollTop = 99999; });
  await sleep(300);
  const info = await page.evaluate(() => {
    const r = document.querySelector(".route");
    return { scrolled: r.scrollTop > 0, overflowX: getComputedStyle(r).overflowX, w: r.offsetWidth - r.clientWidth };
  });
  if (!info.scrolled) throw new Error("route did not scroll");
  return `route starts y=${route.y} ≥ ${wb.bottom}; scrollbar slot=${info.w}px (thin round thumb)`;
});

await step("滚动条样式：webkit 自定义细圆条生效（未被 scrollbar-width 抢走）", async () => {
  await gotoSinger(1000, 620);
  const applied = await page.evaluate(() => {
    // scrollbar-width 若为 auto 说明 ::-webkit-scrollbar 规则在生效链上（Chromium≥121 反之会禁用）
    const route = document.querySelector(".route");
    return { sw: getComputedStyle(route).scrollbarWidth };
  });
  if (applied.sw !== "auto") throw new Error("scrollbar-width=" + applied.sw + " (overrides webkit styling)");
  return "scrollbarWidth=auto → ::-webkit-scrollbar custom thumb active";
});

await step("搜索框跨路由仍常驻（顶带不随视图重建）", async () => {
  await gotoSinger(1000, 700);
  await page.evaluate(() => { window.__sb = document.querySelector(".content .searchbar"); });
  await page.type(".searchbar input", "晴天");
  await page.click(".sidebar .nav a[href='#/']");
  await sleep(700);
  const same = await page.evaluate(() => document.querySelector(".searchbar") === window.__sb
    && document.querySelector(".searchbar").closest(".content-top") !== null);
  const v = await page.$eval(".searchbar input", (el) => el.value);
  if (!same) throw new Error("searchbar rebuilt or left .content-top");
  if (v !== "晴天") throw new Error("input lost: " + v);
  return "same node in .content-top, kept across #/singer → #/";
});

await step("首页窄窗：搜索框 vs page-title 零重叠", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await page.setViewport({ width: w, height: h });
    await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
    await sleep(700);
    const sb = await rect(page, ".searchbar");
    const t = await rect(page, ".page-title");
    if (overlap(sb, t)) bad.push(`${w}x${h}`);
  }
  if (bad.length) throw new Error("overlap at " + bad.join(", "));
  return "5 sizes";
});

await step("截图存档（三档关键尺寸）", async () => {
  const fs = await import("node:fs");
  fs.mkdirSync("/tmp/quaver-layout", { recursive: true });
  for (const [w, h] of [[760, 520], [1000, 620], [1280, 840]]) {
    await gotoSinger(w, h);
    await page.evaluate(() => { document.querySelector(".route").scrollTop = 400; });
    await sleep(200);
    await page.screenshot({ path: `/tmp/quaver-layout/fixed_${w}x${h}.png` });
  }
  return "/tmp/quaver-layout/fixed_*.png";
});

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
