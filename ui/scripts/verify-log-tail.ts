// 回归护栏：/api/log 的日志尾部读取。
//
// 背景：两处服务端（src/relay.ts 与 electron/native-server.ts）曾经 readFileSync 整读日志文件，
// 再截尾 2MB —— 而主进程日志上限是 50MiB（electron/main.ts 的 LOG_MAX_BYTES），于是每滚动一次
// 就有**一次按文件大小线性增长**的大 Buffer 分配，而调用方（src/views/log.ts）只要尾部 800 行。
// 现在两处都按 start 偏移定长尾读。本脚本钉两件事：
//   ① 行为等价：新读法与「整读后截尾」逐字一致（小文件 / 多字节 / 超窗口大文件）；
//   ② 收益成立：分配锁在尾部窗口上界，不随日志大小增长。
// 用法：node scripts/verify-log-tail.ts
import { startQuaverServer } from "../electron/native-server.ts";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TAIL_BYTES = 2_000_000;

// —— 分配测量：一个测量一个子进程 ——
// 同进程里连测两次不可信：第二次的 external 增量会被前一次遗留物的回收时机污染
// （实测能测出负数）。子进程只读一次就退出，测到的就是那一次读的实际分配。
if (process.argv[2] === "--measure") {
  const [, , , impl, path] = process.argv;
  const before = process.memoryUsage().external;
  const text = (impl === "old" ? readWholeTail : readWindowTail)(path);

  process.stdout.write(JSON.stringify({ held: process.memoryUsage().external - before, len: text.length }));
  process.exit(0);
}

/** 优化前的读法：整文件进内存再截尾（子进程里也要用，故提到模块顶层） */
function readWholeTail(path: string): string {
  const size = statSync(path).size;
  const buf = readFileSync(path);

  return size > TAIL_BYTES ? buf.subarray(size - TAIL_BYTES).toString("utf8") : buf.toString("utf8");
}

/** 现在的读法：按 start 偏移定长尾读（与两处服务端的 readLogTail 同款） */
function readWindowTail(path: string): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.allocUnsafe(size - start);
  const fd = openSync(path, "r");
  let got = 0;

  try {
    for (; got < buf.length;) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);

      if (n <= 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }

  return buf.subarray(0, got).toString("utf8");
}

/** 起子进程测一次某条读法读该文件实际吃下多少 external。 */
function measure(impl: "old" | "new", path: string): { held: number; len: number } {
  const r = spawnSync(process.execPath, [process.argv[1]!, "--measure", impl, path], { encoding: "utf8" });

  if (r.status !== 0) throw new Error(`测量子进程失败(${impl}): ${r.stderr}`);

  return JSON.parse(r.stdout);
}

const dir = mkdtempSync(join(tmpdir(), "quaver-logtail-"));
const file = join(dir, "electron-dev.log");

let fails = 0;

