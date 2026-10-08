// Quaver — Mach-O 头部读「最低系统版本」（纯 Node，零依赖，可单测）。
//
// 为什么需要它：门槛不对的二进制**不会报错，只会跑不起来**。macOS 上那就是 dyld 一句
//   Symbol not found: … (built for macOS 15.0 which is newer than running OS)
// 然后 SIGABRT —— 应用侧只看到「mpv 起不来」，看不出是「随包运行时要求的系统版本比本机高」。
// 而 CI 在 macos-15 的 runner 上跑同一份包永远正常，只有用户的机器才炸 —— 所以门槛必须
// 在**构建期**静态读出来卡住（见 scripts/stage-mpv-official.mjs），运行期再读一次只为把
// 人话写进日志。
//
// minos 的编码（LC_BUILD_VERSION.minos / LC_VERSION_MIN_MACOSX.version）：
//   32 位整数，高 16 位 major、次 8 位 minor、低 8 位 patch。
// 只读头部，不解析符号/段表 —— 够用且不碰外部工具（otool/vtool 只在 mac 上有）。
import { closeSync, openSync, readSync, statSync } from "node:fs";

const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;      // 大端
const FAT_MAGIC_64 = 0xcafebabf;   // 大端
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

const HEAD_BYTES = 1 << 20; // 1MiB：load command 表在文件头，1MiB 足够覆盖（比读整文件省）

/** 版本整数 → {major, minor, patch} */
const fromPacked = (v) => ({ major: (v >>> 16) & 0xffff, minor: (v >>> 8) & 0xff, patch: v & 0xff });

/** 读文件头部若干字节（路径或已经是 Buffer 都收）。读不到返回 null。 */
function headBytes(src) {
  if (Buffer.isBuffer(src)) return src;
  try {
    const size = Math.min(statSync(src).size, HEAD_BYTES);
    const fd = openSync(src, "r");
    try {
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, 0);
      return buf.subarray(0, n);
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * 读 Mach-O 声明的**最低系统版本**（LC_BUILD_VERSION.minos，回落 LC_VERSION_MIN_MACOSX）。
 * fat（universal）二进制取第一个架构切片 —— 声明的 minos 逐架构一致是常态。
 * @param {Buffer|string} src 文件内容或路径
 * @returns {{major:number, minor:number, patch:number}|null} null = 不是 Mach-O / 没声明门槛
 */
export function machOMinOs(src) {
  const buf = headBytes(src);
  if (!buf || buf.length < 32) return null;
  let off = 0;
  // fat 头（大端）：nfat_arch 个 arch 描述（cputype 8 / cpusubtype 12 / offset 16 …），
  // 跟着第一个切片的偏移走。fat_arch_64 的 offset 是 64 位字段，位置同样是 16。
  const be32 = (o) => buf.readUInt32BE(o);
  if (be32(0) === FAT_MAGIC || be32(0) === FAT_MAGIC_64) {
    const fat64 = be32(0) === FAT_MAGIC_64;
    if (buf.length < (fat64 ? 40 : 28)) return null;
    const off0 = fat64 ? Number(buf.readBigUInt64BE(16)) : be32(16);
    if (!off0 || off0 >= buf.length) return null;
    off = off0;
  }
  const magic = buf.readUInt32LE(off);
  const is64 = magic === MH_MAGIC_64;
  if (!is64 && magic !== MH_MAGIC) return null;
  const ncmds = buf.readUInt32LE(off + 16);
  let p = off + (is64 ? 32 : 28);
  let minOs = null;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > buf.length) break;
    const cmd = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;
    // BUILD_VERSION 比 VERSION_MIN_MACOSX 新且优先（新版链接器只发前者）
    if (cmd === LC_BUILD_VERSION && p + 24 <= buf.length) {
      minOs = fromPacked(buf.readUInt32LE(p + 12));
      break;
    }
    if (cmd === LC_VERSION_MIN_MACOSX && p + 16 <= buf.length) minOs = fromPacked(buf.readUInt32LE(p + 8));
    p += size;
  }
  return minOs;
}

/** {major, minor, patch} → "14.0.0"（拿不到返回 ""） */
export function formatOsVersion(v) {
  return v ? `${v.major}.${v.minor}.${v.patch}` : "";
}

/** "14.5.2" / "14.5" → {major, minor, patch}；解析不出返回 null（段数不足按 0 补） */
export function parseOsVersion(s) {
  const m = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(s ?? ""));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/** a 是否比 b 高（任一侧为 null 时返回 false —— 判不出来就别乱报警） */
export function osVersionGt(a, b) {
  if (!a || !b) return false;
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] > b[k];
  }
  return false;
}
