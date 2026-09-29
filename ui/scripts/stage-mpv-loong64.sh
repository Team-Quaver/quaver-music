#!/usr/bin/env bash
# Quaver — loong64 随包 mpv 运行时暂存
#
# 上游（pkgforge/mpv 官方）都不发 loong64 二进制；可用来源是 Debian 官方 loong64
# 移植（sid 里的 mpv 0.41.0，与 x86 随包运行时同版本）。本脚本在 CI 的 ubuntu
# runner 上用「私有 apt root + loong64 架构源」解析 mpv 的依赖闭包，逐 deb 展开
# 后组装成 bins.mjs 认可的布局：
#   mpv/shared/bin/mpv        载荷（Debian usr/bin/mpv）
#   mpv/lib/ld-linux*.so*     包内 loader（libc6 loong64 自带，与包内 libc 配套）
#   mpv/lib/*.so              全部依赖库拍平（libraryPath 基准就是 lib/）
# 运行方式与 Linux 随包一致：loader --library-path <lib> 载荷（见 bins.mjs resolveBundled）。
#
# 用法: ./scripts/stage-mpv-loong64.sh [目标目录=build-res/audio]
# 注意：runner 不是龙芯，无法真跑 —— 产物校验只做 ELF 机器码核对（file / LoongArch）。
set -euo pipefail

TARGET="${1:-build-res/audio}"
DEB_MIRROR="https://deb.debian.org/debian"
SUITE="sid"
# 闭包种子：mpv 播放器本体 + libmpv2（mpv 二进制动态链接的运行库）
SEED_PKGS=(mpv libmpv2)

command -v apt-get >/dev/null || { echo "需要 apt-get（CI ubuntu runner）"; exit 1; }
command -v dpkg >/dev/null || { echo "需要 dpkg"; exit 1; }
command -v file >/dev/null || { echo "需要 file"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/root"
APT="$WORK/apt"
mkdir -p "$APT/etc/apt/sources.list.d" "$APT/var/lib/apt/lists/partial" \
         "$APT/var/cache/apt/archives/partial" "$ROOT"

# 私有 apt root：只声明 loong64 架构，不碰 runner 自己的源与状态
cat > "$APT/etc/apt/sources.list.d/loong64.list" <<EOF
deb [arch=loong64] $DEB_MIRROR $SUITE main
EOF
APT_OPTS=(
  -o "Dir::State=$APT/var/lib/apt"
  -o "Dir::Cache=$APT/var/cache/apt"
  -o "Dir::Etc::sourcelist=$APT/etc/apt/sources.list.d/loong64.list"
  -o "Dir::Etc::sourceparts=-"
  -o "APT::Architecture=loong64"
  -o "APT::Architectures::=loong64"
  -o "Acquire::Languages=none"
)

echo ">> apt-get update (Debian $SUITE loong64)"
apt-get "${APT_OPTS[@]}" update

echo ">> 解析依赖闭包"
mapfile -t PKGS < <(
  apt-cache "${APT_OPTS[@]}" depends --recurse --no-pre-depends \
    --no-recommends --no-suggests --no-conflicts --no-breaks \
    --no-replaces --no-enhances --important "${SEED_PKGS[@]}" \
    | grep -E '^[a-z0-9][a-z0-9.+~-]*$' | sort -u
)
echo "   闭包 ${#PKGS[@]} 个包"

echo ">> 下载 deb"
( cd "$WORK" && apt-get "${APT_OPTS[@]}" download "${PKGS[@]}" )

echo ">> 展开与组装"
for d in "$WORK"/*.deb; do
  [ -e "$d" ] || continue
  dpkg -x "$d" "$ROOT"
done

STAGE="$TARGET/mpv"
rm -rf "$STAGE"
mkdir -p "$STAGE/shared/bin" "$STAGE/lib"

cp "$ROOT/usr/bin/mpv" "$STAGE/shared/bin/mpv"
chmod +x "$STAGE/shared/bin/mpv"

# 拍平全部共享库（含符号链解引用；同以名先到者为准——闭包来自同一档案，内容一致）
while IFS= read -r f; do
  base=$(basename "$f")
  case "$base" in
    *.so|*.so.*) ;;
    *) continue ;;
  esac
  [ -e "$STAGE/lib/$base" ] && continue
  cp -L "$f" "$STAGE/lib/$base"
done < <(find "$ROOT" \( -type f -o -type l \) \( -name "*.so" -o -name "*.so.*" \) 2>/dev/null)

# loader 提到 lib/ 顶层（findLoader 只扫 lib/ 一级，正则 ^ld-linux）
LOADER=$(find "$ROOT" -name "ld-linux-loongarch*" \( -type f -o -type l \) | head -1)
[ -n "$LOADER" ] || { echo "::error::闭包里没有 loongarch 动态 loader（libc6 缺失？）"; exit 1; }
cp -L "$LOADER" "$STAGE/lib/"

# 机器码核对（runner 非龙芯，只能验 ELF 不能真跑）
file "$STAGE/shared/bin/mpv" | grep -qi LoongArch \
  || { echo "::error::mpv 不是 LoongArch 机器码"; exit 1; }
LO_COUNT=$(ls "$STAGE/lib"/*.so* 2>/dev/null | wc -l)
echo "✓ loong64 mpv 暂存完成: $STAGE（依赖库 $LO_COUNT 个）"
