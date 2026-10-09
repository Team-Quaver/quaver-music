// 响应式布局验证：窄宽度（搜索框 vs 标题/按钮簇）、矮高度（播放条可见性）、滚动条带位置。
// 用法：QBASE=http://127.0.0.1:5173 node scripts/verify-layout-responsive.ts
import puppeteer from "puppeteer-core";
const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

const rect = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const hidden = cs.display === "none" || cs.visibility === "hidden";
  const r = el.getBoundingClientRect();
  return { hidden, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    right: Math.round(r.right), bottom: Math.round(r.bottom) };
}, sel);
const overlap = (a, b) => a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
/** 从计算色里取透明度：color(srgb … / .98) 与 rgba(…, 0) 两种写法都要认 */
const alphaOf = (c: string) => {
  const m = /\/\s*([\d.]+)\)/.exec(c) ?? /rgba?\([^)]*,\s*([\d.]+)\)/.exec(c);
  return m ? Number(m[1]) : 1;
};
const hitOk = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return "NO_EL";
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return "OFFSCREEN";
  const t = document.elementFromPoint(cx, cy);
  return (t === el || el.contains(t) || (t && t.contains(el))) ? "ok" : "COVERED:" + (t ? t.className || t.tagName : "none");
}, sel);

async function gotoSinger(w, h) {
  await page.setViewport({ width: w, height: h });
  await page.goto(`${BASE}/index.html#/singer?mid=0025NhlN2yWrP4&name=${encodeURIComponent("周杰伦")}`, { waitUntil: "domcontentloaded" });
  await sleep(1300);
}

const SIZES = [[1280, 840], [1000, 700], [860, 620], [780, 560], [760, 520]];

await step("窄→宽五档：搜索框与标题/歌手名/信息头零重叠", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await gotoSinger(w, h);
    const sb = await rect(page, ".searchbar");
    const name = await rect(page, ".pl-name");
    const meta = await rect(page, ".pl-meta");
    const desc = await rect(page, ".pl-desc");
    const art = await rect(page, ".pl-art");
    for (const [k, t] of [["name", name], ["meta", meta], ["desc", desc], ["art", art]]) {
      if (overlap(sb, t)) bad.push(`${w}x${h}: searchbar∩${k}`);
    }
  }
  if (bad.length) throw new Error(bad.join("; "));
  return SIZES.map((s) => s.join("×")).join(", ");
});

await step("五档：CSD 按钮簇可见、close 可点、与搜索框零重叠", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await gotoSinger(w, h);
    const wb = await rect(page, ".winbtns");
    const sb = await rect(page, ".searchbar");
    if (!wb || wb.hidden) bad.push(`${w}x${h}: winbtns hidden`);
    if (wb && wb.bottom > h || (wb && wb.right > w)) bad.push(`${w}x${h}: winbtns clipped`);
    if (overlap(wb, sb)) bad.push(`${w}x${h}: winbtns∩searchbar`);
    const hit = await hitOk(page, '[data-win="close"]');
    if (hit !== "ok") bad.push(`${w}x${h}: close hit=${hit}`);
  }
  if (bad.length) throw new Error(bad.join("; "));
  return "5 sizes";
});

await step("五档：播放条完整在视口内、播放键可点", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await gotoSinger(w, h);
    const pl = await rect(page, ".player");
    if (!pl || pl.hidden) bad.push(`${w}x${h}: player hidden`);
    else if (pl.bottom > h || pl.top_ < 0 || pl.y < 0) bad.push(`${w}x${h}: player clipped bottom=${pl.bottom}/${h}`);
    const hit = await hitOk(page, "#pb-play");
    if (hit !== "ok") bad.push(`${w}x${h}: play hit=${hit}`);
  }
  if (bad.length) throw new Error(bad.join("; "));
  return "5 sizes";
});

