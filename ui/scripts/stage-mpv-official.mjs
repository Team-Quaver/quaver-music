#!/usr/bin/env node
// Quaver — 暂存随包音频运行时（mpv 官方 release，Windows / macOS 专用）。
//
// 上游 mpv 从 v0.41 起 GitHub Release 直接托管 Windows（mingw x86_64 + msvc arm64）与
// macOS（macos-1x-arm 自包含 mpv.app）二进制。Linux 不在此列 —— Linux 走 pkgforge
// AppImage，见 stage-mpv.sh。macOS 只出 arm64（x86 构建已裁撤）。
//
// 布局实测（v0.41.0）：
//   win mingw x64 zip = 外层单文件 zip → 内层 mpv-git-*.zip → 平铺 mpv.exe + 全套 DLL
//   win msvc  arm64 zip = 平铺 mpv.exe（静态链接）+ mpv.pdb（223MB 调试符号，必丢）+ vulkan-1.dll
//   mac zip = 单文件 mpv.tar.gz → mpv.app（MacOS/mpv + MacOS/lib/*.dylib + Frameworks/MoltenVK）
//
// 用法：
//   node scripts/stage-mpv-official.mjs [win32|darwin] [x64|arm64] [目标目录]
//   平台/架构缺省按本机归一化；目标目录默认 ui/build-res/audio，产物落 <目录>/mpv/
// 校验：脚本做 sha256 + PE 机器码 +（macOS）Mach-O 最低系统版本校验；装完用生产解析路径真跑一次：
//   cd ui && node electron/audio/bins.mjs --check build-res/audio
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { platform as hostPlatform, arch as hostArch } from "node:process";
import { spawnSync } from "node:child_process";
import { formatOsVersion, machOMinOs, osVersionGt } from "../electron/audio/macho.mjs";
import { ASSETS, MACOS_FLOOR } from "./mpv-assets.mjs";

// 版本钉与资产表在 mpv-assets.mjs（纯数据，好让 verify-mpv 断言「mac 那份必须是最低档」）；
// macOS 那份取 macos-14：上游按构建机的系统版本出 14 / 15 / 26 三档，Mach-O 的 minos 就是那个
// 版本号 —— 塞 macos-15 那份给 macOS 14 的用户 = 一启动就被 dyld 拒（v0.41 实测 SIGABRT +
// 「built for macOS 15.0 which is newer than running OS」）。跟 Windows 不同，这里没法靠「跑一次」
// 发现 —— CI runner 是 macOS 15，跑得动，只有老系统的用户才炸 → 由 assertMacOSFloor 静态卡住。

// mingw x64 与 msvc arm64：mingw 自带全套运行时 DLL（自包含），arm64 只有 msvc 构建
// （静态链接）。mpv.pdb 是调试符号（>200MB），一律剥掉。

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function sh(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", ...opts });
  if (r.status !== 0) die(`${bin} ${args.join(" ")} 失败（exit=${r.status}）:\n${r.stderr}`);
  return r;
}

