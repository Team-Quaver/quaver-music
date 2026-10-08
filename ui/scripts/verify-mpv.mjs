// Quaver — 随包 audio 运行时（mpv）的版本钉 + 门槛判据 + 接线：单测与源码护栏。
// 跑：  node scripts/verify-mpv.mjs
//
// 背景：这一块最贵的回归是「随包 mpv 在某一类机器上一启动就死」，而它在本机与 CI 都验不出来 ——
// CI 是 macOS 15 runner，v0.41 的 macos-15 那份在那儿跑得好好的，macOS 14 的用户却直接 SIGABRT
// （dyld: built for macOS 15.0 which is newer than running OS）。所以抓三头：
//   • 判据本身：macho.mjs 用合成镜像单测（mos 编码/优先级/fat/垃圾输入）
//   • 版本钉：mpv-assets.mjs —— mac 那份不能比地板高（数字就是载荷的最低系统版本）
//   • 接线：暂存脚本必须真按地板卡、运行期必须真自检并回落（源码护栏，跟 verify-icon 同款路子）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";
import {
  formatOsVersion, machOMinOs, osVersionGt, parseOsVersion,
} from "../electron/audio/macho.mjs";
import { probeRuntime, resolveBundled } from "../electron/audio/bins.mjs";
import { ASSETS, MACOS_FLOOR, MPV_VERSION, macosAssetMajor } from "./mpv-assets.mjs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = join(import.meta.dirname, "..");
const pack = (major, minor = 0, patch = 0) => ((major & 0xffff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);

/** 合成一个 thin Mach-O：只放我们要的 load command（足够喂解析器，不需要真能跑） */
function fakeMacho(commands, { magic = 0xfeedfacf, is64 = true } = {}) {
  const head = Buffer.alloc(is64 ? 32 : 28);
  head.writeUInt32LE(magic, 0);
  head.writeUInt32LE(0x0100000c, 4);              // CPU_TYPE_ARM64
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(2, 12);                      // MH_EXECUTE
  head.writeUInt32LE(commands.length, 16);
  head.writeUInt32LE(commands.reduce((n, c) => n + c.length, 0), 20);
  return Buffer.concat([head, ...commands]);
}
/** LC_BUILD_VERSION（cmd 0x32）：minos 在偏移 12 */
function lcBuild(minos) {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(0x32, 0); b.writeUInt32LE(24, 4);
  b.writeUInt32LE(1, 8);            // platform = macOS
  b.writeUInt32LE(minos, 12);
  b.writeUInt32LE(pack(15), 16);
  return b;
}
/** LC_VERSION_MIN_MACOSX（cmd 0x24）：version 在偏移 8 */
function lcVersionMin(version) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x24, 0); b.writeUInt32LE(16, 4);
  b.writeUInt32LE(version, 8); b.writeUInt32LE(pack(15), 12);
  return b;
}
/** 合成一个 fat 二进制：头 + 一个 arch 描述，切片放在 offset 处 */
function fakeFat(thin, offset = 4096) {
  const head = Buffer.alloc(4096);
  head.writeUInt32BE(0xcafebabe, 0); // FAT_MAGIC（大端）
  head.writeUInt32BE(1, 4);          // nfat_arch
  head.writeUInt32BE(0x0100000c, 8); // cputype
  head.writeUInt32BE(0, 12);
  head.writeUInt32BE(offset, 16);
  head.writeUInt32BE(thin.length, 20);
  head.writeUInt32BE(14, 24);
  return Buffer.concat([head, thin]);
}

