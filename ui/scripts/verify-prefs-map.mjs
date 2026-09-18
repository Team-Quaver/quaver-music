// Quaver — 渲染层配置映射单测（纯 Node，不需要浏览器）。
// prefs.ts 是 TS + 依赖 DOM，这里用 vite 的 build API 现打包成 JS，再注入最小
// window/document/localStorage 桩，验证「配置文件取值 ⇄ 内部枚举」的双向映射与写盘键名
// —— 这层写错了最难从界面上看出来。
// 跑： node scripts/verify-prefs-map.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = mkdtempSync(join(tmpdir(), "quaver-prefs-"));
const OUT = join(OUT_DIR, "bundle.mjs");

// 临时入口：把 prefs 与 config 的导出合到一处（lib 模式单入口，写绝对路径最省事）
writeFileSync(join(OUT_DIR, "entry.ts"), `
export * from ${JSON.stringify(join(UI_ROOT, "src/lib/prefs.ts"))};
export { loadConfig, resetConfig, configInfo } from ${JSON.stringify(join(UI_ROOT, "src/lib/config.ts"))};
`);

const res = await viteBuild({
  configFile: false,
  logLevel: "error",
  define: { "import.meta.env.DEV": "true" }, // config.ts 的 dev 钩子分支
  build: {
    write: false,
    target: "esnext",
    minify: false,
    lib: { entry: join(OUT_DIR, "entry.ts"), formats: ["es"], fileName: () => "bundle.mjs" },
  },
});
const chunk = res[0].output.find((o) => o.type === "chunk");
writeFileSync(OUT, chunk.code);

// —— 最小 DOM 桩 ——
const ls = new Map();
const cssVars = new Map();
const htmlDataset = {};
const htmlClasses = new Set();
const bodyClasses = new Set();
const mkClassList = (set) => ({ toggle: (n, on) => (on ? set.add(n) : set.delete(n)), contains: (n) => set.has(n) });
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => void ls.set(k, String(v)),
  removeItem: (k) => void ls.delete(k),
};
globalThis.document = {
  documentElement: {
    dataset: htmlDataset,
    classList: mkClassList(htmlClasses),
    style: {
      setProperty: (k, v) => void cssVars.set(k, v),
      removeProperty: (k) => void cssVars.delete(k),
      getPropertyValue: (k) => cssVars.get(k) ?? "",
    },
  },
  body: { classList: mkClassList(bodyClasses) },
  addEventListener: () => {},
  visibilityState: "visible",
};
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  addEventListener: () => {},
  setTimeout,
  clearTimeout,
  // 故意不给 quaverCSD / quaverConfig：浏览器 dev 的形态
};

const P = await import(OUT);

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const conf = () => JSON.parse(ls.get("quaver.conf.v1") ?? "{}");
const seed = (o) => { ls.set("quaver.conf.v1", JSON.stringify(o)); };
const settle = () => new Promise((r) => setTimeout(r, 450)); // 等合并落盘窗口（400ms）走完

// ——— 默认值（无配置文件）———
section("默认值 / 回落");
await P.loadConfig();
eq("主题默认 dark", P.getTheme(), "dark");
eq("装饰默认 csd", P.getDecor(), "csd");
eq("关闭行为默认 tray", P.getCloseAction(), "tray");
eq("后端默认 MPV", P.getDecode(), "MPV");
eq("音质 fallback 默认 no-atmos", P.getFallbackSort(), "no-atmos");
eq("淡入淡出默认 normal", P.getFade(), "normal");
eq("音频设备默认 auto", P.getAudioDevice(), "auto");
eq("字体默认（留空 ⇒ 认成系统默认，走 Mi Sans VF 内置栈）", [P.getUiFont(), P.getLyricFont()], ["system", "system"]);
check("内置字体列表能被反查成预设", P.fontKeyOf('"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif') === "serif");
check("空字体值 = 系统默认", P.fontKeyOf("") === "system");
check("自定义字体族列表归为 custom", P.fontKeyOf('"LXGW WenKai", serif') === "custom");

