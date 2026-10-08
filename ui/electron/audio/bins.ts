// Quaver — 音频运行时二进制解析（当前只有 mpv）。
// 解析顺序：env 显式路径（QUAVER_MPV）> 随包运行时 > 宿主 PATH。
// 随包是优化不是前提：三级兜底本来就在，没有随包那份就落系统 mpv，再没有就由渲染层落 <audio>。
// 只认可执行文件：AppImage 只读挂载点不允许运行时 chmod，env 顶掉包里那份是排障刚需。
//
// 随包运行时按平台分三套布局（暂存脚本：Linux=stage-mpv.sh，Windows/macOS=stage-mpv-official.ts）：
//   linux  = pkgforge mpv AppImage 构建期 --appimage-extract 出来的 quick-sharun 目录
//   win32  = mpv 官方 release zip（mingw/msvc）平铺的 mpv.exe + 同目录 DLL
//   darwin = mpv 官方 release 包的 mpv.app（自带 dylib，按 @executable_path 自举）
// darwin 那份另有一条系统性坑：上游按构建机的系统版本出 macos-14/15/26 多档，Mach-O 里写死的
// minos 就是那个版本号 —— 装高了在低版本系统上 dyld 直接拒（SIGABRT），所以暂存脚本按地板挑资产并
// 静态校验（见 macho.ts / stage-mpv-official.ts），运行期 probeRuntime 再兜一道。
// Linux 那套里有两件事必须照它自己的声明来做，别自作聪明：
//   1. 载荷在 mpv/shared/bin/mpv，不能裸跑（缺包内 so，如 libunibreak）；
//   2. 用包内自带 loader + `lib/lib.path` 声明的库路径启动 ——
//      **绝不能改用宿主 LD_LIBRARY_PATH**：那会让宿主 loader 加载包内 libc.so.6，
//      glibc 混用直接 `undefined symbol: __pointer_chk_guard` 崩掉。
// 也不要走它的 AppRun：sharun 启动器会跑包内钩子（10-self-updater 会下载
// appimageupdatetool 自更新、05-get-yt-dlp 会弹「要不要装 yt-dlp」）—— 对 spawn 出来的
// 子进程是灾难。loader 直启载荷 = 同一套运行时、零钩子。
//
// CLI（CI 与本地自检用；验的就是生产解析路径本身）：
//   node electron/audio/bins.ts --check <声源根>   # 只认随包运行时，真跑一次 --version
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { env, platform } from "node:process";
import { spawnSync } from "node:child_process";

const PATH_SEP = platform === "win32" ? ";" : ":";
const isExec = (p: string): boolean => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** 在 PATH 各目录里找一个可执行文件 */
function fromPath(name: string): string | null {
  for (const dir of (env.PATH ?? "").split(PATH_SEP)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (isExec(p)) return p;
  }
  return null;
}

/** 解析 lib/lib.path：基准是 lib/，`+<子目录>` 追加（单独的 `+` 行是重复基准，跳过） */
function libraryPath(tree: string): string {
  const libDir = join(tree, "lib");
  const parts = [libDir];
  const decl = join(libDir, "lib.path");
  if (existsSync(decl)) {
    for (const raw of readFileSync(decl, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("+")) continue;
      const sub = line.slice(1).replace(/^\/+/, "");
      if (sub) parts.push(join(libDir, sub));
    }
  }
  return parts.join(PATH_SEP);
}

/** 自带 loader（ld-linux-*.so.*）：与包内 libc 配套，必须用它启动载荷 */
function findLoader(tree: string): string | null {
  const libDir = join(tree, "lib");
  if (!existsSync(libDir)) return null;
  const hit = readdirSync(libDir).filter((n) => /^ld-linux.*\.so/.test(n)).sort()[0];
  return hit ? join(libDir, hit) : null;
}

/**
 * 解析到的 mpv 可执行体：payload 是真正 spawn 的东西，argv 是完整命令行
 * （随包 Linux 运行时 = [loader, --library-path, <lp>, 载荷, ...mpv 参数]）。
 */
export interface MpvBin {
  source: "env" | "bundled" | "path";
  payload: string;
  argv: string[];
}

/** 随包 Linux 运行时的解析结果：多了运行时根目录（macho 门槛判据 / 日志用）。 */
export interface BundledRuntime extends MpvBin {
  tree: string;
}

/**
 * 解析随包运行时。
 * @param audioRoot 声源根（打包态 <resources>/audio，开发态 ui/build-res/audio）
 */
