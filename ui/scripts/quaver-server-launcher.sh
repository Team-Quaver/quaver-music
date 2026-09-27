#!/bin/sh
# Quaver — macOS sidecar 分发壳（universal 包用）。
#
# 为什么需要它：PyInstaller onefile 的档案拼在 Mach-O 尾部，两份单架构产物**不能** lipo
# 合并（PyInstaller 官方明确不支持），所以 universal 包里放 quaver-server-arm64 /
# quaver-server-x64 两份 + 这个按 uname -m 分发的壳。main.mjs 照旧 spawn
# bin/quaver-server（shebang 脚本可被 spawn 直接 exec），stdin/stdout 凭证交接经
# exec 原样透传，壳本身零存在感。Windows/Linux 不需要：各自只有一份单架构二进制。
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in
  arm64)  exec "$dir/quaver-server-arm64" "$@" ;;
  x86_64) exec "$dir/quaver-server-x64" "$@" ;;
  *) echo "quaver-server: 不支持的架构 $(uname -m)" >&2; exit 1 ;;
esac
