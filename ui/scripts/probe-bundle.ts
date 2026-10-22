// Quaver — 打包与内存探针（量尺，不是闸门）
//
// ①静态面：读 dist/.vite/manifest.json，算每个入口「首屏静态闭包」到底要下载+解析多少字节，
//   并把懒加载可达的 chunk 单列 —— 这是 code splitting 的唯一真相，别拿 bundle 总大小自嗨。
// ②活体面：自己起一个隔离 Electron（独立 QUAVER_CONFIG_DIR + Crotchet 调试端口），连 CDP 按
//   固定里程碑驱动真界面，逐点采样 JS 堆 / 进程树 RSS / DOM 节点 / 监听器 / 脚本耗时，
//   落到 /tmp/quaver-perf/<label>.json，改前改后各测一次即可对比。
//
// 用法：
//   pnpm run build                     # 先出产物（含 manifest）
//   node scripts/probe-bundle.ts --static
//   node scripts/probe-bundle.ts --label base
//   node scripts/probe-bundle.ts --live-only --label after   # 已开着应用时只测活体
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const UI = import.meta.dirname.replace(/\/scripts$/, "");
const DIST = join(UI, "dist");
const PERIODIR = process.env.QUAVER_PROBE_DIR || "/tmp/quaver-perf";
const PORT = Number(process.env.QUAVER_PROBE_PORT || 9333);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, dflt) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const LABEL = opt("label", "run");
const kb = (n) => (n / 1024).toFixed(1).padStart(8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— ① 静态面 ——

function manifest() {
  const p = join(DIST, ".vite", "manifest.json");

  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

const bytes = (rel) => { const f = join(DIST, rel); return existsSync(f) ? statSync(f).size : 0; };

function reportStatic() {
  const m = manifest();
  const keys = Object.keys(m);
  console.log("\n=== ① 产物 dist/ ===");

  if (!keys.length) { console.log("  ⚠ 缺 dist/.vite/manifest.json"); return {}; }

  const byFile = new Map(keys.map((k) => [m[k].file, k]));

  const closure = (entryKey) => {
    const seen = [];

    const walk = (k) => {
      const c = m[k];

      if (!c?.file || seen.includes(c.file)) return;
      seen.push(c.file);

      for (const i of c.imports ?? []) walk(byFile.get(i) ?? i);
    };

    walk(entryKey);

    return seen;
  };

  const out = { entries: {}, chunks: {} };

  for (const e of keys.filter((k) => m[k].isEntry)) {
    const files = closure(e);
    const js = files.reduce((s, f) => s + bytes(f), 0);
    const css = [...new Set(files.flatMap((f) => m[byFile.get(f)]?.css ?? []))];
    const cssBytes = css.reduce((s, f) => s + bytes(f), 0);
    const lazy = [...new Set(files.flatMap((f) => m[byFile.get(f)]?.dynamicImports ?? []).map((k) => m[k]?.file).filter(Boolean))];
    const lazyBytes = lazy.reduce((s, f) => s + bytes(f), 0);
    out.entries[e] = { js, cssBytes, lazyBytes, files, css, lazy };
    console.log(`  ${e.padEnd(22)} 首屏 JS ${kb(js)}KB/${files.length}chunk + CSS ${kb(cssBytes)}KB ｜ 懒加载可达 ${kb(lazyBytes)}KB/${lazy.length}`);
    console.log(`      ${files.map((f) => `${f.split("/").pop()}=${(bytes(f) / 1024).toFixed(0)}k`).join("  ")}`);

    if (lazy.length) console.log(`      lazy→ ${lazy.map((f) => `${f.split("/").pop()}=${(bytes(f) / 1024).toFixed(0)}k`).join("  ")}`);
  }

  const graphPath = join(DIST, ".vite", "chunk-graph.json");
  const graph = existsSync(graphPath) ? JSON.parse(readFileSync(graphPath, "utf8")) : {};
  console.log("\n  chunk 明细（体积降序；类型与最大来源）：");

  for (const rel of Object.keys(graph).sort((a, b) => (graph[b]?.bytes ?? 0) - (graph[a]?.bytes ?? 0))) {
    const g = graph[rel];
    const mods = g.modules ?? [];
    const top = mods.slice(0, 2).map((t) => t.id.replace(/^.*(node_modules|src|vendor|third_party)/, "$1").slice(0, 44)).join(" · ");
    console.log("    " + kb(g.bytes) + "KB " + rel.split("/").pop().padEnd(26) + " " + g.kind.padEnd(8) + String(mods.length).padStart(3) + " mods" + (top ? " ｜ " + top : ""));
    out.chunks[rel] = { bytes: g.bytes, kind: g.kind, modules: mods.map((m) => m.id) };
  }

  console.log("  （chunk-graph 每块只留最大的 60 个模块；全量在 dist/.vite/chunk-graph.json）");

  return out;
}

// —— ② 活体面 ——

function treePids() {
  const all = readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d));
  const cmd = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } };
  const ppid = (pid) => { try { return readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s*(\d+)/m)?.[1] ?? ""; } catch { return ""; } };
  const roots = all.filter((pid) => { const c = cmd(pid); return c.includes("electron") && !c.includes("--type=") && c.includes(UI) && !c.includes("probe-bundle"); });
  const seen = new Set();
  const walk = (pid) => { if (seen.has(pid)) return; seen.add(pid); for (const p of all) if (ppid(p) === pid) walk(p); };

  roots.forEach(walk);

  const withSidecar = [...seen].filter((pid) => cmd(pid).includes("typhoeus") || cmd(pid).includes("mpv") || cmd(pid).includes("quaver-server"))
    .concat([...seen].map((pid) => pid));

  return [...new Set(withSidecar)];
}

