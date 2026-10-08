// 一次性探针：侧栏导航「每日 30 首 / 我喜欢」的双击与右键（未登录态，取歌失败也该有 toast）。
// 跑：node scripts/probe-virtual-list-menu.ts（前置 dev server :5173）
import puppeteer from "puppeteer-core";

const BASE = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e))); // 双击路径不允许未处理拒绝（取歌失败须被 toast 兜住）

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

const centerOf = async (sel) => {
  const el = await page.$(sel);
  if (!el) throw new Error("找不到 " + sel);
  const b = await el.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(800);

await step("右键「每日 30 首」弹出菜单（立即播放 + 插队播放）", async () => {
  const { x, y } = await centerOf('.nav a[data-route="/daily"]');
  await page.mouse.click(x, y, { button: "right" });
  await sleep(250);
  const labels = await page.$$eval(".ctx-layer .ct-item .ct-label", (els) => els.map((e) => e.textContent.trim()));
  if (!labels.includes("立即播放") || !labels.includes("插队播放")) throw new Error("菜单项: " + labels.join(","));
  return labels.join(" / ");
});

await step("菜单点「插队播放」→ 取歌失败有 toast（未登录，不静默）", async () => {
  const items = await page.$$(".ctx-layer .ct-item");
  for (const it of items) {
    if ((await it.$eval(".ct-label", (e) => e.textContent.trim())) === "插队播放") { await it.click(); break; }
  }
  await sleep(400);
  const toast = await page.$eval(".toast", (e) => e.textContent);
  if (!toast.includes("取歌失败") && !toast.includes("歌单为空")) throw new Error("toast: " + toast);
  return toast;
});

await page.mouse.click(640, 500); // 关掉可能残留的菜单层
await sleep(200);

await step("双击「我喜欢」→ 有 toast 反馈，且无未处理拒绝", async () => {
  const { x, y } = await centerOf('.nav a[data-route="/liked"]');
  await page.mouse.click(x, y);
  await page.mouse.click(x, y); // 双击
  await sleep(600);
  const toast = await page.$eval(".toast", (e) => e.textContent).catch(() => "");
  if (!toast) throw new Error("没有任何 toast");
  return toast;
});

await step("全程无未处理 Promise 拒绝", async () => {
  if (errors.length) throw new Error(errors.join(" | "));
  return "clean";
});

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
