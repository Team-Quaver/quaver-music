// 本次三项更改的验证：默认音质=auto、设置页两个新开关、播放条只读徽章移除、后端 deprioritize 参数
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

await page.goto(`${BASE}/index.html#/settings`, { waitUntil: "networkidle2" });
await sleep(800);

// 1) 干净 profile：默认音质 = auto（配置文件无覆盖时也选中「自动」）
await step("默认音质=auto", async () => {
  const st = await page.evaluate(() => window.__cfg.get("Quality.DefaultQuality"));
  if (st !== "Auto") throw new Error("DefaultQuality=" + st);
  const sel = await page.$eval("#quality-grid .sel", (el) => el.dataset.q);
  if (sel !== "auto") throw new Error("selected=" + sel);
  return "selected auto, conf stays Auto";
});

// 2) 设置页新开关
await step("Fallback 排序开关（默认不优先全景声）", async () => {
  const s = await page.$eval("#qfallback-cards .sel", (el) => el.dataset.opt);
  if (s !== "no-atmos") throw new Error("sel=" + s);
  await page.click('#qfallback-cards [data-opt="rank"]');
  await sleep(120);
  const after = await page.evaluate(() => ({ sel: document.querySelector("#qfallback-cards .sel")?.dataset.opt, stored: window.__cfg.get("Quality.FallbackToQMAtmos") }));
  if (after.sel !== "rank" || after.stored !== "True") throw new Error(JSON.stringify(after));
  await page.click('#qfallback-cards [data-opt="no-atmos"]');
  return "toggle + persist ok";
});
await step("关闭按钮行为开关（默认缩放到托盘）", async () => {
  const s = await page.$eval("#close-cards .sel", (el) => el.dataset.opt);
  if (s !== "tray") throw new Error("sel=" + s);
  await page.click('#close-cards [data-opt="quit"]');
  await sleep(120);
  const after = await page.evaluate(() => ({ sel: document.querySelector("#close-cards .sel")?.dataset.opt, stored: window.__cfg.get("Window.CloseAction") }));
  if (after.sel !== "quit" || after.stored !== "quit") throw new Error(JSON.stringify(after));
  await page.click('#close-cards [data-opt="tray"]');
  return "toggle + persist ok (browser dev: bridge absent = no-op)";
});

// 3) 播放条结构：只读音质徽章已删，可选胶囊仍在
await step("播放条徽章移除（胶囊保留）", async () => {
  const info = await page.evaluate(() => ({ badge: !!document.querySelector(".q-badge"), pill: !!document.querySelector("#pb-quality") }));
  if (info.badge) throw new Error("q-badge still present");
  if (!info.pill) throw new Error("quality pill missing");
  return "pill kept, badge gone";
});

// 4) 真实播放（默认 auto 档）：起播成功 + sub 行不再出徽章 + 胶囊反映实际档
const songs = await page.evaluate(async () => {
  const d = await (await fetch("/api/song/002Cvsvv1RVStG/detail")).json();
  const t = d.data.track ?? d.data;
  return [{ id: t.id, mid: t.mid, name: t.name, type: t.type ?? 1, singer: t.singer, album: t.album, interval: t.interval, file: t.file }];
});
await step("auto 档真实起播，sub 无徽章，胶囊=实际档", async () => {
  await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
  await sleep(600);
  await page.evaluate((s) => window.__quaverPlayer.playList(s, 0), songs);
  for (let i = 0; i < 60; i++) {
    const st = await page.evaluate(() => ({ t: window.__quaverPlayer.audio.currentTime, err: window.__quaverPlayer.error, loading: window.__quaverPlayer.loading }));
    if (st.err) throw new Error("play error: " + st.err);
    if (st.t > 0.5) break;
    await sleep(250);
    if (i === 59) throw new Error("did not start within 15s");
  }
  await sleep(400);
  const view = await page.evaluate(() => ({
    badge: !!document.querySelector(".q-badge"),
    sub: document.querySelector("#pb-sub")?.textContent,
    pill: document.querySelector("#pb-quality")?.textContent?.trim(),
  }));
  if (view.badge) throw new Error("badge appeared while playing");
  if (!view.pill || view.pill === "…" || view.pill === "自动") throw new Error("pill not reflecting applied tier: " + view.pill);
  return `pill="${view.pill}" sub="${view.sub}"`;
});

// 5) 后端：/stream/resolve 接受 deprioritize（200 + 正常协商；含不带该参数的旧形状请求不回归）
await step("后端 deprioritize 协商", async () => {
  const res = await page.evaluate(async (m) => {
    const call = async (body) => {
      const r = await fetch("/api/stream/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      return { status: r.status, tier: j?.data?.tier, msg: j?.msg };
    };
    return {
      withDp: await call({ mid: m.mid, media_mid: m.media, tier: "master", auto: true, deprioritize: ["atmos51", "atmos71"] }),
      legacy: await call({ mid: m.mid, media_mid: m.media, tier: "flac", auto: true }), // 旧客户端不带 deprioritize
    };
  }, { mid: songs[0].mid, media: songs[0].file?.media_mid ?? songs[0].mid });
  if (res.withDp.status !== 200) throw new Error("deprioritize rejected: " + JSON.stringify(res.withDp));
  if (res.legacy.status !== 200) throw new Error("legacy shape broke: " + JSON.stringify(res.legacy));
  return JSON.stringify(res);
});

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
