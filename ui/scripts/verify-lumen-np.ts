// Lumen（md3 主题）× 正在播放页 —— 真实渲染回归
//
// 为什么必须开浏览器，而不是像多数 verify-* 那样读源码做正则：这三类断言的真相都在
// 「计算值 / 合成结果」里，源码字符串看不见 ——
//   ① 封面投影：播放时要有、暂停时要收干净，而且深色下真的看得见、颜色要跟着 Tint 跑；
//   ② 逐字歌词（内置 AMLL）：主题强制保持 `mix-blend-mode: plus-lighter` —— 文字给底色**加光**。
//      只有把字画在真实底色上量像素才测得出 Lumen 的墨色/遮罩是否与这层混合自洽；
//   ③ 行级回退列表 / 页内浮层：宿主那套「白字 + 深色玻璃」口径在浅色接管态要整体翻面。
//
// 口径：宿主 style.css + AMLL 自己的 style.css + **真实打包出来的主题 CSS**（走 registerTheme
// 那条注入路，包装选择器与 host.ts 一致），fixture 的 DOM 形状照 ui/src/components/NowPlaying.ts
// 与 AMLL 的实际输出（类名、逐词遮罩渐变都是 core 真在用的那份）。
//
// 先打包：node ../vendor/Sparkle/scripts/build-marketplace.mjs
// 跑法：node scripts/verify-lumen-np.ts（要截图：LUMEN_SHOTS=/tmp/lumen-np node ...）
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { parseHex, toBarColors, toUiColors } from "../src/lib/color.ts";

const themeCode = readFileSync(
  process.env.MD3_PLUGIN_PATH ?? new URL("../../vendor/Sparkle/dist/site/sparkle/plugins/md3.js", import.meta.url),
  "utf8",
);

const hostCss = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const amllCss = readFileSync(new URL("../node_modules/@applemusic-like-lyrics/core/dist/style.css", import.meta.url), "utf8");
const shots = process.env.LUMEN_SHOTS;

if (shots) mkdirSync(shots, { recursive: true });

/** 逐字遮罩的真形状（core: generateFadeGradient）：左半=已唱(bright)，右半=未唱(dark)。 */
const MASK = "mask-image:linear-gradient(to right, rgb(0 0 0 / var(--bright-mask-alpha, 1)) 50%, "
  + "rgb(0 0 0 / var(--dark-mask-alpha, 1)) 50%);mask-size:100% 100%;mask-repeat:no-repeat";

