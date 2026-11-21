// Quaver — Liino 曲末自动换曲探针：真引擎、真流、两次自然 Ended。
import { app } from "electron";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liinoEngine } from "../electron/audio/liino-engine.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const fixture = resolve(HERE, "../../vendor/Liino/testdata/tone-48000-stereo.ogg");

app.whenReady().then(async () => {
  const body = await readFile(fixture);

  const server = createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ""));

    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : body.length - 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Content-Length": String(end - start + 1),
        "Content-Type": "application/ogg",
      });
      res.end(body.subarray(start, end + 1));

      return;
    }

    res.writeHead(200, { "Content-Length": String(body.length), "Content-Type": "application/ogg" });
    res.end(body);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  // SAFETY: listen(port=0) succeeds before the callback runs; the address is always TCP info.
  const port = (server.address() as { port: number }).port;
  const events: any[] = [];

  liinoEngine.device = "auto";
  liinoEngine.init({
    baseUrl: `http://127.0.0.1:${port}`,
    getWin: () => null,
    log: (...args) => console.log("[engine]", ...args),
    adaptiveRate: true,
    alsaExclusive: true,
  });
  liinoEngine.send = (ev) => {
    events.push(ev);
    console.log("event", ev);
  };

  // Match the production UI: EngineTransport starts with the configured fade
  // and Player.interrupt() sends stop before the next load lands.
  await liinoEngine.call({ cmd: "fade", inMs: 800, outMs: 500 });

  for (let epoch = 1; epoch <= 2; epoch++) {
    events.length = 0;

    const loaded = await liinoEngine.call({
      cmd: "load",
      url: `http://127.0.0.1:${port}/api/stream/track-${epoch}`,
      paused: false,
      startAt: epoch === 1 ? 1.4 : 0,
      epoch,
      client: "auto-next-probe",
    });

    console.log(`load ${epoch}`, loaded);

    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline && !events.some((ev) => ev?.t === "ended")) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    }

    if (!events.some((ev) => ev?.t === "ended")) {
      throw new Error(`track ${epoch} did not end`);
    }

    if (epoch === 1) {
      const stopped = await liinoEngine.call({ cmd: "stop" });

      console.log("stop after ended", stopped);
    }
  }

  await liinoEngine.shutdown();
  server.close();
  app.exit(0);
}).catch((error) => {
  // SAFETY: catch boundary is unknown; only Error-shaped stack text is consumed.
  console.error("probe failed:", String((error as Error)?.stack ?? error));
  app.exit(1);
});
