// 探针：设置页「热键」选项卡的端到端行为（浏览器 dev 态，无需 Electron 壳层）。
// 覆盖：选项卡渲染 / 默认绑定文案 / 录制（Esc 取消、退格清除、组合键写入配置）/
//       焦点内热键分发（Ctrl+Up 调音量）/ 输入框内让位。
// 前置：pnpm run dev -- --port 5173 --strictPort --host 127.0.0.1（vite 实际绑 ::1，用 localhost 访问）
// 跑：node scripts/probe-hotkeys-settings.mjs
import puppeteer from "puppeteer-core";

const BASE = "http://localhost:5173";
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

await step("热键选项卡存在且在通用之后", async () => {
  const order = await page.$$eval(".set-tab", (els) => els.map((e) => e.textContent.trim()));
  const at = order.indexOf("热键");
  if (at < 0) throw new Error("没有热键标签: " + order.join(","));
  if (order[at - 1] !== "通用") throw new Error("不在通用旁边: " + order.join(","));
  return order.join(" / ");
});

await step("切到热键页：两组共 11 条", async () => {
  await page.evaluate(() => document.querySelector('.set-tab[data-tab="hotkeys"]').click());
  await sleep(300);
  const n = await page.$$eval('[data-panel="hotkeys"] .hk-btn', (els) => els.length);
  if (n !== 11) throw new Error("hk-btn 数量 " + n);
  return "11 rows";
});

await step("默认绑定文案", async () => {
  const got = await page.$eval('[data-panel="hotkeys"] .hk-btn[data-scope="Global"][data-action="toggle"]', (e) => e.textContent);
  const quit = await page.$eval('[data-panel="hotkeys"] .hk-btn[data-scope="Focus"][data-action="quit"]', (e) => e.textContent);
  const volup = await page.$eval('[data-panel="hotkeys"] .hk-btn[data-scope="Global"][data-action="volup"]', (e) => e.textContent);
  if (got !== "Ctrl+Alt+F5") throw new Error("Global toggle = " + got);
  if (quit !== "Ctrl+Q") throw new Error("Focus quit = " + quit);
  if (volup !== "Ctrl+Alt+Up") throw new Error("Global volup = " + volup);
  return "toggle=F5, quit=Ctrl+Q, volup=Ctrl+Alt+Up";
});

await step("录制组合键写入配置", async () => {
  const btn = await page.$('[data-panel="hotkeys"] .hk-btn[data-scope="Global"][data-action="toggle"]');
  await btn.click();
  await sleep(120);
  const capturing = await page.$eval('[data-panel="hotkeys"] .hk-btn.capturing', (e) => e.textContent);
  if (!capturing.includes("按下新组合键")) throw new Error("没进录制态: " + capturing);
  await page.keyboard.down("Control"); await page.keyboard.down("Shift");
  await page.keyboard.press("9");
  await page.keyboard.up("Shift"); await page.keyboard.up("Control");
  await sleep(200);
  const text = await page.$eval('[data-panel="hotkeys"] .hk-btn[data-scope="Global"][data-action="toggle"]', (e) => e.textContent);
  const conf = await page.evaluate(() => window.__cfg.get("Hotkeys.Global.Toggle"));
  if (text !== "Ctrl+Shift+9" || conf !== "Ctrl+Shift+9") throw new Error(`text=${text} conf=${conf}`);
  return "conf = Ctrl+Shift+9";
});

await step("Esc 取消录制", async () => {
  const btn = await page.$('[data-panel="hotkeys"] .hk-btn[data-scope="Focus"][data-action="toggle"]');
  await btn.click();
  await sleep(120);
  await page.keyboard.press("Escape");
  await sleep(120);
  const text = await page.$eval('[data-panel="hotkeys"] .hk-btn[data-scope="Focus"][data-action="toggle"]', (e) => e.textContent);
  const conf = await page.evaluate(() => window.__cfg.get("Hotkeys.Focus.Toggle"));
  if (text !== "Ctrl+P" || conf !== "Ctrl+P") throw new Error(`text=${text} conf=${conf}`);
});

await step("退格清除 = 停用", async () => {
  const btn = await page.$('[data-panel="hotkeys"] .hk-btn[data-scope="Focus"][data-action="toggle"]');
  await btn.click();
  await sleep(120);
  await page.keyboard.press("Backspace");
  await sleep(120);
  const text = await page.$eval('[data-panel="hotkeys"] .hk-btn[data-scope="Focus"][data-action="toggle"]', (e) => e.textContent);
  const conf = await page.evaluate(() => window.__cfg.get("Hotkeys.Focus.Toggle"));
  if (conf !== "") throw new Error("conf=" + conf);
  if (text !== "未设置") throw new Error("text=" + text);
  return "已停用";
});

await step("录回默认 Ctrl+P（焦点热键随即恢复）", async () => {
  const btn = await page.$('[data-panel="hotkeys"] .hk-btn[data-scope="Focus"][data-action="toggle"]');
  await btn.click();
  await sleep(120);
  await page.keyboard.down("Control"); await page.keyboard.press("p"); await page.keyboard.up("Control");
  await sleep(120);
  const conf = await page.evaluate(() => window.__cfg.get("Hotkeys.Focus.Toggle"));
  if (conf !== "Ctrl+P") throw new Error("conf=" + conf);
});

await step("焦点内热键：Ctrl+Up 音量 +5%", async () => {
  await page.evaluate(() => window.__player.setVolume(0.8));
  await sleep(100);
  await page.keyboard.down("Control");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Control");
  await sleep(150);
  const vol = await page.evaluate(() => window.__player.volume);
  if (Math.abs(vol - 0.85) > 1e-9) throw new Error("volume=" + vol);
  await page.evaluate(() => window.__player.setVolume(0.8));
  return "0.8 → 0.85";
});

await step("焦点内热键：Ctrl+Down 音量 -5%", async () => {
  await page.keyboard.down("Control");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Control");
  await sleep(150);
  const vol = await page.evaluate(() => window.__player.volume);
  if (Math.abs(vol - 0.75) > 1e-9) throw new Error("volume=" + vol);
  await page.evaluate(() => window.__player.setVolume(0.8));
  return "0.8 → 0.75";
});

await step("输入框内方向热键让位（音量不变）", async () => {
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "__probe-input";
    document.body.append(i);
    i.focus();
  });
  await sleep(80);
  await page.keyboard.down("Control");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Control");
  await sleep(150);
  const vol = await page.evaluate(() => ({ vol: window.__player.volume, focused: document.activeElement?.id }));
  if (Math.abs(vol.vol - 0.8) > 1e-9) throw new Error("输入框内音量被改: " + vol.vol);
  return "音量保持 0.8";
});

await step("浏览器 dev 无壳层：全局组有说明", async () => {
  await sleep(3500); // 等录制过程的临时提示（3.2s）恢复成默认说明
  const hint = await page.$eval('[data-panel="hotkeys"] .set-group:first-child [data-hint]', (e) => e.textContent);
  if (!hint.includes("没有壳层") && !hint.includes("门户") && !hint.includes("系统 API")) throw new Error(hint);
  return hint.slice(0, 40) + "…";
});

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
