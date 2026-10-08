// 「我喜欢」预载 + 红心收藏态验证（单曲收藏的在线链路）：
//   1) 开机预载：本地红心缓存清空后重启，红心态仍全部来自服务端 /user/liked
//   2) 我喜欢页：预载缓存秒开、默认全部红心点亮、计数与服务端 total 一致
//   3) 其它视图（每日 30 首，取样自我喜欢）红心同样点亮 —— 收藏态是全局单一真相源
//   4) 取消红心 = 在线取消单曲收藏：上游 total -1、该曲移出我喜欢、行淡出移除、本地落盘同步
//   5) 复原：重新收藏后上游 total 回到初始值，重进我喜欢恢复全亮
// 前置：sidecar :3200 已登录 + dev server（BASE）在跑。
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
// 容器里 /tmp 常是小 tmpfs：Chrome 的 profile/临时文件必须挪到大分区。
// profile 固定复用（不删目录：本机 node 带批量删除守卫，rm 大目录会被拦），
// 「localStorage 为空」的冷启动场景靠脚本内清空 + reload 复现（见 step 0）。
const TMP = process.env.CHROME_TMP ?? "/home/ne0w0r1d/Desktop/quaver/.workbuddy/tmp/chrome-loved";
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
// 本验证只看结构与状态：挡掉图片/字体请求，省内存也省上游 CDN 流量；
// 另外留一个开关把「取消收藏」写接口打成失败，用来验证回滚（不碰真账号）
let mockUnlikeFail = false;
await page.setRequestInterception(true);
page.on("request", (r) => {
  const t = r.resourceType();
  if (mockUnlikeFail && r.url().includes("/api/song/unlike")) {
    r.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ code: -1, msg: "mock：取消收藏失败" }) }).catch(() => {});
  } else if (t === "image" || t === "media" || t === "font") r.abort().catch(() => {});
  else r.continue().catch(() => {});
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.log("[console.error]", m.text());
});

const api = (path) => page.evaluate(async (p) => (await fetch("/api" + p)).json(), path);
const state = () => page.evaluate(() => {
  const p = window.__quaverPlayer;
  return {
    size: p?.loved.size ?? -1,
    cache: p?.likedCache?.length ?? -1,
    total: p?.likedTotal ?? -1,
    ls: JSON.parse(localStorage.getItem("quaver.loved.v1") ?? "null")?.length ?? -1,
  };
});
// 上游读侧有缓存：一次请求拿全（num 开大），只有 total 与实际条数自洽才算「可靠读数」
const readLiked = async () => {
  const d = (await api("/user/liked?page=1&num=1000"))?.data ?? {};
  const mids = (d.songs ?? []).map((s) => s.mid);
  return { total: d.total ?? 0, n: mids.length, mids, ok: (d.total ?? 0) === mids.length };
};
/** 轮询上游到「可靠读数且满足条件」或超时 */
const waitUpstream = async (want, ms = 60000) => {
  const t0 = Date.now();
  let up = await readLiked();
  while (Date.now() - t0 < ms) {
    up = await readLiked();
    if (up.ok && want(up)) return { up, lag: Date.now() - t0 };
    await sleep(2000);
  }
  return { up, lag: Date.now() - t0 };
};
const rows = () => page.evaluate(() => ({
  n: document.querySelectorAll(".rows .row").length,
  on: document.querySelectorAll(".rows .row .row-love.on").length,
  firstMid: document.querySelector(".rows .row")?.dataset.songkey ?? "",
  cnt: document.querySelector(".page-title .cnt")?.textContent?.trim() ?? "",
}));
// 注意：不能拿「文本里有『加载中』」判定未就绪——本账号就有一首叫「天使加载中…」的歌，
// 会误判成还在加载。改用结构性判定：出现 .row 即为已渲染。
const waitRows = () => page.waitForFunction(
  () => document.querySelectorAll(".rows .row").length > 0,
  { timeout: 60000 },
);

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

/** 同址 goto 可能被当成 no-op（不重载、连 hashchange 都不发）：需要「干净页面」时显式 reload */
const reloadLiked = async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitRows();
  await sleep(2000);
};

