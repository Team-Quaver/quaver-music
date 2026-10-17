#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -u "$DIR/chrome-sandbox" ] || export ELECTRON_DISABLE_SANDBOX=1
exec "$DIR/quaver" "$@"