export function resolveBundled(audioRoot: string | null | undefined): BundledRuntime | null {
  if (!audioRoot) return null;
  const tree = join(audioRoot, "mpv");
  // win32 / darwin：官方二进制自包含（win 同目录找 DLL；mac mpv.app 自带 dylib rpath），
  // 直接 spawn 载荷本身，不需要 Linux 那套 loader + lib.path 花活。
  if (platform === "win32") {
    const payload = join(tree, "mpv.exe");
    if (!isExec(payload)) return null;
    return { source: "bundled", payload, argv: [payload], tree };
  }
  if (platform === "darwin") {
    const payload = join(tree, "mpv.app", "Contents", "MacOS", "mpv");
    if (!isExec(payload)) return null;
    return { source: "bundled", payload, argv: [payload], tree };
  }
  const payload = join(tree, "shared", "bin", "mpv");
  if (!isExec(payload)) return null; // 目录在但没产物（本地只放 .gitkeep）= 未随包，正常回落
  const loader = findLoader(tree);
  if (!loader) return null;
  return {
    source: "bundled",
    payload,
    // 完整 spawn argv：argv[0] 是包内 loader，mpv 参数接在载荷之后（loader 的 --library-path
    // 必须排在程序名之前）。
    argv: [loader, "--library-path", libraryPath(tree), payload],
    tree,
  };
}

/**
 * 解析 mpv 运行时。返回的 `argv` 是完整 spawn argv（argv[0] = 可执行文件）。
 * @param {{bundledRoot?: string}} [opts]
 * @returns {{source:"env"|"bundled"|"path", payload:string, argv:string[], tree?:string}|null}
 */
export function resolveMpv(opts: { bundledRoot?: string | null } = {}): MpvBin | null {
  // 1) env 显式路径：排障要能一条 env 顶掉包里那份；指定了但不可执行就直接判不可用，
  //    不再偷偷回落（排障要可预期）。env 那份按普通可执行文件启动。
  const explicit = env.QUAVER_MPV;
  if (explicit) {
    return isExec(explicit) ? { source: "env", payload: explicit, argv: [explicit] } : null;
  }
  // 2) 随包运行时
  const bundled = resolveBundled(opts.bundledRoot);
  if (bundled) return bundled;
  // 3) 宿主 PATH
  const name = platform === "win32" ? "mpv.exe" : "mpv";
  const p = fromPath(name);
  return p ? { source: "path", payload: p, argv: [p] } : null;
}

/** 真跑一次 `--version` 的自检结果（CI --check 与引擎开机自检共用）。 */
export interface MpvProbe {
  ok: boolean;
  status: number | null;
  signal: string | null;
  output: string;
}

/**
 * 真跑一次 `--version`。可执行位在 ≠ 跑得起来 —— 跨架构（exec 126）、缺库、以及 macOS 上
 * 「载荷声明的最低系统版本比本机高」被 dyld 直接拒，全都是 spawn 成功、进程立刻死，
 * 只有真执行一次才知道（CI 自检与引擎开机自检共用这一份判据）。
 */
export function probeRuntime(resolved: { payload: string; argv: string[] }, timeoutMs = 30000): MpvProbe {
  const [bin, ...rest] = resolved.argv;
  const r = spawnSync(bin, [...rest, "--version"], { encoding: "utf8", timeout: timeoutMs });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  // stdout 里混日志/崩溃报告是常态 → 按行找版本行（mpv 的门面是 "mpv v0.41.0 ..."）
  return {
    ok: r.status === 0 && !r.signal && /^mpv v?\d/m.test(output),
    status: r.status ?? null,
    signal: r.signal ?? null,
    output,
  };
}

// —— CLI：--check <audioRoot>（只认随包运行时；真跑一次 --version）——
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [flag, root] = process.argv.slice(2);
  if (flag !== "--check" || !root) {
    console.error("用法: node electron/audio/bins.ts --check <声源根目录>");
    process.exit(2);
  }
  const found = resolveBundled(root);
  if (!found) {
    console.error(`✗ 随包运行时不可用：${root}（本平台预期的载荷/loader 不在位，布局见 resolveBundled）`);
    process.exit(1);
  }
  // 真跑一次：跨架构/缺库/系统版本不够都不会在 exec 时报错，只会跑不起来，必须执行才算验过
  const probe = probeRuntime(found);
  if (!probe.ok) {
    console.error(`✗ 随包 mpv 跑不起来（exit=${probe.status}${probe.signal ? `, signal=${probe.signal}` : ""}）:\n${probe.output}`);
    process.exit(1);
  }
  console.log(`✓ 随包 mpv 可用：${probe.output.split("\n")[0]}`);
  console.log(`  payload: ${found.payload}`);
}
