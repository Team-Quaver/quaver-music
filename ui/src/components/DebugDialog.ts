// Quaver — 进程 / 内存自检弹窗（设置 → 通用 → 调试）
//
// 为什么要有它：Electron 是**多进程**的，渲染层只看得见自己那一份堆 —— 主进程、GPU 进程、
// zygote 池，以及我们自己的外部子进程（sidecar / mpv / 看门狗）全在它的视野外。
// 于是「这应用到底吃了多少、被谁吃的」在界面里问不出答案。这里把主进程侧的事实
// （app.getAppMetrics + /proc）与渲染层侧的事实（JS 堆、首屏解析量、DOM 规模）拼成一张表。
//
// 口径必须写在脸上，否则一定被读错：**RSS 逐行相加必然虚高** —— Chromium 各进程共享同一批
// 映射（electron 二进制、ICU、字体文件、/dev/shm 合成缓冲），而且那些是 clean 页，内存紧张时
// 内核直接回收。所以同时给 Pss（Linux 从 smaps_rollup 取；win 用 privateBytes）—— 它才是
// 「按共享比例摊过之后」的真实占用。读不到的平台自动退到 RSS 口径并标注。
//
// 「开发者模式」按钮 = 开 DevTools。F12 不绑定：插件宿主里 DevTools 是能把任意代码敲进
// 渲染层的口子，只走这个显式、看得见入口的按钮（主进程日志会记一行）。
import { copyText, escHtml } from "../lib/api";
import { toast } from "./SongMenu";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ProcRow = { pid: number; tag: string; rssKB: number; peakKB: number; privKB?: number | null; cpu: number; ext?: boolean };

type Metrics = {
  ok: boolean;
  app: { version: string; packaged: boolean; platform: string; arch: string; electron: string; chrome: string; node: string; configDir: string };
  main: { pid: number; rssKB: number; heapUsedMB: number; heapTotalMB: number; externalMB: number; uptimeSec: number };
  windows: { mainPid: number; dlPid: number };
  procs: ProcRow[];
  external: { pid: number; tag: string; rssKB: number | null; privKB: number | null }[];
  totals: { chromiumRSSKB: number; externalRSSKB: number; privKB: number; privKnown: boolean; count: number };
};

const REFRESH_MS = 5000;
const mb = (kb: number): string => (kb >= 1024 ? (kb / 1024).toFixed(0) + " MB" : kb + " KB");

/** Chromium 私有的性能量测扩展（lib.dom 不声明；非 Chromium 运行时字段缺席，读侧都有回退）。 */
interface ChromePerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

/** 渲染层侧的量（没有主进程桥时也能出这几行，浏览器 dev 同理）。 */
function rendererSide() {
  // SAFETY: Chrome 系宿主提供 performance.memory；非 Chromium 走可选链回退
  const mem = (performance as ChromePerformance).memory;
  // SAFETY: resource 条目的 PerformanceEntry 均带 decodedBodySize，即 PerformanceResourceTiming
  const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];

  const sum = (re: RegExp) => {
    const a = res.filter((r) => re.test(r.name));

    return { kb: Math.round(a.reduce((s, r) => s + (r.decodedBodySize || 0), 0) / 1024), n: a.length };
  };

  return {
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
    js: sum(/\.js(\?|$)/), css: sum(/\.css(\?|$)/),
    nodes: document.getElementsByTagName("*").length,
  };
}

const kv = (label: string, value: string, hint = ""): string =>
  `<div class="dbg-kv"><span>${escHtml(label)}</span><b>${escHtml(value)}</b>`
  + (hint ? `<i>${escHtml(hint)}</i>` : "") + `</div>`;

const bridge = () => (window as any).quaverDebug as
  | { devtools(msg: Record<string, unknown>): Promise<any>; metrics(): Promise<any> }
  | undefined;

let layer: HTMLElement | null = null;