// ——— Mach-O 最低系统版本解析 ———
section("macho.mjs：门槛判据");
eq("LC_BUILD_VERSION 的 minos（major/minor/patch 拆分）", machOMinOs(fakeMacho([lcBuild(pack(15, 0, 0))])), { major: 15, minor: 0, patch: 0 });
eq("小版本号也拆得对", machOMinOs(fakeMacho([lcBuild(pack(14, 5, 0))])), { major: 14, minor: 5, patch: 0 });
eq("只有 LC_VERSION_MIN_MACOSX 时回落它", machOMinOs(fakeMacho([lcVersionMin(pack(11, 2, 0))])), { major: 11, minor: 2, patch: 0 });
eq("两条都在时 BUILD_VERSION 优先（新链接器口径）",
  machOMinOs(fakeMacho([lcVersionMin(pack(11, 2, 0)), lcBuild(pack(15, 0, 0))])), { major: 15, minor: 0, patch: 0 });
eq("两条都在、顺序反过来同样优先 BUILD_VERSION",
  machOMinOs(fakeMacho([lcBuild(pack(15, 0, 0)), lcVersionMin(pack(11, 2, 0))])), { major: 15, minor: 0, patch: 0 });
eq("fat（universal）取第一个架构切片", machOMinOs(fakeFat(fakeMacho([lcBuild(pack(14, 0, 0))]))), { major: 14, minor: 0, patch: 0 });
eq("没有门槛类 load command → null", machOMinOs(fakeMacho([])), null);
eq("不是 Mach-O（PNG 头）→ null", machOMinOs(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), null);
eq("全是 0 的垃圾 → null", machOMinOs(Buffer.alloc(64)), null);
eq("32 位头也认（MH_MAGIC）", machOMinOs(fakeMacho([lcBuild(pack(12, 0, 0))], { magic: 0xfeedface, is64: false })), { major: 12, minor: 0, patch: 0 });
eq("长度不够 → null（不许抛）", machOMinOs(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), null);
eq("路径不存在 → null（不许抛）", machOMinOs(join(UI, "build-res", "audio", "__nope__")), null);

eq("formatOsVersion 补足三段", formatOsVersion({ major: 14, minor: 0, patch: 0 }), "14.0.0");
eq("formatOsVersion 对 null 返回空串", formatOsVersion(null), "");
eq("parseOsVersion \"14.5.2\"", parseOsVersion("14.5.2"), { major: 14, minor: 5, patch: 2 });
eq("parseOsVersion \"14.5\" 补 0", parseOsVersion("14.5"), { major: 14, minor: 5, patch: 0 });
eq("parseOsVersion 认不出的返回 null", parseOsVersion("Sonoma"), null);
check("osVersionGt：15.0.0 > 14.0.0", osVersionGt({ major: 15, minor: 0, patch: 0 }, { major: 14, minor: 5, patch: 3 }) === true);
check("osVersionGt：14.0.0 不大于 14.0.0", osVersionGt({ major: 14, minor: 0, patch: 0 }, { major: 14, minor: 0, patch: 0 }) === false);
check("osVersionGt：任一侧 null 时判不出来（不乱报警）",
  osVersionGt({ major: 15, minor: 0, patch: 0 }, null) === false && osVersionGt(null, { major: 14, minor: 0, patch: 0 }) === false);

// ——— 版本钉：mac 那份不能比地板高 ———
section("mpv-assets.mjs：版本钉");
check("三个平台的资产都在（CI 就 stage 这三份）",
  ["win32/x64", "win32/arm64", "darwin/arm64"].every((k) => ASSETS[k]),
  `实有 ${Object.keys(ASSETS).join(" ")}`);
for (const [key, a] of Object.entries(ASSETS)) {
  check(`${key}：url 指向上游 v${MPV_VERSION} 的 release 资产`,
    a.url.startsWith(`https://github.com/mpv-player/mpv/releases/download/v${MPV_VERSION}/mpv-v${MPV_VERSION}-`), a.url);
  check(`${key}：sha256 是 64 位小写 hex（digest 抄错就是「下载校验失败」）`,
    /^[0-9a-f]{64}$/.test(a.sha256 ?? ""), String(a.sha256));
}
const macMajor = macosAssetMajor(ASSETS["darwin/arm64"].url);
eq("darwin 资产能抠出 macos 档位号", macMajor, 14);
check("darwin 资产档位 ≤ 本项目地板（装高了低版本系统一启动就 SIGABRT）",
  macMajor !== null && macMajor <= MACOS_FLOOR.major,
  `资产 macOS ${macMajor} > 地板 ${MACOS_FLOOR.major}`);
