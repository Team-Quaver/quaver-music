// 顶部常驻搜索框验证：absolute 浮层随壳层挂载、切视图不重建（节点同一 + 输入不丢）、
// 联想、搜索落点页、分类标签；CSD 按钮簇在右上角（无浮窗底、无标题栏，KDE/Windows 惯例）。
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

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(800);

// 标记搜索框节点，跨路由比对是否同一 DOM（不随视图刷新重载）
await step("搜索框=顶带流内组件（.content-top），独立一行、不与标题同带", async () => {
  const info = await page.evaluate(() => {
    const sb = document.querySelector(".content-top .searchbar");
    if (!sb) throw new Error("no .searchbar in .content-top");
    const r = sb.getBoundingClientRect();
    const c = document.querySelector(".content").getBoundingClientRect();
    const t = document.querySelector(".page-title").getBoundingClientRect();
    window.__sb = sb;
    return {
      pos: getComputedStyle(sb).position,
      h: Math.round(r.height),
      centered: Math.abs(r.left + r.width / 2 - (c.left + c.width / 2)) < 4,
      clearOfTitle: r.bottom <= t.top + 2, // 顶带独立一行：搜索框下缘在标题上缘之上 = 永不遮挡
      goGone: !sb.querySelector("#go"),
    };
  });
  if (info.pos !== "relative") throw new Error("position=" + info.pos);
  if (!info.centered) throw new Error("not horizontally centered");
  if (!info.clearOfTitle) throw new Error("overlaps the page title row");
  if (!info.goGone) throw new Error("standalone go button still present");
  return `h=${info.h}px, centered, own band above title-row, no go-btn`;
});

await step("CSD 三按钮+把手在右上角（无浮窗底/无标题栏）", async () => {
  const info = await page.evaluate(() => {
    const b = document.querySelector(".winbtns");
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      right: Math.round(innerWidth - r.right), y: Math.round(r.top),
      bg: cs.backgroundColor, hasGrip: !!b.querySelector(".win-grip"),
      order: [...b.querySelectorAll("button")].map((x) => x.dataset.win).join(","),
    };
  });
  if (info.right > 60 || info.y > 40) throw new Error(`not top-right: right=${info.right}, top=${info.y}`);
  if (info.bg !== "rgba(0, 0, 0, 0)") throw new Error("pill background still painted: " + info.bg);
  if (!info.hasGrip) throw new Error("missing grip");
  if (info.order !== "min,max,close") throw new Error("button order (close must be rightmost on Linux/Win): " + info.order);
  return `at right=${info.right}, flat, order min→max→close`;
});

await step("切视图不重建：同一 DOM 节点 + 输入保留", async () => {
  await page.type(".searchbar input", "告白");
  await page.click(".sidebar .nav a[href='#/guess']");
  await sleep(600);
  const same = await page.evaluate(() => document.querySelector(".searchbar") === window.__sb);
  if (!same) throw new Error("searchbar node was re-created on route change");
  const v = await page.$eval(".searchbar input", (el) => el.value);
  if (v !== "告白") throw new Error("input lost: " + v);
  return "same node, value kept across #/ → #/guess";
});

await step("联想下拉（/search/complete）", async () => {
  await page.evaluate(() => { const q = document.querySelector(".searchbar input"); q.value = ""; q.dispatchEvent(new Event("input")); });
  await page.type(".searchbar input", "告白");
  await sleep(900);
  const items = await page.$$eval(".sb-drop:not([hidden]) .sb-item", (els) => els.map((e) => e.textContent.trim()));
  if (!items.length) throw new Error("no suggestions");
  return items.slice(0, 3).join(" | ");
});

await step("Enter → 搜索页出结果", async () => {
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.startsWith("#/search"), { timeout: 4000 });
  await page.waitForSelector(".search-body .row", { timeout: 8000 });
  const n = await page.$$eval(".search-body .row", (els) => els.length);
  const kw = await page.$eval(".searchbar input", (el) => el.value);
  const hist = await page.evaluate(() => localStorage.getItem("quaver.search.history.v1"));
  if (!hist?.includes("告白")) throw new Error("history not saved: " + hist);
  return `${n} rows, box="${kw}", hash=${await page.evaluate(() => location.hash)}`;
});

await step("搜索后输入框仍常驻可见", async () => {
  const info = await page.evaluate(() => ({
    same: document.querySelector(".searchbar") === window.__sb,
    v: document.querySelector(".searchbar input").value,
  }));
  if (!info.same) throw new Error("searchbar re-created after search nav");
  if (info.v !== "告白") throw new Error("value=" + info.v);
  return "persisted through #/search";
});

await step("分类标签切换（歌曲→歌手）", async () => {
  // 换用四类都有结果的关键词（「告白」的歌手档上游命中为 0，属正常空结果）
  await page.evaluate(() => { const q = document.querySelector(".searchbar input"); q.value = ""; q.dispatchEvent(new Event("input")); });
  await page.type(".searchbar input", "周杰伦");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".search-body .row", { timeout: 8000 });
  await page.click('.stab[data-type="1"]');
  await sleep(500);
  await page.waitForSelector(".search-body .card", { timeout: 8000 });
  const h = await page.evaluate(() => location.hash);
  if (!h.includes("type=1")) throw new Error(h);
  return h;
});

await step("视图刷新（重新渲染 route）不影响搜索框", async () => {
  await page.click('.stab[data-type="2"]');
  await sleep(400);
  await page.click('.stab[data-type="0"]');
  await sleep(900);
  const same = await page.evaluate(() => document.querySelector(".searchbar") === window.__sb);
  if (!same) throw new Error("searchbar replaced during rapid route swaps");
  return "still same node after two swaps";
});

await step("空关键词 → 热搜词兜底", async () => {
  await page.evaluate(() => (location.hash = "#/search"));
  await sleep(900);
  const chips = await page.$$eval(".hot-chips .chip", (els) => els.length).catch(() => 0);
  if (!chips) throw new Error("no hotkey chips");
  return `${chips} hotkeys`;
});

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