const ok = (name: string, cond: boolean, note = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${note ? " — " + note : ""}`);
  if (!cond) fails++;
};

const srv = await startQuaverServer({ dist: dir, logFile: file });
const get = async (tail: number) => {
  const r = await fetch(new URL(`api/log?tail=${tail}`, srv.url));

  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

  return r.text();
};
const oldBody = (tail: number, path = file) =>
  readWholeTail(path).split("\n").slice(-Math.max(1, Math.min(5000, tail))).join("\n");

try {
  // —— 1. 小文件（低于窗口）：逐字等价 ——
  writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i} 中文日志`).join("\n") + "\n");
  ok("小文件：与旧实现逐字等价", await get(800) === oldBody(800));
  ok("小文件：tail=5 生效", await get(5) === oldBody(5));

  // —— 2. 多字节 + 大文件（远超窗口）：仍逐字等价 ——
  const chunk = Array.from({ length: 20_000 }, (_, i) => `#${i} ${"日本語とEnglish混在".repeat(4)}`).join("\n") + "\n";
  writeFileSync(file, chunk);
  for (let i = 0; i < 3; i++) appendFileSync(file, chunk);

  const size = statSync(file).size;
  const perChunk = chunk.trim().split("\n").length;
  const lastLine = `#${perChunk - 1} ${"日本語とEnglish混在".repeat(4)}`; // 每段相同，序号回到 perChunk-1
  ok("构造出远超窗口的日志", size > TAIL_BYTES, `size=${(size / 1e6).toFixed(1)}MB`);
  ok("大文件：与旧实现逐字等价", await get(5000) === oldBody(5000));
  ok("大文件：只回尾部窗口（不超 2MB 行集）", (await get(5000)).length <= readWholeTail(file).length);
  // 文件以 \n 收尾 → 尾部 1 段是空串（与旧实现同口径），故取 2 段看末行
  ok("大文件：包含日志真正的最后一行", (await get(2)).split("\n").some((l) => l === lastLine));
  ok("tail 上限夹紧为 5000 段", (await get(99999)).split("\n").length <= 5000);

  // —— 3. 两条读法在大文件上结果一致 ——
  ok("newRead 与 oldRead 同结果", readWindowTail(file) === readWholeTail(file), `len=${readWindowTail(file).length}`);

  // —— 4. 收益：分配锁在尾部窗口，与日志大小无关 ——
  // Buffer（含 toString 产出的字符串）记在 memoryUsage().external。用真实上限 50MiB
  // （electron/main.ts 的 LOG_MAX_BYTES）建一份日志，两条读法各读一次：整读要吞下整个
  // 文件，尾读只吞窗口。差距是 25 倍量级，留足余量，不靠 GC 时序的细枝末节。
  const big = join(dir, "big.log");
  writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 0x61)); // 50MiB ASCII，末行口径不敏感
  const bigSize = statSync(big).size;

  const old50 = measure("old", big);
  const new50 = measure("new", big);

  ok("整读法在 50MiB 日志上按文件大小分配", old50.held > bigSize * 0.9,
    `≈${(old50.held / 1e6).toFixed(1)}MB / file=${(bigSize / 1e6).toFixed(1)}MB`);
  ok("尾读法只按窗口分配（与文件大小无关）", new50.held < TAIL_BYTES * 3,
    `≈${(new50.held / 1e6).toFixed(1)}MB vs 窗口 ${(TAIL_BYTES / 1e6).toFixed(1)}MB`);
  ok("尾读分配比整读低一个量级", new50.held * 4 < old50.held,
    `${(old50.held / 1e6).toFixed(1)}MB → ${(new50.held / 1e6).toFixed(1)}MB`);
  ok("尾读结果与旧实现的尾部一致", new50.len === old50.len);

  // 再来一档：同样的尾读，文件换成 6MB —— 分配不许跟着文件变大
  const small = join(dir, "small.log");
  writeFileSync(small, Buffer.alloc(6 * 1024 * 1024, 0x61));
  const new6 = measure("new", small);

  ok("尾读在 6MB 与 50MB 日志上分配相同", Math.abs(new6.held - new50.held) < TAIL_BYTES,
    `6MB→${(new6.held / 1e6).toFixed(1)}MB，50MB→${(new50.held / 1e6).toFixed(1)}MB`);
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}

// —— 5. 静态防回归：两处服务端都不许再整读日志文件 ——
const sourceOf = (rel: string) => readFileSync(join(import.meta.dirname ?? ".", "..", rel), "utf8");

for (const rel of ["src/relay.ts", "electron/native-server.ts"]) {
  const src = sourceOf(rel);
  const body = src.match(/function readLogTail[\s\S]*?\n\}/)?.[0] ?? "";

  ok(`${rel}: 有 readLogTail 定长尾读`, !!body && body.includes("openSync") && body.includes("readSync"));
  ok(`${rel}: 尾读不再整读日志文件`, !/readFileSync\((?:file|logFile)/.test(body));
  ok(`${rel}: 按 start 偏移定位尾部`, body.includes("size - LOG_TAIL_BYTES") || body.includes("size - TAIL_BYTES") || body.includes("size - LOG_TAIL"));
  ok(`${rel}: fd 在 finally 里关闭`, /finally \{[\s\S]{0,60}closeSync\(fd\)/.test(body));
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
