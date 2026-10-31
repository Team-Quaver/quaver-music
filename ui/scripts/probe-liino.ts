// Quaver — Liino 后端运行时探针（Electron 主进程，真出声/真取流）。
//
// 用法（需要 PipeWire 会话；只想看管线可用 --driver=null 走静音 sink）：
//   QUAVER_LIINO=../vendor/Liino/build/linux-amd64/libliino.so ./node_modules/.bin/electron scripts/probe-liino.ts
//   ./node_modules/.bin/electron scripts/probe-liino.ts --driver=null
//
// 它验的是**接入面**而不是 Liino 本身：quaver:audio 命令契约、事件广播、世代丢弃、
// 位置来自 clock()、EQ/设备/音量映射、曲末 ended 只发一次。库内部行为由 vendor/Liino 自己的
// go test 与 node smoke 守着。
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liinoEngine } from "../electron/audio/liino-engine.ts";
import { selectedBackend } from "../electron/audio/liino-runtime.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const driverArg = args.find((a) => a.startsWith("--driver="))?.slice(9) ?? "";
const fixture = resolve(join(HERE, "../../vendor/Liino/testdata/tone-48000-stereo.ogg"));

let fails = 0;

const ok = (name: string, cond: boolean, note = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${note ? " — " + note : ""}`);

  if (!cond) fails++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取流端点长得像 /api/stream/<token>，并支持 Range —— 与 sidecar 同一形态。 */
async function startStreamServer(): Promise<{ url: string; close: () => void }> {
  const body = await readFile(fixture);

  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ""));

    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": "application/ogg",
      });
      res.end(body.subarray(start, end + 1));

      return;
    }

    res.writeHead(200, { "Content-Length": String(body.length), "Accept-Ranges": "bytes", "Content-Type": "application/ogg" });
    res.end(body);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  return { url: `http://127.0.0.1:${port}/api/stream/probe-token`, close: () => server.close() };
}

/** 事件收集：把 engine.send 换成内存队列（渲染层那条 wc.send 在探针里没有意义）。 */
function captureEvents() {
  const events: any[] = [];

  liinoEngine.send = (ev: unknown) => { events.push(ev); };

  return events;
}

