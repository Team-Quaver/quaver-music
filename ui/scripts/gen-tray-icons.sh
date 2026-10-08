#!/usr/bin/env bash
# Quaver — 从设计源 img/tray-icon*.svg 生成随包托盘图 build-res/tray/*.png。
#
# 为什么不「原样导出」：设计稿在 512 的 viewBox 里留了约 22%/边的内边距，直出的话图形只占画布
# ~56% —— 塞进 16pt 的托盘盒子就只剩 ~9px 的实形，比别的托盘图标明显小一圈（实测报过「小了一点点」）。
# 所以：① inkscape 导出 512² ② 按 alpha 裁到图形 ③ 每边补 6% 余量成正方形 ④ 缩到 256²（降采样，清晰）。
# verify-icon 会核对产物确实是「裁过边」的（图形包围盒占画布 ≥82%）。
#
# 依赖：inkscape + ImageMagick（设计侧工具，不进 CI —— CI 与打包直接用仓库里已生成的 PNG）。
# 用法：ui/scripts/gen-tray-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # → ui/
SRC=../img
OUT=build-res/tray
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

for pair in "tray-icon.svg:tray-icon.png" "tray-icon-dark.svg:tray-icon-dark.png"; do
  svg=${pair%%:*}; png=${pair##*:}
  inkscape --export-type=png --export-filename="$TMP/raw.png" \
           --export-width=512 --export-height=512 "$SRC/$svg" >/dev/null 2>&1
  magick "$TMP/raw.png" -trim +repage "$TMP/trim.png"
  w=$(magick identify -format %w "$TMP/trim.png")
  h=$(magick identify -format %h "$TMP/trim.png")
  side=$(( (w > h ? w : h) * 100 / 88 ))   # 图形占画布 88%（每边 6% 余量）
  # PNG32: 强制 8bit RGBA —— 单色图默认会被 ImageMagick 写成 GrayscaleAlpha(colorType 4)，
  # 虽然 nativeImage 读得动，但格式随 ImageMagick 版本飘；钉成 RGBA 也让 verify-icon 的像素核对稳定
  magick "$TMP/trim.png" -background none -gravity center \
         -extent "${side}x${side}" -resize 256x256 "PNG32:$OUT/$png"
  echo "✓ $OUT/$png（图形 ${w}x${h} → 画布 ${side}² → 256²）"
done

# 随包也带上 SVG 源：改图标时手上有一份能对的原稿（真正的设计源仍在仓库根 img/）
cp "$SRC/tray-icon.svg" "$SRC/tray-icon-dark.svg" "$OUT/"
echo "✓ SVG 源已同步到 $OUT/"