eq("macosAssetMajor 对非 mac 资产返回 null", macosAssetMajor(ASSETS["win32/x64"].url), null);

// ——— 接线：暂存脚本与运行期 ———
section("源码护栏：构建期卡门槛 + 运行期自检");
const stageSrc = readFileSync(join(UI, "scripts", "stage-mpv-official.mjs"), "utf8");
check("暂存脚本从 mpv-assets.mjs 取资产表（版本钉只有一份真相）",
  /from "\.\/mpv-assets\.mjs"/.test(stageSrc) && !/^const ASSETS = /m.test(stageSrc));
check("darwin 分支落盘后按地板校验最低系统版本", /assertMacOSFloor\(\s*join\(dest/.test(stageSrc));
check("校验高于地板就 die（不是只打日志）", /osVersionGt\(min, MACOS_FLOOR\)[\s\S]{0,120}die\(/.test(stageSrc));

const engineSrc = readFileSync(join(UI, "electron", "audio", "engine.mjs"), "utf8");
check("引擎导入 probeRuntime 做开机自检", /import \{[^}]*probeRuntime[^}]*\} from "\.\/bins\.mjs"/.test(engineSrc));
check("自检结果只算一次（bundledProbe 缓存）", /this\.bundledProbe === undefined/.test(engineSrc));
check("自检失败回落宿主 mpv（bundledRoot: null）",
  /this\.bin = resolveMpv\(\{ bundledRoot: null \}\)/.test(engineSrc));
check("失败原因进日志（含 macOS 门槛 vs 本机的对照）",
  /osVersionGt\(min, running\)/.test(engineSrc) && /this\.binNote =/.test(engineSrc));
check("找不运行时把随包失败原因一并说清（别只说「未找到 mpv」）",
  /未找到 mpv 可执行文件[\s\S]{0,80}this\.binNote/.test(engineSrc));

const binsSrc = readFileSync(join(UI, "electron", "audio", "bins.mjs"), "utf8");
check("bins.mjs 导出 probeRuntime（CI --check 与运行期共用同一判据）",
  /export function probeRuntime\(/.test(binsSrc) && /const probe = probeRuntime\(found\)/.test(binsSrc));
check("probeRuntime 认「被信号带走」为失败（dyld abort 就是这种）", /!r\.signal/.test(binsSrc));

// ——— 有随包运行时的话，真跑一次（本机没 stage 就跳过） ———
section("随包运行时实跑（可选）");
const root = join(UI, "build-res", "audio");
const found = resolveBundled(root);
if (!found) {
  console.log("  ⏭  本机没有 stage 随包运行时（build-res/audio 空）—— 跳过；CI 与装机后各跑一次");
} else {
  const probe = probeRuntime(found, 30000);
  check(`随包 mpv 真跑得起来（${found.payload}）`, probe.ok, `exit=${probe.status} signal=${probe.signal}\n${probe.output.slice(0, 300)}`);
  if (platform === "darwin") {
    const min = machOMinOs(found.payload);
    check("随包 mpv 声明的最低系统版本不高于地板",
      min !== null && !osVersionGt(min, MACOS_FLOOR),
      `载荷 macOS ${formatOsVersion(min)} > 地板 ${formatOsVersion(MACOS_FLOOR)}`);
    check("本机系统版本够跑这份随包运行时",
      !osVersionGt(min, parseOsVersion(process.getSystemVersion?.() ?? "")),
      `本机 ${process.getSystemVersion?.()} < 载荷要求的 ${formatOsVersion(min)}`);
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-mpv: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
