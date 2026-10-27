// 一次性探针：歌曲行委托监听 + markActive 分域高亮（dev server 5199，无需登录）
import puppeteer from "puppeteer-core";

const BASE = "http://[::1]:5199";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server", "--autoplay-policy=no-user-gesture-required"],
});

const page = await browser.newPage();

await page.setViewport({ width: 1280, height: 840 });

const errors: string[] = [];

page.on("pageerror", (e) => errors.push(String(e)));

let fails = 0;

const step = async (name: string, fn: () => Promise<string | void>) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
};

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1000);

// 监听器计数探针：在任何渲染之前包住 addEventListener，数出「挂在行上」与「挂在容器上」的监听数
await page.evaluate(() => {
  const w = window as any;

  w.__lw = { row: 0, box: 0, other: 0 };

  const orig = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function (this: any, type: string, fn: any, opts?: any) {
    const cl = this instanceof Element ? this.classList : null;

    if (cl?.contains("row")) w.__lw.row++;
    else if (cl?.contains("rows")) w.__lw.box++;
    else w.__lw.other++;

    return orig.call(this, type, fn, opts);
  };
});

// 造 400 首歌，渲染进一个离屏容器（走真实 renderSongRows）
const setup = await page.evaluate(async () => {
  const m = await import("/src/lib/songs.ts");
  (window as any).__songs = m;
  const box = document.createElement("div");

  box.className = "rows";
  document.body.append(box);
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
    mid: `mid${i}`, id: 1000 + i, title: `曲名${i}`, interval: 200 + i,
    singer: [{ mid: `sm${i}`, name: `歌手${i}` }], album: { mid: `am${i}`, name: `专辑${i}` },
  }));

  (window as any).__mk = mk;
  (window as any).__box = box;
  (window as any).__calls = [] as string[];

  const hooks = {
    showAlbum: true,
    onPlay: (s: any, index: number, all: any[]) => (window as any).__calls.push(`play:${s.mid}:${index}:${all.length}`),
    onLove: (s: any, loved: boolean) => (window as any).__calls.push(`love:${s.mid}:${loved}`),
  };

  (window as any).__hooks = hooks;
  m.renderSongRows(box, mk(400), hooks);

  return { rows: box.querySelectorAll(".row").length };
});

await step("400 行渲染完成", async () => `rows=${setup.rows}`);

await step("逐行监听只剩右键菜单 1 个（委托生效）", async () => {
  const lw = await page.evaluate(() => (window as any).__lw as { row: number; box: number; other: number });

  // 400 行 × 1 个 contextmenu（bindSongMenu 契约要求挂在行上）+ 容器 2 个（click/dblclick）
  if (lw.row > 400) throw new Error(`行上挂了 ${lw.row} 个监听（应 ≤400：只剩 contextmenu）`);
  if (lw.box < 2) throw new Error(`容器上没有委托监听：box=${lw.box}`);

  return `行监听=${lw.row}（≤400，每行至多 1 个）容器监听=${lw.box}`;
});

