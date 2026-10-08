// A/B 实验：渲染层长音频播放期间，每 5s 轮询总线上是否冒出 chromium.instance*
// 用法：node scripts/mpris-mediator-poll.ts <cdpPort> [轮询秒数,默认70]
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = process.argv[2] || "9334";
const secs = Number(process.argv[3] || 70);

const names = () => {
  const out = execFileSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
    "--method", "org.freedesktop.DBus.ListNames"], { encoding: "utf8" });
  return (out.match(/chromium\.instance\d+/g) || []);
};
const base = names();
console.log("baseline chromium entries:", base.join(",") || "(none)");

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => (p.url() || "").includes("index.html"));
await page.bringToFront();
const playing = await page.evaluate(async () => {
  const a = new Audio("/tone30.wav");
  a.loop = true; a.volume = 0.6;
  window.__pa = a;
  try { await a.play(); } catch (e) { return "ERR:" + e.name; }
  return !a.paused;
});
console.log("long tone playing:", playing);

let appeared = [];
for (let i = 0; i < secs / 5; i++) {
  await sleep(5000);
  const cur = names().filter((n) => !base.includes(n));
  if (cur.length) { appeared = cur; console.log(`t+${(i + 1) * 5}s NEW:`, cur.join(",")); break; }
  console.log(`t+${(i + 1) * 5}s: none`);
}
if (appeared.length) {
  try {
    const id = execFileSync("gdbus", ["call", "--session", "--dest", `org.mpris.MediaPlayer2.${appeared[0]}`, "--object-path", "/org/mpris/MediaPlayer2",
      "--method", "org.freedesktop.DBus.Properties.Get", "org.mpris.MediaPlayer2", "Identity"], { encoding: "utf8" }).trim();
    console.log("appeared:", appeared.join(","), "| Identity:", id);
  } catch (e) { console.log("appeared:", appeared.join(",")); }
} else {
  console.log("no chromium mediator appeared in", secs, "s");
}
await page.evaluate(() => window.__pa?.pause());
browser.disconnect();
