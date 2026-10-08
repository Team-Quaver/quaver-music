// 「全局输入治理」行为冒烟（需 dev server 在 5173；puppeteer-core + 本机 Chrome）
//
// verify-input-policy.ts 是源码正则护栏；这个脚本用真浏览器事件验证行为本身：
//   1. 中键点链接：不开新标签/新窗口、当前页不跳转；
//   2. 左键点链接/按钮：导航照常发生，但焦点不落在被点的元素上；
//   3. 左键点输入框：焦点照常落上去（打字要用）；
//   4. Tab 键：焦点不动（既有全局拦截，回归盯防）。
//
// 用法：先起 dev server（pnpm run dev -- --port 5173 --strictPort --host 127.0.0.1），
//       再 node scripts/probe-input-policy.ts
import puppeteer from "puppeteer-core";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" }).catch(async () => {
  // dev server 可能绑在 ::1：换 IPv6 字面量再试一次
  await page.goto(BASE.replace("127.0.0.1", "[::1]") + "/index.html#/", { waitUntil: "networkidle2" });
});
await sleep(800);

const linkSel = '.nav a[href="#/settings"], a.side-btn.settings[href="#/settings"]';
await step("页面就绪：侧栏/设置链接存在", async () => {
  const n = await page.$$eval(linkSel, (els) => els.length);
  if (!n) throw new Error("no settings link found");
});

await step("中键点链接：不开新页面、当前页不跳转", async () => {
  const before = await browser.pages();
  const urlBefore = page.url();
  const el = await page.$(linkSel);
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "middle" });
  await sleep(600);
  const after = await browser.pages();
  if (after.length !== before.length) throw new Error(`new target opened (${before.length} -> ${after.length})`);
  if (page.url() !== urlBefore) throw new Error(`current page navigated: ${page.url()}`);
});

await step("左键点链接：导航照常发生，但焦点不落在链接上", async () => {
  const el = await page.$(linkSel);
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "left" });
  await sleep(600);
  const r = await page.evaluate(() => ({
    hash: location.hash,
    focused: document.activeElement?.tagName ?? "null",
    isLink: document.activeElement?.closest?.("a") != null,
  }));
  if (r.hash !== "#/settings") throw new Error(`navigation broken, hash=${r.hash}`);
  if (r.isLink || r.focused === "A") throw new Error(`focus stayed on link (${r.focused})`);
});

await step("左键点按钮（设置页里的真 <button>）：焦点不落在按钮上", async () => {
  const okBtn = await page.$("button");
  if (!okBtn) throw new Error("no button on settings page");
  const box = await okBtn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "left" });
  await sleep(200);
  const r = await page.evaluate(() => ({
    focused: document.activeElement?.tagName ?? "null",
    isBtn: document.activeElement?.closest?.("button") != null,
  }));
  if (r.isBtn || r.focused === "BUTTON") throw new Error(`focus stayed on button (${r.focused})`);
});

await step("左键点输入框：焦点照常落上去（搜索框要能打字）", async () => {
  const input = await page.$(".content-top input[type=search], .content-top input#q");
  if (!input) throw new Error("search input not found");
  const box = await input.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "left" });
  await sleep(200);
  const r = await page.evaluate(() => document.activeElement?.tagName);
  if (r !== "INPUT") throw new Error(`input not focused, activeElement=${r}`);
});

await step("Tab 键：焦点不动（既有全局拦截）", async () => {
  const before = await page.evaluate(() => document.activeElement?.tagName ?? "null");
  await page.keyboard.press("Tab");
  await sleep(150);
  const after = await page.evaluate(() => document.activeElement?.tagName ?? "null");
  if (before !== after) throw new Error(`Tab moved focus: ${before} -> ${after}`);
});

await browser.close();
console.log(`\n${fails ? `${fails} FAILED` : "all passed"}`);
process.exit(fails ? 1 : 0);
