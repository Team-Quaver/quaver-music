// 「我喜欢」写后增量回源（远端同步）验证：
//   1) 红心写确认后触发**增量**回源：只打一枪 /user/liked?page=1&num=100 小窗，
//      不做整单分页重载（num=500）；本地缓存头部顺序/计数收敛到服务端
//   2) 打开中的我喜欢页即时跟进：播放条/别处点的红心，行在增量回源落定前就上屏（广播路径）
//   3) 别处取消收藏：打开中的页逐行淡出移除 + 计数 -1
//   4) 读侧滞后庇护：回源读到旧数据（刚写的 like 不可见）时，红心/行不被冲掉，限次重试后收敛
//   5) 复原：测试用歌曲全部移出我喜欢，上游 total 回到初始值
// 前置：已登录的 sidecar :3200（pnpm run app 拉起）+ dev server :5173 —— 打包态没有
//       __quaverPlayer 钩子，本脚本必须在 DEV 页面上跑（BASE 可覆盖）。
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const TMP = process.env.CHROME_TMP ?? "/home/ne0w0r1d/Desktop/quaver/.workbuddy/tmp/chrome-loved-sync";
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
// 只看结构与状态：挡掉图片/字体；统计 /user/liked 的分页请求（num=500=整单预载，num=100=增量小窗）；
// 另留一次性「读侧滞后」开关：把下一发 num=100 打成旧数据，验证滞后庇护（不碰真账号的写）
let likedStats = { n500: 0, n100: 0, n100DoneAt: [], other: 0 };
let staleArm = false, staleUsed = false, stalePayload = null;
await page.setRequestInterception(true);
page.on("request", (r) => {
  const t = r.resourceType();
  const u = new URL(r.url());
  if (u.pathname.endsWith("/user/liked")) {
    const num = Number(u.searchParams.get("num") ?? 0);
    if (num === 500) likedStats.n500++;
    else if (num === 100) {
      likedStats.n100++;
      likedStats.n100DoneAt.push(Date.now());
      if (staleArm) {
        staleArm = false; staleUsed = true;
        r.respond({ status: 200, contentType: "application/json",
          body: JSON.stringify({ code: 0, msg: "ok", data: stalePayload }) }).catch(() => {});
        return;
      }
    } else likedStats.other++;
  }
  if (t === "image" || t === "media" || t === "font") r.abort().catch(() => {});
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
    loved: [...(p?.loved ?? [])],
    cache: (p?.likedCache ?? []).map((s) => s.mid),
    total: p?.likedTotal ?? -1,
    listVersion: p?.lovedListVersion ?? -1,
    ls: JSON.parse(localStorage.getItem("quaver.loved.v1") ?? "null")?.length ?? -1,
  };
});
// 上游读侧有缓存：一次请求拿全（num 开大），只有 total 与实际条数自洽才算「可靠读数」
const readLiked = async () => {
  const d = (await api("/user/liked?page=1&num=1000"))?.data ?? {};
  const mids = (d.songs ?? []).map((s) => s.mid);
  return { total: d.total ?? 0, n: mids.length, mids, ok: (d.total ?? 0) === mids.length };
};
const waitUpstream = async (want, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const up = await readLiked();
    if (up.ok && want(up)) return { up, lag: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { up, lag: Date.now() - t0 };
    await sleep(2000);
  }
};
const rows = () => page.evaluate(() => ({
  n: document.querySelectorAll(".rows .row").length,
  cnt: document.querySelector(".page-title .cnt")?.textContent?.trim() ?? "",
}));
const rowPresent = (mid) => page.evaluate(
  (m) => !!document.querySelector(`.rows .row[data-songkey="${m}"]`), mid,
);
const waitRows = () => page.waitForFunction(
  () => document.querySelectorAll(".rows .row").length > 0, { timeout: 60000 },
);
/** 等条件成立，返回耗时；超时返回 -1（gap：轮询间隔——打上游的用 2s，别把读侧缓存打爆） */
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