/** 够长的一行，保证已唱/未两侧都有实心字形可量。 */
const LYRIC = "银鸥的回旋 Tourdion of Silver Seagulls 右半是未唱区";
const AUX = "银鸥的回旋 · 翻译辅助行";

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>${hostCss}</style>
<style>${amllCss}</style>
<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>
</head><body>
<div class="np open kara playing">
  <div class="np-bg show"></div><div class="np-bg np-bg2"></div><div class="np-scrim"></div>
  <div class="np-inner">
    <div class="np-lyrics">
      <div class="np-ly-line"><span class="l1">上一句</span></div>
      <div class="np-ly-line cur"><span class="l1">${LYRIC}</span><span class="l2">${AUX}</span></div>
      <div class="np-ly-line"><span class="l1">下一句</span></div>
      <div class="np-ly-empty">暂无歌词</div>
    </div>
    <div class="np-kara-host"><div class="amll-lyric-player dom" style="position:absolute;inset:0">
      <div class="FmKaba_lyricLineWrapper FmKaba_gradientMask FmKaba_active"
           style="position:relative;top:auto;left:auto;margin:150px 0 0;display:block">
        <div class="FmKaba_lyricMainLine"><span style="${MASK}">${LYRIC}</span></div>
        <div class="FmKaba_lyricSubLine">${AUX}</div>
      </div>
    </div></div>
    <div class="np-side">
      <div class="np-cover-wrap"><div class="np-cover"></div></div>
      <div class="np-meta">
        <div class="np-title np-marquee"><span class="mt">曲名</span></div>
        <div class="np-artist np-marquee"><span class="mt">歌手 - 专辑</span></div>
        <div class="np-morewrap">
          <button class="np-qpill" type="button">HQ</button>
          <button class="np-more" type="button">⋮</button>
          <div class="np-menu open"><button class="np-menu-item" type="button">同名搜索</button></div>
          <div class="np-qinfo open"><div class="qi-title">音频流信息</div><div class="qi-row">比特率</div></div>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
  headless: true, args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1040, height: 780, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });

  // 注：这份「引擎默认档」是 AMLL 自己的 style.css 在无主题状态下的值 —— 后面深空黑 /
  // 不接管两态必须与它逐字相等，才能证明浅色的修功没有漏进那两态。
  const engine = await page.evaluate(() => ({
    maskDark: getComputedStyle(document.querySelector(".FmKaba_lyricLineWrapper")!).getPropertyValue("--dark-mask-alpha").trim(),
    subOpacity: getComputedStyle(document.querySelector(".FmKaba_lyricSubLine")!).opacity,
    blend: getComputedStyle(document.querySelector(".amll-lyric-player")!).mixBlendMode,
  }));

  await page.evaluate(async (source) => {
    const plugin = (await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))).default;
    plugin.setup({
      storage: { get: () => null, set: () => {}, remove: () => {}, keys: () => [] },
      registerTheme: (theme: { id: string; css: string }) => {
        const style = document.createElement("style");
        style.textContent = `html[data-sparkle-theme="${theme.id}"]{${theme.css}}`;
        document.head.append(style);
      },
      registerSettingsSection: () => {},
    });
    document.documentElement.dataset.sparkleTheme = "md3";
  }, themeCode);

  // —— 工具 ——
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);

  const contrast = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);

    return (x + 0.05) / (y + 0.05);
  };

  /** 截图 → 像素（在页面里解码，省掉额外图片依赖；口径同 verify-flowscape-lyrics） */
  const toPixels = (base64: string) => page.evaluate(async (src) => {
    const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d")!; x.drawImage(img, 0, 0);

    return Array.from(x.getImageData(0, 0, img.width, img.height).data);
  }, base64);

  const shoot = async (clip: { x: number; y: number; width: number; height: number }, name?: string) => {
    const png = Buffer.from(await page.screenshot({ clip }));

    if (shots && name) writeFileSync(`${shots}/${name}.png`, png);

    return toPixels(png.toString("base64"));
  };

  const rect = (sel: string) => page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();

    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  /** 一行像素里「与底色差别最大」的那个 = 墨色本体（浅底取最深、深底取最亮，同一把尺） */
  const ink = (data: number[], width: number, from: number, to: number, bg: number[]) => {
    let best = bg, bestC = 1;

    for (let i = 0; i < width; i++) {
      if (i < from || i >= to) continue;

      for (let y = 0; y < data.length / (4 * width); y++) {
        const p = (y * width + i) * 4;
        const rgb = [data[p], data[p + 1], data[p + 2]];
        const c = contrast(rgb, bg);

        if (c > bestC) { bestC = c; best = rgb; }
      }
    }

    return { rgb: best, c: bestC };
  };

  /** 任意 CSS 颜色 → [r,g,b,a01]。计算值可能是 lch()/color() 这类非 rgb() 字面量，
   *  所以一律交给 canvas 归一化，别拿正则猜。 */
  const rgba = (color: string) => page.evaluate((c) => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 1;
    const x = cv.getContext("2d")!; x.fillStyle = c; x.clearRect(0, 0, 1, 1); x.fillRect(0, 0, 1, 1);
    const d = Array.from(x.getImageData(0, 0, 1, 1).data);

    return { rgb: d.slice(0, 3) as number[], a: (d[3] ?? 255) / 255 };
  }, color);

  /** 底色 + 一个带 alpha 的前景色 → 合成后实际落在屏上的 rgb（CSS 在 sRGB 上做 src-over） */
  const composite = (fg: string, alpha: number, bg: string) => page.evaluate((f, a, b) => {
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const x = c.getContext("2d")!;
    x.fillStyle = b; x.fillRect(0, 0, 1, 1);
    x.globalAlpha = a; x.fillStyle = f; x.fillRect(0, 0, 1, 1);

    return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }, fg, alpha, bg);

  const pageState = () => page.evaluate(() => {
    const before = (sel: string, prop: string) => {
      const el = document.querySelector(sel);

      // SAFETY: CSSStyleDeclaration 无字符串索引声明；-- 变量走 getPropertyValue，这里只读普通 camel 属性
      return el ? String((getComputedStyle(el, "::before") as CSSStyleDeclaration & Record<string, string>)[prop] ?? "") : "";
    };

    // 自定义属性（--x-yy）只能 getPropertyValue；普通属性反过来 —— Blink 的
    // getPropertyValue 不认驼峰名，拿它读 backgroundColor 会返回空串（量尺一旦读到空，
    // 后面所有对比度都是拿「黑底」算出来的，全是假数据）。
    const g = (sel: string, prop: string) => {
      const el = document.querySelector(sel);

      if (!el) return "";
      const cs = getComputedStyle(el);

      // SAFETY: 同上 —— 普通属性只能按名索引读，CSSStyleDeclaration 类型里没有这条索引声明
      return prop.startsWith("--") ? cs.getPropertyValue(prop) : String((cs as CSSStyleDeclaration & Record<string, string>)[prop] ?? "");
    };

    return {
      bg: g(".np", "backgroundColor"),
      blend: g(".amll-lyric-player", "mixBlendMode"),
      karaShadow: g(".np-kara-host", "textShadow"),
      maskDark: g(".FmKaba_lyricLineWrapper", "--dark-mask-alpha"),
      subOpacity: g(".FmKaba_lyricSubLine", "opacity"),
      coverShadow: before(".np-cover-wrap", "boxShadow"),
      lyCurShadow: g(".np-ly-line.cur", "textShadow"),
      menuSurface: g(".np-menu", "backgroundColor"),
      menuInk: g(".np-menu-item", "color"),
      pillColor: g(".np-qpill", "color"),
      pillBg: g(".np-qpill", "backgroundColor"),
      title: g(".np-title", "color"),
    };
  });

  /** 像 lib/tint.ts 那样把一套 Tint 方案写进行内变量（主题源色读的就是 --cvg-bar-line） */
  const setTint = (hex: string) => {
    const rgb = parseHex(hex);
    assert.ok(rgb, `fixture 源色不是合法 HEX: ${hex}`);
    const ui = toUiColors(rgb)!, bar = toBarColors(rgb)!;

    return page.evaluate((v) => {
      const s = document.documentElement.style;

      for (const [k, val] of Object.entries(v)) s.setProperty(k, val);
    }, {
      "--cvg-accent": ui.accent, "--cvg-glow": ui.glow,
      "--cvg-bar-fill": bar.soft, "--cvg-bar-line": bar.line, "--np-hl": bar.line,
    });
  };

  const setDataset = (patch: Record<string, string>) => page.evaluate((p) => {
    for (const [k, v] of Object.entries(p)) document.documentElement.dataset[k] = v;
  }, patch);

  const toggle = (cls: string, on: boolean) => page.evaluate((c, o) => {
    document.querySelector(".np")!.classList.toggle(c, o);
  }, cls, on);

  const SOURCES = [["紫罗兰", "#6750a4"], ["翠绿", "#2e7d32"]] as const;
  const results: string[] = [];

  // —— ⑤ 正在播放页固定 Quaver Design：恒为深底，引擎默认口径才是对的 ——
  for (const name of ["Quaver Design"]) {
    await setDataset({ theme: "light", sparkleTheme: "md3" });
    await setTint(SOURCES[0][1]);
    const st = await pageState();
    const bgRgb = (await rgba(st.bg)).rgb;
    const mean = bgRgb.reduce((a, b) => a + b, 0) / 3;
    assert.ok(mean < 96, `Lumen ${name}：这态的底色不该翻成浅色（rgb(${bgRgb.map(Math.round)})）`);
    const line = await rect(".FmKaba_lyricMainLine");

    const data = await shoot({
      x: Math.round(line.x), y: Math.round(line.y),
      width: Math.round(line.width), height: Math.round(line.height),
    }, `lyric-${name}`);

    const sung = ink(data, Math.round(line.width), 0, Math.floor(line.width / 2), bgRgb);
    assert.ok(sung.c >= 4.5, `Lumen ${name}：歌词墨色对比只有 ${sung.c.toFixed(2)}`);
    assert.equal(st.maskDark.trim(), engine.maskDark, `Lumen ${name}：改写了 AMLL 的未唱遮罩（引擎默认 ${engine.maskDark}，实际 ${st.maskDark}）`);
    assert.equal(st.subOpacity, engine.subOpacity, `Lumen ${name}：改写了 AMLL 的子行透明度（引擎默认 ${engine.subOpacity}，实际 ${st.subOpacity}）`);
    assert.equal(st.blend, engine.blend, `Lumen ${name}：动了 AMLL 的混合模式（应保持 ${engine.blend}）`);
    results.push(`${name}: 底色 rgb(${bgRgb.map(Math.round)}) / 歌词 ${sung.c.toFixed(2)} / 遮罩交还引擎`);
  }

  console.log(results.map((r) => `PASS ${r}`).join("\n"));
  console.log("\nLumen 正在播放页回归全绿");
} finally {
  await browser.close();
}
