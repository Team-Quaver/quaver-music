// Quaver — Sparkle Marketplace 冒烟（手动跑，需 dev server：QBASE 缺省 http://localhost:5173）
//
// 覆盖：
//  - 四标签相互隔离：主题/插件/扩展（已装管理）与 Marketplace（安装入口）
//  - 索引按 category 安装后归入对应标签（theme→主题 / 缺省→插件 / extension→扩展）
//  - 插件设置收进行内齿轮弹窗（不再常驻页面）；主题行齿轮仅在插件提供设置区时出现
//  - 「添加本地插件」红色渐变按钮 + 5s 倒计时警告弹窗 → blob import 校验 → installLocal
//  - Esc / 取消关弹窗不触发安装；非法形状拒绝落盘
// 跑：  pnpm run dev （另开终端）  node scripts/verify-sparkle-market.mjs
import puppeteer from "puppeteer-core";

const BASE = process.env.QBASE || "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};

// 冒烟「本地插件文件」：单文件 ESM（与真实手装同形），装上后注册一个主题
const FAKE_PLUGIN = `export default { id: "smoke-local", name: "冒烟本地插件", version: "0.0.1", kind: "third-party", setup(ctx) { ctx.registerTheme({ id: "smoke-local", name: "冒烟主题", css: "--acc: #e5484d;" }); } };`;
const FAKE_PLUGIN_B64 = Buffer.from(FAKE_PLUGIN, "utf8").toString("base64");

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

// 桥桩：索引带齐三类条目；安装把 category 持久化进 manifest（同主进程行为）
await page.evaluateOnNewDocument((fakeB64) => {
  window.__installed = [];
  window.__installLocalMsg = null;
  window.__pickResult = { ok: true, canceled: true };
  const inst = (meta) => ({ id: meta.id, dir: `/x/${meta.id}`, manifest: { ...meta, main: "main.js" }, installedAt: Date.now() });
  window.quaverSparkle = {
    list: async () => ({ ok: true, plugins: window.__installed }),
    install: async (m) => { window.__installed.push(inst(m.meta)); return { ok: true, id: m.meta.id }; },
    uninstall: async (m) => { window.__installed = window.__installed.filter((x) => x.id !== m.id); return { ok: true }; },
    market: async () => ({ ok: true, index: { version: 1, plugins: [
      { id: "t1", name: "主题一号", version: "1.0.0", author: "Q", description: "冒烟主题", category: "theme", download: "http://x/t1.js" },
      { id: "p1", name: "插件一号", version: "1.0.0", author: "Q", description: "冒烟插件", download: "http://x/p1.js" },
      { id: "e1", name: "扩展一号", version: "1.0.0", author: "Q", description: "冒烟扩展", category: "extension", download: "http://x/e1.js" },
    ] } }),
    pickLocal: async () => window.__pickResult,
    installLocal: async (m) => { window.__installLocalMsg = m; window.__installed.push(inst(m.meta)); return { ok: true, id: m.meta.id }; },
  };
}, FAKE_PLUGIN_B64);

await page.goto(`${BASE}/#/settings`, { waitUntil: "networkidle2" });

