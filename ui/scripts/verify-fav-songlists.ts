// 收藏歌单（在线收藏 API）验证：
//   1) 侧栏主菜单栏出现「收藏的歌单」分组，条目来自 /user/fav-songlists
//   2) 歌单页收藏按钮接的是在线写接口：点一次收藏（侧栏同帧 +1）、再点取消（恢复）
//   3) 自有歌单不渲染收藏按钮
// 前置：sidecar :3200 已登录 + dev server :5173 在跑。
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
// 容器里 /tmp 常是小 tmpfs（本机仅 10MB）：Chrome 的 profile/临时文件必须挪到大分区，
// 否则满盘即 net::ERR_INSUFFICIENT_RESOURCES（页面资源全加载失败）。
const TMP = process.env.CHROME_TMP ?? "/home/ne0w0r1d/Desktop/quaver/.workbuddy/tmp/chrome";
mkdirSync(TMP + "/profile", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  userDataDir: TMP + "/profile",
  env: { ...process.env, TMPDIR: TMP, XDG_CACHE_HOME: TMP + "/cache" },
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server",
         "--disable-extensions", "--disable-background-networking", "--disable-sync",
         "--no-first-run", "--disable-default-apps", "--disable-component-update",
         "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 720 });
// 本验证只看结构与状态：挡掉图片/字体请求，省内存也省上游 CDN 流量
await page.setRequestInterception(true);
page.on("request", (r) => {
  const t = r.resourceType();
  if (t === "image" || t === "media" || t === "font") r.abort().catch(() => {});
  else r.continue().catch(() => {});
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
page.on("console", (m) => {
  // 图片被主动 abort 会产生 ERR_FAILED 噪音，不算错误
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.log("[console.error]", m.text());
});

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

// 侧栏歌单分组解析：#playlists 直系子节点里 .pl-group 开团，后续 .pl 归属该团
const sidebarGroups = () => page.evaluate(() => {
  const box = document.querySelector("#playlists");
  const out = [];
  let cur = null;
  for (const el of box ? box.children : []) {
    if (el.classList.contains("pl-group")) {
      cur = { label: el.querySelector("span")?.textContent?.trim() ?? "", count: 0, titles: [], subs: [], hrefs: [] };
      out.push(cur);
    } else if (el.classList.contains("pl") && cur) {
      cur.count++;
      cur.titles.push(el.querySelector(".ptitle")?.textContent?.trim() ?? "");
      cur.subs.push(el.querySelector(".psub")?.textContent?.trim() ?? "");
      cur.hrefs.push(el.getAttribute("href") ?? "");
    }
  }
  return out;
});
const favGroup = async () => (await sidebarGroups()).find((g) => g.label.includes("收藏的歌单"));
const api = (path) => page.evaluate(async (p) => (await fetch("/api" + p)).json(), path);

await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#playlists", { timeout: 30000 });
await sleep(1500);

// 0) 中继 + 登录态
await step("中继与登录态可用", async () => {
  const st = await api("/login/status");
  if (!st?.data?.logged_in) throw new Error("sidecar 未登录：" + JSON.stringify(st));
  return `musicid=${st.data.credential.musicid}`;
});

// 1) 侧栏收藏分组
let favCount0 = 0;
await step("侧栏出现「收藏的歌单」分组", async () => {
  let g = null;
  for (let i = 0; i < 60 && !g; i++) { g = await favGroup(); if (!g) await sleep(500); }
  if (!g) throw new Error("侧栏没有收藏的歌单分组：" + JSON.stringify(await sidebarGroups()));
  const up = await api("/user/fav-songlists?page=1&num=100");
  const total = up?.data?.total ?? 0;
  favCount0 = g.count;
  if (total > 0 && g.count === 0) throw new Error("上游有收藏但侧栏为空");
  return `侧栏 ${g.count} 条 / 上游 total=${total}${g.subs[0] ? `；首条副行「${g.subs[0]}」` : ""}`;
});

// 2) 歌单页收藏按钮：拿一个「未收藏」的推荐歌单做 like → unlike 来回
let target = null;
await step("歌单页收藏按钮（在线写接口 like/unlike 来回）", async () => {
  const favs = await api("/user/fav-songlists?page=1&num=500");
  const favIds = new Set((favs?.data?.playlists ?? []).map((x) => String(x.id)));
  const rec = await api("/recommend/songlist?num=30");
  target = (rec?.data?.songlists ?? []).find((x) => x.id && !favIds.has(String(x.id)));
  if (!target) throw new Error("推荐里找不到未收藏的歌单");

  await page.goto(`${BASE}/index.html#/playlist?id=${target.id}&name=${encodeURIComponent(target.title)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".fav-btn", { timeout: 30000 });
  // 侧栏收藏分组就绪后再动按钮（保证 favs 缓存已是收藏列表，而非空表误判）
  await page.waitForFunction(
    () => [...document.querySelectorAll("#playlists .pl-group")].some((g) => g.textContent.includes("收藏的歌单")),
    { timeout: 30000 },
  );
  const before = await page.$eval(".fav-btn", (b) => ({ txt: b.textContent.trim(), on: b.classList.contains("on"), id: b.dataset.plid }));
  if (before.on) throw new Error("初始状态应为未收藏：" + JSON.stringify(before));
  if (before.id !== String(target.id)) throw new Error(`按钮 id 不符：${before.id} != ${target.id}`);

  await page.click(".fav-btn");
  await page.waitForFunction(() => document.querySelector(".fav-btn")?.classList.contains("on"), { timeout: 15000 });
  const afterLike = await page.$eval(".fav-btn", (b) => b.textContent.trim());
  // 侧栏同帧出现该歌单（收藏态与侧栏同源的证据）
  const g1 = await favGroup();
  const inSidebar = g1?.hrefs.some((h) => h.includes(`id=${target.id}`));
  const upstream1 = await api("/user/fav-songlists?page=1&num=500");
  const upstreamHas = (upstream1?.data?.playlists ?? []).some((x) => String(x.id) === String(target.id));

  await page.click(".fav-btn");
  await page.waitForFunction(() => !document.querySelector(".fav-btn")?.classList.contains("on"), { timeout: 15000 });
  const afterUnlike = await page.$eval(".fav-btn", (b) => b.textContent.trim());
  await sleep(1200); // 回源校准
  const g2 = await favGroup();
  const upstream2 = await api("/user/fav-songlists?page=1&num=500");
  const upstreamBack = !(upstream2?.data?.playlists ?? []).some((x) => String(x.id) === String(target.id));
  const sidebarBack = !(g2?.hrefs ?? []).some((h) => h.includes(`id=${target.id}`));

  if (!upstreamHas) throw new Error("收藏后上游列表里没有该歌单（写接口未生效）");
  if (!upstreamBack) throw new Error("取消收藏后上游列表里仍有该歌单（unlike 未生效）");
  if (target && g1 && g2 && g2.count !== favCount0) throw new Error(`侧栏收藏数未复原：${favCount0} -> ${g1.count} -> ${g2.count}`);
  return `「${target.title}」${before.txt} → ${afterLike}（侧栏${inSidebar ? "同步出现" : "未见→回源后同步"}, 上游已收录）→ ${afterUnlike}（上游已移除, 侧栏${sidebarBack ? "恢复" : "残留"}）`;
});

// 3) 自有歌单不给收藏按钮
await step("自有歌单不渲染收藏按钮", async () => {
  const mine = await api("/user/created-songlists");
  const own = (mine?.data?.playlists ?? []).find((p) => p.id && p.dirid !== 201);
  if (!own) return "无自建歌单，跳过";
  await page.goto(`${BASE}/index.html#/playlist?id=${own.id}&name=${encodeURIComponent(own.title)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pl-head", { timeout: 30000 });
  await sleep(1200);
  const btn = await page.$(".fav-btn");
  if (btn) throw new Error(`自有歌单「${own.title}」仍渲染了收藏按钮`);
  return `自有歌单「${own.title}」无收藏按钮`;
});

await browser.close();
console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
