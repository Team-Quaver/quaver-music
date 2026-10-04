// 「歌单」写后增量回源（远端同步）验证（与 verify-loved-sync 同一套路，落到自建歌单上）：
//   1) 加入歌单写确认后触发增量回源：单请求 /songlist/{tid}/detail 首页窗口对账（新加入的歌在头部，
//      整单缓存头部与上游一致；对 >100 首的歌单，整单重载会多出 page≥2 请求，本脚本一并盯着）
//   2) 打开中的歌单页即时跟进：别处/同页加入的歌，行在回源落定前就上屏（广播路径）
//   3) 同页删除 → 行淡出 + 序号重排，双击首行命中自身（DOM 真相源）
//   4) 读侧滞后庇护：回源读到旧数据（刚加的歌不可见）时行/计数不被冲掉，限次重试后收敛
//   5) 复原：移出测试歌，上游 total 回到初始值
// 前置：已登录的 sidecar（pnpm run app 拉起）+ dev server（BASE，默认 [::1]:5173）——
//       打包态没有 __quaverSonglists/__quaverPlayer 钩子。
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://[::1]:5173";
const TMP = process.env.CHROME_TMP ?? "/home/ne0w0r1d/Desktop/quaver/.workbuddy/tmp/chrome-songlist-sync";
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
// 挡图片/字体；统计目标歌单 detail 请求（page≥2 只会出现在整单回源里，窗口回源只打 page=1）；
// 留一次性「读侧滞后」开关：把下一发首页窗口打成旧数据，验证庇护（不碰真账号的写）
let PLTID = "";
let stats = { detailP1: 0, detailP2: 0, p1DoneAt: [] };
let staleArm = false, staleUsed = false, stalePayload = null;
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = new URL(r.url());
  const m = /\/api\/songlist\/(\d+)\/detail$/.exec(u.pathname);
  if (m && m[1] === PLTID) {
    const pg = Number(u.searchParams.get("page") ?? 1);
    if (pg >= 2) stats.detailP2++;
    else if (Number(u.searchParams.get("num")) === 100) {
      stats.detailP1++;
      stats.p1DoneAt.push(Date.now());
      if (staleArm) {
        staleArm = false; staleUsed = true;
        r.respond({ status: 200, contentType: "application/json",
          body: JSON.stringify({ code: 0, msg: "ok", data: stalePayload }) }).catch(() => {});
        return;
      }
    }
  }
  const t = r.resourceType();
  if (t === "image" || t === "media" || t === "font") r.abort().catch(() => {});
  else r.continue().catch(() => {});
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.log("[console.error]", m.text());
});

const api = (path) => page.evaluate(async (p) => (await fetch("/api" + p)).json(), path);
/** 上游可靠读数（单请求拿全；total 与条数自洽才算可靠） */
const readDetail = async () => {
  const d = (await api(`/songlist/${PLTID}/detail?page=1&num=1000`))?.data ?? {};
  const mids = (d.songs ?? []).map((s) => s.mid);
  return { total: d.total ?? 0, n: mids.length, mids, ok: (d.total ?? 0) === mids.length };
};
const waitUpstream = async (want, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const up = await readDetail();
    if (up.ok && want(up)) return { up, lag: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { up, lag: Date.now() - t0 };
    await sleep(2000);
  }
};
const cacheState = () => page.evaluate((tid) => {
  const d = window.__quaverSonglists?.getCachedSonglist?.(tid) ?? null;
  return d ? { head: d.songs.slice(0, 10).map((s) => s.mid), n: d.songs.length, total: d.total } : null;
}, PLTID);
const rows = () => page.evaluate(() => ({
  n: document.querySelectorAll(".rows .row").length,
  cnt: document.querySelector(".pl-meta")?.textContent?.trim() ?? "",
}));
const rowPresent = (mid) => page.evaluate(
  (m) => !!document.querySelector(`.rows .row[data-songkey="${m}"]`), mid,
);
const waitRows = () => page.waitForFunction(
  () => document.querySelectorAll(".rows .row").length > 0, { timeout: 60000 },
);
const waitFor = async (fn, ms, gap = 150) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await sleep(gap);
  }
};

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

