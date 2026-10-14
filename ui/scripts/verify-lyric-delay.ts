// Quaver — 「歌词延迟」（按歌曲歌词同步微调）活体验证：需要 dev server（QBASE 缺省
// http://127.0.0.1:5173），歌曲/歌词走 window.__player 桩（同 verify-np-gallery 的路数）。
//
// 覆盖：
//  - ⋮ 菜单「歌词延迟」行的出现条件（有曲且有歌词；未在播放不出现）与 −/+ 步进、点数值归零
//  - localStorage 按歌曲持久化（quaver.lyricDelay.v1：mid → 毫秒；换曲各读各值；0 删条目）
//  - ±10s 钳位（连点越界不越过，到界 −/+ 禁用）
//  - 行级兜底视图：延迟实时挪动当前行（时钟 = time + 0.2 − delay），点击行的 seek 加回延迟
//  - 逐字（内置 AMLL）：kara 态菜单行同在；步进后 AMLL 的 active 行随「time() − lyricDelay()」
//    重锚换行 —— 这是给插件的透传契约（SDK SparkleKaraokeRenderCtx.lyricDelay）的行为面
import puppeteer from "puppeteer-core";
import { deflateSync } from "node:zlib";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const LS = "quaver.lyricDelay.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 64x64 纯色 PNG（同 gallery：封面请求被拦下，np 背景/侧封面有图可解）
function solidPng(r, g, b) {
  const crc32 = (buf) => {
    let c, t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : t[n] = c; }
    let crc = 0xFFFFFFFF;
    for (const x of buf) crc = t[(crc ^ x) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 2, 0, 0, 0]);
  const rows = [];
  for (let y = 0; y < 64; y++) {
    const line = Buffer.alloc(1 + 64 * 3);
    for (let x = 0; x < 64; x++) { line[1 + x * 3] = r; line[2 + x * 3] = g; line[3 + x * 3] = b; }
    rows.push(line);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = solidPng(120, 80, 160);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (req.url().includes("y.gtimg.cn")) return req.respond({ status: 200, contentType: "image/png", body: PNG });
  if (req.url().includes("/api/")) return req.respond({ status: 200, contentType: "application/json", body: '{"code":0,"msg":"ok","data":{}}' });
  req.continue();
});

let fails = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

// —— 桩：定位置时钟（覆盖 player 的原型 getter，通知走 notifyPublic）——
const stubSong = (mid, { kara = false } = {}) => page.evaluate(async (mid, kara) => {
  const p = window.__player;
  if (!p) throw new Error("window.__player 不存在（需要 vite dev 的 DEV 钩子）");
  p.queue = [{ mid, name: "延迟测试曲" + mid, singer: [{ name: "测试歌手" }], album: { mid: "al" + mid, name: "专辑" } }];
  p.index = 0;
  p.expanded = true;
  p.lyricState = "ok";
  p.karaoke = [];
  p.lyrics = [{ t: 0, text: "第一行" }, { t: 3, text: "第二行" }];
  if (kara) {
    const line = (t0, dur, text) => ({
      startTime: t0, endTime: t0 + dur,
      words: [{ word: text, startTime: t0, endTime: t0 + dur }],
    });
    p.karaoke = [line(0, 3000, "你好世界"), line(3000, 3000, "第二句")];
  }
  // 固定时钟 + 捕获 seek（instance own property 遮蔽原型 getter/方法）
  Object.defineProperty(p, "time", { configurable: true, get: () => (window.__testTime ??= 2.9) });
  Object.defineProperty(p, "paused", { configurable: true, get: () => true });
  if (!window.__seekCap) {
    window.__seekCap = [];
    p.seek = (sec) => { window.__seekCap.push(sec); };
  }
  p.notifyPublic();
}, mid, kara);

const openMenu = async () => {
  await page.waitForFunction(() => {
    const b = document.querySelector("#np-more");
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== "hidden";
  }, { timeout: 8000 });
  await page.evaluate(() => document.querySelector("#np-more").click());
  await page.waitForSelector("#np-menu.open", { timeout: 4000 });
};
const closeMenu = async () => {
  await page.evaluate(() => document.querySelector(".np").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await page.waitForFunction(() => !document.querySelector("#np-menu.open"), { timeout: 4000 });
};
const delayVal = () => page.$eval(".np-delay-val", (el) => el.textContent.trim());
const clickDelay = (side, times = 1) => page.evaluate((s, n) => {
  const b = document.querySelector(s === "inc" ? ".np-delay-inc" : ".np-delay-dec");
  for (let i = 0; i < n; i++) b.click();
}, side, times);
const lsRead = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } }, LS);

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1500); // initSparkle：内置 AMLL 动态 import 注册（kara 用例依赖）
await page.evaluate((k) => localStorage.removeItem(k), LS);