const lastState = (events: any[]) => [...events].reverse().find((e) => e?.t === "state");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 320, height: 200 });
  const events = captureEvents();

  if (!existsSync(fixture)) {
    console.log(`FAIL fixture 缺失：${fixture}`);
    app.exit(1);

    return;
  }

  const stream = await startStreamServer();

  // 探针直接指定后端偏好：不依赖调用方带 QUAVER_AUDIO_BACKEND
  ok("开关解析：liino 被识别", selectedBackend("liino") === "liino" && selectedBackend(undefined) === "mpv");
  liinoEngine.device = driverArg === "null" ? "auto" : liinoEngine.device;

  liinoEngine.init({ baseUrl: new URL(stream.url).origin, getWin: () => win, log: (...a) => console.log("[engine]", ...a) });

  const status = await liinoEngine.call({ cmd: "status" });

  ok("status 报 backend=liino", status.backend === "liino", JSON.stringify(status).slice(0, 220));
  ok("status 报 available（libliino 已 dlopen）", !!status.available, String(status.reason));
  ok("status 说实话：captureCompatible=false", status.captureCompatible === false);
  ok("status 带版本与来源", !!status.version && !!status.source, `${status.version} / ${status.source}`);

  const mode = await liinoEngine.call({ cmd: "mode", mode: "native" });

  ok("mode(native) 被接受", mode.ok === true && mode.mode === "native");

  const pcm = await liinoEngine.call({ cmd: "mode", mode: "pcm" });

  ok("mode(pcm) 被明确拒绝（不伪装支持）", pcm.ok === false, String(pcm.error));

  const devices = await liinoEngine.call({ cmd: "devices" });

  ok("devices 列出可切设备", devices.ok === true && Array.isArray(devices.devices) && devices.devices.length > 0,
    JSON.stringify(devices.devices).slice(0, 200));

  // —— 挂流 → 出声 ——
  const load = await liinoEngine.call({ cmd: "load", url: stream.url, paused: false, startAt: 0, epoch: 9 });

  ok("load 接受并回世代", load.ok === true && load.gen === 9, JSON.stringify(load));

  const loadedDeadline = Date.now() + 4000;

  while (Date.now() < loadedDeadline && !events.some((e) => e?.t === "loaded")) await sleep(60);
  ok("loaded 事件已广播（渲染层据此熄转圈）", events.some((e) => e?.t === "loaded"));

  const deadline = Date.now() + 8000;
  let state = null as any;

  while (Date.now() < deadline) {
    await sleep(120);
    state = lastState(events);

    if (state && !state.paused && !state.buffering && state.pos > 0.05) break;
  }

  ok("进入 playing 且位置在走", !!state && !state.paused && state.pos > 0.05, JSON.stringify(state));
  ok("时长来自 native（≈2s）", !!state && state.dur > 1.5 && state.dur < 2.6, state ? `${state.dur.toFixed(3)}s` : "-");

  const p1 = lastState(events)?.pos ?? 0;

  await sleep(600);
  const p2 = lastState(events)?.pos ?? 0;

  ok("位置单调前进（clock 驱动，非假时间戳）", p2 > p1, `${p1.toFixed(3)} -> ${p2.toFixed(3)}`);

  // —— seek ——
  const seek = await liinoEngine.call({ cmd: "seek", sec: 0.8, epoch: 9 });

  ok("seek 被接受", seek.ok === true);
  await sleep(400);
  const after = lastState(events)?.pos ?? 0;

  ok("seek 后位置回到目标附近", after >= 0.6 && after <= 1.6, String(after.toFixed(3)));

  // —— 音量 / 静音 / EQ ——
  ok("volume 生效", (await liinoEngine.call({ cmd: "volume", value: 0.3 })).ok === true);
  ok("mute 生效", (await liinoEngine.call({ cmd: "mute", value: false })).ok === true);

  const eq = await liinoEngine.call({
    cmd: "eq",
    state: { enabled: true, preamp: 2, bands: [
      { id: "b1", freq: 120, gain: 3, q: 1.2, type: "bell" },
      { id: "b2", freq: 6000, gain: -2, q: 0.9, type: "highShelf" },
      { id: "b3", freq: 12000, gain: 0, q: 0.707, type: "lowPass" },
    ] },
  });

  ok("EQ 落地并如实报丢弃数", eq.ok === true && eq.bands === 2 && eq.dropped === 1, JSON.stringify({ bands: eq.bands, dropped: eq.dropped, note: eq.note }));

  // —— 世代丢弃：旧 epoch 的 load 不许盖住正在放的歌（epoch 0 = 渲染层「你自定」，不走这里）——
  const stale = await liinoEngine.call({ cmd: "load", url: stream.url, paused: true, startAt: 0, epoch: 4 });

  ok("旧世代 load 被丢弃", stale.ok === true && stale.stale === true, JSON.stringify(stale));
  ok("丢弃后当前流不受影响", liinoEngine.lastUrl === stream.url && !liinoEngine.st.idle);

  // —— 曲末：用 startAt 贴尾重挂，等 ended（只发一次，重复会被渲染层当双倍切歌）——
  // 注：不测「播放中 seek 到贴尾」，那个场景 native 有独立问题（native 侧重排缓冲后
  // underrun 不恢复），归 vendor/Liino 上游；我们只用引擎的 load(startAt) 语义换位置。
  await liinoEngine.call({ cmd: "load", url: stream.url, paused: false, startAt: Math.max(0.2, (lastState(events)?.dur ?? 2) - 0.6), epoch: 9 });
  const endDeadline = Date.now() + 12000;

  while (Date.now() < endDeadline && !events.some((e) => e?.t === "ended")) await sleep(200);
  const endedCount = events.filter((e) => e?.t === "ended").length;

  ok("曲末 ended 广播且只发一次", endedCount === 1, `count=${endedCount}`);
  const finalState = events.filter((e) => e?.t === "state").at(-1);

  ok("曲末状态回到 idle/paused", !!finalState && finalState.idle === true && finalState.paused === true, JSON.stringify(finalState));

  // —— stop 后的 play：不能装模作样。mpv 引擎口径是 stop=卸载当前流 ——
  await liinoEngine.call({ cmd: "stop" });
  await sleep(500);
  ok("stop 已卸载当前流", liinoEngine.lastUrl === "" && liinoEngine.st.idle === true);
  const replay = await liinoEngine.call({ cmd: "play" });

  ok("stop 后 play 老实报错（渲染层据此重新取链）", replay.ok === false && liinoEngine.lastUrl === "", JSON.stringify(replay));

  const snap = await liinoEngine.call({ cmd: "snapshot" });

  ok("snapshot 可被窗口重建后的页面接管", snap.ok === true && typeof snap.running === "boolean", JSON.stringify(snap).slice(0, 200));

  liinoEngine.shutdown();
  await sleep(150);
  ok("shutdown 后引擎回到 idle", liinoEngine.st.idle === true && liinoEngine.player === null);

  win.destroy();
  stream.close();
  console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
  app.exit(fails ? 1 : 0);
}).catch((e) => {
  console.log("探针异常:", String((e as Error)?.stack ?? e));
  app.exit(2);
});
