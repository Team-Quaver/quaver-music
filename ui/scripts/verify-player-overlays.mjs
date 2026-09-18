// Player overlay regression checks: quality menu + queue panel share one FloatWindow
// control (body > .v-float, right-bottom) on the home page and the full-screen view.
// Usage: QBASE=http://127.0.0.1:5173 npm run verify:overlays
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const browserPath = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));

if (!browserPath) throw new Error("Chrome/Chromium not found; set CHROME_BIN");

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (error) => console.log("[pageerror]", String(error)));

let failures = 0;
const step = async (name, check) => {
  try {
    const detail = await check();
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
};
const panelState = () => page.evaluate(() => {
  const panel = document.querySelector("#queue-panel");
  if (!panel) throw new Error("queue panel missing");
  return {
    className: panel.className,
    open: !panel.hidden,
    parent: panel.parentElement === document.body ? "body" : panel.parentElement?.className || panel.parentElement?.id,
    sameNode: panel === window.__overlayQueueNode,
  };
});
const seedPlayer = (state) => page.evaluate((next) => {
  const player = window.__player;
  player.queue = [{ mid: "overlay-fixture", name: "Overlay fixture", singer: [{ name: "Quaver" }] }];
  player.index = 0;
  player.expanded = next.expanded;
  player.queueOpen = next.queueOpen;
  player.notifyPublic();
}, state);

try {
  await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pb-qpop");
  await page.evaluate(() => { window.__overlayQueueNode = document.querySelector("#queue-panel"); });

  await step("quality menu is initially hidden and has no box", async () => {
    const state = await page.$eval("#pb-qpop", (menu) => {
      const rect = menu.getBoundingClientRect();
      return { hidden: menu.hidden, display: getComputedStyle(menu).display, width: rect.width, height: rect.height };
    });
    if (!state.hidden || state.display !== "none" || state.width || state.height) {
      throw new Error(JSON.stringify(state));
    }
    return "hidden + display:none";
  });

  await step("regular wide layout shows the queue as a right-bottom window", async () => {
    await seedPlayer({ expanded: false, queueOpen: true });
    const state = await panelState();
    const inContent = await page.$(".q-content #queue-panel");
    if (inContent || !state.sameNode || !state.open || !state.className.includes("v-float") || state.parent !== "body") {
      throw new Error(JSON.stringify({ ...state, inContent: !!inContent }));
    }
    return "body > .v-float";
  });

  await step("quality and queue share the same window control", async () => {
    const shape = await page.evaluate(() => ["#queue-panel", "#pb-qpop"].map((sel) => {
      const w = document.querySelector(sel);
      return {
        sel,
        cls: w.className,
        parent: w.parentElement === document.body,
        head: !!w.querySelector(":scope > .v-float__head"),
        body: !!w.querySelector(":scope > .v-float__body"),
      };
    }));
    for (const w of shape) {
      if (w.cls !== "v-float" || !w.parent || !w.head || !w.body) throw new Error(JSON.stringify(shape));
    }
    return "both body > .v-float with head + body";
  });

  await step("full-screen reuses that queue as a right-bottom window", async () => {
    await seedPlayer({ expanded: true, queueOpen: true });
    const state = await panelState();
    const hasInlineSlot = await page.$("#np-queue");
    if (hasInlineSlot || !state.sameNode || !state.open || !state.className.includes("v-float") || state.parent !== "body") {
      throw new Error(JSON.stringify({ ...state, hasInlineSlot: !!hasInlineSlot }));
    }
    return "same node, body > .v-float";
  });

  await step("full-screen queue window closes without leaving a column", async () => {
    const close = await page.$("#queue-panel-close");
    const clickable = await close.isIntersectingViewport();
    if (!clickable) throw new Error("close button is not visible");
    await close.click();
    const state = await panelState();
    if (state.open || await page.$("#np-queue")) {
      throw new Error(JSON.stringify(state));
    }
    return "closed window, no #np-queue";
  });

  await step("leaving full-screen keeps the same open queue window", async () => {
    await seedPlayer({ expanded: true, queueOpen: true });
    await seedPlayer({ expanded: false, queueOpen: true });
    const state = await panelState();
    if (!state.sameNode || !state.open || !state.className.includes("v-float") || state.parent !== "body") {
      throw new Error(JSON.stringify(state));
    }
    return "same window after collapse";
  });

  await step("regular narrow layout uses the same queue window", async () => {
    await page.setViewport({ width: 760, height: 720 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const state = await panelState();
    if (!state.sameNode || !state.open || !state.className.includes("v-float") || state.parent !== "body") {
      throw new Error(JSON.stringify(state));
    }
    return "narrow body > .v-float";
  });

  await step("quality and queue overlays are mutually exclusive", async () => {
    await page.setViewport({ width: 1280, height: 840 });
    await seedPlayer({ expanded: true, queueOpen: true });
    await page.waitForFunction(() => !document.querySelector("#pb-quality").disabled, { timeout: 8000 });
    await page.click("#pb-quality");
    const afterQuality = await page.evaluate(() => ({
      qualityHidden: document.querySelector("#pb-qpop").hidden,
      queueOpen: window.__player.queueOpen,
    }));
    if (afterQuality.qualityHidden || afterQuality.queueOpen) throw new Error(JSON.stringify(afterQuality));

    await page.click("#pb-queue");
    const afterQueue = await page.evaluate(() => ({
      qualityHidden: document.querySelector("#pb-qpop").hidden,
      queueOpen: window.__player.queueOpen,
    }));
    if (!afterQueue.qualityHidden || !afterQueue.queueOpen) throw new Error(JSON.stringify(afterQueue));
    return "only one overlay remains open";
  });

  await step("wheel over quality menu scrolls instead of changing volume", async () => {
    await page.evaluate(() => { window.__player.setVolume(0.5); });
    await page.click("#pb-quality");
    await page.waitForFunction(() => !document.querySelector("#pb-qpop").hidden);
    const box = await page.$eval("#pb-qpop", (menu) => {
      const rect = menu.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.wheel({ deltaY: 200 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterMenu = await page.evaluate(() => ({ volume: window.__player.volume }));
    if (Math.abs(afterMenu.volume - 0.5) > 1e-6) {
      throw new Error(`volume moved 0.5 -> ${afterMenu.volume} (menu scroll hijacked)`);
    }
    // Bar 上的滚轮微调音量意图保留
    await page.evaluate(() => {
      document.querySelector("#pb-qpop-close").click();
      window.__player.setVolume(0.5);
    });
    const rail = await page.$eval("#pb-volrail", (r) => {
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.move(rail.x, rail.y);
    await page.mouse.wheel({ deltaY: -120 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const v = await page.evaluate(() => window.__player.volume);
    if (!(v > 0.5)) throw new Error(`bar wheel no longer tunes volume: ${v}`);
    return "menu keeps wheel, bar keeps volume";
  });
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
