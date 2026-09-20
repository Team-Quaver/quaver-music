#!/usr/bin/env bash
# Quaver — QQ 音乐扫码登录助手（终端版，适配 Python sidecar :3200）
# 流程：GET /login/qrcode/<type> → zbarimg 解 URL → qrencode 终端渲染 →
#       轮询 /login/qrcode/<type>/status；DONE 后凭证由 sidecar 自行处理 —— 本脚本不落 token。
#   由 Electron 主进程拉起时（QUAVER_CREDENTIAL_MODE=external）：交给主进程加密存进系统密钥管理器。
#   手工单跑（本脚本的用法）：memory 模式 —— 凭证只驻内存，关掉 sidecar 即需重新登录。
#   （凭证明文不再落盘，所以「手工跑一次就持久登录」这条路已经没有了，请用应用内登录页。）
#   想知道这次是哪种：curl -s $BASE/login/status | jq .data.credential_mode
#
# 用法:  ./scripts/qq-login.sh [mobile|qq|wx]
#   mobile = 手机 QQ 音乐 App 扫码（推荐，MQTT 推送）; qq = 手机 QQ; wx = 微信
# 依赖:  curl jq qrencode zbarimg;  sidecar 已在 :3200 运行（vendor/Typhoeus: uv run run.py）
set -euo pipefail

CHANNEL="${1:-mobile}"
BASE="${QUAVER_API:-http://localhost:3200}"

command -v qrencode >/dev/null && command -v zbarimg >/dev/null || {
  echo "缺依赖: sudo dnf install qrencode zbar"; exit 1; }

echo "[1/3] 拉取 ${CHANNEL} 二维码 ..."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -sf -m 20 "$BASE/login/qrcode/$CHANNEL" > "$TMP/qr.json" \
  || { echo "key 失败（服务没起？被限流？等 90s 重试）"; exit 1; }
IDENT=$(jq -r .data.identifier "$TMP/qr.json")
jq -r .data.data "$TMP/qr.json" | base64 -d > "$TMP/qr.png"
zbarimg -q --raw "$TMP/qr.png" > "$TMP/url" 2>/dev/null || {
  # mobile/wx 的码内容不是纯 URL 时 zbar 也能出文本；拿不到就直接渲染 PNG 给用户看
  echo "（二维码内容不可读，渲染 PNG 失败时请用支持图片的终端查看）"; }

clear 2>/dev/null || true
echo "请用 ${CHANNEL} 对应客户端扫码（码有效期约 2 分钟）:"
echo
if [ -s "$TMP/url" ]; then qrencode -t ansiutf8 < "$TMP/url"; else echo "(无法在终端渲染，请改用应用内登录页)"; fi
echo
echo "[2/3] 等待扫码 ..."

# mobile 型 sidecar 后台消费 MQTT；qq/wx 型每次轮询转发上游。事件: 0=DONE 1=SCAN 2=CONF 3=TIMEOUT 4=REFUSE
for _ in $(seq 1 80); do
  EVENT=$(curl -s -m 15 "$BASE/login/qrcode/$CHANNEL/status?identifier=$IDENT" | jq -r '.data.event // -1')
  case "$EVENT" in
    0) echo; echo "[3/3] ✅ 登录成功，凭证已由 sidecar 保存（credential_mode 见下）"
       curl -s "$BASE/login/status" | jq '{logged_in: .data.logged_in, credential_mode: .data.credential_mode, musicid: .data.credential.musicid}'
       exit 0 ;;
    1|2) printf '.' ;;
    3) echo; echo "❌ 二维码过期/失效，重跑本脚本"; exit 1 ;;
    4) echo; echo "❌ 已拒绝登录"; exit 1 ;;
    *) echo; echo "意外状态: $EVENT"; exit 1 ;;
  esac
  sleep 2
done
echo "超时"; exit 1