// 0) 环境 + 基线：等登录、清理上次中断残留、挑自有歌单与两首测试歌
await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__quaverPlayer?.likedAt && !!window.__quaverSonglists, { timeout: 90000 });
const writeType = (t) => (Number(t ?? 1) === 1 ? 0 : Number(t ?? 0));
// 残留自清理：上次运行若中途挂掉，测试歌可能留在歌单里 —— 直写接口逐个移出并等上游反映
const leftovers = await page.evaluate(() => JSON.parse(localStorage.getItem("quaver.songlist-sync.test") ?? "[]"));
for (const s of leftovers) {
  PLTID = String(s.tid);
  const done = await page.evaluate(async (p) => {
    const r = await fetch(`/api/songlist/${p.dirid}/songs`, { method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ song_id: p.song_id, song_type: p.song_type, tid: p.tid }) });
    return (await r.json()).code;
  }, s);
  if (done !== 0) { fails++; console.log(`FAIL 残留清理：${s.name} 取消未接受`); continue; }
  const { up } = await waitUpstream((u) => !u.mids.includes(s.mid), 45000);
  if (up.mids.includes(s.mid)) { fails++; console.log(`FAIL 残留清理：${s.name} 仍在歌单，需人工处理`); }
  else console.log(`PASS 残留清理 — 「${s.name}」已移出「${s.plTitle}」`);
}
const lists = ((await api("/user/created-songlists"))?.data?.playlists ?? [])
  .map((p) => ({ id: Number(p.id), dirid: Number(p.dirid), title: String(p.title ?? "歌单") }))
  .filter((p) => p.dirid > 0 && p.dirid !== 201);
const pl = lists[0];
if (!pl) { console.log("FAIL 基线：账号没有可写的自建歌单"); await browser.close(); process.exit(1); }
PLTID = String(pl.id);
const up0 = await readDetail();
if (!up0.ok || up0.n < 3) { console.log(`FAIL 基线：上游读数不可靠（total=${up0.total} n=${up0.n}，且至少要 3 首才好验证重排）`); await browser.close(); process.exit(1); }
const total0 = up0.total;
stalePayload = (await api(`/songlist/${PLTID}/detail?page=1&num=100`))?.data ?? null;
const d0 = (await api("/recommend/daily?page=1&num=100"))?.data ?? {};
const pool = (d0.songs ?? []).filter((s) => s?.mid && s?.id && !up0.mids.includes(s.mid));
const [pick, pick2] = pool;
if (!pick || !pick2) { console.log("FAIL 基线：挑不到两首不在歌单里的歌"); await browser.close(); process.exit(1); }
await page.evaluate((list) => localStorage.setItem("quaver.songlist-sync.test", JSON.stringify(list)),
  [pick, pick2].map((s) => ({ tid: pl.id, dirid: pl.dirid, plTitle: pl.title, mid: s.mid, song_id: s.id, song_type: writeType(s.type), name: s.name })));