await step("长列表滚动：内容/滚动条永远在按钮簇下缘之下", async () => {
  await gotoSinger(1000, 620);
  const route = await rect(page, ".route");
  const wb = await rect(page, ".winbtns");
  if (route.y < wb.bottom) throw new Error(`route top ${route.y} above winbtns bottom ${wb.bottom}`);
  await page.evaluate(() => { document.querySelector(".route").scrollTop = 99999; });
  await sleep(300);
  const info = await page.evaluate(() => {
    const r = document.querySelector(".route");
    return { scrolled: r.scrollTop > 0, overflowX: getComputedStyle(r).overflowX, w: r.offsetWidth - r.clientWidth };
  });
  if (!info.scrolled) throw new Error("route did not scroll");
  return `route starts y=${route.y} ≥ ${wb.bottom}; scrollbar slot=${info.w}px (thin round thumb)`;
});

await step("滚动条样式：webkit 自定义细圆条生效（未被 scrollbar-width 抢走）", async () => {
  await gotoSinger(1000, 620);
  const applied = await page.evaluate(() => {
    // scrollbar-width 若为 auto 说明 ::-webkit-scrollbar 规则在生效链上（Chromium≥121 反之会禁用）
    const route = document.querySelector(".route");
    return { sw: getComputedStyle(route).scrollbarWidth };
  });
  if (applied.sw !== "auto") throw new Error("scrollbar-width=" + applied.sw + " (overrides webkit styling)");
  return "scrollbarWidth=auto → ::-webkit-scrollbar custom thumb active";
});

await step("搜索框跨路由仍常驻（顶带不随视图重建）", async () => {
  await gotoSinger(1000, 700);
  await page.evaluate(() => { window.__sb = document.querySelector(".content .searchbar"); });
  await page.type(".searchbar input", "晴天");
  await page.click(".sidebar .nav a[href='#/']");
  await sleep(700);
  const same = await page.evaluate(() => document.querySelector(".searchbar") === window.__sb
    && document.querySelector(".searchbar").closest(".content-top") !== null);
  const v = await page.$eval(".searchbar input", (el) => el.value);
  if (!same) throw new Error("searchbar rebuilt or left .content-top");
  if (v !== "晴天") throw new Error("input lost: " + v);
  return "same node in .content-top, kept across #/singer → #/";
});

await step("首页窄窗：搜索框 vs page-title 零重叠", async () => {
  const bad = [];
  for (const [w, h] of SIZES) {
    await page.setViewport({ width: w, height: h });
    await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
    await sleep(700);
    const sb = await rect(page, ".searchbar");
    const t = await rect(page, ".page-title");
    if (overlap(sb, t)) bad.push(`${w}x${h}`);
  }
  if (bad.length) throw new Error("overlap at " + bad.join(", "));
  return "5 sizes";
});

