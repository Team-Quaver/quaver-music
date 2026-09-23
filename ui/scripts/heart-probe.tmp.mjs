// 播放条红心探针（临时脚本，验证后删除）：无登录、mock 写接口，直接驱动 __quaverPlayer
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/song/like") || u.includes("/api/song/unlike")) {
    r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0 }) }).catch(() => {});
  } else if (u.includes("/api")) {
    r.abort().catch(() => {});
  } else r.continue().catch(() => {});
});

await page.goto("http://localhost:5173/index.html", { waitUntil: "networkidle2", timeout: 30000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500));

const hasPlayer = await page.evaluate(() => !!window.__quaverPlayer);
console.log("player hook:", hasPlayer);

// 用例 A：队列对象带 id（歌单/歌手页同款对象）→ 点播放条红心
const resA = await page.evaluate(async () => {
  const p = window.__quaverPlayer;
  p.playList([{ mid: "TESTMID_A", id: 99999, type: 1, name: "A", interval: 200 }], 0);
  await new Promise((r) => setTimeout(r, 400));
  const btn = document.querySelector("#pb-love");
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  return { loved: p.loved.has("TESTMID_A"), on: btn.classList.contains("on") };
});
console.log("A (song.id 存在):", JSON.stringify(resA));

// 用例 B：队列对象不带 id 且预载 lovedRef 为空（缺 song_id 的场景）→ 点播放条红心
const resB = await page.evaluate(async () => {
  const p = window.__quaverPlayer;
  p.playList([{ mid: "TESTMID_B", name: "B", interval: 200 }], 0);
  await new Promise((r) => setTimeout(r, 400));
  const btn = document.querySelector("#pb-love");
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  return { loved: p.loved.has("TESTMID_B"), on: btn.classList.contains("on") };
});
console.log("B (song.id 缺失):", JSON.stringify(resB));

// 用例 B2：同曲再点一次（toggleLove 显式调用，等价于行内红心同款入口）
const resB2 = await page.evaluate(async () => {
  const p = window.__quaverPlayer;
  const fin = await p.toggleLove(p.current);
  return { fin, loved: p.loved.has("TESTMID_B") };
});
console.log("B2 toggleLove 返回值:", JSON.stringify(resB2));

await browser.close();
