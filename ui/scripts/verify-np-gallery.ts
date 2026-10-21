// Quaver — 正在播放页验证：背景交叉淡化 / 层叠顺序 / 画廊模式全屏 / kara(AMLL) 冒烟。
// 跑：  node scripts/verify-np-gallery.ts   （需 dev server，QBASE 缺省 http://127.0.0.1:5173）
// 不需要 sidecar：歌曲/歌词经 window.__player 桩进（DEV 钩子），封面请求被拦截为本地纯色 PNG。
// 覆盖：
//  - np 背景双层（A 垫底 / B 淡入）就位与换曲交接（A 接管、B 退场），全程不操纵 z-index
//    —— 背景层一旦盖住 .np-scrim，kara 模式左缘渐变蒙版（歌词可读性背光）就没了
//  - 画廊模式（播放条按钮）：开 = 展开本页 + 全屏；再点 = 收起 + 退全屏 + 按钮熄灭
//  - 展开/画廊时 CSD、搜索及候选隐藏；收起恢复；主页面候选仍盖过吸顶区
//  - ESC 收起本页 = 同步退出画廊全屏
//  - kara 冒烟：AMLL 元素挂载、行级隐藏、左缘渐变蒙版仍在、karaoke 清空回退行级
//  - kara 注音：QRCKana 的词级 ruby 真的画在词上方，且不会被算成第二条辅助行
import puppeteer from "puppeteer-core";
import { deflateSync } from "node:zlib";

const BASE = process.env.QBASE || "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 64x64 纯色 PNG（零依赖手工组块：IHDR/IDAT/IEND + CRC32），够 blur(60px) 出纯色氛围底
function solidPng(r, g, b) {
  const crc32 = (buf) => {
    let c, t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    let crc = 0xFFFFFFFF;
    for (const x of buf) crc = t[(crc ^ x) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 2, 0, 0, 0]);
  const rows = [];
  for (let y = 0; y < 64; y++) {
    const line = Buffer.alloc(1 + 64 * 3);
    for (let x = 0; x < 64; x++) { line[1 + x * 3] = r; line[2 + x * 3] = g; line[3 + x * 3] = b; }
    rows.push(line);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_A = solidPng(180, 60, 60);
const PNG_B = solidPng(60, 60, 180);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
// 封面域名拦截为本地 PNG（交替两色，便于确认「换曲真的换了图」）
let flip = false;
const inhibitCalls = [];
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (req.url().endsWith("/api/inhibit")) {
    try { inhibitCalls.push(JSON.parse(req.postData() ?? "{}")); } catch { /* invalid test request is asserted by absence */ }
    return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({
      code: 0, msg: "ok", data: { supported: true, active: false, reason: "" },
    }) });
  }
  if (req.url().includes("y.gtimg.cn")) { flip = !flip; return req.respond({ status: 200, contentType: "image/png", body: flip ? PNG_A : PNG_B }); }
  req.continue();
});

