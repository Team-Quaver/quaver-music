// Quaver — 正在播放页验证：背景交叉淡化 / 层叠顺序 / 画廊模式全屏 / kara(AMLL) 冒烟。
// 跑：  node scripts/verify-np-gallery.ts   （需 dev server，QBASE 缺省 http://127.0.0.1:5173）
// 不需要 sidecar：歌曲/歌词经 window.__player 桩进（DEV 钩子），封面请求被拦截为本地纯色 PNG。
// 覆盖：
//  - np 背景双层（A 垫底 / B 淡入）就位与换曲交接（A 接管、B 退场），全程不操纵 z-index
//    —— 背景层一旦盖住 .np-scrim，kara 模式左缘渐变蒙版（歌词可读性背光）就没了
//  - 画廊模式（播放条按钮）：开 = 展开本页 + 全屏；再点 = 收起 + 退全屏 + 按钮熄灭
//  - ESC 收起本页 = 同步退出画廊全屏
//  - kara 冒烟：AMLL 元素挂载、行级隐藏、左缘渐变蒙版仍在、karaoke 清空回退行级
import puppeteer from "puppeteer-core";
import { deflateSync } from "node:zlib";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 64x64 纯色 PNG（零依赖手工组块：IHDR/IDAT/IEND + CRC32），够 blur(60px) 出纯色氛围底
function solidPng(r, g, b) {
  const crc32 = (buf) => {
    let c, t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
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

const PNG_A = solidPng(180, 60, 60);
const PNG_B = solidPng(60, 60, 180);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
// 封面域名拦截为本地 PNG（交替两色，便于确认「换曲真的换了图」）
let flip = false;
const inhibitCalls = [];
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (req.url().endsWith("/api/inhibit")) {
    try { inhibitCalls.push(JSON.parse(req.postData() ?? "{}")); } catch { /* invalid test request is asserted by absence */ }
    return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({
      code: 0, msg: "ok", data: { supported: true, active: false, reason: "" },
    }) });
  }
  if (req.url().includes("y.gtimg.cn")) { flip = !flip; return req.respond({ status: 200, contentType: "image/png", body: flip ? PNG_A : PNG_B }); }
  req.continue();
});

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

const waitForInhibit = async (mode, active, from = 0) => {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (inhibitCalls.slice(from).some((x) => x.mode === mode && x.active === active)) return;
    await sleep(50);
  }
  throw new Error(`未收到 mode=${mode} active=${active} 请求`);
};

/** 桩一首歌进队列并展开本页（行级歌词态；kara 步骤自行挂逐字数据） */
const setupSong = (mid) => page.evaluate((mid) => {
  const p = window.__player;
  if (!p) throw new Error("window.__player 不存在（需要 vite dev，DEV 钩子）");
  p.queue = [{ mid, name: "歌曲" + mid, singer: [{ name: "测试歌手" }], album: { mid: "al" + mid, name: "测试专辑" } }];
  p.index = 0;
  p.lyricState = "ok";
  p.lyrics = [{ t: 0, text: "第一行" }, { t: 3, text: "第二行" }];
  p.karaoke = [];
  p.expanded = true;
  p.notifyPublic();
}, mid);

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1500); // 等 initSparkle（amll 官方插件动态 import）

await step("展开本页：A 垫底层可见且被压在 scrim 之下", async () => {
  await setupSong("A");
  await page.waitForFunction(() => {
    const a = document.querySelector("#np-bg");
    return !!a && getComputedStyle(a).opacity === "1" && a.style.backgroundImage.includes("y.gtimg.cn");
  }, { timeout: 8000 });
  const top = await page.evaluate(() => String(document.elementFromPoint(640, 100)?.className ?? ""));
  if (top.includes("np-bg")) throw new Error("np-bg 盖在了 scrim 之上（层叠被操纵）");
});

await step("背景层零 z-index 操纵（scrim 渐变蒙版不被顶掉）", async () => {
  const st = await page.evaluate(() => ({
    a: getComputedStyle(document.querySelector("#np-bg")).zIndex,
    b: getComputedStyle(document.querySelector("#np-bg2")).zIndex,
    grad: getComputedStyle(document.querySelector(".np-scrim")).backgroundImage.includes("linear-gradient"),
  }));
  if (st.a !== "auto" || st.b !== "auto") throw new Error("背景层 z-index 被操纵: " + JSON.stringify(st));
  if (!st.grad) throw new Error("scrim 渐变丢失");
});

await step("换曲交叉淡化：B 淡入 → 收尾后 A 接管、B 退场", async () => {
  await setupSong("B");
  await page.waitForFunction(() => {
    const b = document.querySelector("#np-bg2");
    return !!b && b.classList.contains("show") && b.style.backgroundImage.includes("y.gtimg.cn");
  }, { timeout: 8000 });
  await sleep(750); // settle(520ms) + 淡出过渡
  const st = await page.evaluate(() => {
    const a = document.querySelector("#np-bg"), b = document.querySelector("#np-bg2");
    return { aShow: a.classList.contains("show"), aImg: a.style.backgroundImage.includes("y.gtimg.cn"),
      bShow: b.classList.contains("show"), bImg: b.style.backgroundImage !== "" };
  });
  if (!st.aShow || !st.aImg) throw new Error("A 未接管新图 " + JSON.stringify(st));
  if (st.bShow || st.bImg) throw new Error("B 未退场 " + JSON.stringify(st));
});