const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
const text = (sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
const exists = (sel) => page.$(sel).then((x) => !!x);
const catTab = (c) => `.sparkle-cats .set-tab[data-cat="${c}"]`;

// —— 1. 进 Sparkle tab，四标签骨架 ——
await page.waitForSelector(".set-tabs", { timeout: 15000 });
await click('.set-tabs .set-tab[data-tab="plugins"]');
await page.waitForSelector(".sparkle-cats", { timeout: 5000 });
const cats = await page.$$eval(".sparkle-cats .set-tab", (els) => els.map((e) => e.dataset.cat));
check("四标签齐备（主题/插件/扩展/Marketplace）", JSON.stringify(cats) === JSON.stringify(["theme", "plugin", "extension", "market"]), JSON.stringify(cats));
check("索引源固定展示且不可编辑", (await text(".sparkle-src")) === "https://quaver.0w0.red/marketplace.json" && !(await exists(".sparkle-market-bar input")));
check("添加本地插件按钮为红色渐变", await page.$eval(".sparkle-local", (e) => getComputedStyle(e).backgroundImage.includes("linear-gradient")));

// —— 2. Marketplace 安装 → 按分类归入对应标签（相互隔离） ——
await click(catTab("market"));
await page.waitForFunction(() => document.querySelectorAll(".sparkle-market-list .sparkle-row").length === 3, { timeout: 8000 });
const marketBadges = await page.$$eval(".sparkle-market-list .sparkle-badge", (els) => els.map((e) => e.textContent.trim()));
check("Marketplace 列表三类条目同列（徽标=主题/插件/扩展）", JSON.stringify(marketBadges) === JSON.stringify(["主题", "插件", "扩展"]), JSON.stringify(marketBadges));

// Marketplace 内部分类筛选 chips
const mcatChips = await page.$$eval(".sparkle-mkt-chip", (els) => els.map((e) => e.dataset.mcat));
check("Marketplace 分类筛选 chips 齐备", JSON.stringify(mcatChips) === JSON.stringify(["all", "theme", "plugin", "extension"]), JSON.stringify(mcatChips));
const mcatCount = async () => (await page.$$(".sparkle-market-list .sparkle-row")).length;
const pickMcat = async (c) => { await page.evaluate((cc) => document.querySelector(`.sparkle-mkt-chip[data-mcat="${cc}"]`).click(), c); await sleep(150); };
await pickMcat("theme");
check("「主题」筛选只剩主题条目", (await mcatCount()) === 1 && (await text(".sparkle-market-list .sparkle-name"))?.startsWith("主题一号"));
await pickMcat("extension");
check("「扩展」筛选只剩扩展条目", (await mcatCount()) === 1 && (await text(".sparkle-market-list .sparkle-name"))?.startsWith("扩展一号"));
await pickMcat("plugin");
check("「插件」筛选只剩插件条目（缺省 category 归插件）", (await mcatCount()) === 1 && (await text(".sparkle-market-list .sparkle-name"))?.startsWith("插件一号"));
await pickMcat("all");
check("「全部」恢复三行", (await mcatCount()) === 3);
const installEntry = async (name) => {
  await page.evaluate((kw) => {
    const row = [...document.querySelectorAll(".sparkle-market-list .sparkle-row")].find((r) => r.textContent.includes(kw));
    row.querySelector(".sparkle-install").click();
  }, name);
  await sleep(300);
};
await installEntry("主题一号");
await installEntry("插件一号");
await installEntry("扩展一号");

const rowInfo = (panelSel, keyword) => page.$$eval(`${panelSel} .sparkle-row`, (rows, kw) => {
  const row = rows.find((r) => r.textContent.includes(kw));
  if (!row) return null;
  return {
    badge: row.querySelector(".sparkle-badge")?.textContent.trim() ?? null,
    gear: !!row.querySelector(".sparkle-gear"),
    switchText: row.querySelector(".sparkle-switch")?.textContent.trim() ?? null,
  };
}, keyword);
await click(catTab("theme"));
const t1 = await rowInfo('[data-cat="theme"]', "主题一号");
check("主题装进「主题」标签（徽标=主题，默认停用，未启用无齿轮）", t1?.badge === "主题" && t1?.switchText === "已停用" && t1?.gear === false, JSON.stringify(t1));
check("主题不混进「插件」标签", !(await rowInfo('[data-cat="plugin"]', "主题一号")));
await click(catTab("plugin"));
const p1 = await rowInfo('[data-cat="plugin"]', "插件一号");
check("插件装进「插件」标签（第三方徽标，恒有齿轮）", p1?.badge === "第三方" && p1?.gear === true && p1?.switchText === "已停用", JSON.stringify(p1));
check("插件不混进「扩展」标签", !(await rowInfo('[data-cat="extension"]', "插件一号")));
await click(catTab("extension"));
const e1 = await rowInfo('[data-cat="extension"]', "扩展一号");
check("扩展装进「扩展」标签（徽标=扩展，恒有齿轮）", e1?.badge === "扩展" && e1?.gear === true, JSON.stringify(e1));

// —— 3. 插件设置收进齿轮弹窗（die-for-you 默认启用、提供设置区） ——
await click(catTab("plugin"));
await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-cat="plugin"] .sparkle-row')].find((r) => r.textContent.includes("Die For You"));
  row.querySelector(".sparkle-gear").click();
});
await page.waitForSelector(".sparkle-settings-dialog", { timeout: 5000 });
const dlgHasSection = await page.evaluate(() => {
  const body = document.querySelector(".sparkle-settings-body");
  return body?.textContent.includes("Die For You") && !!body?.querySelector(".ghost-btn");
});
check("齿轮弹窗渲染插件设置区（含「换一句」）", dlgHasSection === true);
await page.evaluate(() => document.querySelector('.sparkle-settings-dialog [data-act="close"]').click());
await sleep(400);
check("「关闭」收弹窗", !(await page.$(".sparkle-settings-dialog")));

