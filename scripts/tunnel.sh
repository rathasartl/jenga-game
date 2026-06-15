#!/bin/bash
# เปิดเกมให้เพื่อนจากที่ไหนก็ได้ (ไม่ต้อง Wi‑Fi เดียวกัน)
# ใช้ Cloudflare Quick Tunnel ฟรี

cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"

if ! command -v cloudflared &>/dev/null; then
  echo "❌ ติดตั้ง cloudflared ก่อน: brew install cloudflared"
  exit 1
fi

if ! lsof -i ":$PORT" &>/dev/null; then
  echo "🚀 เริ่มเกมเซิร์ฟเวอร์พอร์ต $PORT..."
  node server.js &
  SERVER_PID=$!
  sleep 1
  trap "kill $SERVER_PID 2>/dev/null" EXIT
else
  echo "✓ เซิร์ฟเวอร์รันอยู่แล้วที่พอร์ต $PORT"
fi

echo ""
echo "🌐 กำลังสร้างลิงก์สาธารณะ..."
echo "   แชร์ URL ที่ขึ้นมาให้เพื่อน — เล่นได้ทั้งมือถือและคอม"
echo ""

cloudflared tunnel --url "http://localhost:$PORT"