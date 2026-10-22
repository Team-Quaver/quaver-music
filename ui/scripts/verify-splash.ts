// Quaver — 启动闪屏（electron/splash.ts / splash-page.ts / splash.html + main.ts 接线）
// 单测与源码护栏。跑：  node scripts/verify-splash.ts
//
// 抓的三类回归：
//   • 素材/模板：图标瘦身必须真把 C2PA 元数据剥掉（35KB → 绘图本体）；模板占位符/关键动画
//     状态/降级路径都在；底色常量与 style.css、主窗 backgroundColor 三方逐字一致 —— 闪屏
//     与主窗交接的是同一条底色。
//   • 纯逻辑：strip/build/时序常量的行为断言（splash-page 不 import electron，可直接单测）。
//   • 接线护栏（源码正则）：闪屏是**主窗口自身的同窗覆盖层**（不是独立小窗）——建窗与
//     loadSplash 必须先于 sidecar 慢路径，dismissSplash 必须先于应用导航；冷启动才放闪屏
//     （warmBoot 门控）；did-finish-load 按 data: 分流；splash.ts 不得值导入 electron。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPLASH_BG_DARK, SPLASH_BG_LIGHT, SPLASH_FADE_MS, SPLASH_MIN_MS,
  buildSplashHtml, splashBackgroundColor, stripSplashIconMarkup,
} from "../electron/splash-page.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, "..");
const src = (p: string) => readFileSync(join(UI, p), "utf8");

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ——— 1. 图标瘦身 ———
section("stripSplashIconMarkup（真素材）");

const iconRaw = src("public/quaver-icon-dark.svg");
const iconStripped = stripSplashIconMarkup(iconRaw);

check("输入确实是设计源（含 C2PA 元数据块）", /<metadata/.test(iconRaw) && /c2pa/i.test(iconRaw));

check("剥掉 <metadata> 与 c2pa", !/<metadata/i.test(iconStripped) && !/c2pa/i.test(iconStripped));

check("剥掉注释/XML 声明/title/desc", !/<!--/.test(iconStripped) && !/<\?xml/.test(iconStripped)
  && !/<title/.test(iconStripped) && !/<desc/.test(iconStripped));

check("剥掉根节点 id/role/aria 与杂 xmlns", !/\bid="/.test(iconStripped) && !/role=/.test(iconStripped)
  && !/aria-labelledby=/.test(iconStripped) && !/xmlns:(rdf|cc|dc|c2pa|svg)=/.test(iconStripped));

check("绘图本体还在（<svg + 主色 #29b8ff + rect/path）",
  iconStripped.startsWith("<svg") && iconStripped.includes("#29b8ff") && /<path /.test(iconStripped) && /<rect /.test(iconStripped));

// 实测瘦身大头是元数据（约 9KB），绘图路径本体 ~26KB 才是体积主体 —— 阈值按实测口径钉：
// 剥掉必须见肉（<80%），且总量守在 data: URL 的舒适区（远低于 2MB 导航上限，留足余量）。
check("瘦身后显著变小（元数据确被剥掉）", iconStripped.length < iconRaw.length * 0.8,
  `raw=${iconRaw.length} stripped=${iconStripped.length}`);

check("瘦身后仍在 data: URL 的体量安全区（<30KB）", iconStripped.length < 30000, `${iconStripped.length}B`);

// ——— 2. 模板拼装 ———
section("buildSplashHtml");

const tpl = src("electron/splash.html");
const darkHtml = buildSplashHtml(tpl, { iconSvg: iconStripped, dark: true });
const lightHtml = buildSplashHtml(tpl, { iconSvg: "", dark: false });

check("占位符全部消费掉（两档主题各一次）",
  !darkHtml.includes("__ICON__") && !darkHtml.includes("__THEME__")
  && !lightHtml.includes("__ICON__") && !lightHtml.includes("__THEME__"));

check("主题落到 data-theme", darkHtml.includes('data-theme="dark"') && lightHtml.includes('data-theme="light"'));

check("图标注入 & 空图标降级合法（不炸、仍是整页）",
  darkHtml.includes(iconStripped) && lightHtml.includes("<body>") && lightHtml.includes('class="foot"'));

check("文案：字标与底部署名逐字在", darkHtml.includes(">Quaver</span>") && darkHtml.includes(">Music</span>")
  && darkHtml.includes("Built by Team Quaver"));

check("模板缺占位时抛错（不静默出半页）",
  (() => { try { buildSplashHtml("<html><body>x</body></html>", { iconSvg: "", dark: true }); return false; } catch { return true; } })());

// ——— 3. 底色三方同源 ———
section("底色一致性（splash-page ⇄ splash.html ⇄ style.css ⇄ 主窗）");

const styleCss = src("src/style.css");

check("常量对上 style.css 的 --bg 两档",
  styleCss.includes(`--bg: ${SPLASH_BG_LIGHT};`) && styleCss.includes(`--bg: ${SPLASH_BG_DARK};`));

