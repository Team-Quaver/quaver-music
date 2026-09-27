#!/usr/bin/env bash
# Quaver — loongarch64（新世界 / ABI 2.0）sidecar 构建脚本。
# 运行环境：loong64 容器（CI 里经 QEMU binfmt 跑在 x64 runner 上）：
#   docker run --platform linux/loong64 -v "$GITHUB_WORKSPACE":/src ghcr.io/loong64/python:3.11 bash /src/.github/scripts/loong64-sidecar.sh
#
# 依赖策略：uv / PyPI 官方源都没有 loong64 的二进制 wheel，三个 Rust 包
# （cryptography、pydantic-core、orjson）从 loong64 社区 PyPI 镜像取预编译 wheel
# （https://mirrors.loong64.com/pypi/simple，版本覆盖见 .github/workflows/build.yml 头注），
# 其余依赖全为纯 Python，直接 PyPI。PyInstaller 无 loong64 wheel → sdist 安装时编译
# 自带 bootloader（纯 C，镜像里有 gcc）。
# 产物：/src/dist-bin/quaver-server-loong64（onefile）。
set -euo pipefail

echo "[loong64] python: $(python3 -VV)"
uname -m   # 必须输出 loongarch64，否则 QEMU/binfmt 没接上，产物架构就是错的

pip install --no-cache-dir --upgrade pip wheel

MIRROR="--extra-index-url https://mirrors.loong64.com/pypi/simple"
pip install --no-cache-dir $MIRROR \
  /src/vendor/QQMusicApi \
  /src/vendor/Typhoeus \
  pyinstaller pyinstaller-hooks-contrib

python3 -m PyInstaller --clean --noconfirm --onefile \
  --name quaver-server \
  --distpath /src/dist-bin --workpath /src/build/pyi-la --specpath /src/build/pyi-la \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.loops.asyncio \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.protocols.websockets.wsproto_impl \
  --hidden-import uvicorn.protocols.websockets.websockets_impl \
  --hidden-import python_socks \
  --copy-metadata qqmusic-api-python \
  /src/vendor/Typhoeus/build_entry.py

mv /src/dist-bin/quaver-server /src/dist-bin/quaver-server-loong64
readelf -h /src/dist-bin/quaver-server-loong64 | grep -q LoongArch \
  || { echo "[loong64] 产物不是 LoongArch ELF"; exit 1; }
echo "[loong64] sidecar 构建完成"
