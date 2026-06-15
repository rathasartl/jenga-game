#!/bin/bash
# เปิดเกมจากเครื่องบ้านให้เพื่อนเล่นได้ (ฟรี 100%)
# เครื่องต้องเปิดอยู่ — ใช้ PM2 หรือรันใน tmux ให้ tunnel ค้าง

set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"

if ! command -v cloudflared &>/dev/null; then
  echo "❌ ติดตั้ง cloudflared ก่อน:"
  echo "   macOS:  brew install cloudflared"
  echo "   Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

if ! lsof -i ":$PORT" &>/dev/null; then
  echo "🚀 เริ่มเกมเซิร์ฟเวอร์พอร์ต $PORT..."
  if command -v pm2 &>/dev/null; then
    pm2 start ecosystem.config.cjs 2>/dev/null || PORT="$PORT" node server.js &
  else
    PORT="$PORT" node server.js &
  fi
  SERVER_PID=$!
  sleep 1
  trap "kill $SERVER_PID 2>/dev/null" EXIT
else
  echo "✓ เซิร์ฟเวอร์รันอยู่แล้วที่พอร์ต $PORT"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  JENGA — โหมดเครื่องบ้าน (ฟรี)"
echo "══════════════════════════════════════════"
echo "  แชร์ URL ที่ขึ้นมาให้เพื่อน"
echo "  กด Ctrl+C เพื่อหยุด tunnel"
echo "  เปิด 24 ชม.: ใช้ pm2 + รันสคริปต์นี้ใน tmux/screen"
echo "══════════════════════════════════════════"
echo ""

cloudflared tunnel --url "http://localhost:$PORT"