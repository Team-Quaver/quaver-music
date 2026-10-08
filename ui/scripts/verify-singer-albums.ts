// 歌手页改版 + 顶带返回按钮验证（2026-09-16）：
//   1) 歌手页含「热门歌曲」「最新发布歌曲」两分区（各自独立 .rows），专辑区带「查看全部」入口
//   2) 顶带返回按钮：首屏隐藏 → 进歌手页出现（搜索框左侧、不重叠）→ 点击回上级 → 再点回首页后隐藏
//   3) 「查看全部」→ #/singer-albums 全部专辑页渲染（数量 ≥ 歌手页内联区，卡片可点进专辑页）
//   4) 搜索框节点跨路由不重建，且仍精确水平居中（按钮绝对挂载不推走胶囊）
import puppeteer from "puppeteer-core";
const BASE = "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

// —— 首页：无上级 → 返回钮隐藏 ——
await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(800);

await step("首页：顶带返回按钮隐藏、搜索框居中", async () => {
  const info = await page.evaluate(() => {
    const b = document.querySelector(".top-back");
    const sb = document.querySelector(".searchbar");
    if (!b) throw new Error("no .top-back in .content-top");
    if (!sb || !sb.closest(".content-top")) throw new Error("searchbar missing/left band");
    window.__sb = sb;
    const r = sb.getBoundingClientRect();
    const c = document.querySelector(".content").getBoundingClientRect();
    return { hidden: b.hidden || getComputedStyle(b).display === "none", centered: Math.abs(r.left + r.width / 2 - (c.left + c.width / 2)) < 4 };
  });
  if (!info.hidden) throw new Error("back button visible on home");
  if (!info.centered) throw new Error("searchbar not centered");
  return "hidden + centered";
});

// —— 进歌手页（模拟点击路径：hash 导航）——
await page.evaluate(() => { location.hash = "#/singer?mid=0025NhlN2yWrP4&name=" + encodeURIComponent("周杰伦"); });
await sleep(1800);

await step("歌手页：返回钮出现（搜索框左侧、零重叠、可点）", async () => {
  const info = await page.evaluate(() => {
    const b = document.querySelector(".top-back");
    const sb = document.querySelector(".searchbar");
    const br = b.getBoundingClientRect(), sr = sb.getBoundingClientRect();
    return {
      visible: !b.hidden && getComputedStyle(b).display !== "none",
      leftOf: br.right <= sr.left + 1,
      sameBandVert: br.top >= sr.top - 8 && br.bottom <= sr.bottom + 8,
      overlap: !(br.right < sr.left || br.left > sr.right || br.bottom < sr.top || br.top > sr.bottom),
      hit: (() => { const c = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); return !!c && !!c.closest(".top-back"); })(),
      sameSearchBox: sb === window.__sb,
    };
  });
  if (!info.visible) throw new Error("back button hidden on singer page");
  if (!info.leftOf) throw new Error("back button not left of searchbar");
  if (!info.sameBandVert) throw new Error("back button vertically off the pill");
  if (info.overlap) throw new Error("back button overlaps searchbar");
  if (!info.hit) throw new Error("back button not hittable (occluded)");
  if (!info.sameSearchBox) throw new Error("searchbar was rebuilt across routes");
  return "visible, left of pill, hittable, searchbar node stable";
});

await step("歌手页：热歌/新歌 两个标签各有一份独立列表（order=1 / order=2）", async () => {
  const hot = await page.evaluate(() => ({
    idx: [...document.querySelectorAll(".tag-body .tag-panel")].findIndex((p) => !p.hidden),
    rows: document.querySelectorAll(".tag-body .tag-panel:not([hidden]) .row").length,
    first: document.querySelector(".tag-body .tag-panel:not([hidden]) .row .rt")?.textContent ?? "",
  }));
  if (hot.idx !== 0) throw new Error("default visible panel should be 热歌, idx=" + hot.idx);
  if (hot.rows < 10) throw new Error("too few hot rows: " + hot.rows);
  await page.click('.tag-tabs .tag[data-tab="new"]');
  await sleep(200);
  const nw = await page.evaluate(() => ({
    idx: [...document.querySelectorAll(".tag-body .tag-panel")].findIndex((p) => !p.hidden),
    rows: document.querySelectorAll(".tag-body .tag-panel:not([hidden]) .row").length,
    first: document.querySelector(".tag-body .tag-panel:not([hidden]) .row .rt")?.textContent ?? "",
  }));
  if (nw.idx !== 1) throw new Error("新歌 panel not visible, idx=" + nw.idx);
  if (nw.rows < 10) throw new Error("too few new rows: " + nw.rows);
  if (hot.first === nw.first) throw new Error("hot and new start with same song (order param not applied?)");
  return `hot rows=${hot.rows} "${hot.first}" / new rows=${nw.rows} "${nw.first}"`;
});