// 1) 打开歌单页建立缓存 → 回首页 → 加入歌单：写确认后乐观进缓存头部，增量回源收敛到上游
let p1AtStart = 0, p2AtStart = 0;
await step("加入歌单写确认后触发增量回源（首页窗口，无整单重载）", async () => {
  await page.goto(`${BASE}/index.html#/playlist?id=${pl.id}&name=${encodeURIComponent(pl.title)}`, { waitUntil: "domcontentloaded" });
  await waitRows(); await sleep(800);
  if (!(await rowPresent(up0.mids[0]))) throw new Error("歌单页首行缺失");
  await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
  await sleep(500);
  p1AtStart = stats.detailP1; p2AtStart = stats.detailP2;
  const fin = await page.evaluate(async (x) => {
    const pl = window.__quaverSonglists.mySonglists().find((p) => p.dirid === x.dirid) ?? x;
    await window.__quaverSonglists.addSongToSonglist(pl, x.song);
    return true;
  }, { dirid: pl.dirid, id: pl.id, title: pl.title, song: pick });
  if (!fin) throw new Error("加入歌单未成功");
  const opt = await cacheState();
  if (!opt) throw new Error("缓存没有建立");
  if (opt.head[0] !== pick.mid) throw new Error(`乐观阶段未插到列表头：${opt.head[0]}`);
  if (opt.total !== total0 + 1) throw new Error(`乐观计数未 +1：${opt.total}`);
  const conv = await waitFor(async () => {
    if (stats.detailP1 === p1AtStart) return false; // 2s 去抖：等增量回源真的发出去
    const up = await readDetail();
    if (!up.ok || up.total !== total0 + 1 || !up.mids.includes(pick.mid)) return false;
    const c = await cacheState();
    return c && c.total === up.total && c.head.slice(0, 5).join() === up.mids.slice(0, 5).join();
  }, 40000, 2000);
  if (conv < 0) {
    const up = await readDetail(); const c = await cacheState();
    throw new Error(`40s 未收敛：上游 total=${up.total} 缓存 total=${c?.total} 缓存头=${c?.head[0]}`);
  }
  if (stats.detailP2 !== p2AtStart) throw new Error("出现了 page≥2 的整单回源请求，不是增量窗口");
  return `收敛 ${conv}ms，窗口请求 ${stats.detailP1 - p1AtStart} 发，头部与上游一致`;
});

// 2) 打开中的歌单页即时跟进：同页再加一首，行在回源落定前就上屏
await step("加入歌单 → 打开中的歌单页即时上屏（不等回源）", async () => {
  await page.goto(`${BASE}/index.html#/playlist?id=${pl.id}&name=${encodeURIComponent(pl.title)}`, { waitUntil: "domcontentloaded" });
  await waitRows(); await sleep(800);
  if (!(await rowPresent(pick.mid))) throw new Error("歌单页缺刚加入的歌");
  const t0 = Date.now();
  await page.evaluate(async (x) => {
    const pl = window.__quaverSonglists.mySonglists().find((p) => p.dirid === x.dirid) ?? x;
    await window.__quaverSonglists.addSongToSonglist(pl, x.song);
  }, { dirid: pl.dirid, id: pl.id, title: pl.title, song: pick2 });
  const at = await waitFor(() => rowPresent(pick2.mid), 2500);
  if (at < 0) throw new Error("2.5s 内行未上屏");
  const syncDoneAt = stats.p1DoneAt.at(-1) ?? Infinity;
  if (t0 + at < syncDoneAt) console.log(`  （行上屏 ${at}ms，早于最近一次回源发出 —— 走的广播路径）`);
  return `行上屏 ${at}ms`;
});

// 3) 同页删除：行淡出 + 序号重排，双击首行命中自身
await step("从歌单删除 → 行淡出移除 + 序号重排 + 双击命中当前行", async () => {
  const fin = await page.evaluate(async (x) => {
    const pl = window.__quaverSonglists.mySonglists().find((p) => p.dirid === x.dirid) ?? x;
    await window.__quaverSonglists.removeSongFromSonglist(pl, x.song);
    return true;
  }, { dirid: pl.dirid, tid: pl.id, song: pick2 });
  if (!fin) throw new Error("删除未成功");
  const at = await waitFor(() => page.evaluate(
    (m) => !document.querySelector(`.rows .row[data-songkey="${m}"]`), pick2.mid,
  ), 3000);
  if (at < 0) throw new Error("3s 内行未移出");
  // 删除重排后双击：序号/列表以当时 DOM 为准 —— 双击第 1 行必须播第 1 行这首歌（不真放流，只抓参数）
  const played = await page.evaluate(() => new Promise((resolve) => {
    const pl = window.__quaverPlayer;
    const orig = pl.playList.bind(pl);
    pl.playList = (all, i) => {
      pl.playList = orig;
      const firstRow = document.querySelector(".rows .row[data-songkey]");
      resolve({ want: firstRow?.dataset.songkey, got: all?.[Number(i)]?.mid,
        label: firstRow?.querySelector(".idx")?.textContent?.trim() });
    };
    document.querySelector(".rows .row")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    setTimeout(() => resolve({ want: null, got: null, label: null }), 3000);
  }));
  if (!played.want || played.want !== played.got) throw new Error(`双击错位：want=${played.want} got=${played.got}`);
  if (played.label !== "1") throw new Error(`首行序号未重排：${played.label}`);
  const c = await cacheState();
  if (!c || c.total !== total0 + 1) throw new Error(`缓存计数未回落：${c?.total}`);
  return `行移出 ${at}ms，双击首行命中自身（序号已重排）`;
});

