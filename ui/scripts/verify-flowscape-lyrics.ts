// Chromium 回归：真实 Flowscape 插件的字形、扫色、主题前景色、阴影与行级回退。
// 先 node ../vendor/Sparkle/scripts/build-marketplace.mjs；无需 dev server / sidecar。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

declare global {
  interface Window {
    flowscapeFixture: {
      state: { time: number; karaoke: boolean; trans: boolean; rows: string };
      notify(): void;
      dispose(): void;
    };
  }
}
const code = readFileSync(process.env.FLOWSCAPE_PLUGIN_PATH ?? new URL("../../vendor/Sparkle/dist/site/sparkle/plugins/flowscape.js", import.meta.url), "utf8");
const themeCode = readFileSync(new URL("../../vendor/Sparkle/dist/site/sparkle/plugins/md3.js", import.meta.url), "utf8");
const snapshots = process.env.FLOWSCAPE_SHOTS;
if (snapshots) mkdirSync(snapshots, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 1 });
  await page.setContent('<style>body{margin:0;background:#12141b} .np{position:absolute;inset:0;background:#12141b} *{box-sizing:border-box}</style><div class="np"><div id="host"></div></div>');
  await page.evaluate(async (source) => {
    const plugin = (await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))).default;
    let view: { render(host: HTMLElement, ctx: Record<string, unknown>): () => void } | undefined;
    let notify = () => {};
    const state = { time: -0.2, karaoke: true, trans: true, rows: "1" };
    const song = { mid: "fixture", name: "Tourdion of Silver Seagulls", singer: [{ name: "HOYO-MiX" }] };
    const lines = [
      { startTime: 0, endTime: 2000, words: [{ word: "银鸥的回旋 Tourdion of Silver Seagulls - HOYO-MiX", startTime: 0, endTime: 2000 }], translatedLyric: "银鸥的回旋 · 混排与换行测试" },
      { startTime: 3000, endTime: 5000, words: [
        { word: "   保留空格 ", startTime: 3000, endTime: 4000 },
        { word: "第二句 <&>", startTime: 4000, endTime: 5000 },
      ], translatedLyric: "第二句翻译" },
    ];
    plugin.setup({
      storage: { get: (key: string) => key === "lyrows" ? state.rows : null, set: () => {} },
      registerNowPlayingView: (v: NonNullable<typeof view>) => { view = v; }, registerSettingsSection: () => {},
    });
    if (!view) throw new Error("Flowscape 未注册播放页");
    const dispose = view.render(document.querySelector<HTMLElement>("#host")!, {
      current: () => song, songAt: () => null, cover: () => "", expanded: () => true,
      time: () => state.time, duration: () => 10, paused: () => true, loading: () => false,
      error: () => "", volume: () => 0.8, muted: () => false, loved: () => false,
      qualityLabel: () => "自动", qualityTiers: () => [], quality: () => "auto",
      showTrans: () => state.trans, lyricState: () => "ready",
      karaokeActive: () => state.karaoke, karaoke: () => lines,
      lyrics: () => lines.map((l) => ({ t: l.startTime / 1000, text: l.words.map((w) => w.word).join(""), trans: l.translatedLyric })),
      onNotify: (fn: () => void) => { notify = fn; return () => {}; },
    });
    window.flowscapeFixture = { state, notify: () => notify(), dispose };
  }, code);
  const settle = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const update = async (state: Partial<Window["flowscapeFixture"]["state"]>) => {
    await page.evaluate((patch) => { Object.assign(window.flowscapeFixture.state, patch); window.flowscapeFixture.notify(); }, state);
    await settle();
  };
  // 在浏览器里解码真实截图，无额外图片依赖。
  const pixels = async (image: string) => page.evaluate(async (src) => {
    const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, img.width, img.height).data);
  }, image);
  const capture = async (selector: string, name?: string) => {
    const el = await page.$(selector); assert.ok(el);
    const png = Buffer.from(await el.screenshot());
    if (snapshots && name) writeFileSync(`${snapshots}/${name}.png`, png);
    return pixels(png.toString("base64"));
  };
  await settle();
  assert.equal(await page.$eval(".fs-ll.cur", (el) => el.textContent),
    "银鸥的回旋 Tourdion of Silver Seagulls - HOYO-MiX银鸥的回旋 · 混排与换行测试");
  // 进度不仅要更新 CSS 变量，实际高亮像素也必须随时间增长（包含折成多行的长词）。
  for (const width of [900, 420]) {
    await page.setViewport({ width, height: 800 });
    const highlighted: number[] = [];
    for (const [time, expected] of [[-0.2, "0"], [0.8, "0.5"], [1.8, "1"]] as const) {
      await update({ time });
      assert.equal(await page.$eval(".fs-ll.cur .kw", (el) => (el as HTMLElement).style.getPropertyValue("--p")), expected);
      const data = await capture(".fs-ll.cur .t1");
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 2] > 100 && data[i + 2] - data[i] > 25) count++;
      highlighted.push(count);
    }
    assert.equal(highlighted[0], 0);
    assert.ok(highlighted[1] > 50 && highlighted[2] > highlighted[1] * 1.3, `扫色没有增长：${highlighted}`);
    console.log(`PASS ${width}px 未唱 / 半词 / 唱完的实际扫色像素：${highlighted.join(" / ")}`);
  }

  // 唱完的字形应与同一字体的普通文字一致；抓住双层排字的基线/换行错位。
  const shapeStyle = await page.addStyleTag({ content: ".fs-ll.cur .t1{filter:none!important;text-shadow:none!important} .fs-root{--fs-acc:#fff}" });
  for (const family of ["serif", "sans-serif"]) {
    for (const width of [900, 420]) {
      await page.setViewport({ width, height: 800 });
      await page.evaluate((font) => document.documentElement.style.setProperty("--font-lyric", font), family);
      await settle();
      if (width === 420) {
        const fragments = await page.$eval(".fs-ll.cur .kw", (el) => el.getClientRects().length);
        assert.ok(fragments > 1, "窄窗样例必须实际折行");
      }
      const actual = await capture(".fs-ll.cur .t1", `${family}-${width}-actual`);
      const referenceStyle = await page.addStyleTag({ content: ".fs-ll.cur .kw{background:none!important;color:#fff!important;-webkit-text-fill-color:#fff!important}" });
      const reference = await capture(".fs-ll.cur .t1", `${family}-${width}-reference`);
      await referenceStyle.evaluate((el) => el.remove());
      assert.equal(actual.length, reference.length);
      const difference = actual.reduce((sum, value, i) => sum + Math.abs(value - reference[i]), 0) / actual.length;
      // background-clip 与普通文本的抗锯齿不同；比较字形覆盖范围并容忍边缘灰度差。
      let union = 0, mismatch = 0;
      for (let i = 0; i < actual.length; i += 4) {
        const a = Math.max(actual[i], actual[i + 1], actual[i + 2]) > 64;
        const b = Math.max(reference[i], reference[i + 1], reference[i + 2]) > 64;
        if (a || b) union++;
        if (a !== b) mismatch++;
      }
      assert.ok(difference < 3 && mismatch / union < 0.06,
        `${family} / ${width}px 字形错位：像素差 ${difference}，轮廓差 ${mismatch / union}`);
      console.log(`PASS ${family} / ${width}px 混排与折行，字形像素差 ${difference.toFixed(3)}`);
    }
  }
  await shapeStyle.evaluate((el) => el.remove());
  await page.setViewport({ width: 900, height: 800 });
  await update({ time: 0.8 });
  await capture(".fs-ll.cur", "dark-progress");
  // 实际 Lumen 主题与 Flowscape 同时挂载，覆盖随主题 / 深空黑 / 不接管三个表面。
  await page.evaluate(async (source) => {
    const plugin = (await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))).default;
    plugin.setup({
      storage: { get: () => null }, registerSettingsSection: () => {},
      registerTheme: (theme: { css: string }) => {
        const style = document.createElement("style");
        style.textContent = `html[data-sparkle-theme="md3"] { ${theme.css} }`;
        document.head.append(style);
      },
    });
    document.documentElement.dataset.sparkleTheme = "md3";
  }, themeCode);
  const colors = () => page.evaluate(() => {
    const line = document.querySelector<HTMLElement>(".fs-ll.cur")!;
    const main = getComputedStyle(line.querySelector(".t1")!);
    const translation = getComputedStyle(line.querySelector(".t2")!);
    const background = getComputedStyle(document.querySelector(".np")!).backgroundColor;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    const swatch = (color: string, opacity = 1) => {
      ctx.globalAlpha = 1; ctx.fillStyle = background; ctx.fillRect(0, 0, 1, 1);
      ctx.globalAlpha = opacity; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const probe = document.createElement("span"); line.append(probe);
    const resolve = (color: string) => { probe.style.color = color; return getComputedStyle(probe).color; };
    const result = {
      background: swatch(background),
      unsung: swatch(resolve("var(--fs-lyric-unsung,#ffffffa6)")),
      sung: swatch(resolve("var(--fs-lyric-highlight,color-mix(in srgb, var(--fs-acc) 45%, #fff))")),
      translation: swatch(translation.color, Number(translation.opacity)),
      color: getComputedStyle(line).color,
      filter: main.filter, shadow: translation.textShadow,
    };
    probe.remove();
    return result;
  });
  const luminance = (rgb: number[]) => rgb.map((n) => {
    const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a: number[], b: number[]) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  for (const scheme of ["light", "dark"]) {
    for (const source of ["#6750a4", "#f4cf32", "#ffffff"]) {
      await page.evaluate(({ scheme, source }) => {
        document.documentElement.dataset.theme = scheme;
        document.documentElement.style.setProperty("--cvg-bar-line", source);
      }, { scheme, source });
      await settle();
      const st = await colors();
      assert.equal(st.filter, "none");
      assert.equal(st.shadow, "none");
      for (const rgb of [st.unsung, st.sung, st.translation]) {
        assert.ok(contrast(rgb, st.background) >= 4.5, `${scheme} / ${source} 歌词对比不足：${contrast(rgb, st.background)}`);
      }
      console.log(`PASS Lumen ${scheme} / ${source} 无阴影，未唱 / 已唱 / 翻译对比均 ≥ 4.5`);
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--cvg-bar-line", "#6750a4");
  });
  for (const [time, label] of [[-0.2, "unsung"], [0.8, "progress"], [1.8, "sung"]] as const) {
    await update({ time });
    await capture(".fs-ll.cur", `light-${label}`);
  }
  // 应用浅色时，深空黑和关闭接管仍使用亮字，不能误套浅色页面的深色歌词。
  for (const [mode, value] of [["md3NpColor", "deep"], ["md3Np", "off"]] as const) {
    await page.evaluate(({ mode, value }) => { document.documentElement.dataset[mode] = value; }, { mode, value });
    await settle();
    const st = await colors();
    assert.equal(st.color, "rgb(255, 255, 255)");
    assert.notEqual(st.filter, "none");
    assert.ok(contrast(st.sung, st.background) >= 4.5);
    console.log(`PASS 浅色应用的 ${value} 播放页保持亮字与柔阴影`);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.md3Np = "on";
    document.documentElement.dataset.md3NpColor = "theme";
  });
  await update({ time: 3.3, rows: "5" });
  assert.equal(await page.$eval(".fs-ll.cur .t1", (el) => el.textContent), "   保留空格 第二句 <&>");
  assert.equal(await page.$$eval(".fs-ll.cur .kw", (els) => els.length), 2);
  await update({ trans: false });
  assert.equal(await page.$(".fs-ll.cur .t2"), null);
  await update({ karaoke: false });
  assert.equal(await page.$(".fs-ll.cur .kw"), null);
  assert.equal(await page.$eval(".fs-ll.cur .t1", (el) => el.textContent), "   保留空格 第二句 <&>");
  assert.equal(await page.$eval(".fs-ll.cur", (el) => getComputedStyle(el).textShadow), "none");
  await page.evaluate(() => window.flowscapeFixture.dispose());
  console.log("PASS 五行切句、空格与特殊字符、隐藏翻译、行级回退及卸载");
} finally {
  await browser.close();
}