/** 打开自检弹窗（已开着就只把它拉回最新一次采样，不叠第二层）。 */
export function showDebugDialog(): void {
  if (layer) { void refresh(); return; }

  layer = document.createElement("div");
  layer.className = "upd-overlay";
  layer.innerHTML = `<div class="upd-dialog dbg-dialog" role="dialog" aria-modal="true" aria-label="进程与内存自检">
    <div class="upd-head">
      <h3>进程与内存自检</h3>
      <span class="muted upd-meta" data-meta>采样中…</span>
    </div>
    <div class="upd-notes dbg-body"><p class="muted">正在向主进程要数据…</p></div>
    <div class="upd-foot">
      <label class="dbg-auto"><input type="checkbox" data-auto checked /> 每 5s 自动采样</label>
      <button class="ghost-btn" data-act="copy" type="button">复制报告</button>
      <span class="upd-spacer"></span>
      <button class="ghost-btn" data-act="devtools" type="button">开发者模式</button>
      <button class="upd-primary" data-act="close" type="button">关闭</button>
    </div>
  </div>`;

  const body = layer.querySelector<HTMLElement>(".dbg-body")!;
  const meta = layer.querySelector<HTMLElement>("[data-meta]")!;
  const auto = layer.querySelector<HTMLInputElement>("[data-auto]")!;
  let timer: number | null = null;
  let last: Metrics | null = null;

  const stop = () => { if (timer !== null) { window.clearInterval(timer); timer = null; } };
  const start = () => { stop(); if (auto.checked) timer = window.setInterval(() => void refresh(), REFRESH_MS); };

  const close = () => {
    const el = layer;
    stop();
    window.removeEventListener("keydown", onKey);
    layer = null;

    if (!el) return;
    const fin = () => el.remove();
    el.addEventListener("animationend", fin, { once: true });
    window.setTimeout(fin, 240);
    el.classList.add("leaving");
  };

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

  async function refresh(): Promise<void> {
    const r = rendererSide();
    const b = bridge();

    if (b) { try { last = await b.metrics(); } catch (e) { last = null; meta.textContent = "主进程自检失败：" + errText(e); } }

    const at = new Date().toLocaleTimeString();

    if (!last?.ok) {
      body.innerHTML = `<div class="dbg-grid">
        ${kv("本窗 JS 堆", r.heapMB === null ? "—" : r.heapMB + " MB")}
        ${kv("首屏实际解析", r.js.kb + " KB JS · " + r.css.kb + " KB CSS", r.js.n + " 个脚本块")}
        ${kv("DOM 节点", String(r.nodes))}
      </div><p class="muted dbg-note2">浏览器 dev 没有主进程，进程表只在桌面端有。</p>`;
      meta.textContent = "渲染层读数 · " + at;

      return;
    }

    const rows: ProcRow[] = [
      ...last.procs,
      ...last.external.map((x) => ({ pid: x.pid, tag: x.tag, rssKB: x.rssKB ?? 0, peakKB: 0, privKB: x.privKB, cpu: 0, ext: true })),
    ];

    const rssTotal = last.totals.chromiumRSSKB + last.totals.externalRSSKB;
    body.innerHTML = `<div class="dbg-grid">
        ${kv("真实占用（Pss 求和）", last.totals.privKnown && last.totals.privKB ? mb(last.totals.privKB) : "—（本平台读不到）", "共享页按比例摊过")}
        ${kv("进程合计（RSS 直加）", mb(rssTotal), "虚高，见下方口径")}
        ${kv("进程数", String(last.totals.count), "Chromium " + last.procs.length + " + 外部 " + last.external.length)}
        ${kv("主进程 Node 堆", last.main.heapUsedMB + " / " + last.main.heapTotalMB + " MB", "已用 / 已申请")}
        ${kv("本窗 JS 堆", r.heapMB === null ? "—" : r.heapMB + " MB")}
        ${kv("首屏实际解析", r.js.kb + " KB JS · " + r.css.kb + " KB CSS", r.js.n + " 个脚本块")}
        ${kv("DOM 节点", String(r.nodes))}
        ${kv("运行时长", Math.floor(last.main.uptimeSec / 60) + " 分钟")}
        ${kv("构建", last.app.version + " · Electron " + last.app.electron + " · Chromium " + last.app.chrome,
          (last.app.packaged ? "打包态" : "开发态") + " · " + last.app.platform + "/" + last.app.arch)}
      </div>
      <table class="dbg-table"><thead><tr><th>进程</th><th>pid</th><th>RSS</th><th>Pss/私有</th><th>峰值</th><th>CPU</th></tr></thead>
      <tbody>${rows.map((x) => `<tr><td>${escHtml(x.tag)}</td><td>${x.pid}</td><td>${escHtml(mb(x.rssKB))}</td>`
        // CPU 是「自上次采样以来的均值」：首采样恒 0，外部子进程压根没这个数 —— 都别显示成 0%
        + `<td>${x.privKB ? escHtml(mb(x.privKB)) : "—"}</td><td>${x.peakKB ? escHtml(mb(x.peakKB)) : "—"}</td>`
        + `<td>${x.ext ? "—" : x.cpu.toFixed(1) + "%"}</td></tr>`).join("")}</tbody></table>
      <p class="muted dbg-note">口径：RSS 会把共享页在每个进程各算一遍（Electron 二进制、ICU、字体、
      /dev/shm 合成缓冲），所以逐行相加必然虚高；那些还是 clean 页，内存紧张时内核直接回收。
      看趋势用合计，看真实成本用 Pss 列。开发态的主进程还兼着 vite preview 与 /api 中继（打包态没有这层）。</p>`;
    meta.textContent = `采样于 ${at} · 配置目录 ${last.app.configDir}`;
  }

  layer.querySelector<HTMLElement>("[data-act=close]")!.onclick = close;
  layer.addEventListener("mousedown", (e) => { if (e.target === layer) close(); });
  auto.onchange = start;
  layer.querySelector<HTMLElement>("[data-act=copy]")!.onclick = async () => {
    const ok = await copyText(JSON.stringify({ at: new Date().toISOString(), metrics: last, renderer: rendererSide() }, null, 1));
    toast(ok ? "自检报告已复制到剪贴板" : "复制失败（浏览器可能拦了剪贴板）");
  };

  layer.querySelector<HTMLElement>("[data-act=devtools]")!.onclick = async () => {
    const b = bridge();

    if (!b) { toast("浏览器 dev 没有主进程，DevTools 只在桌面端可用"); return; }

    const r = await b.devtools({ op: "toggle" }).catch((e: unknown) => ({ ok: false, error: errText(e) }));

    if (!r?.ok) toast("打不开开发者工具：" + String(r?.error ?? "未知原因"));
  };

  document.body.append(layer);
  window.addEventListener("keydown", onKey);
  void refresh();
  start();
}