// 4) 读侧滞后庇护：回源读到旧数据（刚加的歌不可见）时行/计数不被冲掉，重试后收敛
await step("读侧滞后：旧读数不冲掉刚加入的行，重试后收敛", async () => {
  if (!stalePayload) throw new Error("拿不到基线页快照，无法回放旧数据");
  staleArm = true; staleUsed = false;
  await page.evaluate(async (x) => {
    const pl = window.__quaverSonglists.mySonglists().find((p) => p.dirid === x.dirid) ?? x;
    await window.__quaverSonglists.addSongToSonglist(pl, x.song);
  }, { dirid: pl.dirid, id: pl.id, title: pl.title, song: pick2 });
  const used = await waitFor(() => staleUsed, 8000);
  if (used < 0) throw new Error("打桩的增量回源没发生");
  await sleep(1200);
  const c = await cacheState();
  if (!c || !c.head.includes(pick2.mid)) throw new Error("旧读数把刚加的行冲掉了（滞后庇护失效）");
  if (c.total !== total0 + 2) throw new Error(`旧读数把计数冲掉了：${c.total} != ${total0 + 2}`);
  const conv = await waitFor(async () => {
    const up = await readDetail();
    if (!up.ok || up.total !== total0 + 2 || !up.mids.includes(pick2.mid)) return false;
    const st = await cacheState();
    return st && st.total === up.total && st.head.includes(pick2.mid);
  }, 40000, 2000);
  if (conv < 0) {
    const up = await readDetail(); const st = await cacheState();
    throw new Error(`重试未收敛：上游 total=${up.total} 缓存 total=${st?.total}`);
  }
  if (!(await rowPresent(pick2.mid))) {
    await page.goto(`${BASE}/index.html#/playlist?id=${pl.id}&name=${encodeURIComponent(pl.title)}`, { waitUntil: "domcontentloaded" });
    await waitRows();
  }
  if (!(await rowPresent(pick2.mid))) throw new Error("收敛后歌单页缺该行");
  return `庇护生效（行/计数保留），${conv}ms 后重试收敛`;
});

// 5) 复原：移出测试歌，上游回到初始值
await step("复原：移出测试歌曲，上游回到初始 total", async () => {
  for (const s of [pick2, pick]) {
    await page.evaluate(async (x) => {
      const pl = window.__quaverSonglists.mySonglists().find((p) => p.dirid === x.dirid) ?? x;
      await window.__quaverSonglists.removeSongFromSonglist({ dirid: x.dirid, tid: x.tid }, x.song);
    }, { dirid: pl.dirid, tid: pl.id, song: s });
  }
  const { up, lag } = await waitUpstream((u) => u.total === total0 && !u.mids.includes(pick.mid) && !u.mids.includes(pick2.mid));
  if (up.total !== total0) throw new Error(`上游未复原：total=${up.total}（期望 ${total0}）——需人工检查「${pl.title}」里的「${pick.name}」「${pick2.name}」`);
  const conv = await waitFor(async () => {
    const c = await cacheState();
    return c && c.total === total0 && !c.head.includes(pick.mid) && !c.head.includes(pick2.mid);
  }, 30000, 2000);
  if (conv < 0) throw new Error("本地缓存未跟随复原");
  await page.evaluate(() => localStorage.removeItem("quaver.songlist-sync.test"));
  return `上游 ${lag}ms 后回到 total=${total0}，本地 ${conv}ms 后跟随`;
});

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
await browser.close();
process.exit(fails ? 1 : 0);