await step("菜单：未在播放时不出现延迟行；有曲有歌词时出现且初值 0.0s", async () => {
  await page.evaluate(() => {
    const p = window.__player;
    p.queue = []; p.index = -1; p.lyrics = []; p.karaoke = []; p.lyricState = "none";
    p.expanded = true; p.notifyPublic();
  });
  await openMenu();
  if (await page.$(".np-menu-delay")) throw new Error("未在播放仍挂了延迟行");
  await closeMenu();
  await stubSong("TESTA");
  await openMenu();
  const row = await page.$(".np-menu-delay");
  if (!row) throw new Error("缺 .np-menu-delay 行");
  if ((await delayVal()) !== "0.0s") throw new Error("初值应为 0.0s，读到 " + await delayVal());
});

await step("步进与持久化：+3→+0.3s/LS 300；−5→-0.2s；点数值归零且删条目", async () => {
  await clickDelay("inc", 3);
  if ((await delayVal()) !== "+0.3s") throw new Error("+3 档读数错: " + await delayVal());
  if ((await lsRead()).TESTA !== 300) throw new Error("localStorage 未写/写错: " + JSON.stringify(await lsRead()));
  await clickDelay("dec", 5);
  if ((await delayVal()) !== "-0.2s") throw new Error("-5 档读数错: " + await delayVal());
  if ((await lsRead()).TESTA !== -200) throw new Error("LS 应为 -200: " + JSON.stringify(await lsRead()));
  await page.evaluate(() => document.querySelector(".np-delay-val").click());
  if ((await delayVal()) !== "0.0s") throw new Error("归零失败: " + await delayVal());
  if ("TESTA" in await lsRead()) throw new Error("0 值应删条目: " + JSON.stringify(await lsRead()));
  await closeMenu();
});

await step("按歌曲区分：换曲读 0；A/B 各自的值互不串门", async () => {
  await openMenu();
  await clickDelay("inc", 5); // TESTA = +500
  await closeMenu();
  await stubSong("TESTB");
  await sleep(260); // 等 np 的换曲迁移（mid 变 → 重建行 DOM）
  await openMenu();
  if ((await delayVal()) !== "0.0s") throw new Error("B 曲应读 0.0s，读到 " + await delayVal());
  await clickDelay("inc", 3); // TESTB = +300
  await closeMenu();
  const all = await lsRead();
  if (all.TESTA !== 500 || all.TESTB !== 300) throw new Error("两曲的值不对: " + JSON.stringify(all));
  await stubSong("TESTA");
  await sleep(260);
  await openMenu();
  if ((await delayVal()) !== "+0.5s") throw new Error("回到 A 应读 +0.5s，读到 " + await delayVal());
  await closeMenu();
});

await step("钳位：连点 110 下 − 封死在 -10.0s 且 dec 禁用；+ 复位后封在 +10.0s", async () => {
  await openMenu();
  await clickDelay("dec", 110);
  if ((await delayVal()) !== "-10.0s") throw new Error("下界读数错: " + await delayVal());
  if (!(await page.$eval(".np-delay-dec", (el) => el.disabled))) throw new Error("触底后 − 未禁用");
  if ((await lsRead()).TESTA !== -10000) throw new Error("LS 未钳到 -10000");
  await page.evaluate(() => document.querySelector(".np-delay-val").click()); // 复位 0
  await clickDelay("inc", 110);
  if ((await delayVal()) !== "+10.0s") throw new Error("上界读数错: " + await delayVal());
  if (!(await page.$eval(".np-delay-inc", (el) => el.disabled))) throw new Error("触顶后 + 未禁用");
  await page.evaluate(() => document.querySelector(".np-delay-val").click());
  await closeMenu();
});