// 0) 冷启动：把本地红心缓存清成「全新装」(空数组) 后 reload，
//    这样后面亮起来的红心只可能来自服务端 /user/liked 预载
await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#playlists", { timeout: 60000 });
await page.evaluate(() => localStorage.setItem("quaver.loved.v1", "[]"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#playlists", { timeout: 60000 });
const up0 = await api("/user/liked?page=1&num=5");
const total0 = up0?.data?.total ?? 0;

await step("开机预载「我喜欢」（空 localStorage 下灌满红心态）", async () => {
  await page.waitForFunction(() => (window.__quaverPlayer?.likedCache?.length ?? 0) > 0, { timeout: 90000 });
  const s = await state();
  if (total0 <= 0) throw new Error("上游「我喜欢」为空，无法验证");
  if (s.size !== total0) throw new Error(`红心态 ${s.size} != 上游 total ${total0}`);
  if (s.cache !== total0) throw new Error(`预载列表 ${s.cache} != 上游 total ${total0}`);
  if (s.ls !== s.size) throw new Error(`本地落盘 ${s.ls} != 红心态 ${s.size}`);
  return `红心态 ${s.size} / 预载列表 ${s.cache} / 本地落盘 ${s.ls}（上游 total=${total0}）`;
});

// 1) 我喜欢页：预载缓存秒开 + 默认全亮
await step("我喜欢页默认全部红心点亮且计数一致", async () => {
  await page.goto(`${BASE}/index.html#/liked`, { waitUntil: "domcontentloaded" });
  await waitRows();
  await sleep(1500);
  const r = await rows();
  if (r.n !== total0) throw new Error(`行数 ${r.n} != 上游 total ${total0}`);
  if (r.on !== r.n) throw new Error(`只有 ${r.on}/${r.n} 行红心点亮`);
  if (!r.cnt.includes(String(total0))) throw new Error(`计数不符：${r.cnt}`);
  return `${r.n} 行全亮，标题「${r.cnt}」`;
});

// 2) 其它视图：红心态全局同源（每日 30 首取样自我喜欢）
await step("其它视图红心同为点亮（全局单一真相源）", async () => {
  await page.goto(`${BASE}/index.html#/daily`, { waitUntil: "domcontentloaded" });
  await waitRows();
  await sleep(1500);
  const r = await rows();
  if (!r.n) throw new Error("每日 30 首没有行");
  if (r.on !== r.n) throw new Error(`每日 30 首只有 ${r.on}/${r.n} 行亮`);
  return `每日 30 首 ${r.on}/${r.n} 行亮`;
});

// 3) 取消红心 = 在线取消单曲收藏
const pick = up0?.data?.songs?.[0];
await step("取消红心即在线取消单曲收藏（行移出 + 本地落盘 + 上游 -1）", async () => {
  if (!pick?.mid) throw new Error("拿不到我喜欢第一首");
  await page.goto(`${BASE}/index.html#/liked`, { waitUntil: "domcontentloaded" });
  await waitRows();
  await sleep(1200);
  const r0 = await rows();
  if (r0.firstMid !== pick.mid) throw new Error(`首行 ${r0.firstMid} != 上游首曲 ${pick.mid}（顺序不一致，断言不可靠）`);
  if (!(await page.$(`.row[data-songkey="${pick.mid}"] .row-love.on`))) throw new Error("目标行红心未点亮");

  await page.click(`.row[data-songkey="${pick.mid}"] .row-love`);
  await page.waitForFunction(
    (mid) => !document.querySelector(`.row[data-songkey="${mid}"]`),
    { timeout: 30000 }, pick.mid,
  );
  const r1 = await rows();
  const s = await state();
  if (r1.n !== r0.n - 1) throw new Error(`行数未 -1：${r0.n} -> ${r1.n}`);
  if (s.size !== total0 - 1) throw new Error(`红心态未 -1：${s.size}`);
  if (s.ls !== s.size) throw new Error(`本地落盘未同步：${s.ls} != ${s.size}`);
  if (!r1.cnt.includes(String(total0 - 1))) throw new Error(`计数未 -1：${r1.cnt}`);
  // 上游回源（读侧有缓存，给足时间等它自己反映）
  const { up, lag } = await waitUpstream((u) => u.total === total0 - 1 && !u.mids.includes(pick.mid));
  if (up.total !== total0 - 1 || up.mids.includes(pick.mid)) {
    throw new Error(`上游未反映取消收藏（total=${up.total} / 仍含该曲=${up.mids.includes(pick.mid)}）`);
  }
  return `「${pick.name}」已移出（行 ${r0.n}→${r1.n}，本地 ${total0}→${s.size}，上游 ${lag}ms 后确认 ${up.total}）`;
});

// 4) 复原：重新收藏（在线 like）→ 上游与视图回到全亮
await step("取消后可重新收藏并恢复全亮（复原账号）", async () => {
  // 写接口 songType 语义：读接口 type=1（普通歌曲）在写接口要传 0，否则 QQ 静默丢弃
  //（retCode=0 但歌单没动）——见 ui/src/lib/api.ts writeSongType
  const writeType = (t) => (Number(t ?? 1) === 1 ? 0 : Number(t ?? 0));
  const like = (t) => page.evaluate(async (p) => {
    const r = await fetch("/api/song/like", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ song_id: p.id, song_type: p.t }),
    });
    return (await r.json()).code;
  }, { id: pick.id, t });
  let restored = false, lag = 0;
  for (const t of [writeType(pick.type), 1]) { // 主用正确值；万一类型特殊再兜一次原值
    if ((await like(t)) !== 0) continue;
    const r = await waitUpstream((u) => u.total === total0 && u.mids.includes(pick.mid), 45000);
    lag = r.lag;
    if (r.up.ok && r.up.total === total0 && r.up.mids.includes(pick.mid)) { restored = true; break; }
  }
  if (!restored) throw new Error("补回收藏未生效——账号可能少了一首，需人工确认");

  // 重进我喜欢（冷启动路径）：重新预载 → 依然全亮
  let r = null;
  for (let i = 0; i < 3; i++) {
    await page.goto(`${BASE}/index.html#/liked`, { waitUntil: "domcontentloaded" });
    await reloadLiked();
    r = await rows();
    if (r.n === total0 && r.on === r.n) break;
    await sleep(3000);
  }
  if (r.n !== total0) throw new Error(`复原后行数 ${r.n} != ${total0}`);
  if (r.on !== r.n) throw new Error(`复原后只有 ${r.on}/${r.n} 行亮`);
  return `上游 ${lag}ms 后复原 total=${total0}，重进我喜欢 ${r.on}/${r.n} 行全亮`;
});

