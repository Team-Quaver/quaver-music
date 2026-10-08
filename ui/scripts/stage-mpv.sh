#!/usr/bin/env bash
# Quaver — 暂存随包音频运行时（mpv）
#
# 上游 mpv 不发布 Linux 二进制，这里钉 pkgforge 的 AppImage（anylinux 变体，
# 自带 libc/编解码/音频后端 so），在**构建期**展开成目录：
#   - 运行时 spawn 嵌套 AppImage 需要宿主机 FUSE（等于套第二层），展开成目录最稳；
#   - 展开后由 engine 用包内自带 loader + lib/lib.path 直启载荷，绕开 sharun 的
#     自更新/yt-dlp 钩子（见 ui/electron/audio/bins.ts 头部注释）。
#
# 用法：
#   scripts/stage-mpv.sh [架构] [目标目录]
#   架构：x86_64 | aarch64（默认按 uname -m 归一化）
#   目标目录：默认 <repo>/ui/build-res/audio，产物落在 <目标目录>/mpv/
# 校验：脚本只负责取货落盘；装完用下面这条验证（验的就是生产解析路径）：
#   cd ui && node electron/audio/bins.ts --check build-res/audio
set -euo pipefail

# —— 钉版本：升级时同时改 MPV_TAG 与两个 sha256（GitHub API 的 asset digest 即为 sha256）——
MPV_VERSION="0.41.0"
MPV_TAG="v0.41.0%402026-09-07_1788787125"
ASSET_BASE="https://github.com/pkgforge-dev/mpv-AppImage/releases/download/${MPV_TAG}"

sha_for() {
  case "$1" in
    x86_64)  echo "bb52fb49c54e83155891bfb97578e7ee40575a306d0dddc96fc603be20db8214" ;;
    aarch64) echo "55c5642226ffdcf464a8783ffbacfdf3b6c64e7a77e85ba89e97196421b81321" ;;
    *) echo ""; return 1 ;;
  esac
}

arch="${1:-}"
if [ -z "$arch" ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "✗ 不支持的架构 $(uname -m)（只做 x86_64 / aarch64）" >&2; exit 1 ;;
  esac
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ui_dir="$(dirname "$script_dir")"
dest_root="${2:-$ui_dir/build-res/audio}"
dest="$dest_root/mpv"

sha="$(sha_for "$arch")" || { echo "✗ 不支持的架构 $arch（只做 x86_64 / aarch64）" >&2; exit 1; }
name="mpv-v${MPV_VERSION}-anylinux-${arch}.AppImage"

# 下载暂存放目标目录旁的 .work：**别用 /tmp** —— 容器/CI 的 /tmp 常是 10MB tmpfs，
# 30MB 的 AppImage 直接 ENOSPC（curl 23）。extraResources 的 filter 已排除 **/.work/**，
# 万一 trap 没跑成，残留也不会被打进包里。
mkdir -p "$dest_root"
work="$dest_root/.work"
# 清理一律容错：某些环境会对批量删除设护栏（本仓开发沙箱就是这样，rm -rf 直接非零退出），
# 在 set -e 下会连带把整个打包流程弄挂 —— 清理失败不值得中断发布构建。
rm -rf "$work" 2>/dev/null || true
mkdir -p "$work"
trap 'rm -rf "$work" >/dev/null 2>&1 || true' EXIT

echo "→ 下载 $name"
curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$work/$name" "$ASSET_BASE/$name"

echo "→ 校验 sha256"
echo "$sha  $work/$name" | sha256sum -c - >/dev/null || { echo "✗ sha256 不匹配（上游重打包或下载损坏）" >&2; exit 1; }

echo "→ 解包（--appimage-extract，不需要 FUSE）"
chmod +x "$work/$name"
( cd "$work" && "./$name" --appimage-extract >/dev/null )

# 解包目录名随 runtime 而异：老版给 squashfs-root，新版 uruntime 直接给 AppDir
# （且 squashfs-root 可能只是指向 AppDir 的符号链接 —— 所以后面 cp 必须 -L 解引用，
#  否则复制到的是个悬空链接，表现成「装完了但运行时找不到载荷」）。
src=""
for cand in squashfs-root AppDir; do
  if [ -e "$work/$cand" ]; then src="$work/$cand"; break; fi
done
[ -n "$src" ] || { echo "✗ 解包目录未找到（既无 squashfs-root 也无 AppDir）" >&2; exit 1; }

# 布局自检：载荷与自带 loader 缺一不可，缺了就是上游换布局，宁可早失败
payload="$src/shared/bin/mpv"
loader="$(echo "$src"/lib/ld-linux*.so* 2>/dev/null | head -1)"
[ -x "$payload" ] || { echo "✗ 载荷缺失：$payload" >&2; exit 1; }
[ -x "$loader" ] || { echo "✗ 自带 loader 缺失（lib/ld-linux*）" >&2; exit 1; }

# 架构核对：跨架构 exec 只会 126、文件权限校验和全对，必须看 ELF e_machine
want_machine="Advanced Micro Devices X86-64"
[ "$arch" = "aarch64" ] && want_machine="AArch64"
if command -v readelf >/dev/null 2>&1; then
  readelf -h "$payload" | grep -q "$want_machine" || { echo "✗ $payload 不是 $want_machine" >&2; exit 1; }
fi

echo "→ 落盘 $dest（约 90MB，gitignored）"
rm -rf "$dest" 2>/dev/null || rm -f "$dest" 2>/dev/null || true
mkdir -p "$dest_root"
cp -aL "$src" "$dest"

echo "✓ 完成。验证：cd ui && node electron/audio/bins.ts --check ${dest_root#$PWD/}"