/** zip 解包：GNU tar 不认 zip（windows runner 的 Git Bash 里 tar 也是 GNU 的），按可用性降级 */
function extractZip(zip, dir) {
  const attempts = [
    ["unzip", ["-qo", zip, "-d", dir]],
    ["bsdtar", ["-xf", zip, "-C", dir]],
    ["tar", ["-xf", zip, "-C", dir]],   // bsdtar 装在 PATH 里时叫 tar（macOS 自带、windows System32）
  ];
  let lastErr = "";
  for (const [bin, args] of attempts) {
    const r = spawnSync(bin, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status === 0) return;
    lastErr = `${bin}: ${(r.stderr || "").trim().split("\n")[0]}`;
  }
  if (process.platform === "win32") {
    const winPath = (p) => spawnSync("cygpath", ["-w", p], { encoding: "utf8" }).stdout?.trim() ?? p;
    const r = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${winPath(zip)}' -DestinationPath '${winPath(dir)}' -Force`,
    ], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status === 0) return;
    lastErr = `powershell Expand-Archive: ${(r.stderr || "").trim()}`;
  }
  die(`zip 解包失败（${zip}）\n  最后错误：${lastErr}`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) die(`下载失败 ${res.status}: ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 下载（带 sha256 校验）并解到 dir；返回 dir。 */
async function fetchAndExtract(asset, dir) {
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "asset.bin");
  console.log(`→ 下载 ${asset.url.split("/").pop()}`);
  await download(asset.url, zipPath);
  const got = sha256File(zipPath);
  if (got !== asset.sha256) die(`sha256 不匹配（上游重打包或下载损坏）\n  期望 ${asset.sha256}\n  实得 ${got}`);
  console.log("→ 校验 sha256 OK");
  extractZip(zipPath, dir);
  rmSync(zipPath, { force: true });
  // 嵌套层：win mingw 外层 zip 里还有一个 mpv-git-*.zip；mac 外层里是 mpv.tar.gz
  const nestedZip = readdirSync(dir).find((n) => n.endsWith(".zip"));
  if (nestedZip) {
    const inner = join(dir, nestedZip);
    extractZip(inner, dir);
    rmSync(inner, { force: true });
  }
  const nestedTgz = readdirSync(dir).find((n) => n.endsWith(".tar.gz"));
  if (nestedTgz) sh("tar", ["-xzf", join(dir, nestedTgz), "--no-same-owner", "-C", dir]);
  return dir;
}

/** PE 机器码核对（跨架构 exec 只是跑不起来不会报错，必须看头部） */
function checkPE(exe, want) { // want: 0x8664 | 0xaa64
  const b = readFileSync(exe);
  const off = b.readUInt32LE(0x3c);
  if (b.toString("ascii", off, off + 4) !== "PE\0\0") die(`${exe} 不是 PE 文件`);
  const machine = b.readUInt16LE(off + 4);
  if (machine !== want) die(`${exe} 机器码 0x${machine.toString(16)} ≠ 0x${want.toString(16)}`);
}

/** macOS 载荷的最低系统版本核对。
 *  上游按构建机系统版本发 macos-14 / 15 / 26 几份，Mach-O 里写死的 minos 就跟着抬 —— 装高了
 *  在低版本系统上 dyld 直接 abort（SIGABRT，「built for macOS x.y which is newer than running OS」），
 *  而 CI runner 恰好在够新的系统上，跑得动、验不出。所以门槛必须静态读出来卡在构建期。
 *  顺带把实际门槛打进日志：将来升级 mpv 时，要能一眼看出地板有没有被抬高。 */
function assertMacOSFloor(payload) {
  const min = machOMinOs(payload);
  if (!min) die(`${payload} 读不到 Mach-O 最低系统版本（布局变了？）`);
  console.log(`→ 载荷最低系统版本：macOS ${formatOsVersion(min)}`);
  if (osVersionGt(min, MACOS_FLOOR)) {
    die(`随包 mpv 要求 macOS ${formatOsVersion(min)}，高于本项目地板 macOS ${formatOsVersion(MACOS_FLOOR)}`
      + `\n  上游换更高版本的构建了？把 ASSETS 里 darwin/arm64 指向编号最低的那份资产，`
      + `否则低版本 macOS 的用户一播放就 SIGABRT。`);
  }
}

const USAGE = "用法: node scripts/stage-mpv-official.mjs [win32|darwin] [x64|arm64] [目标目录]";

const plat = process.argv[2] ?? hostPlatform;
const arch = process.argv[3] ?? (hostArch === "arm64" ? "arm64" : "x64");
const destRoot = process.argv[4] ?? join(import.meta.dirname, "..", "build-res", "audio");
if (plat !== "win32" && plat !== "darwin") die(USAGE);
if (arch !== "x64" && arch !== "arm64") die(USAGE);
const key = `${plat}/${arch}`;
if (!ASSETS[key]) die(`本脚本没有 ${key} 的随包方案（Linux 用 stage-mpv.sh）`);

const dest = join(destRoot, "mpv");
const work = join(destRoot, ".work-mpv-official");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
try {
  const tree = await fetchAndExtract(ASSETS[key], join(work, key.replace("/", "-")));

  if (plat === "win32") {
    // 平铺目录整棵搬走，剥 pdb/中间 zip；核对 PE 机器码
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(tree, dest, { recursive: true, filter: (s) => {
      const base = s.split(/[\\/]/).pop();
      return !base.endsWith(".pdb") && !base.endsWith(".zip") && !base.endsWith(".bat");
    } });
    const exe = join(dest, "mpv.exe");
    if (!existsSync(exe)) die(`载荷缺失：${exe}`);
    checkPE(exe, arch === "arm64" ? 0xaa64 : 0x8664);
    console.log(`✓ 落盘 ${dest}（mpv.exe + 运行时 DLL）`);
  } else {
    const app = join(tree, "mpv.app");
    if (!existsSync(app)) die(`mpv.app 缺失：${app}`);
    // cpSync 是「dest 变成 src 的拷贝」语义：必须落进 dest/mpv.app，
    // 保持 bins.mjs 约定的 <声源根>/mpv/mpv.app/Contents/MacOS/mpv 布局
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(app, join(dest, "mpv.app"), { recursive: true });
    assertMacOSFloor(join(dest, "mpv.app", "Contents", "MacOS", "mpv"));
    console.log(`✓ 落盘 ${dest}（mpv.app）`);
  }
  console.log(`✓ 完成。验证：cd ui && node electron/audio/bins.mjs --check ${destRoot}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