const tplDark = tpl.match(/html\[data-theme="dark"\]\s*\{[^}]*--bg:\s*(#[0-9a-f]{6})/i)?.[1];
const tplLight = tpl.match(/html\[data-theme="light"\]\s*\{[^}]*--bg:\s*(#[0-9a-f]{6})/i)?.[1];

check("splash.html 的 --bg 与常量逐字一致", tplDark === SPLASH_BG_DARK && tplLight === SPLASH_BG_LIGHT,
  `tpl=${tplDark}/${tplLight}`);

check("主窗 backgroundColor 用的是同两个值", /backgroundColor:\s*bootDark\s*\?\s*"#131417"\s*:\s*"#f7f7f8"/.test(src("electron/main.ts")));

check("splashBackgroundColor 选档正确", splashBackgroundColor(true) === SPLASH_BG_DARK && splashBackgroundColor(false) === SPLASH_BG_LIGHT);

// ——— 4. 模板动画关键件 ———
section("splash.html 动画关键件");

check("四段关键帧齐（pop/glide/word-in/rise）", ["pop", "glide", "word-in", "rise"].every((k) => tpl.includes(`@keyframes ${k}`)));

check("动画定住到 .go（实测 --shift 后才放行）", tpl.includes("body:not(.go)") && tpl.includes('classList.add("go")'));

check("--shift 用布局量实测（offsetWidth，不吃 transform）", tpl.includes("word.offsetWidth"));

check("退场淡出由 .closing 驱动且与 SPLASH_FADE_MS 同量级",
  tpl.includes("body.closing") && /transition:opacity\s*\.3/.test(tpl) && SPLASH_FADE_MS >= 320 && SPLASH_FADE_MS <= 500);

check("prefers-reduced-motion 降级为纯淡入", tpl.includes("prefers-reduced-motion"));

check("无边框可拖 + CSP 收紧 + 禁选中", tpl.includes("-webkit-app-region:drag") && tpl.includes("Content-Security-Policy") && tpl.includes("user-select:none"));

// ——— 5. 时序常量 ———
section("时序常量");

// MIN 必须盖住四段动画全程（pop .1+.75 / glide 1+.8 / word 1.15+.55 / foot 1.45+.55 → 2.0s 收）：
// 这正是「底部 Built by Team Quaver 还没露头就被换掉」事故的回归钉。上限防快机器被无谓拖住。
check("MIN 覆盖动画全程（含底部署名，2.2s ≤ MIN ≤ 3s）", SPLASH_MIN_MS >= 2200 && SPLASH_MIN_MS <= 3000);

check("FADE 与模板 transition 同量级", SPLASH_FADE_MS >= 320 && SPLASH_FADE_MS <= 500);

// ——— 6. 接线护栏（源码正则） ———
section("main.ts / splash.ts 接线（同窗覆盖层架构）");

const mainTs = src("electron/main.ts");
const splashTs = src("electron/splash.ts");
const bootSidecar = mainTs.indexOf("sidecar = spawnSidecar();");
const createWinIdx = mainTs.indexOf("win = new BrowserWindow({");
const loadIdx = mainTs.indexOf("loadSplash(win, {");
const dismissIdx = mainTs.indexOf("await dismissSplash(win);");
const navIdx = mainTs.indexOf("win.loadURL(url);");

check("先建窗、先放闪屏，再进 sidecar 慢路径（空窗期有画面）",
  createWinIdx >= 0 && createWinIdx < loadIdx && loadIdx < bootSidecar, `create=${createWinIdx} load=${loadIdx} sidecar=${bootSidecar}`);

check("闪屏收场（最短驻留+淡出）先于应用导航", dismissIdx > bootSidecar && dismissIdx < navIdx);

check("warmBoot 门控：重建/集成测试路径不放闪屏",
  mainTs.includes("const warmBoot = !!cachedUrl || !!process.env.QUAVER_URL;") && mainTs.includes("if (!warmBoot) {"));

check("did-finish-load 按 data: 分流（闪屏不算应用加载完成）", mainTs.includes('startsWith("data:")'));

check("did-fail-load 忽略 -3（闪屏→应用导航的正常掐帧）", /did-fail-load[\s\S]{0,140}code !== -3/.test(mainTs));

check("whenReady 里不再有独立闪屏窗的残留（showSplash/closeSplash）",
  !mainTs.includes("showSplash") && !mainTs.includes("closeSplash") && !mainTs.includes("splashHandle"));

check("图标候选按态排序（dist → public → img）",
  (() => { const i = mainTs.indexOf("iconCandidates:"); const seg = mainTs.slice(i, i + 400);

    return seg.indexOf('join(DIST, "quaver-icon-dark.svg")') < seg.indexOf('join(UI_ROOT, "public"')
      && seg.indexOf('join(UI_ROOT, "public"') < seg.indexOf('join(UI_ROOT, "img"'); })());

check("splash.ts 零 electron 值导入（import type 可）：裸 node 可载",
  !splashTs.includes("new BrowserWindow") && !/^import \{[^}]*\} from "electron"/m.test(splashTs) && splashTs.includes('import type { BrowserWindow }'));

check("闪屏页走 data: URL（与后端就绪解耦）", splashTs.includes('"data:text/html;charset=utf-8,"'));

check("收场：压 MIN → 页面淡出 → 导航接管（executeJavaScript closing）",
  splashTs.includes("SPLASH_MIN_MS - Date.now()") && splashTs.includes('classList.add("closing")'));

check("闪屏失败只记账不抛（模板/拼装失败 = 跳过，启动主链不受影响）",
  splashTs.includes("跳过闪屏") && splashTs.includes("catch (e)"));

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);

process.exit(fail ? 1 : 0);
