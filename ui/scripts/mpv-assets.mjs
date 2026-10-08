// Quaver — 随包音频运行时（mpv 官方 release）的版本钉：纯数据，零依赖。
//
// 为什么单拉成一个模块：这几个常量是「上游换资产 / 本地改资产 → 悄悄坏掉」的唯一真相来源，
// 光写在暂存脚本里没法被断言（脚本是 CLI，一 import 就跑）。verify-mpv 直接 import 这一份。
//
// 升级步骤：改 MPV_VERSION，再把三个 sha256 换成新 release 的 asset digest
// （GitHub API 的 assets[].digest 形如 "sha256:xxxx"，去掉前缀就是这里要的值）。

export const MPV_VERSION = "0.41.0";
const BASE = `https://github.com/mpv-player/mpv/releases/download/v${MPV_VERSION}`;

/** 随包 macOS 运行时允许的最低系统版本。上游按构建机系统版本发 macos-14 / 15 / 26 几档，
 *  数字写进 Mach-O 的 LC_BUILD_VERSION.minos，就是「最低能跑的系统」—— 挑了 15 那份，
 *  macOS 14 的用户一启动就被 dyld 拒（SIGABRT）。所以地板取上游给的最低档，且不许悄悄抬高。 */
export const MACOS_FLOOR = { major: 14, minor: 0, patch: 0 };

/** 资产表：平台/架构 → 下载地址 + sha256（= 上游 digest）。 */
export const ASSETS = {
  "win32/x64":   { url: `${BASE}/mpv-v${MPV_VERSION}-x86_64-w64-mingw32.zip`,      sha256: "a49811c0752c108b8260636f9c6f6fcb97406641c98b30f1e7b500dfb20177de" },
  "win32/arm64": { url: `${BASE}/mpv-v${MPV_VERSION}-aarch64-pc-windows-msvc.zip`, sha256: "a822abeffd0ac88951f4084f3425f949842aa17d616f880637ebe9041e482e97" },
  // macOS：14 / 15 / 26 三档里取编号最小的那份（编号 = 载荷声明的最低系统版本）
  "darwin/arm64": { url: `${BASE}/mpv-v${MPV_VERSION}-macos-14-arm.zip`,           sha256: "5c96f9b21355fc0a11d2e2161ad65f33031070e9fb3f6bd9865fb459b94587e6" },
};

/** 从资产 URL 抠出 macOS 档位号（"…-macos-15-arm.zip" → 15）；不是 mac 资产返回 null。 */
export function macosAssetMajor(url) {
  const m = /-macos-(\d+)-/.exec(String(url ?? ""));
  return m ? Number(m[1]) : null;
}
