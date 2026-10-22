// Quaver — POSIX PCM FIFO helper。
//
// 主进程不能直接长期阻塞读 FIFO：进程退出时 libuv 的 open/read 可能还挂在 FIFO 上，
// Node 窗口关不掉。这里把 FIFO 读端放到独立 helper，主进程通过其 stdin 控制生命周期：
// 主进程一死，stdin 关闭 → helper 退出，不会留下卡在 FIFO 的 cat/sh。
//
// helper 只做字节搬运，不解析 PCM；背压通过 stdout drain 回传到 FIFO → mpv。
import { closeSync, constants, createReadStream, openSync } from "node:fs";

const fifo = process.argv[2];
const parentPid = Number(process.argv[3]);

if (!fifo) process.exit(2);

let fd: number;

try {
  // O_RDWR：writer 关闭后不会立刻 EOF，下一首歌 mpv 打开同名 FIFO 时可以继续写。
  fd = openSync(fifo, constants.O_RDWR);
} catch (e) {
  console.error("[pcm-pipe-helper] open failed:", String(e));
  process.exit(3);
}

const reader = createReadStream(fifo, { fd, autoClose: false, highWaterMark: 64 * 1024 });
let done = false;

function cleanup() {
  if (done) return;
  done = true;

  try { reader.destroy(); } catch {}

  try { closeSync(fd); } catch {}

  process.exit(0);
}

reader.on("data", (chunk) => {
  if (!process.stdout.write(chunk)) reader.pause();
});

process.stdout.on("drain", () => reader.resume());

process.stdout.on("error", () => cleanup());

// 主进程保持 stdin 写端打开；进程退出/崩溃/被 SIGKILL 时管道断开，helper 跟着退。
process.stdin.resume();

process.stdin.on("end", cleanup);

process.stdin.on("close", cleanup);

process.stdin.on("error", cleanup);

process.on("SIGTERM", cleanup);

process.on("SIGINT", cleanup);

// 父进程被 SIGKILL 时 stdin EOF 可能有平台时序差异；PID 探针是最后一道保险。
if (Number.isFinite(parentPid) && parentPid > 0) {
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) { cleanup(); return; }

    try { process.kill(parentPid, 0); } catch { cleanup(); }
  }, 500);

  timer.unref();
}
