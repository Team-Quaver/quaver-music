// Quaver — 打包形状护栏（Rolldown 产物的「谁在首屏、谁按需求」）
// 跑：  node scripts/verify-bundle.ts      （产物过期会自动重 build，见下）
//
// 为什么不是「总大小不超过 X」这种断言：bundle 总字节会随依赖漂移，而且**总量本来就不是问题**
// —— 真正决定首屏体验与常驻内存的是「入口的静态闭包」有多大。所以这里钉的是形状：
//   ① 两个真入口（SPA 壳 / 桌面歌词覆盖层）各自的首屏静态闭包在预算内；
//   ② 重量级依赖必须留在懒加载侧：AMLL（~400KB）、繁简词典（~1MB）、更新链路（~22KB）；
//   ③ 视图必须按路由分块，任何一块都不许回退成静态；
//   ④ 除词典数据块外，没有 chunk 越过 500KB；
//   ⑤ modulepreload polyfill 不在产物里（运行时只有 Electron 的 Chromium，那份探测是死码）。
// 谁把动态 import 改回静态、或往壳层塞了个大依赖，这里立刻红，而不是等到有人在
// 低端机上问「为什么启动慢了两秒」。
import { build } from "vite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const UI = resolve(import.meta.dirname, "..");
const DIST = join(UI, "dist");
const MANIFEST = join(DIST, ".vite", "manifest.json");
const GRAPH = join(DIST, ".vite", "chunk-graph.json");

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

// ——— 产物新鲜度：源码比清单新就重新 build（护栏验的是**当前源码**，不是上周的 dist）———
function newestMtime(dir: string, exts: string[]): number {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) m = Math.max(m, newestMtime(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) m = Math.max(m, statSync(p).mtimeMs);
  }
  return m;
}
const stale = !existsSync(MANIFEST) || !existsSync(GRAPH)
  || newestMtime(join(UI, "src"), [".ts", ".css", ".html"]) > statSync(MANIFEST).mtimeMs
  || statSync(join(UI, "vite.config.ts")).mtimeMs > statSync(MANIFEST).mtimeMs;