await step("吸顶：歌手页信息头缩成单行贴顶、缩略头像+名字浮现、雾层压得住内容", async () => {
  await gotoSinger(1000, 700);
  await page.evaluate(() => { document.querySelector<HTMLElement>(".route")!.scrollTop = 600; });
  await sleep(320);
  const r = await page.evaluate(() => {
    const route = document.querySelector<HTMLElement>(".route")!;
    const bar = document.querySelector<HTMLElement>(".sticky-bar");
    const blank = { missing: true, stuck: false, gap: 0, leadOpacity: "0", leadArt: false, leadName: "", tabsInBar: false, veilAlpha: 0 };
    if (!bar) return blank;
    const rb = route.getBoundingClientRect(), bb = bar.getBoundingClientRect();
    const lead = bar.querySelector<HTMLElement>(".sticky-bar__lead");
    const name = lead?.querySelector(".sticky-bar__name")?.textContent ?? "";
    const veil = getComputedStyle(bar, "::before").backgroundImage;
    const m = /\/\s*([\d.]+)\)\s+\d/.exec(veil);
    return {
      missing: false,
      stuck: bar.classList.contains("stuck"),
      gap: Math.round(bb.top - rb.top),
      leadOpacity: lead ? getComputedStyle(lead).opacity : "0",
      leadArt: !!lead?.querySelector("img"),
      leadName: name.trim(),
      tabsInBar: !!bar.querySelector(".tag-tabs"),
      veilAlpha: m ? Number(m[1]) : NaN,
    };
  });
  if (r.missing) throw new Error("歌手页没有 .sticky-bar");
  // sticky 的 0 点是 .route 内容盒顶（低 6px）：必须用负 top 抵消 --route-pad-top，否则顶部留缝漏内容
  if (r.gap < -1 || r.gap > 1) throw new Error(`没贴住 .route 顶缘：gap=${r.gap}px`);
  // 判定基准必须是滚动容器顶缘：早期用 rect.top<=0（视口）导致 .stuck 永不生效
  if (!r.stuck) throw new Error("滚动后未进入 .stuck");
  if (r.leadOpacity !== "1") throw new Error(`缩略信息未浮现：opacity=${r.leadOpacity}`);
  if (!r.leadArt || !r.leadName) throw new Error(`缩略头像/名字缺失：art=${r.leadArt} name=${JSON.stringify(r.leadName)}`);
  if (!r.tabsInBar) throw new Error("分类标签没进吸顶条右侧");
  if (!(r.veilAlpha > 0.9)) throw new Error(`雾层太透：α=${r.veilAlpha}`);
  // 顶带（CSD 按钮簇 + 搜索框）与吸顶条「完美接壤」：同色实底 + 撤掉顶带自带的 112px 渐隐
  const seam = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content")!;
    const top = content.querySelector<HTMLElement>(".content-top")!;
    const route = content.querySelector<HTMLElement>(".route")!;
    return {
      bandBottom: Math.round(top.getBoundingClientRect().bottom),
      routeTop: Math.round(route.getBoundingClientRect().top),
      bandBg: getComputedStyle(top).backgroundColor,
      fade: getComputedStyle(content, "::before").opacity,
    };
  });
  if (seam.bandBottom !== seam.routeTop) throw new Error(`顶带与内容区不接壤：bandBottom=${seam.bandBottom} routeTop=${seam.routeTop}`);
  // 滚动条槽补条：滚动条占 10px 布局且画在内容之上，吸顶条够不到，靠 .content-body::before
  // （高度 = --stuck-h）补同色底。--stuck-h 必须 = 吸顶头高 + 22px 化开带，否则槽里会露底色/露硬边。
  const gutter = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content")!;
    const bar = content.querySelector<HTMLElement>(".sticky-bar")!;
    const body = content.querySelector<HTMLElement>(".content-body")!;
    const route = content.querySelector<HTMLElement>(".route")!;
    return {
      stuckH: getComputedStyle(body).getPropertyValue("--stuck-h").trim(),
      barH: Math.round(bar.getBoundingClientRect().height),
      gutterW: route.offsetWidth - route.clientWidth,
      sbGutter: getComputedStyle(route).scrollbarGutter,
    };
  });
  const stuckNum = parseFloat(gutter.stuckH) || 0;
  if (Math.abs(stuckNum - (gutter.barH + 22)) > 2) {
    throw new Error(`--stuck-h 与吸顶头高度不符（滚动条槽补条会错位）：${gutter.stuckH} vs ${gutter.barH}+22`);
  }
  if (gutter.sbGutter !== "stable") throw new Error(`.route 未常驻滚动槽：scrollbar-gutter=${gutter.sbGutter}`);
  if (!(alphaOf(seam.bandBg) > 0.9)) throw new Error(`吸顶时顶带没换成与条身同色的实底：${seam.bandBg}`);
  if (seam.fade !== "0") throw new Error(`吸顶时顶带 112px 渐隐未撤掉（会与吸顶雾层叠成灰雾）：opacity=${seam.fade}`);
  // 回到顶部要复原：顶带玻璃底 + 渐隐层回来
  await page.evaluate(() => { document.querySelector<HTMLElement>(".route")!.scrollTop = 0; });
  await sleep(320);
  const back = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content")!;
    return {
      bandBg: getComputedStyle(content.querySelector<HTMLElement>(".content-top")!).backgroundColor,
      fade: getComputedStyle(content, "::before").opacity,
    };
  });
  if (alphaOf(back.bandBg) > 0.5) throw new Error(`回顶后顶带底色没复原：${back.bandBg}`);
  if (back.fade !== "1") throw new Error(`回顶后渐隐层没复原：opacity=${back.fade}`);
  const backH = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>(".content-body")!).getPropertyValue("--stuck-h").trim());
  if (backH !== "0px") throw new Error(`回顶后滚动条槽补条没收起：--stuck-h=${backH}`);
  return `gap=${r.gap}px, 缩略=「${r.leadName}」, 标签贴右, 雾层 α=${r.veilAlpha}, 顶带接壤(底 α=${alphaOf(seam.bandBg)}/渐隐=${seam.fade}), 槽补条 --stuck-h=${gutter.stuckH}(槽宽 ${gutter.gutterW}px)`;
});