const rssOf = (pid) => { try { return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s*(\d+) kB/m)?.[1] ?? 0) * 1024; } catch { return 0; } };

async function live() {
  mkdirSync(PERIODIR, { recursive: true });
  let proc = null;

  if (!flag("live-only")) {
    const cfgDir = join(PERIODIR, LABEL);
    mkdirSync(cfgDir, { recursive: true });
    console.log(`\n=== ② 活体：起 Electron（QUAVER_CONFIG_DIR=${cfgDir}, inspect :${PORT}）===`);
    proc = spawn(process.env.QUAVER_PROBE_ELECTRON || join(UI, "node_modules/.bin/electron"), ["."], {
      cwd: UI, detached: true,
      env: { ...process.env, QUAVER_CONFIG_DIR: cfgDir, QUAVER_CROTCHET: String(PORT) },
      stdio: ["ignore", openSync(join(PERIODIR, `${LABEL}.electron.log`), "w"), "ignore"],
    });
  }

  let url = null;

  for (let i = 0; i < 45 && !url; i++) {
    await sleep(1000);

    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      url = list.find((t) => t.type === "page" && !/desktop-lyrics/.test(t.url) && /:\d+\//.test(t.url))?.url ?? null;
    } catch { /* 还在起 */ }
  }

  if (!url) { console.log("  ❌ CDP 上没有应用页面"); return {}; }

  console.log(`  已连: ${url}`);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });
  const page = (await browser.pages()).find((p) => p.url() === url);
  const cdp = await page.createCDPSession();
  // 懒加载缝坏掉的第一信号是控制台报错（404 的 chunk、被 CSP 拦的 import）——全程收集，最后点名
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e && e.message || e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text().slice(0, 160)); });
  await cdp.send("Performance.enable");
  const samples = [];

  const sample = async (name) => {
    let perf;

    try { perf = await cdp.send("Performance.getMetrics"); }
    catch (e) { console.log(`  ⚠ ${name}: 页面已断开（${String(e).slice(0, 60)}）—— 应用可能被关掉/崩溃，后续读数不可信`); return; }

    const g = (k) => perf.metrics.find((x) => x.name === k)?.value ?? 0;
    const heap = await cdp.send("Runtime.getHeapUsage");

    const res = await page.evaluate(() => {
      const rs = performance.getEntriesByType("resource");
      const sum = (a) => a.reduce((s, r) => s + (r.decodedBodySize || 0), 0);
      const js = rs.filter((r) => /\.js(\?|$)/.test(r.name)), css = rs.filter((r) => /\.css(\?|$)/.test(r.name));

      return { jsBytes: sum(js), jsCount: js.length, cssBytes: sum(css), jsNames: js.map((r) => r.name.split("/").pop()) };
    });

    const pids = treePids();

    const procs = pids.map((p) => {
      let comm = ""; let cl = "";

      try { comm = readFileSync(`/proc/${p}/comm`, "utf8").trim(); } catch {}

      try { cl = readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " "); } catch {}

      const role = cl.match(/--type=([a-z-]+)/)?.[1]
        ?? (/typhoeus-go|quaver-server/.test(cl) ? "sidecar" : /\/mpv\b|ld-linux.*mpv/.test(cl) ? "mpv" : /crashpad|crash_?pad/.test(cl) ? "crashpad" : comm === "electron" ? "main" : comm);

      return { pid: Number(p), role, rss: rssOf(p) };
    });

    const s = {
      name, heapUsed: heap.usedSize, heapTotal: heap.totalSize, nodes: g("Nodes"), listeners: g("JSEventListeners"),
      scriptMs: Math.round(g("ScriptDuration") * 1000), layoutMs: Math.round(g("LayoutDuration") * 1000),
      jsBytes: res.jsBytes, jsCount: res.jsCount, cssBytes: res.cssBytes, rssTotal: procs.reduce((a, x) => a + x.rss, 0), pids: pids.length,
      procs: procs.sort((a, b) => b.rss - a.rss),
    };

    samples.push(s);

    if (name === "steady-gc") for (const x of s.procs.slice(0, 14)) console.log(`      ${(x.rss / 1048576).toFixed(0).padStart(5)}MB ${x.role.padEnd(16)} ${x.pid}`);
    console.log(`  ${name.padEnd(14)} heap ${(s.heapUsed / 1048576).toFixed(1).padStart(6)}MB  进程树RSS ${(s.rssTotal / 1048576).toFixed(0).padStart(4)}MB(${s.pids})  nodes ${String(s.nodes).padStart(6)}  lsn ${String(s.listeners).padStart(4)}  script ${String(s.scriptMs).padStart(5)}ms  JS ${s.jsCount}/${(s.jsBytes / 1024).toFixed(0)}k`);
  };

  const go = async (hash, wait = 2000) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(wait); };

  await sleep(5000);
  await sample("boot");

  for (const [name, hash, wait] of [["settings", "#/settings", 2000], ["guess", "#/guess", 2600], ["daily", "#/daily", 2600], ["liked", "#/liked", 2600], ["search", "#/search?q=%E5%91%8A%E7%99%BD", 3600], ["home", "#/", 2000]]) { await go(hash, wait); await sample(name); }

  // 反复进出「最重的两个页面」后残留多少：堆应当回到首轮水位（涨 = 有东西没解绑）
  const leakBefore = (await cdp.send("Runtime.getHeapUsage")).usedSize;

  for (let i = 0; i < 8; i++) { await go("#/settings", 900); await go("#/", 900); }

  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await sleep(600);
  const leakAfter = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  console.log(`  8 轮进出设置页后堆残留 ${((leakAfter - leakBefore) / 1048576).toFixed(1)}MB（约 0 = 没有越用越肥）`);

  const cn2tAsset = (() => {
    const m = manifest();

    if (!Object.keys(m).length) return null;
    const hit = Object.values(m).find((c) => /assets\/(cjk-)?cn2t-[A-Za-z0-9_-]+\.js$/.test(c.file ?? ""));

    return hit?.file ? `/${hit.file}` : null;
  })();

  const h0 = (await cdp.send("Runtime.getHeapUsage")).usedSize;

  const dict = cn2tAsset
    ? await page.evaluate(async (asset) => {
        const t0 = performance.now();
        const mod = await import(/* @vite-ignore */ asset);
        const t1 = performance.now();
        const conv = mod.Converter({ from: "cn", to: "t" });
        const t2 = performance.now();
        const text = conv("头发会发财");

        return { importMs: Math.round(t1 - t0), trieMs: Math.round(t2 - t1), totalMs: Math.round(performance.now() - t0), text };
      }, cn2tAsset).catch((e) => ({ error: String(e).slice(0, 140) }))
    : { skipped: "产物里没有 cn2t chunk" };

  const h1 = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  dict.heapDeltaMB = +((h1 - h0) / 1048576).toFixed(1);
  console.log("  cn2t 词典：", JSON.stringify(dict));
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await sleep(800);
  await sample("steady-gc");
  const loaded = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.endsWith('.js')).map((r) => `${r.name.split("/").pop()}(${(r.decodedBodySize / 1024).toFixed(0)}k)`));
  console.log("  实际加载 JS：", loaded.join(" "));
  const uniq = [...new Set(errors)];
  console.log("  页面错误(懒加载缝): " + (uniq.length ? uniq.join(" | ") : "无"));
  await page.screenshot({ path: join(PERIODIR, `${LABEL}.png`) }).catch(() => {});
  await browser.close().catch(() => browser.disconnect());

  if (proc?.pid) { try { process.kill(-proc.pid, "SIGTERM"); } catch { /* 已退 */ } }

  const out = { label: LABEL, samples, dict, errors: uniq };
  writeFileSync(join(PERIODIR, `${LABEL}.json`), JSON.stringify(out, null, 1));
  console.log(`  → ${join(PERIODIR, `${LABEL}.json`)}`);

  return out;
}

mkdirSync(PERIODIR, { recursive: true });

const result = {};

if (!flag("live-only")) result.static = reportStatic();

if (!flag("static")) { mkdirSync(PERIODIR, { recursive: true }); result.live = await live(); }

writeFileSync(join(PERIODIR, `${LABEL}.report.json`), JSON.stringify(result, null, 1));
