// Quaver — headless smoke test（puppeteer-core + 系统 Chrome）
// 用法: node scripts/smoke.ts  （需 dev server :5173 + sidecar :3200 在跑）
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:5173";
const OUT = "/tmp/quaver-smoke";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); }
}

// 1) 首页推荐歌单
await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1500);
await step("home: 30 张推荐卡片", async () => {
  const n = await page.$$eval(".playlist-grid .card", (els) => els.length);
  if (n < 5) throw new Error(`only ${n} cards`);
  console.log(`  cards=${n}`);
});
await shot("01-home");

// 2) 打开第一个歌单并取歌曲
await step("playlist: 歌单详情出歌曲", async () => {
  const href = await page.$eval(".playlist-grid .card", (a) => a.getAttribute("href"));
  await page.evaluate((h) => { location.hash = h.replace(/^#/, ""); }, href);
  await sleep(3500);
  const rows = await page.$$eval(".content .row", (els) => els.length);
  if (rows < 10) throw new Error(`only ${rows} rows`);
  console.log(`  rows=${rows}`);
});
await shot("02-playlist");

// 3) 播放（免费曲目 paytype=0，匿名可播；VIP 曲会被降级/拒绝，非 bug）
await step("play: 免费曲目可播（currentTime 前进）", async () => {
  const ok = await page.evaluate(async () => {
    const j = await (await fetch("/api/song/002Cvsvv1RVStG/detail")).json();
    const d = j.data.track ?? j.data;
    await window.__quaverPlayer.playList([{ id: d.id, mid: d.mid, name: d.name, type: d.type ?? 1,
      singer: d.singer, album: d.album, interval: d.interval, file: d.file }], 0);
    return true;
  });
  await page.waitForFunction(() => window.__quaverPlayer.audio.currentTime > 1.0, { timeout: 25000 });
  console.log(`  started=${ok}`);
});
await sleep(2500);
await step("play: 时间继续前进 + 播放条在响", async () => {
  const s = await page.evaluate(() => ({ t: window.__quaverPlayer.audio.currentTime, paused: window.__quaverPlayer.audio.paused }));
  if (s.paused || s.t < 2.5) throw new Error(`stalled at ${s.t} paused=${s.paused}`);
  console.log(`  t=${s.t.toFixed(1)}`);
});
await shot("03-playing");

// 4) 搜索视图（若尚无路由，直接打 API 面）
await step("api: 搜索端到 UI 中继", async () => {
  const r = await page.evaluate(() => fetch("/api/search?keyword=%E5%91%8A%E7%99%BD&num=3").then((x) => x.json()));
  if (r.code !== 0 || !r.data?.song?.length) throw new Error(JSON.stringify(r).slice(0, 120));
  console.log(`  hits=${r.data.song.length}`);
});

// 5) 登录页二维码渲染
await step("login: 二维码 img 出图", async () => {
  await page.evaluate(() => { location.hash = "#/login"; });
  await page.waitForFunction(() => {
    const img = document.querySelector(".qr img");
    return img && img.complete && img.naturalWidth > 0;
  }, { timeout: 15000 });
});
await shot("04-login");

// 6) 设置页
await step("settings: 音质档位卡存在", async () => {
  await page.evaluate(() => { location.hash = "#/settings" });
  await sleep(2500);
  const n = await page.$$eval("#quality-grid [data-q]", (els) => els.length);
  if (n < 2) throw new Error(`only ${n} tier cards`);
  console.log(`  tiers=${n}`);
});
await shot("05-settings");

// 7) 切歌不断流：回首页换一首
await step("continuity: 切视图播放不中断", async () => {
  await page.evaluate(() => { location.hash = "#/guess"; });
  await sleep(2500);
  const a = await page.evaluate(() => window.__quaverPlayer.audio.currentTime);
  await sleep(1200);
  const b = await page.evaluate(() => ({ t: window.__quaverPlayer.audio.currentTime, paused: window.__quaverPlayer.audio.paused }));
  if (b.paused) throw new Error("audio paused after view switch");
  console.log(`  ${a.toFixed(1)} -> ${b.t.toFixed(1)} (guess rows=${(await page.$$(".content .row")).length})`);
});
await shot("06-guess");

await browser.close();
console.log("screenshots in", OUT);
