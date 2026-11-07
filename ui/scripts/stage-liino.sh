#!/usr/bin/env bash
# Quaver — 暂存随包 Liino 后端（libliino 动态库）。
#
# Liino 是 vendor/Liino 的纯 Go 音频管线，交付物是一份 ~3.5MB 的 c-shared 库：
#   Linux   libliino.so    Windows liino.dll    macOS libliino.dylib
# 引擎（electron/audio/liino-engine.ts）按
#   resources/liino/<os>-<arch>/<lib>   解析（开发态回落 vendor/Liino/build/），
# 与 mpv 运行时的「随包是优化不是前提」同一口径。
#
# 用法：
#   scripts/stage-liino.sh [目标目录]          # 宿主平台
#   GOOS/GOARCH/CC 由 vendor/Liino 的 build-capi.sh 决定，这里只挑宿主对应的那份
# 交叉构建示例（先跑 vendor 那边）：
#   cd vendor/Liino && GOOS=windows GOARCH=amd64 scripts/build-capi.sh
# 验证（验的就是生产解析路径本身，真 dlopen + 真出一声 2s 音）：
#   cd ui && ./node_modules/.bin/electron scripts/probe-liino.ts --device=pipewire/default
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ui_dir="$(dirname "$script_dir")"
dest_root="${1:-$ui_dir/build-res/liino}"

# Go/Node 架构名映射：目标目录按 Go 口径命名（liino-runtime.ts 的 goArchName 同表）
case "$(uname -m)" in
  x86_64|amd64) goarch=amd64 ;;
  aarch64|arm64) goarch=arm64 ;;
  *) echo "✗ 不支持的架构 $(uname -m)" >&2; exit 1 ;;
esac
goos="$(uname -s | tr '[:upper:]' '[:lower:]')"
[ "$goos" = "darwin" ] && goos=darwin

# 库名按 platform 分（Windows 不带 lib 前缀，见 vendor/Liino/node/libliino.ts 的 NAMES 表）
case "$goos" in
  windows) lib="liino.dll" ;;
  darwin)  lib="libliino.dylib" ;;
  *)       lib="libliino.so" ;;
esac

src="$ui_dir/../vendor/Liino/build/${goos}-${goarch}/$lib"
[ -f "$src" ] || { echo "✗ 没找到 $src。先构建：cd vendor/Liino && bash scripts/build-capi.sh" >&2; exit 1; }

dest="$dest_root/${goos}-${goarch}"
mkdir -p "$dest"
cp -f "$src" "$dest/"

# 头文件一起带上：集成方排障（koffi 签名对不上时）不用回 vendor 翻
cp -f "$src".h "$dest/" 2>/dev/null || cp -f "$ui_dir/../vendor/Liino/build/${goos}-${goarch}/liino.h" "$dest/" 2>/dev/null || true

echo "✓ 随包 Liino 已暂存：$dest/$lib（来源 $src）"
echo "  验证：cd ui && node scripts/verify-liino.ts && ./node_modules/.bin/electron scripts/probe-liino.ts"