await step("行级视图：延迟实时挪动当前行（时钟 = time+0.2−delay）", async () => {
  // 固定 time=2.9：delay 0 → 时钟 3.1 → 「第二行」；delay +1.5 → 时钟 1.6 → 「第一行」
  await page.evaluate(() => { window.__testTime = 2.9; });
  await stubSong("TESTA");
  await sleep(260);
  const cur = () => page.$eval(".np-ly-line.cur .l1", (el) => el.textContent.trim());
  if ((await cur()) !== "第二行") throw new Error("delay=0 时应跟随第二行，读到 " + await cur());
  await openMenu();
  await clickDelay("inc", 15); // +1.5s
  await sleep(120);
  if ((await cur()) !== "第一行") throw new Error("+1.5s（歌词延后）后应落回第一行，读到 " + await cur());
  await page.evaluate(() => document.querySelector(".np-delay-val").click());
  await closeMenu();
});

await step("行级点击：seek 目标 = 行时间 + 延迟（点屏幕上那行，不点歌词原时间轴）", async () => {
  await openMenu();
  await clickDelay("inc", 20); // +2.0s
  await closeMenu();
  await page.evaluate(() => { window.__seekCap.length = 0; });
  await page.evaluate(() => { [...document.querySelectorAll(".np-ly-line")].find((d) => d.textContent.includes("第二行")).click(); });
  await sleep(120);
  const caps = await page.evaluate(() => window.__seekCap.slice());
  if (caps.length !== 1 || Math.abs(caps[0] - 5) > 1e-9) throw new Error("点第二行(3s) seek 应落 5s（3+2.0），实际 " + JSON.stringify(caps));
  await openMenu();
  await page.evaluate(() => document.querySelector(".np-delay-val").click());
  await closeMenu();
});

await step("逐字 AMLL：菜单行同在；+1.0s 后 active 行随 ctx 时钟重锚换行（透传生效）", async () => {
  // 先 none → 再 kara 数据：走状态迁移逼宿主重建 AMLL
  await page.evaluate(() => {
    const p = window.__player;
    p.lyrics = []; p.karaoke = []; p.lyricState = "none"; p.notifyPublic();
  });
  await sleep(250);
  const arm = () => stubSong("TESTA", { kara: true });
  await arm();
  // 内置引擎注册可能晚于本步：反复重挂直到 kara 接管（同 gallery 的套路）
  await page.evaluate(() => {
    const t0 = Date.now();
    return new Promise((done) => {
      const iv = setInterval(() => {
        if (document.querySelector(".np.kara") || Date.now() - t0 > 15000) { clearInterval(iv); done(); return; }
        const p = window.__player;
        p.lyricState = "ok";
        p.karaoke = [
          { startTime: 0, endTime: 3000, words: [{ word: "你好世界", startTime: 0, endTime: 3000 }] },
          { startTime: 3000, endTime: 6000, words: [{ word: "第二句", startTime: 3000, endTime: 6000 }] },
        ];
        p.lyrics = [{ t: 0, text: "第一行" }, { t: 3, text: "第二行" }];
        p.notifyPublic();
      }, 400);
    });
  });
  await page.waitForFunction(() => document.querySelector(".np.kara") && document.querySelector("#np-karaoke .amll-lyric-player"), { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector("#np-karaoke .amll-lyric-player")?.textContent.includes("你好世界"), { timeout: 8000 });
  const activeText = () => page.evaluate(() => {
    const el = document.querySelector("#np-karaoke [class*=active]");
    return el ? (el.textContent ?? "").trim() : "";
  });
  // time=2.9 → 歌词时钟 (2.9+0.2)*1000 = 3100 → 第二句 active
  await page.waitForFunction(() => {
    const el = document.querySelector("#np-karaoke [class*=active]");
    return !!el && (el.textContent ?? "").includes("第二句");
  }, { timeout: 8000 });
  if (!(await activeText()).includes("第二句")) throw new Error("delay=0 逐字 active 行错: " + await activeText());
  await openMenu();
  if (!(await page.$(".np-menu-delay"))) throw new Error("kara 模式下缺延迟行");
  await clickDelay("inc", 10); // +1.0s → 时钟 2100 → 你好世界 active
  await page.waitForFunction(() => {
    const el = document.querySelector("#np-karaoke [class*=active]");
    return !!el && (el.textContent ?? "").includes("你好世界");
  }, { timeout: 8000 });
  await closeMenu();
  if ((await lsRead()).TESTA !== 1000) throw new Error("kara 态步进未落 LS: " + JSON.stringify(await lsRead()));
});

await step("全程无 pageerror", async () => {
  if (pageErrors.length) throw new Error(pageErrors.join(" | "));
});

await browser.close();
if (fails) { console.log(`\n❌ verify-lyric-delay: ${fails} FAILURES`); process.exit(1); }
console.log("\n✅ verify-lyric-delay: ALL PASS");