// 5) 写接口失败：红心回滚、行留在列表（不假取消收藏）
await step("取消收藏写失败时回滚（红心复原、行不移出）", async () => {
  const target = pick.mid;
  await page.goto(`${BASE}/index.html#/liked`, { waitUntil: "domcontentloaded" });
  await reloadLiked();
  const r0 = await rows();
  mockUnlikeFail = true;
  try {
    await page.click(`.row[data-songkey="${target}"] .row-love`);
    await sleep(2000); // 等乐观熄灭 → 失败回滚
  } finally {
    mockUnlikeFail = false;
  }
  const r1 = await rows();
  const s = await state();
  const stillLit = await page.$(`.row[data-songkey="${target}"] .row-love.on`);
  const err = await page.evaluate(() => window.__quaverPlayer?.error ?? "");
  if (!stillLit) throw new Error("回滚后红心未复原（行内应仍为点亮态）");
  if (r1.n !== r0.n) throw new Error(`回滚后行数变了：${r0.n} -> ${r1.n}（不该移出）`);
  if (s.size !== total0 || s.ls !== s.size) throw new Error(`回滚后本地红心态不对：size=${s.size} ls=${s.ls}`);
  if (!err.includes("收藏失败")) throw new Error("未提示收藏失败：" + err);
  return `红心回滚点亮、行保留 ${r1.n} 行、提示「${err}」`;
});

await browser.close();
console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
