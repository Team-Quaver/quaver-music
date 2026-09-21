// Quaver — 同源 API 中继（dev/preview 中间件）
// 浏览器 -> /api/* -> Python sidecar :3200（FastAPI, vendor/Typhoeus/quaver_server）。
// 会话凭证（Credential）由 Electron 主进程加密保存在系统密钥管理器里（KWallet / 钥匙串 /
// 凭据管理器，磁盘上只有密文 credential.enc），token 完全不进浏览器侧 ——
// 所以这里只剩纯透传 + 封面代理。
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { configDir } from "../electron/config.mjs";

const SIDECAR = process.env.QUAVER_API ?? "http://127.0.0.1:3200";

/** Sparkle 第三方插件目录（与 electron/main.mjs 同规则：env 优先，否则配置目录下 plugins/） */
const SPARKLE_PLUGINS_ROOT = process.env.QUAVER_SPARKLE_DIR?.trim() || join(configDir(), "plugins");
const SPARKLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 已安装插件的静态文件（/api/sparkle/plugin/<id>/<file>）。与 native-server.mjs 的 serveSparkle 同构。 */
export function serveSparkle(sub: string, res: ServerResponse) {
  // sub 形如 /sparkle/plugin/<id>/<file...>；id 与 file 都过白名单（防目录穿越）
  const m = /^\/sparkle\/plugin\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(sub);
  if (!m) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "sparkle: bad path" }));
  }
  const [, id, file] = m;
  const dir = normalize(join(SPARKLE_PLUGINS_ROOT, id));
  if (!dir.startsWith(normalize(SPARKLE_PLUGINS_ROOT))) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ code: -1, msg: "sparkle: bad id" }));
  }
  const target = normalize(join(dir, file));
  if (!target.startsWith(dir + "/") || /[\\/]$/.test(file) || file.includes("..")) {
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

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// 流中继的可预期中断：客户端切歌/seek/关页面 → AbortError；上游（sidecar/CDN）半路断流
// → undici 的 TypeError: terminated / premature close。都不是异常，只是常态。
const EXPECTED_ABORT_CODES = new Set(["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"]);
function isExpectedAbort(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string } | null;
  if (!err) return true;
  if (err.name === "AbortError" || (err.code && EXPECTED_ABORT_CODES.has(err.code))) return true;
  return /terminated|premature close|aborted|socket hang up/i.test(String(err.message ?? ""));
}

// 中继一条上游流并接管全部错误。
// 别用 src.pipe(res)：pipe() 不转发 source 的 'error'，而 Readable.fromWeb(fetch().body)
// 在上游断流/被 abort 时会 emit error —— 无人接管就是主进程的未捕获异常
// （弹「A JavaScript error occurred in the main process」，堆栈落在 undici Fetch.onAborted）。
// pipeline() 把 source/dest/abort 的错误都收敛到 promise，且 abort 会连带销毁两端。
async function pipeStream(body: ReadableStream<Uint8Array>, res: ServerResponse, signal: AbortSignal) {
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  try {
    await pipeline(Readable.fromWeb(body as never), res, { signal });
  } catch (e) {
    if (!isExpectedAbort(e)) console.warn(`[relay] stream aborted: ${e}`);
  }
}

function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

// 封面取色代理：CDN 无 Access-Control-Allow-Origin，canvas 直接加载会被 taint 无法 getImageData。
// 这里同源转发并限定主机+路径白名单（非开放代理）。
const IMG_HOSTS = new Set(["y.gtimg.cn", "qpic.y.qq.com", "img.y.gtimg.cn", "pictax.qpic.cn"]);
const IMG_PATHS = ["/music/photo_new/", "/music_cover/", "/music/a_"];
async function proxyImage(u: string | null, res: ServerResponse) {
  if (!u) { res.statusCode = 400; return res.end("missing u"); }
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    res.statusCode = 400;
    return res.end("bad url");
  }
  const ok = (target.protocol === "https:" || target.protocol === "http:")
    && IMG_HOSTS.has(target.hostname)
    && IMG_PATHS.some((p) => target.pathname.startsWith(p));
  if (!ok) { res.statusCode = 403; return res.end("host not allowed"); }
  try {
    const upstream = await fetch(target, { headers: { referer: "https://y.qq.com/", "user-agent": "Mozilla/5.0" } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
    res.setHeader("cache-control", "public, max-age=86400");
    res.setHeader("access-control-allow-origin", "http://127.0.0.1:5173");
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.end(String(e));
  }
}

// 调试：日志页面数据源。Electron 壳层写 ui/electron-dev.log（见 electron/main.mjs），
// 这里以纯文本给出尾部 N 行；文件不存在（纯浏览器 dev）返回 404 JSON，前端显示占位提示。
function serveLog(res: ServerResponse, tail: number) {
  const file = join(import.meta.dirname ?? ".", "..", "electron-dev.log");
  if (!existsSync(file)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "electron-dev.log 不存在" }));
  }
  const size = statSync(file).size;
  const buf = readFileSync(file);
  const text = size > 2_000_000 ? buf.subarray(size - 2_000_000).toString("utf8") : buf.toString("utf8");
  const lines = text.split("\n");
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(lines.slice(-Math.max(1, Math.min(5000, tail))).join("\n"));
}

export function apiRelay(): Connect.NextHandleFunction {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local"); // req.url 已剥掉挂载前缀 /api
    const path = url.pathname.replace(/^\//, "");

    if (path === "img") return proxyImage(url.searchParams.get("u"), res);
    if (path === "log") return serveLog(res, parseInt(url.searchParams.get("tail") ?? "800", 10) || 800);
    // Sparkle 已安装插件的文件服务（/api/sparkle/...，打包态在 native-server.mjs 有同构实现）
    if (path.startsWith("sparkle/")) return serveSparkle("/" + path, res);

    const target = new URL(SIDECAR);
    target.pathname = "/" + path;
    target.search = url.search; // 透传 query

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
        body: (await readBody(req)) as BodyInit | undefined,
        redirect: "manual",
        signal: ac.signal,
      });
      // 播放流（/api/stream/<token>）：流式管道，绝不整段缓冲（边下边播 + 省内存）
      if (/^stream\/[^/]+$/.test(path) && upstream.body) {
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
      const r = json({ code: -1, msg: `sidecar unreachable: ${e}` }, 502);
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.appendHeader(k, v));
      res.end(Buffer.from(await r.arrayBuffer()));
    } finally {
      res.off("close", onClientGone);
    }
  };
}