// 0) 开机预载 + 基线：上游 total/序、清掉上次中断残留的测试歌、挑两首「不在我喜欢」的歌
await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window.__quaverPlayer?.likedCache?.length ?? 0) >= 0 && window.__quaverPlayer, { timeout: 90000 });
await page.waitForFunction(() => !!window.__quaverPlayer?.likedAt, { timeout: 90000 }); // 预载完成
const writeType = (t) => (Number(t ?? 1) === 1 ? 0 : Number(t ?? 0));
// 残留自清理：上次运行若中途挂掉，测试歌可能留在我喜欢 —— 写接口逐个移出并等上游反映
const leftovers = await page.evaluate(() => JSON.parse(localStorage.getItem("quaver.loved-sync.test") ?? "[]"));
await page.evaluate(() => localStorage.setItem("quaver.loved-sync.test", "[]"));
for (const s of leftovers) {
  const up = await readLiked();
  if (!up.mids.includes(s.mid)) continue;
  const done = await page.evaluate(async (p) => {
    const r = await fetch("/api/song/unlike", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ song_id: p.id, song_type: p.t }) });
    return (await r.json()).code;
  }, { id: s.id, t: writeType(s.type) });
  if (done !== 0) { fails++; console.log(`FAIL 残留清理：${s.name} 取消未接受`); continue; }
  const { up: after } = await waitUpstream((u) => !u.mids.includes(s.mid), 45000);
  if (after.mids.includes(s.mid)) { fails++; console.log(`FAIL 残留清理：${s.name} 仍在我喜欢，需人工处理`); }
  else console.log(`PASS 残留清理 — 「${s.name}」已移出`);
}
// 清理动的是上游：重载一份与上游一致的本地状态，再取基线
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__quaverPlayer?.likedAt, { timeout: 90000 });
const up0 = await readLiked();
if (!up0.ok) { console.log(`FAIL 基线：上游读数不可靠（total=${up0.total} 实际=${up0.n}）`); await browser.close(); process.exit(1); }
const total0 = up0.total;
stalePayload = (await api("/user/liked?page=1&num=100"))?.data ?? null; // 供滞后庇护回放旧数据
const pickFrom = async () => {
  const d = (await api("/recommend/daily?page=1&num=100"))?.data ?? {};
  return (d.songs ?? []).filter((s) => s?.mid && s?.id && !up0.mids.includes(s.mid));
};
let pool = await pickFrom();
if (pool.length < 2) {
  const d = (await api("/search?keyword=海阔天空&type=0&page=1&num=30"))?.data ?? {};
  pool = pool.concat((d?.songs ?? d?.list ?? []).filter((s) => s?.mid && s?.id && !up0.mids.includes(s.mid)));
}
const [pick, pick2] = pool;
if (!pick || !pick2) { console.log("FAIL 基线：挑不到两首不在我喜欢、可写入的歌"); await browser.close(); process.exit(1); }
// 登记本轮测试歌：中途挂掉的话，下次运行按这份名单清理
await page.evaluate((list) => localStorage.setItem("quaver.loved-sync.test", JSON.stringify(list)),
  [pick, pick2].map((s) => ({ mid: s.mid, id: s.id, type: s.type, name: s.name })));