// —— 单击：选中 + prefetch ——
await step("单击第 3 行 → 该行 .sel，其它行不带 .sel", async () => {
  await page.evaluate(() => {
    const row = (window as any).__box.querySelectorAll(".row")[2] as HTMLElement;
    row.querySelector(".rmeta")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const r = await page.evaluate(() => {
    const box = (window as any).__box as HTMLElement;

    return { sel: [...box.querySelectorAll(".row.sel")].length, idx: [...box.children].indexOf(box.querySelector(".row.sel")!) };
  });

  if (r.sel !== 1 || r.idx !== 2) throw new Error(JSON.stringify(r));

  return `sel=1 idx=${r.idx}`;
});

// —— 双击：序号与整列以当时 DOM 为准（删过一行后不错位）——
await step("双击第 5 行 → onPlay 收到当时的序号与整列", async () => {
  await page.evaluate(() => {
    (window as any).__calls = [];
    const row = (window as any).__box.querySelectorAll(".row")[4] as HTMLElement;
    row.querySelector(".rmeta")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const calls = await page.evaluate(() => (window as any).__calls as string[]);

  const parts = calls[0]?.split(":") ?? [];

  if (calls.length !== 1) throw new Error("calls=" + JSON.stringify(calls));
  if (parts[1] !== "mid4" || parts[2] !== "4" || parts[3] !== "400") throw new Error(calls[0]);

  return calls[0];
});

await step("删掉首行后再双击 → 序号按当时 DOM（不错位）", async () => {
  await page.evaluate(() => {
    const box = (window as any).__box as HTMLElement;

    box.querySelector(".row")!.remove();
    (window as any).__calls = [];
    // 现在 DOM 的第 5 行是 mid4 之后那一首（mid5）
    (box.querySelectorAll(".row")[4] as HTMLElement).querySelector(".rmeta")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const calls = await page.evaluate(() => (window as any).__calls as string[]);
  const parts = calls[0]?.split(":") ?? [];

  if (parts[1] !== "mid5" || parts[2] !== "4" || parts[3] !== "399") throw new Error(JSON.stringify(calls));

  return calls[0];
});

// —— 红心：不冒泡选中，走 onLove ——
await step("点红心 → 走收藏回调，且不把行选中", async () => {
  const r = await page.evaluate(async () => {
    const w = window as any;

    w.__calls = [];

    const box = w.__box as HTMLElement;

    box.querySelectorAll(".row.sel").forEach((x) => x.classList.remove("sel"));

    const row = box.querySelectorAll(".row")[2] as HTMLElement;
    const btn = row.querySelector("[data-love]") as HTMLElement;
    const key = row.dataset.songkey;

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // 收藏是异步的（乐观改态 → 写接口 → 终态回调）：等 onLove 落地再判
    for (let i = 0; i < 60 && !w.__calls.length; i++) await new Promise((res) => setTimeout(res, 50));

    return { calls: w.__calls as string[], sel: box.querySelectorAll(".row.sel").length, key };
  });

  if (r.sel !== 0) throw new Error(`红心点击把行选中了: ${JSON.stringify(r)}`);
  if (!r.calls.some((c) => c.startsWith(`love:${r.key}:`))) throw new Error(`onLove 未按该行触发: ${JSON.stringify(r.calls)}`);

  return `${r.key} → ${JSON.stringify(r.calls)}`;
});

// —— 歌手/专辑行内链：跳路由，不选中、不起播 ——
await step("点行内歌手链 → 走路由跳转（不选中/不播）", async () => {
  await page.evaluate(() => {
    (window as any).__calls = [];
    location.hash = "#/";
    const box = (window as any).__box as HTMLElement;
    const row = box.querySelectorAll(".row")[1] as HTMLElement;
    const a = row.querySelector('[data-link^="singer:"]') as HTMLElement;

    a.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const r = await page.evaluate(() => ({
    hash: location.hash,
    sel: (window as any).__box.querySelectorAll(".row.sel").length,
  }));

  if (!r.hash.startsWith("#/singer?mid=")) throw new Error("hash=" + r.hash);
  if (r.sel) throw new Error("跳链同时把行选中了: " + JSON.stringify(r));

  return r.hash;
});

// —— markActive 分域 ——
await step("markActive：高亮跟着当前曲走，旧高亮被清干净", async () => {
  const r = await page.evaluate(() => {
    const player = (window as any).__quaverPlayer;
    const box = (window as any).__box as HTMLElement;
    const setCurrent = (mid: string) => { player.queue = [{ mid }]; player.index = 0; };

    setCurrent("mid7");
    player.markActive();
    const first = [...box.querySelectorAll(".row.playing")].map((e) => e.dataset.songkey);

    setCurrent("mid9");
    player.markActive();
    const second = [...box.querySelectorAll(".row.playing")].map((e) => e.dataset.songkey);

    setCurrent("");
    player.markActive();
    const none = box.querySelectorAll(".row.playing").length;

    return { first, second, none };
  });

  if (r.first.join() !== "mid7") throw new Error("首次高亮不对: " + JSON.stringify(r));
  if (r.second.join() !== "mid9") throw new Error("换曲后没跟着走: " + JSON.stringify(r));
  if (r.none !== 0) throw new Error("无当前曲时残留高亮: " + r.none);

  return `${r.first} → ${r.second} → 空`;
});

await step("markActive：同曲在多个列表里都点亮", async () => {
  const r = await page.evaluate(() => {
    const m = (window as any).__songs; const w = window as any; const player = w.__quaverPlayer;
    const box2 = document.createElement("div");

    box2.className = "rows";
    document.body.append(box2);
    m.renderSongRows(box2, w.__mk(20), w.__hooks); // 第二个列表（另一个视图的容器）
    player.queue = [{ mid: "mid3" }]; player.index = 0;
    player.markActive();

    const a = [...w.__box.querySelectorAll(".row.playing")].map((e) => e.dataset.songkey);
    const b = [...box2.querySelectorAll(".row.playing")].map((e) => e.dataset.songkey);

    box2.remove();
    m.renderSongRows(w.__box, w.__mk(400), w.__hooks); // 复原主列表
    player.markActive();

    return { a, b, after: [...w.__box.querySelectorAll(".row.playing")].length };
  });

  if (r.a.join() !== "mid3" || r.b.join() !== "mid3") throw new Error(JSON.stringify(r));

  return `两列表各命中一处；重画后仍命中 ${r.after} 处`;
});

await step("markActive：同一首重复出现时两处都点亮", async () => {
  const r = await page.evaluate(() => {
    const m = (window as any).__songs; const w = window as any; const player = w.__quaverPlayer;
    const box = w.__box as HTMLElement;
    const dup = w.__mk(12); dup.push({ ...dup[2] }); // 同一个 mid 第二次出现（歌单顺序表允许）
    m.renderSongRows(box, dup, w.__hooks);
    player.queue = [{ mid: "mid2" }]; player.index = 0;
    player.markActive();

    const on = [...box.querySelectorAll(".row.playing")].map((e) => e.dataset.songkey);
    const rows = [...box.querySelectorAll<HTMLElement>(".row[data-songkey]")];
    w.__calls = [];
    rows[rows.length - 1].querySelector(".rmeta").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    return { on, lastCall: w.__calls[0] };
  });

  if (r.on.length !== 2) throw new Error(`重复曲应点亮两处，实际 ${JSON.stringify(r.on)}`);

  return `点亮 ${r.on.length} 处；末行双击 = ${r.lastCall}`;
});

await step("双击同 mid 的两行 → 各自拿到自己的对象（不串台）", async () => {
  const r = await page.evaluate(() => {
    const w = window as any; const box = w.__box as HTMLElement;

    w.__calls = [];
    const rows = [...box.querySelectorAll<HTMLElement>(".row[data-songkey]")];
    const dupAt = rows.filter((el) => el.dataset.songkey === "mid2");

    dupAt[0].querySelector(".rmeta").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const first = { ...w.__calls }; w.__calls = [];
    dupAt[1].querySelector(".rmeta").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    return { n: dupAt.length, first, second: { ...w.__calls } };
  });

  if (r.n !== 2) throw new Error("重复行数量不对: " + r.n);
  const idx1 = r.first[0]?.split(":")[2]; const idx2 = r.second[0]?.split(":")[2];

  if (idx1 === idx2) throw new Error(`两行给出同序号（行→歌被 mid 串台）: ${JSON.stringify(r)}`);

  return `序号 ${idx1} / ${idx2} 各自独立`;
});

if (errors.length) { fails++; console.log("FAIL 页面异常:", errors.join(" | ")); }

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