// ——— 内部枚举 → 配置取值（写盘键名）———
section("写盘：内部枚举 → 配置取值");
P.setTheme("system");   eq("ThemeMode.system → follow-system", conf()["Style.Style"], "follow-system");
P.setTheme("light");    eq("ThemeMode.light → light", conf()["Style.Style"], "light");
P.setTheme("dark");     eq("ThemeMode.dark → dark", conf()["Style.Style"], "dark");
P.setDecode("Blink");   eq("Blink → Chromium", conf()["Playing.Backend"], "Chromium");
P.setDecode("MPV");     eq("MPV → MPV", conf()["Playing.Backend"], "MPV");
P.setFallbackSort("rank");  eq("rank → FallbackToQMAtmos=True", conf()["Quality.FallbackToQMAtmos"], "True");
P.setFallbackSort("no-atmos"); eq("no-atmos → False", conf()["Quality.FallbackToQMAtmos"], "False");
P.setDecor("ssd");      eq("Decor 键名", conf()["Window.Decor"], "ssd");
P.setCloseAction("quit"); eq("CloseAction 键名", conf()["Window.CloseAction"], "quit");
P.setAudioDevice("pipewire"); eq("AudioDevice 键名", conf()["Playing.AudioDevice"], "pipewire");
P.setFade("long");      eq("Fade 键名", conf()["Playing.Fade"], "long");
// 浏览器兜底模式存的是整份内存快照（键名应与 conf 的 Section.Key 完全一致，不能混进旧的 localStorage 键）
const keys = Object.keys(conf());
check("写盘键名齐全（Section.Key 风格）", [
  "Style.Style", "Style.DefaultUIFonts", "Style.DefaultLyricsFonts",
  "Window.Decor", "Window.CloseAction",
  "Playing.Backend", "Playing.AudioDevice", "Playing.Fade",
  "Quality.DefaultQuality", "Quality.FallbackToQMAtmos",
].every((k) => keys.includes(k)), keys.join(","));
check("没有旧 localStorage 键残留", !keys.some((k) => /^quaver\./.test(k)), keys.join(","));

// ——— 字体：预设下拉 + 可直接编辑的 font-family 列表 ———
section("字体：预设与手填");
P.setUiFontPreset("serif");
eq("预设即时写进内存（不等落盘）", P.getUiFontList(), P.FONT_PRESETS.serif.css);
check("--font-ui 生效", /serif/i.test(cssVars.get("--font-ui") ?? ""), cssVars.get("--font-ui"));
eq("写完能反查回同一预设", P.getUiFont(), "serif");
await settle();
check("预设落盘（合并 400ms 后）", /Source Han Serif SC/.test(conf()["Style.DefaultUIFonts"]), conf()["Style.DefaultUIFonts"]);

P.setUiFontPreset("system");
eq("system 预设写空值", P.getUiFontList(), "");
check("空值 = 移除 --font-ui（走内置默认栈）", !cssVars.has("--font-ui"), cssVars.get("--font-ui"));

// 设置页输入框走的就是这两条：applyList（逐字符）+ 失焦规范化
P.setUiFontList('"LXGW WenKai", "Noto Sans CJK SC"');
eq("手填即时可用", P.getUiFontList(), '"LXGW WenKai", "Noto Sans CJK SC"');
eq("手填后下拉切到「自定义」", P.getUiFont(), "custom");
check("手填生效到 CSS", /LXGW WenKai/.test(cssVars.get("--font-ui") ?? ""), cssVars.get("--font-ui"));
P.setUiFontList("  Source Han Sans ,   system-ui ,sans-serif  ");
eq("逗号与空白被规范化", P.getUiFontList(), "Source Han Sans, system-ui, sans-serif");
eq("规范化可独立调用（失焦回写用）", P.normalizeFontList("a ,  b ,, c"), "a, b, c");
P.setUiFontList('Bad; { } ] ) ( : url(http://x) "Real"');
check("手填被清洗成纯字体名字符", !/[;{}()\[\]:/]/.test(P.getUiFontList()), P.getUiFontList());
check("清洗后仍留下可用的字体名", /"Real"/.test(P.getUiFontList()), P.getUiFontList());
const keepBeforeCustom = P.getUiFontList();
P.setUiFontPreset("custom");
eq("选「自定义」不动配置（保持输入框内容）", P.getUiFontList(), keepBeforeCustom);
P.setUiFontList("");
await settle();
eq("清空 = 不覆盖（回落内置默认栈）", conf()["Style.DefaultUIFonts"], "");

// ——— 配置取值 → 内部枚举（读盘方向 / 兼容旧值）———
section("读盘：配置取值 → 内部枚举");
const reload = async (o) => { seed(o); await P.loadConfig(); };

