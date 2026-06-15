#!/bin/bash
# เริ่มเซิร์ฟเวอร์เกม — ใช้โดย launchd / pm2
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

if [[ ! -d node_modules ]]; then
  npm install --omit=dev
fi

export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-8080}"
exec node server.js