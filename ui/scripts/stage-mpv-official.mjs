#!/usr/bin/env node
// Quaver — 暂存随包音频运行时（mpv 官方 release，Windows / macOS 专用）。
//
// 上游 mpv 从 v0.41 起 GitHub Release 直接托管 Windows（mingw x86_64 + msvc arm64）与
// macOS（macos-1x-arm / macos-1x-intel 两份 zip，内含自包含 mpv.app）二进制。Linux 不在此列
// —— Linux 走 pkgforge AppImage，见 stage-mpv.sh。
//
// 布局实测（v0.41.0）：
//   win mingw x64 zip = 外层单文件 zip → 内层 mpv-git-*.zip → 平铺 mpv.exe + 全套 DLL
//   win msvc  arm64 zip = 平铺 mpv.exe（静态链接）+ mpv.pdb（223MB 调试符号，必丢）+ vulkan-1.dll
//   mac zip = 单文件 mpv.tar.gz → mpv.app（MacOS/mpv + MacOS/lib/*.dylib + Frameworks/MoltenVK）
//
// macOS universal：两份单架构 mpv.app 结构逐文件同构 → 以 arm 包为底，lipo 逐个合并
// MacOS/mpv 与 lib/*.dylib（上游 ad-hoc 签名在合并后失效，必须重签 ad-hoc，否则 arm mac
// 直接拒跑）。
//
// 用法：
//   node scripts/stage-mpv-official.mjs [win32|darwin] [x64|arm64|universal] [目标目录]
//   平台/架构缺省按本机归一化；目标目录默认 ui/build-res/audio，产物落 <目录>/mpv/
// 校验：脚本做 sha256 + 机器码校验；装完用生产解析路径真跑一次：
//   cd ui && node electron/audio/bins.mjs --check build-res/audio
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, relative } from "node:path";
import { platform as hostPlatform, arch as hostArch } from "node:process";
import { spawnSync } from "node:child_process";

// —— 钉版本：升级时同时改 MPV_VERSION 与四个 sha256（GitHub API 的 asset digest 即 sha256）——
const MPV_VERSION = "0.41.0";
const BASE = `https://github.com/mpv-player/mpv/releases/download/v${MPV_VERSION}`;
const ASSETS = {
  "win32/x64":     { url: `${BASE}/mpv-v${MPV_VERSION}-x86_64-w64-mingw32.zip`,      sha256: "a49811c0752c108b8260636f9c6f6fcb97406641c98b30f1e7b500dfb20177de" },
  "win32/arm64":   { url: `${BASE}/mpv-v${MPV_VERSION}-aarch64-pc-windows-msvc.zip`, sha256: "a822abeffd0ac88951f4084f3425f949842aa17d616f880637ebe9041e482e97" },
  "darwin/arm64":  { url: `${BASE}/mpv-v${MPV_VERSION}-macos-15-arm.zip`,            sha256: "489cf6a54f57c54f86ad8d7cedaf5bb26848770d58dc059021214e2f689ee799" },
  "darwin/x64":    { url: `${BASE}/mpv-v${MPV_VERSION}-macos-15-intel.zip`,          sha256: "41003617ab4f7784394b5ddea7ce51b3e0838e8cfc8166ad1a378b2eda3b583c" },
};
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
  // 外层 zip（windows bsdtar / macOS bsdtar 都直接认 zip）
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

const USAGE = "用法: node scripts/stage-mpv-official.mjs [win32|darwin] [x64|arm64|universal] [目标目录]";

const plat = process.argv[2] ?? hostPlatform;
const arch = process.argv[3] ?? (hostArch === "arm64" ? "arm64" : "x64");
const destRoot = process.argv[4] ?? join(import.meta.dirname, "..", "build-res", "audio");
if (plat !== "win32" && plat !== "darwin") die(USAGE);
if (!["x64", "arm64", "universal"].includes(arch)) die(USAGE);
const need = arch === "universal"
  ? ["darwin/arm64", "darwin/x64"]
  : [`${plat}/${arch}`];
for (const k of need) if (!ASSETS[k]) die(`本脚本没有 ${k} 的随包方案（Linux 用 stage-mpv.sh）`);
if (arch === "universal" && plat !== "darwin") die("universal 只支持 darwin（lipo 需要 macOS 自带工具链）");

