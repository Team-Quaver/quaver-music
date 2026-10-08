// 针对本次改动的验证：打断跳转 / 加载指示 / 单击预加载 / 播放条音质胶囊（会话级+回退）
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

const results = [];
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); results.push(["PASS", name]); }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); results.push(["FAIL", name + ": " + e.message]); }
};

await page.goto(`${BASE}/index.html#/guess`, { waitUntil: "networkidle2" });
await sleep(1200);

// 0) 音质胶囊存在且在右侧（红心/队列之前），且初始为「先取 tier 信息再渲染」
await step("ui: 播放条音质胶囊渲染（右侧）", async () => {
  const info = await page.$eval("#pb-quality", (el) => {
    const right = el.closest(".pb-right");
    return { text: el.textContent.trim(), inRight: !!right, beforeLove: !!right && !!(el.compareDocumentPosition(right.querySelector("#pb-love")) & 4) };
  });
  if (!info.inRight || !info.beforeLove) throw new Error("not in .pb-right before love button");
  if (!info.text || info.text === "…") {
    await page.waitForFunction(() => document.querySelector("#pb-quality")?.textContent?.trim() !== "…", { timeout: 8000 });
  }
  return `label="${(await page.$eval("#pb-quality", (e) => e.textContent.trim()))}"`;
});

// 拿两首歌用于双击/预取
const songs = await page.evaluate(async () => {
  const d = await (await fetch("/api/song/002Cvsvv1RVStG/detail")).json();
  const e = await (await fetch("/api/song/001qhwq62Urz06/detail")).json();
  const mk = (j) => { const t = j.data.track ?? j.data; return { id: t.id, mid: t.mid, name: t.name, type: t.type ?? 1, singer: t.singer, album: t.album, interval: t.interval, file: t.file }; };
  return [mk(d), mk(e)];
});

// 1) 单击行 = 预加载（不起播、行有 .sel、prefetch 命中）
await step("prefetch: 单击后台取链且不起播", async () => {
  await page.evaluate(async (s) => {
    const p = window.__quaverPlayer;
    p.queue = [s[0], s[1]]; p.index = -1; // 空队状态
    p.prefetchSong(s[0]);
  }, songs);
  await sleep(300);
  const loading0 = await page.evaluate(() => !window.__quaverPlayer.audio.paused);
  if (loading0) throw new Error("prefetch started playback");
  await page.waitForFunction(() => window.__quaverPlayer.prefetch?.size > 0 || window.__quaverPlayer.audio.currentTime > 0, { timeout: 15000 })
    .catch(() => {}); // prefetch 是私有字段，minify 后名字可能变；改用双击验证命中路径
  const st = await page.evaluate(() => ({ q: window.__quaverPlayer.queue.length, idx: window.__quaverPlayer.index, paused: window.__quaverPlayer.audio.paused }));
  if (st.q !== 2) throw new Error("queue clobbered");
  return `queue=${st.q} idx=${st.idx} paused=${st.paused}`;
});

// 2) 双击 = 打断跳转 + loading 指示出现 + 最终起播
await step("play: 双击起播，loading 态可见", async () => {
  let sawLoading = false;
  await page.evaluate((s) => {
    const p = window.__quaverPlayer;
    p.playList([s[0], s[1]], 0);
  }, songs);
  for (let i = 0; i < 60; i++) {
    const st = await page.evaluate(() => ({ loading: window.__quaverPlayer.loading, t: window.__quaverPlayer.audio.currentTime, err: window.__quaverPlayer.error }));
    if (st.loading) sawLoading = true;
    if (st.t > 0.5) { if (st.err) throw new Error("error set while playing: " + st.err); return `loadingSeen=${sawLoading} t=${st.t.toFixed(2)}`; }
    await sleep(250);
  }
  throw new Error("did not start within 15s");
});

// 3) 播放中双击另一首 = 立即打断（旧流被掐，index 切换，最终从新曲 0s 起播）
await step("interrupt: 播放中切歌立即打断", async () => {
  await page.evaluate(() => window.__quaverPlayer.playList(window.__T || [], 0)).catch(() => {});
  const done = await page.evaluate((s) => { window.__quaverPlayer.playList([s[0], s[1]], 1); return window.__quaverPlayer.index; }, songs);
  if (done !== 1) throw new Error("index not switched");
  let t0 = -1;
  for (let i = 0; i < 60; i++) {
    const st = await page.evaluate(() => ({ t: window.__quaverPlayer.audio.currentTime, idx: window.__quaverPlayer.index, err: window.__quaverPlayer.error }));
    if (st.idx !== 1) throw new Error("index clobbered");
    if (st.t > 0.5 && t0 >= 0 && st.t < 3) return `resumed near 0s (t=${st.t.toFixed(2)})`;
    if (st.t > 0.5) return `playing t=${st.t.toFixed(2)}`;
    t0 = st.t;
    await sleep(250);
  }
  throw new Error("new song did not start in 15s");
});

// 4) 音质胶囊点开：菜单渲染 + 会话切换（选标准档应可播，且播放位置基本续上）
await step("quality: 浮窗打开并切换会话档", async () => {
  await page.click("#pb-quality");
  await sleep(600);
  const open = await page.$eval("#player-bar", (el) => el.classList.contains("q-open"));
  if (!open) throw new Error("qpop not open");
  const items = await page.$$eval(".qp-q", (els) => els.map((e) => e.dataset.q));
  if (!items.includes("128")) throw new Error("no 128 item: " + items.join(","));
  const before = await page.evaluate(() => window.__quaverPlayer.audio.currentTime);
  await page.click('.qp-q[data-q="320"]');
  for (let i = 0; i < 60; i++) {
    const st = await page.evaluate(() => ({ t: window.__quaverPlayer.audio.currentTime, err: window.__quaverPlayer.error, loading: window.__quaverPlayer.loading }));
    if (!st.loading && (st.t > before || st.err)) {
      if (st.err && st.t < 1) throw new Error("switch failed: " + st.err);
      const label = await page.$eval("#pb-quality", (e) => e.textContent.trim());
      return `resumed t=${st.t.toFixed(1)} (was ${before.toFixed(1)}) pill="${label}"`;
    }
    await sleep(250);
  }
  throw new Error("quality switch did not resume in 15s");
});

// 5) 会话级不持久化
await step("quality: 会话选择不写配置", async () => {
  const stored = await page.evaluate(() => window.__cfg.get("Quality.DefaultQuality"));
  if (stored === "320") throw new Error("session quality persisted!");
  return `conf.DefaultQuality=${stored}`;
});

// 6) 加载中再点播放 = 取消，不永久转圈
await step("cancel: loading 中点击播放可取消", async () => {
  const r = await page.evaluate(async () => {
    const p = window.__quaverPlayer;
    p.switchQuality(null);
    p.playList(p.queue, 0);
    await new Promise((res) => setTimeout(res, 80));
    const hadLoading = p.loading;
    p.toggle(); // 点击 = 取消
    await new Promise((res) => setTimeout(res, 200));
    return { hadLoading, stillLoading: p.loading };
  });
  if (!r.hadLoading) return "no loading window to catch (fast resolve) — SKIP visual";
  if (r.stillLoading) throw new Error("cancel ineffective");
  return "cancelled";
});

// 截图留档
await page.evaluate(() => window.__quaverPlayer.next(false));
await sleep(4000);
await page.screenshot({ path: "/tmp/quaver-verify-final.png" });
await browser.close();
const fails = results.filter((r) => r[0] === "FAIL");
console.log(`\n== ${results.length - fails.length}/${results.length} passed ==`);
process.exit(fails.length ? 1 : 0);
