// Quaver — 拿真实构建产物 + 真实 Chromium 验证 CSP 确实生效（不是只「写了策略」）。
// 跑：  node scripts/verify-csp-live.ts   （需要先 pnpm run build；浏览器缺省 /usr/bin/google-chrome）
//
// 为什么需要「活体」这一层（verify-csp.ts 的静态断言替代不了）：
//   主进程那次翻车 —— Electron 44 已经没有 `app.session`（undefined），钩子被守卫静默吞掉，
//   静态断言全绿而警告照旧。策略「写了」与「真的贴到了响应上」是两件事，只有真页面能证明后者。
//   这里用一个最小静态服务把 dist/ 按 electron/csp.ts 的同一份策略发出去，让 Chromium 真跑一遍：
//     ① 首屏与官方插件 chunk 都能在策略下加载（动态 import 没被 script-src 拦）；
//     ② 内联脚本 / 内联事件属性**确实被拦**（正向对照：证明头真的到了页面，而不是摆设）；
//     ③ 薄跳转层（外链 public/redirect.js）仍然工作 —— 这是把内联脚本挪出去之后唯一的功能风险。
// 静态服务自带的 /api/* 一律 404：本测试只看 CSP，不测业务；业务由其它 verify 覆盖。
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { APP_CSP } from "../electron/csp.ts";

const UI = import.meta.dirname.replace(/\/scripts$/, "");
const DIST = join(UI, "dist");
const CHROME = process.env.QUAVER_CHROME || "/usr/bin/google-chrome";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error("❌ 先跑 pnpm run build（本测试验的是构建产物在 CSP 下的真实表现）");
  process.exit(1);
}

// —— 最小静态服务：每个响应都贴同一条 CSP ——
const server = createServer((req, res) => {
  res.setHeader("Content-Security-Policy", APP_CSP);
  const path = decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]);
  if (path.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  const file = normalize(join(DIST, path === "/" ? "index.html" : path));
  if (!file.startsWith(DIST) || !existsSync(file) || !/\.(html|js|mjs|css|svg|json|png|ico|woff2)$/.test(extname(file))) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${port}`;

section("响应头");
const head = await fetch(`${BASE}/index.html`);
check("静态服务确实带着策略", head.headers.get("content-security-policy") === APP_CSP);
check("策略里没有 unsafe-eval（Electron 就是看这个报警）", !/unsafe-eval/i.test(APP_CSP));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 760 });
const consoleLines: string[] = [];
page.on("console", (m) => consoleLines.push(`${m.type()}:${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror:${String(e)}`));
/** 只认 CSP 的措辞：其它报错（这里 /api 故意 404）不该算到策略头上 */
const violations = () => consoleLines.filter((l) => /refused to|violates the following|Content Security Policy/i.test(l));

try {
  section("首屏：策略下能不能正常起来");
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!document.querySelector("script[src]"), { timeout: 5000 }).catch(() => {});
  check("外链模块脚本加载执行（壳层挂载完成）",
    await page.evaluate(() => !!document.querySelector("#now-playing, .np, .content-top")));
  check("首屏没有 CSP 违规", violations().length === 0, violations().join(" | "));

  section("官方插件 chunk：运行期动态 import 走的是同源 script-src 'self'");
  await page.waitForFunction(() => (window as any).__quaverSparkleProbe !== undefined || document.title !== "", { timeout: 2000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500)); // 插件注册是异步的，给它一点时间
  check("插件加载日志出现（chunk 被 import 成功）",
    consoleLines.some((l) => l.includes("[sparkle:") && l.includes("loaded")), consoleLines.slice(-6).join(" | "));
  check("插件 chunk 没被策略拦下", violations().length === 0, violations().join(" | "));

  section("正向对照：内联脚本与内联事件属性确实执行不了");
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<img src="data:," onerror="window.__cspInlineHit = 1" alt=""/>`);
    document.body.insertAdjacentHTML("beforeend", `<script>window.__cspInlineScript = 1;<\/script>`);
  });
  await new Promise((r) => setTimeout(r, 600));
  const probe = await page.evaluate(() => ({
    handler: (window as any).__cspInlineHit === 1,
    script: (window as any).__cspInlineScript === 1,
  }));
  check("内联事件属性（onerror=）被拦", !probe.handler);
  check("内联 <script> 被拦", !probe.script);
  // Chromium 会把同类拦截合并上报（内联脚本 + 内联事件属性可能只留一行），所以门槛是「至少一条」：
  // 这一条的意义是「拦截留了痕迹」= 策略真的到达了页面，而不是服务发了头、浏览器没吃。
  check("拦截在控制台留有违规记录（证明策略到达了页面）", violations().length >= 1, `violations=${violations().length}`);

  section("薄跳转层：外链 redirect.js 在同一策略下照常工作");
  for (const [legacy, want] of [["/login.html", "#/login"], ["/settings.html?x=1", "#/settings?x=1"], ["/playlist.html?tid=123", "#/playlist?id=123"]] as const) {
    await page.goto(BASE + legacy, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((frag: string) => location.href.includes(frag), { timeout: 4000 }, want).catch(() => {});
    const at = page.url();
    check(`${legacy} → 跳到 ${want}`, at.includes(want), `实到 ${at}`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-csp-live: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