await step("专辑标签「查看全部」入口存在且指向 singer-albums", async () => {
  await page.click('.tag-tabs .tag[data-tab="album"]');
  await sleep(200);
  const href = await page.evaluate(() =>
    document.querySelector(".tag-body .tag-panel:not([hidden]) .sec-more")?.getAttribute("href") ?? "");
  if (!href.startsWith("#/singer-albums?mid=0025NhlN2yWrP4")) throw new Error("bad href: " + href);
  return href;
});

// —— 点返回钮 → 回首页 ——
await page.click(".top-back");
await sleep(900);

await step("点返回钮 → 回首页且按钮再隐藏", async () => {
  const info = await page.evaluate(() => ({
    hash: location.hash,
    hidden: document.querySelector(".top-back").hidden || getComputedStyle(document.querySelector(".top-back")).display === "none",
    sameSearchBox: document.querySelector(".searchbar") === window.__sb,
  }));
  if (!info.hash.startsWith("#/") || info.hash !== "#/") throw new Error("not back at home: " + info.hash);
  if (!info.hidden) throw new Error("back button still visible at home");
  if (!info.sameSearchBox) throw new Error("searchbar rebuilt");
  return "home, hidden";
});

// —— 全部专辑页 ——
await step("全部专辑页：路由可达、卡片多于歌手页内联区、顶带返回钮出现", async () => {
  await page.evaluate(() => { location.hash = "#/singer?mid=0025NhlN2yWrP4&name=" + encodeURIComponent("周杰伦"); });
  await sleep(1600);
  await page.evaluate(() => { location.hash = "#/singer-albums?mid=0025NhlN2yWrP4&name=" + encodeURIComponent("周杰伦"); });
  await sleep(2200);
  const info = await page.evaluate(() => ({
    cards: document.querySelectorAll(".grid .card").length,
    href0: document.querySelector(".grid .card")?.getAttribute("href") ?? "",
    meta: document.querySelector(".pl-meta")?.textContent.trim() ?? "",
    backVisible: !document.querySelector(".top-back").hidden,
    name: document.querySelector(".pl-name")?.textContent.trim() ?? "",
  }));
  if (info.cards < 40) throw new Error("too few album cards (pagination?): " + info.cards);
  if (!info.href0.startsWith("#/album?mid=")) throw new Error("card href wrong: " + info.href0);
  if (!/共 \d+ 张/.test(info.meta)) throw new Error("missing total in meta: " + info.meta);
  if (!info.backVisible) throw new Error("back button missing on sub page");
  return `cards=${info.cards}, meta="${info.meta}", name="${info.name}"`;
});

await step("全部专辑页 → 点返回回歌手页（栈式往返，再点回首页）", async () => {
  await page.click(".top-back"); await sleep(1500);
  const h1 = await page.evaluate(() => location.hash);
  if (!h1.startsWith("#/singer?")) throw new Error("back should land on singer, got " + h1);
  const backStill = await page.evaluate(() => !document.querySelector(".top-back").hidden);
  if (!backStill) throw new Error("back button should stay on singer page");
  await page.click(".top-back"); await sleep(900);
  const h2 = await page.evaluate(() => location.hash);
  if (h2 !== "#/") throw new Error("second back should land home, got " + h2);
  return "albums → singer → home";
});

await page.screenshot({ path: "/tmp/quaver-singer-albums.png" });
await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
