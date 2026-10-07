// 「上一首」按钮双击行为的行为级验证：单击重放当前曲、双击跳到队列里的上一首（replay 档，默认）。
// 不碰网络：队列塞假歌、transport.seek / jump 影子化只记录调用 —— 只验按钮接线与 prev(force) 的分流语义。
//
// 用法：先起 dev server（pnpm dev），再 node scripts/verify-prev-dblclick.mjs
//      （QA_BASE 覆盖地址，默认 http://127.0.0.1:5173）
import puppeteer from "puppeteer-core";

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:5173";
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
await page.waitForFunction(() => !!window.__quaverPlayer, { timeout: 15000 });

// 桩场：两首假歌，播到第 2 首（index=1）。影子化 seek/jump 只记录不执行 —— jump 真跑会去请求流。
// 双击序列用合成事件复刻原生顺序：click → click → dblclick（与真实双击一致）。
await page.evaluate(() => {
  const mk = (mid, name) => ({ id: mid, mid, name, type: 1, singer: [], album: {}, interval: 200, file: {} });
  const p = window.__quaverPlayer;
  p.queue = [mk("PROBE_A", "探针A"), mk("PROBE_B", "探针B")];
  p.index = 1;
  p.shuffle = false;
  window.__probeCalls = null;
  window.__probeArm = () => {
    const calls = [];
    p.transport.seek = (t) => calls.push(["seek", t]);
    p.jump = (i) => calls.push(["jump", i]);
    window.__probeCalls = calls;
    return calls.length;
  };
});
const arm = () => page.evaluate(() => window.__probeArm());
const calls = () => page.evaluate(() => window.__probeCalls);
const setMode = (v) => page.evaluate((vv) => window.__cfg.set({ "Playing.PrevReplay": vv }), v);
const click = () => page.evaluate(() => document.querySelector("#pb-prev").dispatchEvent(new MouseEvent("click", { bubbles: true })));
const dblclick = () => page.evaluate(() => {
  const el = document.querySelector("#pb-prev");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});

// 1) replay 档（默认）：单击 = 只重放当前曲（seek 0），不跳
await step("replay 档：单击 = seek(0) 重放当前曲", async () => {
  await setMode("True"); await arm(); await click();
  const c = await calls();
  if (JSON.stringify(c) !== JSON.stringify([["seek", 0]])) throw new Error(`calls=${JSON.stringify(c)}`);
  return "seek(0) ×1，未跳曲";
});

// 2) replay 档：双击 = 跳到队列里的上一首（头一击的 seek(0) 无害；dblclick 只补一跳，不多不少）
await step("replay 档：双击 = 跳到队列里的上一首", async () => {
  await setMode("True"); await arm(); await dblclick();
  const c = await calls();
  const jumps = c.filter(([k]) => k === "jump");
  if (c[0]?.[0] !== "seek" || c[1]?.[0] !== "seek") throw new Error(`头两击应为 seek：${JSON.stringify(c)}`);
  if (jumps.length !== 1 || jumps[0][1] !== 0) throw new Error(`应恰好一跳且落在队列上一首：${JSON.stringify(c)}`);
  return "seek(0)×2 → jump(0)×1";
});

// 3) prev(true)：force 通道无视重放档直接跳（播放条双击用的就是它；媒体键/热键不传 force 不受影响）
await step("prev(true)：replay 档下 force 直接跳上一首", async () => {
  await setMode("True"); await arm();
  await page.evaluate(() => window.__quaverPlayer.prev(true));
  const c = await calls();
  if (JSON.stringify(c) !== JSON.stringify([["jump", 0]])) throw new Error(`calls=${JSON.stringify(c)}`);
  return "jump(0)×1，未重放";
});

// 4) prev()：媒体键/热键路径在 replay 档仍是重放（无双击语义，不受 force 影响）
await step("prev()：replay 档下媒体键路径仍重放当前曲", async () => {
  await setMode("True"); await arm();
  await page.evaluate(() => window.__quaverPlayer.prev());
  const c = await calls();
  if (JSON.stringify(c) !== JSON.stringify([["seek", 0]])) throw new Error(`calls=${JSON.stringify(c)}`);
  return "seek(0) ×1";
});

// 5) previous 档：单击 = 直接跳上一首（原「跳到上一首」档不变）
await step("previous 档：单击 = 直接跳上一首", async () => {
  await setMode("False"); await arm(); await click();
  const c = await calls();
  if (JSON.stringify(c) !== JSON.stringify([["jump", 0]])) throw new Error(`calls=${JSON.stringify(c)}`);
  return "jump(0)×1";
});

// 6) previous 档：双击 = 两击各跳一次、dblclick 不再补跳（与连点下一首同语义，不许多退第三首）
await step("previous 档：双击 = 恰好两跳（不补第三跳）", async () => {
  await setMode("False"); await arm(); await dblclick();
  const c = await calls();
  if (c.length !== 2 || c.some(([k, v]) => k !== "jump" || v !== 0)) throw new Error(`calls=${JSON.stringify(c)}`);
  return "jump(0)×2";
});

await setMode("True"); // 回默认档
await browser.close();
const fails = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - fails}/${results.length} 通过${fails ? `，${fails} 项失败` : ""}`);
process.exit(fails ? 1 : 0);
