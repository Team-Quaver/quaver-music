// 一次性端到端探针：音质选择器按当前曲过滤（dev server :5173 + Go 后端 :3379）
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:5173";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, note = "") => {
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1200);

// 用上游搜索响应里的真实 song 对象（自带 file 元数据）驱动队列 —— 与真实点歌数据路径同形
const SONGS = {
  noAtmos: { mid: "002kbvuj2unetj", name: "半梦(无全景声)" },
  full: { mid: "004XX53V27j2m9", name: "半梦(全档)" },
  noFlac: { mid: "003zmlC41qlUwM", name: "DEAD CENTER(无FLAC)" },
};

async function playMid(mid) {
  await page.evaluate(async (mid) => {
    const j = await (await fetch(`/api/search?keyword=${mid}&type=0&page=1&num=1`)).json();
    void j;
    const d = await (await fetch(`/api/song/${mid}/detail`)).json();
    const t = d.data.track_info;
    window.__quaverPlayer.playList([{
      id: t.id, mid: t.mid, name: t.name, type: t.type ?? 1,
      singer: t.singer, album: t.album, interval: t.interval, file: t.file,
    }], 0);
  }, mid);
  await sleep(2500); // 等起播/取链与浮窗重建
}

async function popupItems() {
  await page.evaluate(() => document.querySelector("#pb-quality").click());
  await sleep(150);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll("#pb-qpop .qp-q")].map((x) => ({
      label: x.querySelector("span")?.textContent ?? "",
      note: x.querySelector(".muted")?.textContent ?? "",
    })));
  await page.evaluate(() => document.querySelector("#pb-quality").click()); // 收起
  await sleep(100);
  return items;
}

// —— case 1：无全景声的歌（002kbvuj2unetj）——
await playMid(SONGS.noAtmos.mid);
let items = await popupItems();
let labels = items.map((x) => x.label);
console.log("no-atmos popup:", JSON.stringify(labels));
ok("无全景声：无「臻品音质 2.0」", !labels.includes("臻品音质 2.0"));
ok("无全景声：无「臻品全景声 5.1」", !labels.includes("臻品全景声 5.1"));
ok("无全景声：无「臻品全景声 7.1」", !labels.includes("臻品全景声 7.1"));
ok("无全景声：保留 320ogg/640ogg/flac/母带",
  ["高品质 HQ (OGG)", "无损 SQ (OGG)", "无损 SQ", "臻品母带"].every((l) => labels.includes(l)));
ok("自动恒在首项", labels[0] === "自动");

// —— case 2：全档的歌（004XX53V27j2m9）——
await playMid(SONGS.full.mid);
items = await popupItems();
labels = items.map((x) => x.label);
console.log("full popup:", JSON.stringify(labels));
ok("全档：九档全在", ["标准音质", "高品质 HQ", "高品质 HQ (OGG)", "无损 SQ (OGG)", "无损 SQ",
  "臻品音质 2.0", "臻品全景声 5.1", "臻品全景声 7.1", "臻品母带"].every((l) => labels.includes(l)));

// —— case 3：无明文 FLAC 的歌（003zmlC41qlUwM）——
await playMid(SONGS.noFlac.mid);
items = await popupItems();
labels = items.map((x) => x.label);
console.log("no-flac popup:", JSON.stringify(labels));
ok("无FLAC：「无损 SQ」隐藏", !labels.includes("无损 SQ"));
ok("无FLAC：母带/全景声照常（不受回退全景声开关影响）",
  ["臻品母带", "臻品全景声 5.1", "臻品全景声 7.1"].every((l) => labels.includes(l)));

// —— case 4：选档仍走协商（切母带，降级机制不动）——
const sw = await page.evaluate(() => {
  const master = [...document.querySelectorAll("#pb-qpop .qp-q")]
    .find((x) => x.querySelector("span")?.textContent === "臻品母带");
  master.click();
  return true;
});
await sleep(4000);
const ls = await page.evaluate(() => window.__quaverPlayer && ({
  tier: (window.__quaverPlayer && document.querySelector("#pb-quality")?.textContent) || "",
  last: JSON.parse(localStorage.getItem("quaver.session.v1") || "{}").lastStream ?? null,
}));
console.log("switch result:", JSON.stringify(ls));
ok("切母带：胶囊显示实际档位（master=母带）", /母带/.test(ls.tier ?? ""), ls.tier);

await browser.close();
console.log(fails ? `\n✗ ${fails} FAIL` : "\n✓ all pass");
process.exit(fails ? 1 : 0);