const dest = join(destRoot, "mpv");
const work = join(destRoot, ".work-mpv-official");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
try {
  const trees = {};
  for (const k of need) trees[k] = await fetchAndExtract(ASSETS[k], join(work, k.replace("/", "-")));

  if (plat === "win32") {
    // 平铺目录整棵搬走，剥 pdb/中间 zip；核对 PE 机器码
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(trees[need[0]], dest, { recursive: true, filter: (s) => {
      const base = s.split(/[\\/]/).pop();
      return !base.endsWith(".pdb") && !base.endsWith(".zip") && !base.endsWith(".bat");
    } });
    const exe = join(dest, "mpv.exe");
    if (!existsSync(exe)) die(`载荷缺失：${exe}`);
    checkPE(exe, arch === "arm64" ? 0xaa64 : 0x8664);
    console.log(`✓ 落盘 ${dest}（mpv.exe + 运行时 DLL）`);
  } else if (arch === "universal") {
    // 以 arm 包为底，**整棵树递归 lipo**（MacOS/lib、Frameworks/ 的 MoltenVK、主二进制
    // —— 只处理 MacOS/lib 会把 arm-only 的 dylib 留进两个临时包，universal 合并必炸）。
    const armApp = join(trees["darwin/arm64"], "mpv.app");
    const intelApp = join(trees["darwin/x64"], "mpv.app");
    for (const p of [armApp, intelApp]) if (!existsSync(p)) die(`mpv.app 缺失：${p}`);
    const lipo = (a, b, out) => sh("lipo", ["-create", a, b, "-output", out]);
    // 占位文件（.gitkeep）与资源（plist/icns/json）不是 Mach-O，lipo 会直接 fatal ——
    // 按魔数过滤（fat 0xcafebabe/0xbebafeca + Mach-O 32/64 及其字节序变体），只并真二进制。
    const magics = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
    const isMachO = (p) => {
      try { return magics.has(readFileSync(p).subarray(0, 4).readUInt32BE(0)); }
      catch { return false; }
    };
    const relFiles = (root) => {
      const out = [];
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.isFile()) out.push(relative(root, p));   // 以各自 root 为基准，两侧才可比
        }
      };
      walk(root);
      return out.sort();
    };
    const armFiles = relFiles(armApp), intelFiles = relFiles(intelApp);
    // 两包并非严格同构（实测 arm 独有 Frameworks/libMoltenVK.dylib，intel 没带）。
    // 单侧独有二进制既没法 universal、electron-builder 合并也会拒 → 丢弃（mpv 纯音频
    // 用途不走 Vulkan）；单侧独有的资源文件以 arm 侧为准保留/补拷。
    for (const rel of armFiles) {
      const a = join(armApp, rel), b = join(intelApp, rel);
      if (!intelFiles.includes(rel)) {
        if (isMachO(a)) console.log(`⚠ 单侧独有二进制，丢弃：${rel}`), rmSync(a);
        continue;   // 独有资源保留
      }
      if (!isMachO(a) || !isMachO(b)) continue;   // 资源/占位文件以 arm 侧为准
      // 某个文件自身已是 universal（双架构都在）就不用并
      const archs = sh("lipo", ["-archs", a], { stdio: ["ignore", "pipe", "pipe"] }).stdout;
      if (archs.includes("x86_64") && archs.includes("arm64")) continue;
      sh("chmod", ["u+w", a]);   // 上游 dylib 常是 0444/0555，lipo -output 覆盖写需要写位
      lipo(a, b, a);
    }
    for (const rel of intelFiles) {
      if (armFiles.includes(rel)) continue;
      const b = join(intelApp, rel);
      if (isMachO(b)) { console.log(`⚠ intel 独有二进制，丢弃：${rel}`); continue; }
      mkdirSync(dirname(join(armApp, rel)), { recursive: true });
      copyFileSync(b, join(armApp, rel));
    }
    const info = sh("lipo", ["-info", join(armApp, "Contents/MacOS/mpv")], { stdio: ["ignore", "pipe", "pipe"] }).stdout;
    for (const a of ["x86_64", "arm64"]) if (!info.includes(a)) die(`lipo 结果缺 ${a}: ${info}`);
    // 合并后原 ad-hoc 签名失效 → 重签（不签 arm mac 直接拒跑）
    sh("codesign", ["--force", "--deep", "-s", "-", armApp]);
    // cpSync 是「dest 变成 src 的拷贝」语义：必须落进 dest/mpv.app，
    // 保持 bins.mjs 约定的 <声源根>/mpv/mpv.app/Contents/MacOS/mpv 布局
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(armApp, join(dest, "mpv.app"), { recursive: true });
    console.log(`✓ 落盘 ${dest}（universal mpv.app：${info.trim()}，已重签 ad-hoc）`);
  } else {
    const app = join(trees[need[0]], "mpv.app");
    if (!existsSync(app)) die(`mpv.app 缺失：${app}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(app, join(dest, "mpv.app"), { recursive: true });
    console.log(`✓ 落盘 ${dest}（mpv.app）`);
  }
  console.log(`✓ 完成。验证：cd ui && node electron/audio/bins.mjs --check ${destRoot}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
