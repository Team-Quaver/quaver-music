// Quaver — 打包模式下的纯 Node HTTP 服务（不依赖 vite）。
// 与 dev/preview 的 src/relay.ts 中间件等价：静态 dist/ + /api 中继(sidecar) + 封面取色代理 + 调试日志尾部。
// Electron 主进程与独立 `node native-server.mjs` 都可使用。
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const SPARKLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 已安装插件的静态文件（/api/sparkle/plugin/<id>/<file>）。与 src/relay.ts 的 serveSparkle 同构。 */
function serveSparkle(sub, res, pluginsRoot) {
  const m = /^\/sparkle\/plugin\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(sub);
  if (!m || !pluginsRoot) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "sparkle: bad path" }));
  }
  const [, id, file] = m;
  if (!SPARKLE_ID_RE.test(id)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ code: -1, msg: "sparkle: bad id" }));
  }
  const dir = normalize(join(pluginsRoot, id));
  const target = normalize(join(dir, file));
  if (!target.startsWith(dir + "/") || file.includes("..")) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ code: -1, msg: "sparkle: bad file" }));
  }
  if (!existsSync(target)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "sparkle: not found" }));
  }
  const type = file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript"
    : file.endsWith(".json") ? "application/json"
    : file.endsWith(".css") ? "text/css" : "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(readFileSync(target));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

const SIDECAR = process.env.QUAVER_API ?? "http://127.0.0.1:3200";

// 流中继的可预期中断：客户端切歌/seek/关页面 → AbortError；上游（sidecar/CDN）半路断流
// → undici 的 TypeError: terminated / premature close。都不是异常，只是常态。
const EXPECTED_ABORT_CODES = new Set(["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"]);
function isExpectedAbort(e) {
  if (!e) return true;
  if (e.name === "AbortError" || (e.code && EXPECTED_ABORT_CODES.has(e.code))) return true;
  return /terminated|premature close|aborted|socket hang up/i.test(String(e.message ?? e));
}

// 中继一条上游流并接管全部错误。
// 别用 src.pipe(res)：pipe() 不转发 source 的 'error'，而 Readable.fromWeb(fetch().body)
// 在上游断流/被 abort 时会 emit error —— 无人接管就是主进程的未捕获异常
// （弹「A JavaScript error occurred in the main process」，堆栈落在 undici Fetch.onAborted）。
// pipeline() 把 source/dest/abort 的错误都收敛到 promise，且 abort 会连带销毁两端。
async function pipeStream(body, res, signal) {
  try {
    await pipeline(Readable.fromWeb(body), res, { signal });
  } catch (e) {
    if (!isExpectedAbort(e)) console.warn(`[quaver] relay stream aborted: ${e}`);
  }
}

// —— 封面取色代理（与 relay.ts 同一白名单：主机 + 路径前缀，非开放代理）——
const IMG_HOSTS = new Set(["y.gtimg.cn", "qpic.y.qq.com", "img.y.gtimg.cn", "pictax.qpic.cn"]);
const IMG_PATHS = ["/music/photo_new/", "/music_cover/", "/music/a_"];

async function proxyImage(u, res) {
  if (!u) {
    res.statusCode = 400;
    return res.end("missing u");
  }
  let target;
  try {
    target = new URL(u);
  } catch {
    res.statusCode = 400;
    return res.end("bad url");
  }
  const ok =
    (target.protocol === "https:" || target.protocol === "http:") &&
    IMG_HOSTS.has(target.hostname) &&
    IMG_PATHS.some((p) => target.pathname.startsWith(p));
  if (!ok) {
    res.statusCode = 403;
    return res.end("host not allowed");
  }
  try {
    const upstream = await fetch(target, {
      headers: { referer: "https://y.qq.com/", "user-agent": "Mozilla/5.0" },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
    res.setHeader("cache-control", "public, max-age=86400");
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.end(String(e));
  }
}

function serveLog(res, logFile, tail) {
  if (!logFile || !existsSync(logFile)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "log 文件不存在" }));
  }
  const size = statSync(logFile).size;
  const buf = readFileSync(logFile);
  const text = size > 2_000_000 ? buf.subarray(size - 2_000_000).toString("utf8") : buf.toString("utf8");
  const lines = text.split("\n");
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(lines.slice(-Math.max(1, Math.min(5000, tail))).join("\n"));
}

