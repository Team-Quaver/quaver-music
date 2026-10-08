// 歌手页 + 信息头改版验证：
//   1) 歌手页 = 歌单/专辑同款信息头（左圆形头像 右 名字/详情/简介，上对齐）+ 标签分类（热歌/新歌/专辑）
//   2) 歌单/专辑/歌手三页信息头整体顶缘对齐（图片顶 == 名字顶 ≈ 同一行）
//   3) 简介超两行 → 出现「展开」按钮，点击展开全文并变「收起」，再点收回
//   4) 标签栏：默认「热歌」，点「新歌」/「专辑」只切面板（不重新请求、URL 不变）
import puppeteer from "puppeteer-core";
const BASE = "http://127.0.0.1:5173";
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

// —— 歌手页（周杰伦）——
await page.goto(`${BASE}/index.html#/singer?mid=0025NhlN2yWrP4&name=${encodeURIComponent("周杰伦")}`, { waitUntil: "networkidle2" });
await sleep(1500);

await step("歌手页信息头：圆形头像在左，名字/详情/简介在右", async () => {
  const info = await page.evaluate(() => {
    const head = document.querySelector(".pl-head");
    if (!head) throw new Error("no .pl-head");
    const art = head.querySelector(".pl-art");
    const img = art?.querySelector("img");
    const name = head.querySelector(".pl-name");
    const meta = head.querySelector(".pl-meta");
    const desc = head.querySelector(".pl-desc");
    const ar = art.getBoundingClientRect(), nr = name.getBoundingClientRect();
    return {
      round: getComputedStyle(art).borderRadius === "50%" || parseFloat(getComputedStyle(art).borderRadius) >= ar.width / 2 - 1,
      imgLoaded: !!img && img.naturalWidth > 0,
      nameRightOfArt: nr.left > ar.right - 2,
      nameTop: Math.round(nr.top - ar.top),
      metaBelowName: meta.getBoundingClientRect().top > nr.bottom - 2,
      text: name.textContent.trim(),
      metaText: meta.textContent.trim(),
    };
  });
  if (!info.round) throw new Error("avatar not round");
  if (!info.imgLoaded) throw new Error("avatar img not loaded");
  if (!info.nameRightOfArt) throw new Error("name not right of art");
  if (info.nameTop < -2 || info.nameTop > 8) throw new Error("name not top-aligned with art: " + info.nameTop);
  if (info.text !== "周杰伦") throw new Error("wrong name: " + info.text);
  return `name="${info.text}", meta="${info.metaText}", nameTop-artTop=${info.nameTop}px`;
});

await step("简介长文本 → 出现展开按钮，点击展开全文变收起，再点收回", async () => {
  const state = async () => page.evaluate(() => {
    const d = document.querySelector(".pl-desc");
    const b = document.querySelector(".pl-expand");
    return {
      hasBtn: !!b,
      label: b?.textContent ?? "",
      open: d?.classList.contains("open") ?? false,
      clipped: d ? d.scrollHeight - d.clientHeight > 2 : false,
      h: d ? Math.round(d.getBoundingClientRect().height) : 0,
      lines: d ? d.textContent.length : 0,
    };
  });
  let s = await state();
  if (!s.hasBtn) throw new Error("no .pl-expand button for long desc");
  if (s.open || s.label !== "展开") throw new Error("desc should start clamped: " + JSON.stringify(s));
  const hClamped = s.h;
  await page.click(".pl-expand"); await sleep(150);
  s = await state();
  if (!s.open || s.label !== "收起" || s.clipped) throw new Error("expand failed: " + JSON.stringify(s));
  const hOpen = s.h;
  await page.click(".pl-expand"); await sleep(150);
  s = await state();
  if (s.open || s.label !== "展开") throw new Error("collapse failed: " + JSON.stringify(s));
  if (!(hOpen > hClamped + 40)) throw new Error(`heights too close: ${hClamped} -> ${hOpen}`);
  return `clamped=${hClamped}px expanded=${hOpen}px`;
});

await step("标签栏：默认热歌，切新歌/专辑只换面板（哈希不变）", async () => {
  const info = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".tag-tabs .tag")].map((b) => ({
      label: b.textContent.trim(), sel: b.classList.contains("sel"),
    }));
    const visible = () => [...document.querySelectorAll(".tag-body .tag-panel")].findIndex((p) => !p.hidden);
    return { tabs, hot: visible(), hash: location.hash };
  });
  if (info.tabs.map((t) => t.label).join("/") !== "热歌/新歌/专辑") throw new Error("tab labels wrong: " + JSON.stringify(info.tabs));
  if (info.tabs.filter((t) => t.sel).length !== 1 || !info.tabs[0].sel) throw new Error("default tab should be 热歌: " + JSON.stringify(info.tabs));
  if (info.hot !== 0) throw new Error("hot panel not the visible one: idx=" + info.hot);
  const hash0 = info.hash;

  await page.click('.tag-tabs .tag[data-tab="new"]'); await sleep(150);
  const after = await page.evaluate((h0) => {
    const vis = [...document.querySelectorAll(".tag-body .tag-panel")].findIndex((p) => !p.hidden);
    return { idx: vis, rows: document.querySelectorAll(".tag-body .tag-panel:not([hidden]) .row").length,
      sel: document.querySelector(".tag[data-tab='new']").classList.contains("sel"), sameHash: location.hash === h0 };
  }, hash0);
  if (after.idx !== 1) throw new Error("new panel not visible: idx=" + after.idx);
  if (!after.sel) throw new Error("新歌 tag not highlighted");
  if (!after.sameHash) throw new Error("tab switch should not touch the route hash");
  return `tabs=${info.tabs.map((t) => t.label).join("/")}, new-panel rows=${after.rows}`;
});

