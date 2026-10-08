// Quaver — mpv 看门狗（与主进程共存亡）。
// 背景：mpv 是主进程 spawn 的子进程，但电脑注销/关机时 systemd-logind 会先 SIGTERM、
// 超时后 SIGKILL 会话内所有进程 —— Electron 主进程一死，will-quit 等收尾代码根本没机会跑，
// mpv 就成了孤儿继续放歌（实测：前端退了音乐还在响）。
//
// 原理：主进程 spawn 本进程时递给它一根 stdin 管道、写端握在主进程手里。父进程无论以
// 何种方式死亡（正常退出 / 崩溃 / SIGKILL / 注销），写端必然关闭 → 这边读到 EOF →
// SIGKILL mpv。纯 Node 实现（主进程以 ELECTRON_RUN_AS_NODE 拉起），不依赖 prctl/原生模块。
//
// 退出路径：主进程主动收尾（引擎 shutdown / mpv 自身退出）会 end 管道并直接 kill 本进程；
// 无论如何本进程生命周期 ≤ 主进程，不留驻。
const pid = Number(process.argv[2]);
if (!Number.isFinite(pid) || pid <= 0) process.exit(2);

const killMpv = () => {
  try { process.kill(pid, "SIGKILL"); } catch { /* ESRCH：mpv 已死，正好 */ }
};

// stdin 必须显式 resume，否则流不启动、EOF 永远不来。end/close/error 任一 → 送 mpv 陪葬。
process.stdin.resume();
process.stdin.on("end", () => { killMpv(); process.exit(0); });
process.stdin.on("close", () => { killMpv(); process.exit(0); });
process.stdin.on("error", () => { killMpv(); process.exit(0); });