if (stale) {
  console.log("  …产物缺失或落后于源码，重新构建（Rolldown 一次约 0.3s）");
  await build({ configFile: join(UI, "vite.config.ts"), logLevel: "error" });
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, {
  file?: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; css?: string[]; src?: string;
}>;
const graph = JSON.parse(readFileSync(GRAPH, "utf8")) as Record<string, {
  kind: string; bytes: number; modules: { id: string; bytes: number }[];
}>;
const keyByFile = new Map(Object.keys(manifest).map((k) => [manifest[k]!.file, k]));
const bytesOf = (rel: string) => graph[rel]?.bytes ?? (existsSync(join(DIST, rel)) ? statSync(join(DIST, rel)).size : 0);

/** 入口的静态闭包：沿 manifest.imports 递归（dynamicImports 一律不算 —— 那正是本文件要守的边界）。 */
function staticClosure(entryKey: string): string[] {
  const out: string[] = [];
  const walk = (k: string) => {
    const c = manifest[k];
    if (!c?.file || out.includes(c.file)) return;
    out.push(c.file);
    for (const i of c.imports ?? []) walk(keyByFile.get(i) ?? i);
  };
  walk(entryKey);
  return out;
}
const moduleIdsIn = (files: string[]) => files.flatMap((f) => (graph[f]?.modules ?? []).map((m) => m.id));

section("构建图产物");
check("chunk-graph.json 存在（vite.config 的 quaver-chunk-graph 插件在跑）", Object.keys(graph).length > 0);
const entries = Object.keys(manifest).filter((k) => manifest[k]?.isEntry && /\.html$/.test(k));
check("两个真入口都在（SPA 壳 + 桌面歌词覆盖层）",
  entries.includes("index.html") && entries.includes("desktop-lyrics.html"), entries.join(","));

const BUDGET: Record<string, number> = { "index.html": 200_000, "desktop-lyrics.html": 520_000 };
section("首屏静态闭包预算（入口 + 它静态引到的一切）");
const closures: Record<string, string[]> = {};
for (const e of entries) {
  closures[e] = staticClosure(e);
  const js = closures[e]!.reduce((s, f) => s + bytesOf(f), 0);
  const css = [...new Set(closures[e]!.flatMap((f) => manifest[keyByFile.get(f)!]?.css ?? []))];
  const cssBytes = css.reduce((s, f) => s + bytesOf(f), 0);
  check(`${e} 首屏 JS ${kb(js)} ≤ ${kb(BUDGET[e] ?? 0)}`, js <= (BUDGET[e] ?? 0));
  check(`${e} 首屏 CSS ${kb(cssBytes)} ≤ ${kb(80_000)}`, cssBytes <= 80_000);
  console.log(`      ${closures[e]!.map((f) => `${f.split("/").pop()}=${(bytesOf(f) / 1024).toFixed(0)}k`).join(" ")}`);
}
// 桌面歌词覆盖层的职责就是渲染逐字歌词：AMLL 允许进它的静态闭包（否则首帧空白），
// 但绝不允许进主窗首屏。
const mainClosure = closures["index.html"] ?? [];
const mainModules = moduleIdsIn(mainClosure);
const dlClosure = closures["desktop-lyrics.html"] ?? [];

section("重量级依赖必须在懒加载侧（主窗口）");
for (const [label, re] of [
  ["AMLL 歌词引擎（@applemusic-like-lyrics）", /@applemusic-like-lyrics/],
  ["繁简词典（opencc-js）", /opencc-js/],
  ["更新链路（lib/updater.ts）", /lib\/updater\.ts/],
] as [string, RegExp][]) {
  check(`主窗首屏不含 ${label}`, !mainModules.some((id) => re.test(id)));
}
check("主窗首屏不含任何路由视图实现（src/views/<页面>.ts）",
  !mainModules.some((id) => /src\/views\/(?!index|_shared)[a-z-]+\.ts$/.test(id)),
  mainModules.filter((id) => /src\/views\//.test(id)).join(","));

section("视图按路由分块");
const viewChunks = Object.keys(graph).filter((f) => /^assets\/(home|search|guess|daily|liked|local|playlist|playlists|singer|singer-albums|album|settings|log|user|login)-/.test(f));
for (const v of ["home", "search", "guess", "daily", "liked", "local", "playlist", "playlists", "singer", "album", "settings", "log", "user", "login"]) {
  check(`视图 ${v} 独立成块`, viewChunks.some((f) => f.startsWith(`assets/${v}-`)));
}
check("设置页块是真的（≥30KB，说明整页代码在里面而不是空壳）",
  viewChunks.filter((f) => f.startsWith("assets/settings-")).reduce((s, f) => s + bytesOf(f), 0) >= 30_000);

section("chunk 体积上限（词典数据块除外）");
const OVER = Object.entries(graph).filter(([, i]) => i.bytes > 500_000);
eq("越过 500KB 的只有 cjk-* 词典块", OVER.map(([f]) => f.split("/").pop()!.split("-")[0]).sort(), ["cjk"]);
for (const [f, i] of OVER) {
  check(`${f.split("/").pop()} 是懒加载可达（不在任何入口静态闭包）`,
    ![...mainClosure, ...dlClosure].includes(f) && !i.kind.startsWith("entry"), `kind=${i.kind}`);
}

section("modulepreload polyfill 不进产物");
const allJs = readdirSync(join(DIST, "assets")).filter((f) => f.endsWith(".js"));
const polyfilled = allJs.filter((f) => {
  const t = readFileSync(join(DIST, "assets", f), "utf8");
  // polyfill 的形状：relList 探测 + MutationObserver 补挂已存在的 link。二者同现一块 = 它回来了。
  return t.includes("relList") && t.includes("MutationObserver");
});
check("产物里没有 modulepreload polyfill（运行时只有 Electron 的 Chromium，那段是死码）",
  polyfilled.length === 0, polyfilled.join(","));

section("拆分护栏：不许把视图改回静态导入");
const srcFiles = ["src/shell.ts", "src/main.ts", ...readdirSync(join(UI, "src/components")).map((f) => `src/components/${f}`)];
const staticViewsImport = srcFiles.filter((f) => {
  const t = readFileSync(join(UI, f), "utf8");
  return /import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\.?\/views(?:\/index)?"/.test(t) && !/loadView|prefetchView/.test(t);
});
eq("没有对视图表的静态整体导入（只允许 loadView/prefetchView 那两把钥匙）", staticViewsImport, []);

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-bundle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