await step("热歌面板：歌曲列表渲染（≥10 行）", async () => {
  await page.click('.tag-tabs .tag[data-tab="hot"]'); await sleep(150);
  const info = await page.evaluate(() => ({
    rows: document.querySelectorAll(".tag-body .tag-panel:not([hidden]) .row").length,
    first: document.querySelector(".tag-body .tag-panel:not([hidden]) .row .ra")?.textContent?.trim() ?? "",
  }));
  if (info.rows < 10) throw new Error("too few song rows: " + info.rows);
  return `rows=${info.rows}, first=${info.first}`;
});

await step("专辑面板：卡片网格 + 「查看全部」指向 singer-albums", async () => {
  await page.click('.tag-tabs .tag[data-tab="album"]'); await sleep(200);
  const info = await page.evaluate(() => {
    const panel = document.querySelector(".tag-body .tag-panel:not([hidden])");
    const first = panel.querySelector(".grid .card");
    return { cards: panel.querySelectorAll(".grid .card").length, href: first?.getAttribute("href") ?? "",
      more: panel.querySelector(".sec-more")?.getAttribute("href") ?? "", imgOk: !!first?.querySelector("img")?.src };
  });
  if (info.cards < 5) throw new Error("too few album cards: " + info.cards);
  if (!info.href.startsWith("#/album?mid=")) throw new Error("album card href wrong: " + info.href);
  if (!info.more.startsWith("#/singer-albums?mid=0025NhlN2yWrP4")) throw new Error("bad 查看全部 href: " + info.more);
  return `albums=${info.cards}`;
});

await step("专辑卡点击 → 跳到专辑页且信息头上对齐", async () => {
  const href = await page.evaluate(() =>
    document.querySelector(".tag-body .tag-panel:not([hidden]) .grid .card").getAttribute("href"));
  await page.goto(BASE + "/index.html" + href);
  await sleep(1600);
  const info = await page.evaluate(() => {
    const head = document.querySelector(".pl-head");
    if (!head) throw new Error("no head on album page");
    const art = head.querySelector(".pl-art").getBoundingClientRect();
    const name = head.querySelector(".pl-name").getBoundingClientRect();
    return { align: Math.round(name.top - art.top), round: getComputedStyle(head.querySelector(".pl-art")).borderRadius, name: head.querySelector(".pl-name").textContent.trim() };
  });
  if (info.round === "50%") throw new Error("album art should be square-ish");
  if (info.align < -2 || info.align > 8) throw new Error("album name not top-aligned: " + info.align);
  return `album="${info.name}", align=${info.align}px`;
});

await page.screenshot({ path: "/tmp/quaver-album-head.png" });

// —— 歌单页信息头（对齐 + 展开按钮一致性）——
await step("歌单页信息头上对齐", async () => {
  await page.goto(`${BASE}/index.html#/playlist?id=9339282214&name=${encodeURIComponent("歌单")}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  const info = await page.evaluate(() => {
    const head = document.querySelector(".pl-head");
    if (!head) throw new Error("no head on playlist page");
    const art = head.querySelector(".pl-art").getBoundingClientRect();
    const name = head.querySelector(".pl-name").getBoundingClientRect();
    return { align: Math.round(name.top - art.top), name: head.querySelector(".pl-name").textContent.trim(), hasDesc: !!head.querySelector(".pl-desc")?.textContent.trim() };
  });
  if (info.align < -2 || info.align > 8) throw new Error("playlist name not top-aligned: " + info.align);
  return `playlist="${info.name}", align=${info.align}px, desc=${info.hasDesc}`;
});

await page.screenshot({ path: "/tmp/quaver-playlist-head.png" });

// 回歌手页出图
await page.goto(`${BASE}/index.html#/singer?mid=0025NhlN2yWrP4&name=${encodeURIComponent("周杰伦")}`, { waitUntil: "networkidle2" });
await sleep(2000);
await page.screenshot({ path: "/tmp/quaver-singer-page.png" });
await page.click(".pl-expand").catch(() => {});
await sleep(300);
await page.screenshot({ path: "/tmp/quaver-singer-expanded.png" });

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