await reload({ "Style.Style": "follow-system" });
eq("follow-system → system", P.getTheme(), "system");
await reload({ "Style.Style": "neon-night" });
eq("kebab 自定义主题暂按跟随系统处理", P.getTheme(), "system");
await reload({ "Playing.Backend": "Chromium" });
eq("Chromium → Blink", P.getDecode(), "Blink");
await reload({ "Playing.Backend": "Blink" });
eq("旧值 Blink 仍认（向后兼容）", P.getDecode(), "Blink");
await reload({ "Playing.Backend": "mpv" });
eq("大小写不符的取值回落 MPV", P.getDecode(), "MPV");
await reload({ "Quality.FallbackToQMAtmos": "True" });
eq("True → rank", P.getFallbackSort(), "rank");
await reload({ "Quality.FallbackToQMAtmos": "yes" });
eq("yes 也认成 True", P.getFallbackSort(), "rank");
await reload({ "Quality.FallbackToQMAtmos": "False" });
eq("False → no-atmos", P.getFallbackSort(), "no-atmos");
await reload({ "Playing.Fade": "nonsense" });
eq("非法 fade 回落 normal", P.getFade(), "normal");
await reload({ "Playing.AudioDevice": "" });
eq("空设备名回落 auto", P.getAudioDevice(), "auto");
await reload({ "Style.DefaultUIFonts": '"LXGW WenKai", serif' });
eq("自定义字体回显为 custom", P.getUiFont(), "custom");
P.applyFonts(); // loadConfig 只换内存快照，落到 <html> 要显式 apply（main.ts 启动时就是这么排的）
check("自定义字体照旧生效到 CSS", /LXGW WenKai/.test(cssVars.get("--font-ui") ?? ""), cssVars.get("--font-ui"));
await reload({ "Style.DefaultUIFonts": "sans" });
eq("直接写预设名也认", P.getUiFont(), "sans");
eq("预设名简写要展开成族列表（font-family: sans 是无效声明）", P.fontCssOf("sans"), P.FONT_PRESETS.sans.css);
P.applyFonts();
check("展开后 CSS 变量拿到的是族列表", /Noto Sans CJK SC/.test(cssVars.get("--font-ui") ?? ""), cssVars.get("--font-ui"));

// ——— 重置 ———
section("重置");
await P.resetConfig();
eq("重置回到默认", [P.getTheme(), P.getDecode(), P.getFade()], ["dark", "MPV", "normal"]);
eq("重置后的落盘值", conf()["Style.Style"], "dark");

// ——— 切主题时 data-theme 同步 ———
section("生效链路");
P.setTheme("light");
eq("data-theme 跟随", htmlDataset.theme, "light");
P.setTheme("system"); // matchMedia 桩 matches=false → light
eq("follow-system 落到 light（桩不偏好深色）", htmlDataset.theme, "light");
P.setDecor("ssd");
check("body.ssd 跟随", bodyClasses.has("ssd"));
P.setDecor("csd");
check("切回 csd 去掉 class", !bodyClasses.has("ssd"));

// ——— 桌面端形态：preload 的同步快照（sendSync）优先于 localStorage ———
section("桌面端启动快照（quaverConfig.boot）");
{
  ls.clear();
  ls.set("quaver.conf.v1", JSON.stringify({ "Style.Style": "light" })); // 应被 boot 快照盖过
  let setCalls = [];
  globalThis.window.quaverConfig = {
    boot: { ok: true, dir: "/x/Quaver Music", path: "/x/Quaver Music/quaver.conf", writable: true, values: { "Style.Style": "dark", "Playing.Volume": "0.42" } },
    set: (p) => { setCalls.push(p); return Promise.resolve({ ok: true }); },
    reveal: () => Promise.resolve({ ok: true }),
  };
  const D = await import(`${OUT}?desktop=1`); // 新实例：模块顶层的同步装载会再跑一次
  eq("boot 快照优先于 localStorage", D.getTheme(), "dark");
  eq("音量来自 boot 快照", D.getVolume(), 0.42);
  const inf = D.configInfo();
  check("路径信息来自主进程", inf.bridged && inf.path === "/x/Quaver Music/quaver.conf", JSON.stringify(inf));
  D.setTheme("light");
  eq("有桥时写走 IPC（不再碰 localStorage）", setCalls.length, 1);
  eq("IPC patch 是 Section.Key", Object.keys(setCalls[0]), ["Style.Style"]);
  eq("写桥后 localStorage 未被改写成全量", JSON.parse(ls.get("quaver.conf.v1"))["Style.Style"], "light");
  delete globalThis.window.quaverConfig;
}

// ——— 高频项合并落盘 ———
section("高频项（音量）合并落盘");
{
  ls.clear(); seed({});
  let calls = [];
  globalThis.window.quaverConfig = { boot: { ok: false }, set: (p) => { calls.push(p); return Promise.resolve({ ok: true }); } };
  const V = await import(`${OUT}?debounce=1`);
  for (const v of [0.1, 0.2, 0.3, 0.4, 0.5]) V.setVolume(v);
  eq("拖拽期间内存即时反映", V.getVolume(), 0.5);
  check("尚未落盘（合并在等窗口）", calls.length === 0, `calls=${calls.length}`);
  await new Promise((r) => setTimeout(r, 400));
  eq("窗口到期只写一次", calls.length, 1);
  eq("写的是最后一个值", calls[0]["Playing.Volume"], "0.5");
  check("相同值不产生写入", (V.setVolume(0.5), await new Promise((r) => setTimeout(r, 400)), calls.length === 1), `calls=${calls.length}`);
  eq("静音写入 Muted", (V.setMuted(true), await new Promise((r) => setTimeout(r, 50)), calls.at(-1)["Playing.Muted"]), "True");
  delete globalThis.window.quaverConfig;
}

rmSync(OUT_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-prefs-map: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