// 1) 红心写确认 → 增量回源（单枪 num=100，无整单重载），缓存收敛到服务端
let n100AtStart = likedStats.n100, n500AtStart = likedStats.n500;
await step("红心写确认后触发增量回源（num=100 一枪，无整单重载）", async () => {
  const fin = await page.evaluate((s) => window.__quaverPlayer.toggleLove(s), pick);
  if (fin !== true) throw new Error(`toggleLove 终态=${fin}，应为 true`);
  const opt = await state();
  if (!opt.loved.includes(pick.mid)) throw new Error("乐观阶段红心未亮");
  if (opt.cache[0] !== pick.mid) throw new Error(`乐观阶段未插到列表头：${opt.cache[0]}`);
  const conv = await waitFor(async () => {
    if (likedStats.n100 === n100AtStart) return false; // 2s 去抖：等增量回源真的发出去
    const up = await readLiked();
    if (!up.ok || up.total !== total0 + 1 || !up.mids.includes(pick.mid)) return false;
    const s = await state();
    return s.loved.includes(pick.mid) && s.total === up.total
      && s.cache.slice(0, 10).join() === up.mids.slice(0, 10).join();
  }, 40000, 2000);
  if (conv < 0) {
    const up = await readLiked(); const s = await state();
    throw new Error(`40s 未收敛：上游 total=${up.total} 本地 total=${s.total} 本地头部=${s.cache[0]}`);
  }
  if (likedStats.n100 === n100AtStart) throw new Error("增量回源没打出去（num=100 请求数未变）");
  if (likedStats.n500 !== n500AtStart) throw new Error("打了整单分页重载（num=500），不是增量");
  const s = await state();
  if (s.ls !== s.loved.length) throw new Error(`本地落盘未同步：${s.ls} != ${s.loved.length}`);
  return `收敛 ${conv}ms，窗口请求 ${likedStats.n100 - n100AtStart} 发，头部与上游一致`;
});

// 2) 打开中的我喜欢页即时跟进：广播路径先于增量回源把行画出来
await step("播放条收藏 → 打开中的我喜欢页即时上屏（不等回源）", async () => {
  await page.goto(`${BASE}/index.html#/liked`, { waitUntil: "domcontentloaded" });
  await waitRows(); await sleep(800);
    // 重载后整单预载可能拿到写之前的旧快照：庇护补红心，行由进页增量回源补齐（≤8s）
  const pickRowAt = await waitFor(() => rowPresent(pick.mid), 8000, 500);
  if (pickRowAt < 0) throw new Error("我喜欢页缺刚收藏的歌（8s 内未出现）");
  const t0 = Date.now();
  await page.evaluate((s) => window.__quaverPlayer.toggleLove(s), pick2);
  const at = await waitFor(() => rowPresent(pick2.mid), 2500);
  if (at < 0) throw new Error("2.5s 内行未上屏");
  const syncDoneAt = likedStats.n100DoneAt.at(-1) ?? Infinity;
  if (t0 + at < syncDoneAt) console.log(`  （行上屏 ${at}ms，早于最近一次回源发出 —— 走的广播路径）`);
  const cntOk = await waitFor(async () => (await rows()).cnt.includes(String(total0 + 2)), 10000, 500);
  if (cntOk < 0) throw new Error(`计数未到 ${total0 + 2}：${(await rows()).cnt}`);
  return `行上屏 ${at}ms，计数「${(await rows()).cnt}」`;
});

// 3) 别处取消收藏 → 打开中的页逐行淡出移除
await step("别处取消收藏 → 打开中的页逐行淡出移除", async () => {
  const t0 = Date.now();
  const fin = await page.evaluate((s) => window.__quaverPlayer.toggleLove(s), pick2);
  if (fin !== false) throw new Error(`toggleLove 终态=${fin}，应为 false`);
  const at = await waitFor(() => page.evaluate(
    (m) => !document.querySelector(`.rows .row[data-songkey="${m}"]`), pick2.mid,
  ), 3000);
  if (at < 0) throw new Error("3s 内行未移出");
  const r = await rows();
  if (!r.cnt.includes(String(total0 + 1))) throw new Error(`计数未回落：${r.cnt}`);
  const s = await state();
  if (s.loved.includes(pick2.mid) || s.cache.includes(pick2.mid)) throw new Error("本地状态未移除");
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
  return `行移出 ${at}ms，计数「${r.cnt}」，双击首行命中自身（序号已重排）`;
});

