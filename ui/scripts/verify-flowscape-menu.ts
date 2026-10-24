// Flowscape 菜单回归：底部多余分隔线；歌手次级菜单必须浮在 np overlay(z-index:50) 之上。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const code = readFileSync(new URL("../../vendor/Sparkle/dist/site/sparkle/plugins/flowscape.js", import.meta.url), "utf8");
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 1 });
  await page.setContent('<style>body{margin:0;background:#12141b} .np{position:fixed;inset:0;z-index:50;background:#12141b} *{box-sizing:border-box}</style><div class="np"><div id="host"></div></div>');
  await page.evaluate(async (source) => {
    const plugin = (await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))).default;
    let view: any;
    const song = { mid: "fixture", name: "Fixture Song", singer: [{ name: "A", mid: "a1" }, { name: "B", mid: "b2" }] };
    plugin.setup({
      storage: { get: () => null, set: () => {} },
      registerNowPlayingView: (v: any) => { view = v; }, registerSettingsSection: () => {},
    });
    const ctx = {
      current: () => song, songAt: () => null, cover: () => "", expanded: () => true,
      time: () => 0, duration: () => 10, paused: () => true, loading: () => false,
      error: () => "", volume: () => 0.8, muted: () => false, loved: () => false,
      radioActive: () => false, radioLoading: () => false, radioError: () => "",
      qualityLabel: () => "自动", qualityTiers: () => [], quality: () => "auto",
      showTrans: () => false, lyricAux: () => "off", lyricState: () => "ready",
      karaokeActive: () => false, karaoke: () => [], lyrics: () => ({ lines: [] }),
      onNotify: () => () => {}, collapse: () => {},
    };
    (window as any).__dispose = view.render(document.querySelector("#host")!, ctx);
  }, code);

  await page.click("#fs-more");
  await page.waitForSelector(".fs-mmenu.open", { timeout: 1000 });

  const separators = await page.$$eval(".fs-mmenu .fs-msep", (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }));
  assert.equal(separators.length, 1, `分隔线数量应为 1，实际 ${separators.length}`);
  const lastRow = await page.$eval(".fs-mmenu .fs-mrow:last-of-type", (e) => e.getBoundingClientRect().bottom);
  assert.ok(separators[0].bottom < lastRow, "分隔线应位于最后一个菜单项之前");

  await page.click(".fs-msub-btn");
  await page.waitForSelector(".fs-mslist.open", { timeout: 1000 });
  const overlay = await page.$eval(".fs-mslist.open", (e) => {
    const z = Number(getComputedStyle(e).zIndex);
    return { z, text: e.textContent?.trim(), rect: e.getBoundingClientRect() };
  });
  assert.ok(overlay.z > 50, `歌手子菜单 z-index 应高于 np overlay(50)，实际 ${overlay.z}`);
  assert.match(overlay.text ?? "", /A/);
  assert.match(overlay.text ?? "", /B/);
  assert.equal(await page.$eval(".fs-msub-btn", (e) => e.getAttribute("aria-expanded")), "true");
  console.log("PASS 更多菜单分隔线：仅保留最后一个菜单项之前的一条");
  console.log(`PASS 跳转歌手子菜单：展开于 z-index:${overlay.z}，条目 ${overlay.text}`);

  await page.click(".fs-msub-btn");
  await page.waitForFunction(() => !document.querySelector(".fs-mslist"), { timeout: 1000 });
  assert.equal(await page.$eval(".fs-msub-btn", (e) => e.getAttribute("aria-expanded")), "false");
  console.log("PASS 跳转歌手子菜单可再次收起");
} finally {
  await browser.close();
}