// —— 4. 本地插件警告弹窗：5s 倒计时 ——
await click(catTab("market"));
await page.evaluate(() => document.querySelector(".sparkle-local").click());
await page.waitForSelector(".upd-overlay .upd-dialog.danger", { timeout: 5000 });
check("弹窗为红色渐变变体", !!(await page.$(".upd-dialog.danger")));
check(
  "警告文案逐字保留",
  (await text(".local-warn-text")) === "Quaver Music 无法保证 Marketplace 插件的可用性和安全性，与此同时，我们更无法保证，且并不推荐您通过手动安装的方式安装插件，但自由权利能在您手中，请确保安全后点击确认",
);
check("确认键初始禁用（5s）", await page.$eval('[data-act="confirm"]', (e) => e.disabled));
await sleep(1200);
check("1.2s 后仍在倒计时", (await text('[data-act="confirm"]')) === "确认（4s）");
await page.keyboard.press("Escape");
await sleep(320);
check("Esc 关闭弹窗", !(await page.$(".upd-overlay")));
check("Esc 未触发安装", (await page.evaluate(() => window.__installLocalMsg)) === null);

// —— 5. 完整本地安装流程（装完归入「插件」标签） ——
await page.evaluate((b64) => { window.__pickResult = { ok: true, name: "smoke-local.js", dataBase64: b64 }; }, FAKE_PLUGIN_B64);
await page.evaluate(() => document.querySelector(".sparkle-local").click());
await page.waitForSelector(".upd-overlay .upd-dialog.danger", { timeout: 5000 });
await sleep(5300); // 等倒计时走完
check("5s 后确认解锁", !(await page.$eval('[data-act="confirm"]', (e) => e.disabled)));
await page.evaluate(() => document.querySelector('[data-act="confirm"]').click());
await page.waitForFunction(() => window.__installLocalMsg !== null, { timeout: 8000 });
const msg = await page.evaluate(() => window.__installLocalMsg);
check("installLocal 收到本体与元数据（id 取自插件）", msg?.meta?.id === "smoke-local" && msg?.meta?.name === "冒烟本地插件" && typeof msg.dataBase64 === "string");
await click(catTab("plugin"));
await page.waitForFunction(() => [...document.querySelectorAll('[data-cat="plugin"] .sparkle-name')].some((e) => e.textContent.includes("冒烟本地插件")), { timeout: 8000 });
const local = await rowInfo('[data-cat="plugin"]', "冒烟本地插件");
check("本地装的插件进「插件」标签（第三方徽标，默认停用）", local?.badge === "第三方" && local?.switchText === "已停用", JSON.stringify(local));

// —— 6. 形状不合法的本地文件被原地拒绝 ——
const BAD_B64 = Buffer.from("export default { name: 42 }", "utf8").toString("base64");
await page.evaluate((b64) => { window.__pickResult = { ok: true, name: "bad.js", dataBase64: b64 }; window.__installLocalMsg = null; }, BAD_B64);
await page.evaluate(() => document.querySelector(".sparkle-local").click());
await page.waitForSelector(".upd-overlay .upd-dialog.danger", { timeout: 5000 });
await sleep(5300);
await page.evaluate(() => document.querySelector('[data-act="confirm"]').click());
await sleep(1200);
check("非法形状拒绝落盘", (await page.evaluate(() => window.__installLocalMsg)) === null);

await click(catTab("theme"));
await page.screenshot({ path: "/tmp/sparkle-market-smoke.png", fullPage: true });
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