let fails = 0;
const step = async (name, fn) => {
  try { const note = await fn(); console.log(`PASS ${name}${note ? " — " + note : ""}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
};

const waitForInhibit = async (mode, active, from = 0) => {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (inhibitCalls.slice(from).some((x) => x.mode === mode && x.active === active)) return;
    await sleep(50);
  }
  throw new Error(`未收到 mode=${mode} active=${active} 请求`);
};

const checkTopbar = async (visible: boolean) => {
  const state = await page.evaluate(() => {
    const selectors = [".winbtns", ".win-dragtop", ".content-top", ".searchbar"];
    return selectors.map((selector) => {
      const el = document.querySelector<HTMLElement>(selector)!;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { selector, visible: cs.visibility === "visible" && cs.display !== "none",
        hit: !!hit && el.contains(hit) };
    });
  });
  if (state.some((x) => x.visible !== visible || (!visible && x.hit))) {
    throw new Error(`顶栏应${visible ? "显示" : "隐藏且不能命中"}：${JSON.stringify(state)}`);
  }
};

/** 桩一首歌进队列并展开本页（行级歌词态；kara 步骤自行挂逐字数据） */
const setupSong = (mid) => page.evaluate((mid) => {
  const p = window.__player;
  if (!p) throw new Error("window.__player 不存在（需要 vite dev，DEV 钩子）");
  p.queue = [{ mid, name: "歌曲" + mid, singer: [{ name: "测试歌手" }], album: { mid: "al" + mid, name: "测试专辑" } }];
  p.index = 0;
  p.lyricState = "ok";
  p.lyrics = [{ t: 0, text: "第一行" }, { t: 3, text: "第二行" }];
  p.karaoke = [];
  p.expanded = true;
  p.notifyPublic();
}, mid);

await page.goto(`${BASE}/index.html#/`, { waitUntil: "networkidle2" });
await sleep(1500); // 等 initSparkle（内置歌词引擎 + 官方插件都是动态 import）

await step("频谱关闭 + 懒加载样式未到位时，打开 ⋮ 不会挤动正在播放页", async () => {
  await setupSong("layout");
  await page.waitForFunction(() => document.querySelector(".np.open .np-inner"), { timeout: 4000 });
  await sleep(350); // 让 np 的展开位移过渡结束，只比较静态布局
  const before = await page.evaluate(() => {
    const np = document.querySelector<HTMLElement>(".np")!;
    const inner = document.querySelector<HTMLElement>(".np-inner")!;
    return {
      top: inner.getBoundingClientRect().top,
      spectrumOn: np.classList.contains("spectrum-on"),
      spectrumPosition: getComputedStyle(document.querySelector<HTMLElement>(".np-spectrum")!).position,
    };
  });
  if (before.spectrumOn) throw new Error("回归用例应保持频谱关闭");
  if (before.spectrumPosition !== "absolute") throw new Error(`频谱在懒加载前仍参与 grid 布局: ${before.spectrumPosition}`);
  await page.click("#np-more");
  await page.waitForFunction(() => document.querySelector("#np-menu")?.classList.contains("open"), { timeout: 4000 });
  await page.waitForFunction(() =>
    [...document.styleSheets].some((sheet) => sheet.ownerNode?.textContent?.includes("正在播放页真实音频频谱")), { timeout: 4000 });
  const afterTop = await page.evaluate(() => document.querySelector<HTMLElement>(".np-inner")!.getBoundingClientRect().top);
  if (Math.abs(afterTop - before.top) > 1) throw new Error(`⋮ 触发频谱样式加载后页面位移 ${before.top} → ${afterTop}px`);
  await page.click("#np-more");
  await page.waitForFunction(() => !document.querySelector("#np-menu")?.classList.contains("open"), { timeout: 4000 });
  await page.evaluate(() => { window.__player.expanded = false; window.__player.notifyPublic(); });
  await page.waitForFunction(() => !document.querySelector(".np")?.classList.contains("open"), { timeout: 4000 });
});

await step("矮窗开启频谱：波形画布不会穿过音质胶囊", async () => {
  await page.setViewport({ width: 760, height: 520 });
  await page.evaluate(async () => {
    const { spectrumFacade } = await import("/src/lib/spectrum-controller.ts");
    spectrumFacade.setEnabled(true);
  });
  await setupSong("short");
  await page.waitForFunction(() => document.querySelector(".np.open.spectrum-on"), { timeout: 4000 });
  await sleep(350);
  const boxes = await page.evaluate(() => {
    const q = document.querySelector<HTMLElement>("#np-quality")!.getBoundingClientRect();
    const s = document.querySelector<HTMLElement>("#np-spectrum")!.getBoundingClientRect();
    return { qualityBottom: q.bottom, qualityTop: q.top, spectrumTop: s.top, spectrumBottom: s.bottom };
  });
  if (boxes.qualityBottom >= boxes.spectrumTop) throw new Error(`音质胶囊与频谱相交: ${JSON.stringify(boxes)}`);
  await page.evaluate(async () => {
    const { spectrumFacade } = await import("/src/lib/spectrum-controller.ts");
    spectrumFacade.setEnabled(false);
    window.__player.expanded = false;
    window.__player.notifyPublic();
  });
  await page.waitForFunction(() => !document.querySelector(".np")?.classList.contains("open"), { timeout: 4000 });
  await page.setViewport({ width: 1280, height: 840 });
});

await step("主页面：搜索历史候选覆盖吸顶区（含无 backdrop-filter 的主题）", async () => {
  await page.evaluate(() => {
    localStorage.setItem("quaver.search.history.v1", JSON.stringify(["晴天", "周杰伦", "七里香"]));
    const spacer = document.createElement("div");
    spacer.style.height = "1000px";
    document.querySelector(".route > .entering")!.append(spacer);
    document.querySelector<HTMLElement>(".route")!.scrollTop = 300;
  });
  await page.click(".searchbar input");
  await page.waitForSelector(".sb-item", { visible: true, timeout: 4000 });
  for (const noBackdrop of [false, true]) {
    const hit = await page.evaluate((off) => {
      const content = document.querySelector<HTMLElement>(".content")!;
      content.style.backdropFilter = off ? "none" : "";
      const item = document.querySelectorAll<HTMLElement>(".sb-item")[1];
      const r = item.getBoundingClientRect();
      const header = document.querySelector(".sticky-head")!.getBoundingClientRect();
      const y = r.y + r.height / 2;
      const target = document.elementFromPoint(r.x + r.width / 2, y);
      return { overlaps: y >= header.top && y <= header.bottom, hit: !!target && item.contains(target) };
    }, noBackdrop);
    if (!hit.overlaps || !hit.hit) throw new Error(`候选被吸顶区遮挡：${JSON.stringify(hit)}, noBackdrop=${noBackdrop}`);
  }
  await page.evaluate(() => { document.querySelector<HTMLElement>(".content")!.style.backdropFilter = ""; });
  await checkTopbar(true);
});

await step("展开本页：A 垫底层可见且被压在 scrim 之下", async () => {
  await setupSong("A");
  await page.waitForFunction(() => {
    const a = document.querySelector("#np-bg");
    return !!a && getComputedStyle(a).opacity === "1" && a.style.backgroundImage.includes("y.gtimg.cn");
  }, { timeout: 8000 });
  const top = await page.evaluate(() => String(document.elementFromPoint(640, 100)?.className ?? ""));
  if (top.includes("np-bg")) throw new Error("np-bg 盖在了 scrim 之上（层叠被操纵）");
});

await step("展开播放页：隐藏顶栏与候选、释放搜索焦点；ESC 收起后恢复", async () => {
  await checkTopbar(false);
  const focused = await page.evaluate(() => !!document.activeElement?.closest(".content-top"));
  if (focused) throw new Error("隐藏的搜索框仍占用焦点");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__player.expanded, { timeout: 4000 });
  await checkTopbar(true);
  await page.click(".searchbar input");
  await page.waitForSelector(".sb-item", { visible: true, timeout: 4000 });
  await setupSong("A");
  await sleep(400);
});

await step("背景层零 z-index 操纵（scrim 渐变蒙版不被顶掉）", async () => {
  const st = await page.evaluate(() => ({
    a: getComputedStyle(document.querySelector("#np-bg")).zIndex,
    b: getComputedStyle(document.querySelector("#np-bg2")).zIndex,
    grad: getComputedStyle(document.querySelector(".np-scrim")).backgroundImage.includes("linear-gradient"),
  }));
  if (st.a !== "auto" || st.b !== "auto") throw new Error("背景层 z-index 被操纵: " + JSON.stringify(st));
  if (!st.grad) throw new Error("scrim 渐变丢失");
});

await step("换曲交叉淡化：B 淡入 → 收尾后 A 接管、B 退场", async () => {
  await setupSong("B");
  await page.waitForFunction(() => {
    const b = document.querySelector("#np-bg2");
    return !!b && b.classList.contains("show") && b.style.backgroundImage.includes("y.gtimg.cn");
  }, { timeout: 8000 });
  await sleep(750); // settle(520ms) + 淡出过渡
  const st = await page.evaluate(() => {
    const a = document.querySelector("#np-bg"), b = document.querySelector("#np-bg2");
    return { aShow: a.classList.contains("show"), aImg: a.style.backgroundImage.includes("y.gtimg.cn"),
      bShow: b.classList.contains("show"), bImg: b.style.backgroundImage !== "" };
  });
  if (!st.aShow || !st.aImg) throw new Error("A 未接管新图 " + JSON.stringify(st));
  if (st.bShow || st.bImg) throw new Error("B 未退场 " + JSON.stringify(st));
});

await step("kara 模式：AMLL 挂载、行级隐藏、左缘渐变蒙版仍在", async () => {
  // 歌词引擎是异步注册的：就位瞬间 player 会补拉一次歌词 —— 桩环境下 API 不可达会把
  // 桩 karaoke 清空（真实应用里这步解析真 QRC）。所以这里反复重挂桩数据直到 .np.kara 稳定。
  await page.evaluate(() => {
    const p = window.__player;
    const line = (t0, dur, ws, trans = "", roman = "") => ({
      startTime: t0, endTime: t0 + dur,
      words: ws.map(([w, st, d]) => ({ word: w, startTime: t0 + st, endTime: t0 + st + d })),
      translatedLyric: trans,
      romanLyric: roman,
    });
    const arm = () => {
      p.lyricState = "ok";
      // 行级与逐字两路辅助行都给数据：第 1 行翻译/音译都有、第 2 行翻译是 `//` 占位 ——
      // 据此验证占位行被跳过、「优先所选那一路，本行缺则回落另一路」，以及辅助行只有一个。
      p.lyrics = [{ t: 0, text: "第一行", trans: "第一行（译）", roma: "di yi hang" },
        { t: 3, text: "第二行", roma: "di er hang" }];
      p.karaoke = [
        line(0, 3000, [["你好", 0, 1500], ["世界", 1500, 1500]], "你好世界（译）", "ni hao shi jie"),
        line(3000, 3000, [["第二行", 0, 3000]], "//", "di er hang"),
      ];
      p.notifyPublic();
    };
    arm();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (document.querySelector(".np.kara") || Date.now() - t0 > 15000) { clearInterval(iv); return; }
      arm();
    }, 400);
  });
  await page.waitForFunction(() =>
    document.querySelector(".np.kara") && document.querySelector("#np-karaoke .amll-lyric-player"), { timeout: 20000 });
  // AMLL 的行 DOM 在自己的 rAF 首帧后成形：等文本真的上屏再断言
  await page.waitForFunction(() =>
    document.querySelector("#np-karaoke .amll-lyric-player")?.textContent.includes("你好"), { timeout: 8000 });
  const st = await page.evaluate(() => {
    const host = document.querySelector("#np-karaoke .amll-lyric-player");
    const r = host.getBoundingClientRect();
    return { w: r.width, h: r.height,
      karaDisplay: getComputedStyle(document.querySelector("#np-lyrics")).display,
      leftGrad: getComputedStyle(document.querySelector(".np-scrim")).backgroundImage.includes("90deg") };
  });
  if (st.w < 100 || st.h < 100) throw new Error("AMLL 元素无尺寸 " + JSON.stringify(st));
  if (st.karaDisplay !== "none") throw new Error("行级歌词未隐藏");
  if (!st.leftGrad) throw new Error("kara 左缘渐变蒙版丢失");
});

