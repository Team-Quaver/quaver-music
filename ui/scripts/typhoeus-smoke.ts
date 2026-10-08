// Typhoeus 高档位播放冒烟：headless Chrome 真 <audio> 播 640ogg / master
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:5173";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1500);

// 设置默认音质 = flac（会员档位）
await page.evaluate(() => window.__cfg.set({ "Quality.DefaultQuality": "flac" }));

async function playTier(tier, label) {
  const r = await page.evaluate(async (tier) => {
    const j = await (await fetch("/api/song/001qhwq62Urz06/detail")).json();
    const d = j.data.track ?? j.data;
    const song = { id: d.id, mid: d.mid, name: d.name, type: d.type ?? 1, singer: d.singer, album: d.album, interval: d.interval, file: d.file };
    await window.__quaverPlayer.playList([song], 0);
    return true;
  }, tier);
  try {
    await page.waitForFunction(() => window.__quaverPlayer.audio.currentTime > 2.0, { timeout: 25000 });
    const st = await page.evaluate(() => ({
      t: window.__quaverPlayer.audio.currentTime,
      dur: window.__quaverPlayer.audio.duration,
      src: window.__quaverPlayer.audio.currentSrc,
    }));
    console.log(`PASS play[${tier}] currentTime=${st.t.toFixed(2)}s duration=${st.dur.toFixed(0)}s src=${st.src.slice(0, 60)}`);
  } catch (e) {
    const err = await page.evaluate(() => window.__quaverPlayer.error);
    console.log(`FAIL play[${tier}]: ${e.message.split("\n")[0]} player.error=${err}`);
  }
}

// 通过 quality 设定逐档播放（每档写进配置内存快照，playList 立即按新档协商）
for (const q of ["flac", "640ogg", "master", "320", "128", "auto"]) {
  await page.evaluate((q) => window.__cfg.set({ "Quality.DefaultQuality": q }), q);
  await playTier(q);
  await page.evaluate(() => window.__quaverPlayer.audio.pause());
  await sleep(300);
}

// 播放条音质徽章检查（高档位应显示徽章）
await page.evaluate(() => window.__cfg.set({ "Quality.DefaultQuality": "flac" }));
await playTier("flac-badge");
await sleep(800);
const badge = await page.$eval("#pb-sub", (el) => el.textContent);
console.log("pb-sub:", JSON.stringify(badge));
await page.screenshot({ path: "/tmp/quaver-smoke/typhoeus-player.png" });

// 设置页：档位卡片 + 锁标
await page.goto(`${BASE}/index.html#/settings`, { waitUntil: "networkidle2" });
await sleep(2000);
const cards = await page.$$eval("#quality-grid .opt-card", (els) => els.map((e) => ({
  q: e.dataset.q, text: e.textContent.trim(), disabled: e.disabled, sel: e.classList.contains("sel"),
})));
console.log("quality-grid:", JSON.stringify(cards));
await page.screenshot({ path: "/tmp/quaver-smoke/typhoeus-settings.png" });

await browser.close();
