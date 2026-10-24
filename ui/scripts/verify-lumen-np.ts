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

  for (const scheme of ["light", "dark"] as const) {
    for (const [label, hex] of SOURCES) {
      await setDataset({ theme: scheme, sparkleTheme: "md3", md3Np: "on", md3NpColor: "theme" });
      await setTint(hex);
      const tag = `${scheme}/${label}`;
      // 截图文件名不能带 /（tag 是给人看的，文件名用它就会 ENOENT 把整轮跑崩）
      const slug = `${scheme}-${label}`;
      const st = await pageState();
      const bgRgb = (await rgba(st.bg)).rgb;

      // —— ① 逐字歌词（AMLL）：混合模式 + 已唱/未唱/翻译的真实像素对比 ——
      assert.equal(st.blend, "plus-lighter",
        `Lumen ${tag}：AMLL 的加光混合被改成 ${st.blend} —— 这条是主题最终口径，不许静默回落`);
      const line = await rect(".FmKaba_lyricMainLine");

      const data = await shoot({
        x: Math.round(line.x), y: Math.round(line.y),
        width: Math.round(line.width), height: Math.round(line.height),
      }, `lyric-${slug}`);

      const half = Math.floor(line.width / 2);
      const sung = ink(data, Math.round(line.width), 0, half, bgRgb);
      const unsung = ink(data, Math.round(line.width), half, Math.round(line.width), bgRgb);
      assert.ok(sung.c >= 4.5, `Lumen ${tag}：已唱部分对比 ${sung.c.toFixed(2)}（应 ≥ 4.5）rgb(${sung.rgb.map(Math.round)})`);
      assert.ok(unsung.c >= 3, `Lumen ${tag}：未唱部分对比 ${unsung.c.toFixed(2)}（大字 AA 应 ≥ 3；这半句决定扫色读不读得出）`);
      const sub = await rect(".FmKaba_lyricSubLine");

      const subData = await shoot({
        x: Math.round(sub.x), y: Math.round(sub.y),
        width: Math.round(sub.width), height: Math.round(sub.height),
      }, `aux-${slug}`);

      const aux = ink(subData, Math.round(sub.width), 0, Math.round(sub.width), bgRgb);
      assert.ok(aux.c >= 3, `Lumen ${tag}：翻译辅助行对比 ${aux.c.toFixed(2)}（应 ≥ 3）`);
      assert.equal(st.karaShadow, "none", `Lumen ${tag}：接管态歌词还挂着深色页的 text-shadow（浅色底下发糊）`);
      results.push(`逐字 ${tag}: blend=${st.blend} 已唱 ${sung.c.toFixed(2)} / 未唱 ${unsung.c.toFixed(2)} / 翻译 ${aux.c.toFixed(2)} mask=${st.maskDark.trim() || "默认"} sub=${st.subOpacity}`);

      // —— ② 行级回退列表（无逐字数据时的这条路）——
      await toggle("kara", false);
      const listBg = st.bg;

      const cur = await page.evaluate(() => {
        const c = getComputedStyle(document.querySelector(".np-ly-line.cur")!);
        const o = getComputedStyle(document.querySelector(".np-ly-line:not(.cur)")!);
        const e = getComputedStyle(document.querySelector(".np-ly-empty")!);

        return { cur: c.color, curA: c.opacity, other: o.color, otherA: o.opacity, empty: e.color };
      });

      const curC = contrast(await composite(cur.cur, Number(cur.curA), listBg), await composite(listBg, 1, listBg));
      const otherC = contrast(await composite(cur.other, Number(cur.otherA), listBg), await composite(listBg, 1, listBg));
      const emptyC = contrast(await composite(cur.empty, 1, listBg), await composite(listBg, 1, listBg));
      await toggle("kara", true);
      assert.ok(curC >= 4.5, `Lumen ${tag}：行级当前句对比 ${curC.toFixed(2)}`);
      assert.ok(otherC >= 1.8, `Lumen ${tag}：行级非当前句雾化到 ${otherC.toFixed(2)}（该看得出「有一行字」）`);
      assert.ok(emptyC >= 3, `Lumen ${tag}：「暂无歌词」提示对比 ${emptyC.toFixed(2)}`);
      results.push(`行级 ${tag}: 当前句 ${curC.toFixed(2)} / 非当前句 ${otherC.toFixed(2)} / 空态 ${emptyC.toFixed(2)}`);

      // —— ③ 页内浮层：菜单与音质胶囊不能吃「恒深色玻璃」那套白字 ——
      const menuBg = await composite(st.menuSurface, 1, st.bg);
      const menuC = contrast(await composite(st.menuInk, 1, st.menuSurface), menuBg);
      const pillC = contrast(await composite(st.pillColor, 1, st.pillBg), await composite(st.pillBg, 1, st.bg));
      const titleC = contrast(await composite(st.title, 1, st.bg), bgRgb);
      assert.ok(menuC >= 4.5, `Lumen ${tag}：页内菜单文字对比 ${menuC.toFixed(2)}`);
      assert.ok(pillC >= 3, `Lumen ${tag}：音质胶囊文字对比 ${pillC.toFixed(2)}（白字压在浅底上=隐形）`);
      assert.ok(titleC >= 4.5, `Lumen ${tag}：歌名对比 ${titleC.toFixed(2)}`);
      results.push(`浮层 ${tag}: 菜单 ${menuC.toFixed(2)} / 音质胶囊 ${pillC.toFixed(2)} / 歌名 ${titleC.toFixed(2)}`);

      // —— ④ 封面投影：播放有 / 暂停无 / 深色也看得见 / 颜色跟 Tint ——
      // .np-meta 就在封面正下方，歌名是实心深色字 —— 不藏掉它，采样条里最“黑”的像素是文字
      await page.evaluate(() => {
        const st = document.createElement("style");
        st.id = "hide-meta"; st.textContent = ".np-meta{visibility:hidden}"; document.head.append(st);
      });
      const cover = await rect(".np-cover-wrap");

      const strip = {
        x: Math.round(cover.x + cover.width * 0.3),
        y: Math.round(cover.y + cover.height + 12),
        width: Math.round(cover.width * 0.4),
        height: 16,
      };

      const on = ink(await shoot(strip, `cover-${slug}-playing`), strip.width, 0, strip.width, bgRgb);
      await toggle("playing", false);
      const off = ink(await shoot(strip, `cover-${slug}-paused`), strip.width, 0, strip.width, bgRgb);
      await toggle("playing", true);
      assert.ok(on.c >= 1.12, `Lumen ${tag}：播放中封面投影看不出差别（${on.c.toFixed(3)}）—— 深色底上纯黑投影等于没画`);
      assert.ok(off.c <= 1.02, `Lumen ${tag}：暂停后投影没收回（${off.c.toFixed(3)}）—— 「暂停收阴影」是宿主定的行为`);
      results.push(`投影 ${tag}: 播放 ${on.c.toFixed(3)} / 暂停 ${off.c.toFixed(3)} · ${st.coverShadow}`);

      const otherIdx = label === SOURCES[0][0] ? 1 : 0;
      const other = SOURCES[otherIdx];
      await setTint(other[1]);
      const st2 = await pageState();
      const bgRgb2 = (await rgba(st2.bg)).rgb;
      const shifted = ink(await shoot(strip, `cover-${scheme}-${other[0]}-playing`), strip.width, 0, strip.width, bgRgb2);
      await setTint(hex);

      const hueOfShadow = (spec: string) => {
        const m = /lch\(([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(spec);

        return m ? Number(m[3]) : NaN;
      };

      const h1 = hueOfShadow(st.coverShadow), h2 = hueOfShadow(st2.coverShadow);
      assert.ok(!Number.isNaN(h1) && !Number.isNaN(h2),
        `Lumen ${scheme}：封面投影不是 Tint 派生的 lch()（计算值 ${st.coverShadow || "空"} / ${st2.coverShadow || "空"}）`);
      const dh = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));
      assert.ok(shifted.c >= 1.12, `Lumen ${scheme}/${other[0]}：换这套 Tint 后投影反而看不见（${shifted.c.toFixed(3)}）`);
      assert.ok(dh >= 15, `Lumen ${scheme}：投影色相不跟 Tint —— ${label} H=${h1.toFixed(0)}° vs ${other[0]} H=${h2.toFixed(0)}°（只差 ${dh.toFixed(1)}°）`);
      await page.evaluate(() => document.querySelector("#hide-meta")?.remove());

      if (shots) writeFileSync(`${shots}/page-${slug}.png`, Buffer.from(await page.screenshot()));
      results.push(`投影跟 Tint ${scheme}: ${label} H=${h1.toFixed(0)}° → ${other[0]} H=${h2.toFixed(0)}°`);
    }
  }

  // —— ⑤ 不接管态不许被浅色修功误伤：它恒为深底，引擎默认口径才是对的 ——
  for (const [name, patch] of [["不接管", { md3Np: "off" }]] as const) {
    await setDataset({ theme: "light", sparkleTheme: "md3", md3Np: "on", md3NpColor: "theme" });
    await setDataset(patch as Record<string, string>);
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