await step("kara 辅助行：翻译档优先翻译、音译档优先音译，缺的一路回落另一路（且不落词上方）", async () => {
  // AMLL 每行的 DOM：children[0]=主行，[1]=第一子行（辅助行），[2]=第二子行（本设计里恒空）
  const read = () => page.evaluate(() => {
    const host = document.querySelector("#np-karaoke .amll-lyric-player");
    const mains = [...(host?.querySelectorAll('[class*="lyricMainLine"]') ?? [])];
    const rows = mains.map((m) => {
      const kids = [...(m.parentElement?.children ?? [])].map((c) => (c.textContent ?? "").trim());
      return { main: kids[0] ?? "", subs: kids.slice(1).filter(Boolean) };
    }).filter((r) => r.main.includes("你好") || r.main.includes("第二行"));
    return { rows, rubyEls: (host?.querySelectorAll('[class*="rubyWord"]') ?? []).length };
  });
  const setMode = (m) => page.evaluate((mode) => { window.__player.setLyricAuxMode(mode); window.__player.notifyPublic(); }, m);
  const waitRows = (want) => page.waitForFunction((w) => {
    const host = document.querySelector("#np-karaoke .amll-lyric-player");
    const mains = [...(host?.querySelectorAll('[class*="lyricMainLine"]') ?? [])];
    return mains.some((mm) => (mm.parentElement?.textContent ?? "").includes(w));
  }, { timeout: 8000 }, want);

  await setMode("translation");
  await waitRows("你好世界（译）");
  await sleep(350);
  let st = await read();
  let one = st.rows.find((r) => r.main.includes("你好"));
  let two = st.rows.find((r) => r.main.includes("第二行"));
  if (!one || one.subs.join() !== "你好世界（译）") throw new Error("翻译档第 1 行应显翻译 " + JSON.stringify(st.rows));
  if (!two || two.subs.join() !== "di er hang") throw new Error("翻译档第 2 行无翻译应回落音译 " + JSON.stringify(st.rows));
  if (st.rows.some((r) => r.subs.some((s) => /^\/+$/.test(s)))) throw new Error("辅助行占位 // 被上屏 " + JSON.stringify(st.rows));

  await setMode("romanization");
  await waitRows("ni hao shi jie");
  await sleep(350);
  st = await read();
  one = st.rows.find((r) => r.main.includes("你好"));
  two = st.rows.find((r) => r.main.includes("第二行"));
  if (!one || one.subs.join() !== "ni hao shi jie") throw new Error("音译档第 1 行应显音译（且在上一步的翻译之后真的换了一路） " + JSON.stringify(st.rows));
  if (!two || two.subs.join() !== "di er hang") throw new Error("音译档第 2 行应保持音译 " + JSON.stringify(st.rows));
  if (st.rubyEls > 0) throw new Error("音译不该出现在词上方（Ruby） " + JSON.stringify(st));
  if (st.rows.some((r) => r.subs.length > 1)) throw new Error("辅助行只应有一行 " + JSON.stringify(st.rows));

  await setMode("off");
  await waitRows("你好");
  await sleep(350);
  st = await read();
  if (st.rows.some((r) => r.subs.length)) throw new Error("关闭档仍残留辅助行 " + JSON.stringify(st.rows));
});
await step("kara 振假名：QRCKana 解析出的 ruby 画在词上方（不占辅助行位置）", async () => {
  // NowPlaying 只在「换曲 / 歌词状态迁移 / 接管模式切换」时清容器重挂，逐字内容本身变了
  // 不会重建 —— 所以这里走一次 none → ok 的状态迁移，逼宿主用新行表重建 AMLL。
  // 数据形状 = 内置引擎 parse() 的真实产物（QRC 正文 + [kana:] 对齐后的词级 ruby）。
  await page.evaluate(() => {
    const p = window.__player;
    p.lyrics = []; p.karaoke = []; p.lyricState = "none";
    p.notifyPublic();
  });
  await sleep(250);
  await page.evaluate(() => {
    const p = window.__player;
    p.lyricState = "ok";
    p.lyrics = [{ t: 0, text: "貴下の", trans: "尊下の（译）", roma: "きさ の" }];
    p.karaoke = [{
      startTime: 0, endTime: 3000, translatedLyric: "尊下の（訳）", romanLyric: "",
      words: [
        { word: "貴", startTime: 0, endTime: 750, ruby: [{ word: "きさ", startTime: 0, endTime: 1500 }] },
        { word: "下", startTime: 750, endTime: 1500 },
        { word: "の", startTime: 1500, endTime: 2250 },
      ],
    }];
    p.notifyPublic();
  });
  await page.waitForFunction(() =>
    document.querySelectorAll('#np-karaoke [class*="rubyWord"]').length > 0, { timeout: 8000 });
  const st = await page.evaluate(() => {
    const host = document.querySelector("#np-karaoke .amll-lyric-player");
    const ruby = [...(host?.querySelectorAll('[class*="rubyWord"]') ?? [])];
    const mains = [...(host?.querySelectorAll('[class*="lyricMainLine"]') ?? [])];
    const rowOf = (m: Element) => [...(m.parentElement?.children ?? [])].map((c) => (c.textContent ?? "").trim());
    return {
      rubyText: ruby.map((e) => (e.textContent ?? "").trim()).join(""),
      // 注音元素在 DOM 里排在主行文字**之前**（词上方），且辅助行仍只有一条
      rubyBeforeMain: ruby.length > 0 && mains.length > 0
        ? !!(ruby[0].compareDocumentPosition(mains[0]) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
      rows: mains.map(rowOf),
    };
  });
  if (!st.rubyText.includes("きさ")) throw new Error("注音没上屏 " + JSON.stringify(st));
  if (st.rows.some((r: string[]) => r.filter(Boolean).length > 2)) throw new Error("注音被算成额外的辅助行 " + JSON.stringify(st.rows));

  // 收线：把后面两步（行级回退 / 行级辅助行）依赖的桩数据原样放回去
  await page.evaluate(() => {
    const p = window.__player;
    const line = (t0: number, dur: number, ws: string[][], trans = "", roman = "") => ({
      startTime: t0, endTime: t0 + dur,
      words: ws.map(([w, s, d]) => ({ word: w, startTime: t0 + Number(s), endTime: t0 + Number(s) + Number(d) })),
      translatedLyric: trans, romanLyric: roman,
    });
    p.lyrics = [{ t: 0, text: "第一行", trans: "第一行（译）", roma: "di yi hang" },
      { t: 3, text: "第二行", roma: "di er hang" }];
    p.karaoke = [
      line(0, 3000, [["你好", "0", "1500"], ["世界", "1500", "1500"]], "你好世界（译）", "ni hao shi jie"),
      line(3000, 3000, [["第二行", "0", "3000"]], "", "di er hang"),
    ];
    p.notifyPublic();
  });
  await sleep(250);
});

await step("行级回退：karaoke 清空后回行级列表", async () => {
  await page.evaluate(() => { const p = window.__player; p.karaoke = []; p.setLyricAuxMode("translation"); p.notifyPublic(); });
  await page.waitForFunction(() =>
    !document.querySelector(".np.kara") && document.querySelectorAll("#np-lyrics .np-ly-line").length > 0, { timeout: 8000 });
});

await step("行级辅助行：与逐字同规则（翻译档优先翻译、音译档优先音译，缺则回落另一路）", async () => {
  const read = () => page.evaluate(() => [...document.querySelectorAll("#np-lyrics .np-ly-line")]
    .map((d) => ({ text: d.querySelector(".l1")?.textContent ?? "", aux: d.querySelector(".l2")?.textContent ?? "" })));
  const rows = await read();
  if (rows.find((r) => r.text === "第一行")?.aux !== "第一行（译）") throw new Error("翻译档第 1 行应显翻译 " + JSON.stringify(rows));
  if (rows.find((r) => r.text === "第二行")?.aux !== "di er hang") throw new Error("翻译档第 2 行无翻译应回落音译 " + JSON.stringify(rows));
  await page.evaluate(() => { const p = window.__player; p.setLyricAuxMode("romanization"); p.notifyPublic(); });
  await page.waitForFunction(() => document.querySelector("#np-lyrics .np-ly-line .l2")?.textContent === "di yi hang", { timeout: 8000 });
  const rows2 = await read();
  if (rows2.find((r) => r.text === "第一行")?.aux !== "di yi hang") throw new Error("音译档第 1 行应换到音译 " + JSON.stringify(rows2));
  await page.evaluate(() => { const p = window.__player; p.setLyricAuxMode("off"); p.notifyPublic(); });
  await page.waitForFunction(() => !document.querySelector("#np-lyrics .np-ly-line .l2"), { timeout: 8000 });
});
await step("画廊按钮：开 = 展开并全屏、按钮点亮", async () => {
  await page.evaluate(() => { const p = window.__player; p.expanded = false; p.gallery = false; p.notifyPublic(); });
  await sleep(450);
  const from = inhibitCalls.length;
  await page.click("#pb-gallery");
  await page.waitForFunction(() => window.__player.expanded && window.__player.gallery
    && document.querySelector(".np").classList.contains("open")
    && document.fullscreenElement != null, { timeout: 8000 });
  if (!(await page.$eval("#pb-gallery", (el) => el.classList.contains("on")))) throw new Error("按钮未点亮");
  await checkTopbar(false);
  await waitForInhibit("idle", true, from);
  if (inhibitCalls.slice(from).some((x) => x.mode === "sleep" && x.active)) throw new Error("画廊模式不应额外请求 sleep 抑制");
});

await step("画廊按钮再点：收起并退出全屏", async () => {
  const from = inhibitCalls.length;
  await page.click("#pb-gallery");
  await page.waitForFunction(() => !window.__player.expanded && !window.__player.gallery
    && !document.querySelector(".np").classList.contains("open")
    && document.fullscreenElement == null, { timeout: 8000 });
  await waitForInhibit("idle", false, from);
  await checkTopbar(true);
});

await step("ESC 收起：画廊态下 ESC = 收页 + 退全屏 + 灯灭", async () => {
  await page.click("#pb-gallery");
  await page.waitForFunction(() => window.__player.gallery && document.fullscreenElement != null, { timeout: 8000 });
  const from = inhibitCalls.length;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__player.expanded && !window.__player.gallery
    && document.fullscreenElement == null, { timeout: 8000 });
  await waitForInhibit("idle", false, from);
  await checkTopbar(true);
  if (await page.$eval("#pb-gallery", (el) => el.classList.contains("on"))) throw new Error("按钮仍点亮");
});

await step("外部退出全屏：立即结束画廊抑制", async () => {
  await page.click("#pb-gallery");
  await page.waitForFunction(() => window.__player.gallery && document.fullscreenElement != null, { timeout: 8000 });
  const from = inhibitCalls.length;
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !window.__player.gallery && document.fullscreenElement == null, { timeout: 8000 });
  await waitForInhibit("idle", false, from);
  if (await page.$eval("#pb-gallery", (el) => el.classList.contains("on"))) throw new Error("外部退出后画廊按钮仍点亮");
});

await browser.close();
console.log(`\n${fails === 0 ? "✅" : "❌"} verify-np-gallery: ${fails === 0 ? "ALL PASS" : fails + " FAILURES"}`);
process.exit(fails ? 1 : 0);