// 4) 读侧滞后庇护：回源读到旧数据（like 不可见）时红心/行不被冲掉，重试后收敛
await step("读侧滞后：旧读数不冲掉刚点的红心，重试后收敛", async () => {
  if (!stalePayload) throw new Error("拿不到基线页快照，无法回放旧数据");
  staleArm = true; staleUsed = false;
  const fin = await page.evaluate((s) => window.__quaverPlayer.toggleLove(s), pick2);
  if (fin !== true) throw new Error(`toggleLove 终态=${fin}，应为 true`);
  // 等被打桩的那次回源发生并处理完（2s 去抖 + 请求往返 + 重绘）
  const used = await waitFor(() => staleUsed, 8000);
  if (used < 0) throw new Error("打桩的增量回源没发生");
  await sleep(1200);
  const s = await state();
  if (!s.loved.includes(pick2.mid)) throw new Error("旧读数把红心冲掉了（滞后庇护失效）");
  if (!s.cache.includes(pick2.mid)) throw new Error("旧读数把行冲掉了（滞后庇护失效）");
  if (s.total !== total0 + 2) throw new Error(`旧读数把计数冲掉了：${s.total} != ${total0 + 2}`);
  const conv = await waitFor(async () => {
    const up = await readLiked();
    if (!up.ok || up.total !== total0 + 2 || !up.mids.includes(pick2.mid)) return false;
    const st = await state();
    return st.loved.includes(pick2.mid) && st.total === up.total;
  }, 40000, 2000);
  if (conv < 0) {
    const up = await readLiked(); const st = await state();
    throw new Error(`重试未收敛：上游 total=${up.total} 本地 total=${st.total}`);
  }
  if (!(await rowPresent(pick2.mid))) {
    await page.goto(`${BASE}/index.html#/liked`, { waitUntil: "domcontentloaded" });
    await waitRows();
  }
  if (!(await rowPresent(pick2.mid))) throw new Error("收敛后我喜欢页缺该行");
  return `庇护生效（红心/行/计数保留），${conv}ms 后重试收敛`;
});

// 5) 复原：把测试歌曲移出我喜欢（本地在就走 toggle 验证完整联动；否则直写接口），上游回到初始值
await step("复原：移出测试歌曲，上游回到初始 total", async () => {
  for (const s of [pick2, pick]) {
    const wasLoved = await page.evaluate((m) => window.__quaverPlayer.loved.has(m), s.mid);
    if (wasLoved) {
      const fin = await page.evaluate((x) => window.__quaverPlayer.toggleLove(x), s);
      if (fin !== false) throw new Error(`取消收藏终态=${fin}（${s.name}）`);
    } else {
      // 本地红心已不在（庇护快照异常的兜底）：清掉庇护记录再直写接口，防止增量回源把它加回来
      const code = await page.evaluate(async (p) => {
        const t = Number(p.type ?? 1) === 1 ? 0 : Number(p.type ?? 0);
        const r = await fetch("/api/song/unlike", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ song_id: p.id, song_type: t }) });
        return (await r.json()).code;
      }, s);
      if (code !== 0) throw new Error(`取消收藏未接受（${s.name}）`);
      await page.evaluate((m) => window.__quaverPlayer.recentWrites.delete(m), s.mid);
    }
  }
  const { up, lag } = await waitUpstream((u) => u.total === total0 && !u.mids.includes(pick.mid) && !u.mids.includes(pick2.mid));
  if (up.total !== total0) throw new Error(`上游未复原：total=${up.total}（期望 ${total0}）——需人工检查「${pick.name}」「${pick2.name}」`);
  await page.evaluate(() => window.__quaverPlayer.syncLovedSoon()); // 直写路径没有触发回源，手动排一次
  const loc = await waitFor(async () => {
    const st = await state();
    return !st.loved.includes(pick.mid) && !st.loved.includes(pick2.mid) && st.total === total0;
  }, 30000, 2000);
  if (loc < 0) {
    const st = await state();
    throw new Error(`本地未跟随：loved=${st.loved.length} total=${st.total}（上游 ${up.total}）`);
  }
  const st2 = await state();
  if (st2.ls !== st2.loved.length) throw new Error("本地落盘未同步");
  await page.evaluate(() => localStorage.removeItem("quaver.loved-sync.test"));
  return `上游 ${lag}ms 后回到 total=${total0}，本地 ${loc}ms 后跟随`;
});

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
await browser.close();
process.exit(fails ? 1 : 0);