await step("吸顶页头：首页回顶与下翻都贴死顶带（不留 .route 顶内边距的缝）", async () => {
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto(`${BASE}/index.html#/`, { waitUntil: "domcontentloaded" });
  await sleep(900);
  const read = () => page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content")!;
    const route = content.querySelector<HTMLElement>(".route")!;
    const head = content.querySelector<HTMLElement>(".sticky-head")!;
    const band = content.querySelector<HTMLElement>(".content-top")!;
    return {
      gap: Math.round(head.getBoundingClientRect().top - route.getBoundingClientRect().top),
      bandBottom: Math.round(band.getBoundingClientRect().bottom),
      routeTop: Math.round(route.getBoundingClientRect().top),
      bandBg: getComputedStyle(band).backgroundColor,
      fade: getComputedStyle(content, "::before").opacity,
    };
  });
  const top = await read(); // 回顶态：sticky 未激活，靠负 margin-top 抵消 --route-pad-top
  await page.evaluate(() => { document.querySelector<HTMLElement>(".route")!.scrollTop = 400; });
  await sleep(260);
  const down = await read();
  const bad: string[] = [];
  if (top.gap !== 0) bad.push(`回顶未贴死：gap=${top.gap}px（要负 margin-top 抵消 --route-pad-top）`);
  if (down.gap !== 0) bad.push(`下翻未贴死：gap=${down.gap}px`);
  if (top.bandBottom !== top.routeTop) bad.push(`顶带与内容区不接壤：${top.bandBottom}/${top.routeTop}`);
  if (!(alphaOf(top.bandBg) > 0.9)) bad.push(`顶带没换成吸顶同色实底：${top.bandBg}`);
  if (top.fade !== "0") bad.push(`顶带 112px 渐隐未撤：${top.fade}`);
  const headH = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content")!;
    const head = content.querySelector<HTMLElement>(".sticky-head")!;
    return { h: Math.round(head.getBoundingClientRect().height), stuckH: getComputedStyle(content.querySelector<HTMLElement>(".content-body")!).getPropertyValue("--stuck-h").trim() };
  });
  if (Math.abs((parseFloat(headH.stuckH) || 0) - (headH.h + 22)) > 2) {
    bad.push(`吸顶页头没铺滚动条槽补条：--stuck-h=${headH.stuckH} vs ${headH.h}+22`);
  }
  if (bad.length) throw new Error(bad.join("; "));
  return `回顶 gap=${top.gap}px / 下翻 gap=${down.gap}px，顶带同色接壤（α=${alphaOf(top.bandBg)}），槽补条 --stuck-h=${headH.stuckH}`;
});

await step("截图存档（三档关键尺寸）", async () => {
  const fs = await import("node:fs");
  fs.mkdirSync("/tmp/quaver-layout", { recursive: true });
  for (const [w, h] of [[760, 520], [1000, 620], [1280, 840]]) {
    await gotoSinger(w, h);
    await page.evaluate(() => { document.querySelector(".route").scrollTop = 400; });
    await sleep(200);
    await page.screenshot({ path: `/tmp/quaver-layout/fixed_${w}x${h}.png` });
  }
  return "/tmp/quaver-layout/fixed_*.png";
});

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