function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const MISSING_DIST_PAGE = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
  <h2>dist/ 不存在</h2><p>先构建再启动应用：<code>cd ui &amp;&amp; npm run build &amp;&amp; npm run app</code></p></body>`;

/**
 * @param {{dist: string, logFile?: string, host?: string, port?: number, pluginsRoot?: string}} opts
 * @returns {Promise<{server: import("node:http").Server, url: string, close: () => void}>}
 */
export async function startQuaverServer({ dist, logFile, host = "127.0.0.1", port = 0, pluginsRoot }) {
  const DIST = normalize(dist);

  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");

    // —— /api/*：中继 ——
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const sub = url.pathname.slice(4); // 剥掉 "/api"
      if (sub === "/img") return proxyImage(url.searchParams.get("u"), res);
      if (sub === "/log") return serveLog(res, logFile, parseInt(url.searchParams.get("tail") ?? "800", 10) || 800);
      // Sparkle 已安装插件的文件服务（必须在 sidecar 转发之前截住）
      if (sub.startsWith("/sparkle/")) return serveSparkle(sub, res, pluginsRoot);

      const target = new URL(SIDECAR);
      target.pathname = sub || "/";
      target.search = url.search;

      const headers = new Headers();
      const ct = req.headers["content-type"];
      if (ct) headers.set("content-type", ct);
      const range = req.headers["range"];
      if (range) headers.set("range", range); // 播放流 Range 中继必须透传

      // 客户端断线（切歌 removeAttribute(src)+load()、seek、关页面）→ 立刻掐掉上游 fetch。
      // 不掐的话会留下继续把整首歌拉完的僵尸流（流量白烧），且它被上游中断时 undici 抛
      // TypeError: terminated —— 那正是主进程弹框的根因。abort 由 res 的 close 驱动。
      const ac = new AbortController();
      const onClientGone = () => { if (!res.writableFinished) ac.abort(); };
      res.once("close", onClientGone);

      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: await readBody(req),
          redirect: "manual",
          signal: ac.signal,
        });
        // 播放流（/api/stream/<token>）：流式管道，绝不整段缓冲（边下边播 + 省内存）
        if (/^\/stream\/[^/]+$/.test(sub) && upstream.body) {
          res.statusCode = upstream.status;
          upstream.headers.forEach((v, k) => {
            if (k === "transfer-encoding" || k === "content-encoding" || k === "connection") return;
            res.appendHeader(k, v);
          });
          await pipeStream(upstream.body, res, ac.signal);
          return;
        }
        res.statusCode = upstream.status;
        upstream.headers.forEach((v, k) => {
          // hop-by-hop 与内容编码头交给运行时重算，透传会双重编码
          if (k === "transfer-encoding" || k === "content-encoding" || k === "connection") return;
          res.appendHeader(k, v);
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (e) {
        if (res.destroyed || res.writableEnded) return; // 客户端已走，再写只会抛 ERR_STREAM_DESTROYED
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: -1, msg: `sidecar unreachable: ${e}` }));
      } finally {
        res.off("close", onClientGone);
      }
      return;
    }

    // —— 静态 dist/（MPA：无扩展名的路径补 .html）——
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    let file = join(DIST, path);
    if (!existsSync(file) && !extname(file)) file = join(DIST, path + ".html");
    if (!existsSync(file) || !normalize(file).startsWith(DIST)) {
      if (!existsSync(join(DIST, "index.html"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(MISSING_DIST_PAGE);
      }
      res.statusCode = 404;
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(await import("node:fs/promises").then((m) => m.readFile(file)));
  };

  let server = createServer(handler);
  try {
    await listen(server, port, host);
  } catch (e) {
    // 首选端口被占（别的实例残留 / 端口冲突）→ 回落系统分配。
    // 固定端口的意义是 origin 稳定，但**起不来比 origin 变严重得多**，所以这里绝不硬失败。
    if (port === 0 || e?.code !== "EADDRINUSE") throw e;
    console.warn(`[quaver] 端口 ${port} 被占用，回落随机端口（本次渲染层 origin 会变）`);
    try { server.close(); } catch {}
    server = createServer(handler);
    await listen(server, 0, host);
  }
  const actual = server.address().port;
  return { server, url: `http://${host}:${actual}/`, close: () => server.close() };
}

/** 监听指定端口；失败时 reject，调用方决定是否回落。 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off("listening", onOk); reject(e); };
    const onOk = () => { server.off("error", onErr); resolve(); };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(port, host);
  });
}

// 允许独立跑（调试用）：node electron/native-server.mjs
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dist = new URL("../dist", import.meta.url).pathname;
  const p = parseInt(process.env.PORT ?? "4176", 10);
  const pluginsRoot = process.env.QUAVER_SPARKLE_DIR?.trim() || undefined;
  startQuaverServer({ dist, logFile: join(dist, "..", "electron-dev.log"), port: p, pluginsRoot }).then(({ url }) =>
    console.log("quaver native server:", url),
  );
}