await step("kara 模式：AMLL 挂载、行级隐藏、左缘渐变蒙版仍在", async () => {
  // amll 插件是异步注册的：就位瞬间 player 会补拉一次歌词 —— 桩环境下 API 不可达会把
  // 桩 karaoke 清空（真实应用里这步解析真 QRC）。所以这里反复重挂桩数据直到 .np.kara 稳定。
  await page.evaluate(() => {
    const p = window.__player;
    const line = (t0, dur, ws) => ({
      startTime: t0, endTime: t0 + dur,
      words: ws.map(([w, st, d]) => ({ word: w, startTime: t0 + st, endTime: t0 + st + d })),
      translatedLyric: "",
    });
    const arm = () => {
      p.lyricState = "ok";
      p.lyrics = [{ t: 0, text: "第一行" }, { t: 3, text: "第二行" }];
      p.karaoke = [line(0, 3000, [["你好", 0, 1500], ["世界", 1500, 1500]]), line(3000, 3000, [["第二行", 0, 3000]])];
      p.notifyPublic();
    };
    arm();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (document.querySelector(".np.kara") || Date.now() - t0 > 15000) { clearInterval(iv); return; }
      arm();
    }, 400);
  });
  await page.waitForFunction(() =>
    document.querySelector(".np.kara") && document.querySelector("#np-karaoke .amll-lyric-player"), { timeout: 20000 });
  // AMLL 的行 DOM 在自己的 rAF 首帧后成形：等文本真的上屏再断言
  await page.waitForFunction(() =>
    document.querySelector("#np-karaoke .amll-lyric-player")?.textContent.includes("你好"), { timeout: 8000 });
  const st = await page.evaluate(() => {
    const host = document.querySelector("#np-karaoke .amll-lyric-player");
    const r = host.getBoundingClientRect();
    return { w: r.width, h: r.height,
      karaDisplay: getComputedStyle(document.querySelector("#np-lyrics")).display,
      leftGrad: getComputedStyle(document.querySelector(".np-scrim")).backgroundImage.includes("90deg") };
  });
  if (st.w < 100 || st.h < 100) throw new Error("AMLL 元素无尺寸 " + JSON.stringify(st));
  if (st.karaDisplay !== "none") throw new Error("行级歌词未隐藏");
  if (!st.leftGrad) throw new Error("kara 左缘渐变蒙版丢失");
});

await step("行级回退：karaoke 清空后回行级列表", async () => {
  await page.evaluate(() => { const p = window.__player; p.karaoke = []; p.notifyPublic(); });
  await page.waitForFunction(() =>
    !document.querySelector(".np.kara") && document.querySelectorAll("#np-lyrics .np-ly-line").length > 0, { timeout: 8000 });
});

await step("画廊按钮：开 = 展开并全屏、按钮点亮", async () => {
  await page.evaluate(() => { const p = window.__player; p.expanded = false; p.gallery = false; p.notifyPublic(); });
  await sleep(450);
  const from = inhibitCalls.length;
  await page.click("#pb-gallery");
  await page.waitForFunction(() => window.__player.expanded && window.__player.gallery
    && document.querySelector(".np").classList.contains("open")
    && document.fullscreenElement != null, { timeout: 8000 });
  if (!(await page.$eval("#pb-gallery", (el) => el.classList.contains("on")))) throw new Error("按钮未点亮");
  await waitForInhibit("idle", true, from);
  if (inhibitCalls.slice(from).some((x) => x.mode === "sleep" && x.active)) throw new Error("画廊模式不应额外请求 sleep 抑制");
});

await step("画廊按钮再点：收起并退出全屏", async () => {
  const from = inhibitCalls.length;
  await page.click("#pb-gallery");
  await page.waitForFunction(() => !window.__player.expanded && !window.__player.gallery
    && !document.querySelector(".np").classList.contains("open")
    && document.fullscreenElement == null, { timeout: 8000 });
  await waitForInhibit("idle", false, from);
});

await step("ESC 收起：画廊态下 ESC = 收页 + 退全屏 + 灯灭", async () => {
  await page.click("#pb-gallery");
  await page.waitForFunction(() => window.__player.gallery && document.fullscreenElement != null, { timeout: 8000 });
  const from = inhibitCalls.length;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__player.expanded && !window.__player.gallery
    && document.fullscreenElement == null, { timeout: 8000 });
  await waitForInhibit("idle", false, from);
  if (await page.$eval("#pb-gallery", (el) => el.classList.contains("on"))) throw new Error("按钮仍点亮");
});

await step("外部退出全屏：立即结束画廊抑制", async () => {
  await page.click("#pb-gallery");
  await page.waitForFunction(() => window.__player.gallery && document.fullscreenElement != null, { timeout: 8000 });
  const from = inhibitCalls.length;
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !window.__player.gallery && document.fullscreenElement == null, { timeout: 8000 });
  await waitForInhibit("idle", false, from);
  if (await page.$eval("#pb-gallery", (el) => el.classList.contains("on"))) throw new Error("外部退出后画廊按钮仍点亮");
});

await browser.close();
console.log(`\n${fails === 0 ? "✅" : "❌"} verify-np-gallery: ${fails === 0 ? "ALL PASS" : fails + " FAILURES"}`);
process.exit(fails ? 1 : 0);
