// SelectBox visual/interaction regression checks. Requires the dev server on QBASE (default :5173).
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = (process.env.QBASE || "http://127.0.0.1:5173").replace(/\/$/, "");
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

const selectShape = (selector, index = 0) => page.$$eval(selector, (roots, selectedIndex) => {
  const root = roots[selectedIndex];
  if (!root) throw new Error(`missing SelectBox at index ${selectedIndex}`);
  const button = root.querySelector(".v-sel__btn");
  const drop = root.querySelector(".v-sel__drop");
  const rootRect = root.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const dropRect = drop.getBoundingClientRect();
  return {
    rootWidth: rootRect.width,
    buttonWidth: buttonRect.width,
    dropWidth: dropRect.width,
    hasChevron: Boolean(button.querySelector(":scope > .v-icon")),
    expanded: button.getAttribute("aria-expanded"),
    dropHidden: drop.hidden,
  };
}, index);

const assertTrigger = (shape, context) => {
  if (!shape.hasChevron) throw new Error(`${context}: trigger has no chevron icon`);
  if (Math.abs(shape.buttonWidth - shape.rootWidth) > 0.5) {
    throw new Error(`${context}: trigger ${shape.buttonWidth}px != root ${shape.rootWidth}px`);
  }
};

try {
  await page.goto(`${BASE}/index.html#/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".set-row__ctrl.font-row .v-sel__btn");

  const fontSelects = await page.$$(".set-row__ctrl.font-row .v-sel");
  if (fontSelects.length !== 2) throw new Error(`settings: expected 2 font selects, got ${fontSelects.length}`);
  for (let i = 0; i < fontSelects.length; i += 1) {
    assertTrigger(await selectShape(".set-row__ctrl.font-row .v-sel", i), `settings font select ${i + 1}`);
  }

  await page.click(".set-row__ctrl.font-row .v-sel__btn");
  let shape = await selectShape(".set-row__ctrl.font-row .v-sel");
  if (shape.expanded !== "true" || shape.dropHidden) throw new Error("settings: click did not open listbox");
  if (Math.abs(shape.dropWidth - shape.buttonWidth) > 0.5) {
    throw new Error(`settings: listbox ${shape.dropWidth}px != trigger ${shape.buttonWidth}px`);
  }
  await page.keyboard.press("Escape");
  shape = await selectShape(".set-row__ctrl.font-row .v-sel");
  if (shape.expanded !== "false" || !shape.dropHidden) throw new Error("settings: Escape did not close listbox");

  await page.focus(".set-row__ctrl.font-row .v-sel__btn");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const picked = await page.$eval(".set-row__ctrl.font-row .v-sel__label", (label) => label.textContent);
  if (picked !== "黑体（无衬线）") throw new Error(`settings: keyboard selection picked ${JSON.stringify(picked)}`);

  await page.click('.v-tabs__item[data-tab="playback"]');
  await page.waitForSelector("#backend-device .v-sel__btn", { visible: true });
  assertTrigger(await selectShape("#backend-device .v-sel"), "output device select");

  await page.setViewport({ width: 720, height: 720 });
  await page.click('.v-tabs__item[data-tab="appearance"]');
  const narrowShapes = await page.$$eval(".set-row__ctrl.font-row .v-sel", (roots) => roots.map((root) => {
    const button = root.querySelector(".v-sel__btn");
    const rootRect = root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return { rootWidth: rootRect.width, buttonWidth: buttonRect.width, right: buttonRect.right };
  }));
  for (const [index, narrow] of narrowShapes.entries()) {
    if (Math.abs(narrow.buttonWidth - narrow.rootWidth) > 0.5 || narrow.right > 721) {
      throw new Error(`narrow settings font select ${index + 1}: ${JSON.stringify(narrow)}`);
    }
  }

  await page.setViewport({ width: 1280, height: 840 });
  await page.goto(`${BASE}/index.html#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".qr-actions .v-sel__btn");
  shape = await selectShape(".qr-actions .v-sel");
  assertTrigger(shape, "login channel select");

  console.log("PASS SelectBox triggers, listbox sizing, and keyboard interaction");
} finally {
  await browser.close();
}
