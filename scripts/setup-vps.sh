#!/bin/bash
# ติดตั้งเกมบน VPS ฟรี (Oracle Cloud Always Free / Google e2-micro)
# รันบนเซิร์ฟเวอร์ Ubuntu หลัง clone โปรเจกต์มาแล้ว:
#   git clone <repo-url> jenga-game && cd jenga-game && bash scripts/setup-vps.sh

set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
PORT="${PORT:-8080}"

echo "══════════════════════════════════════════"
echo "  JENGA — ติดตั้งเซิร์ฟเวอร์ 24 ชม. (VPS)"
echo "══════════════════════════════════════════"
echo ""

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "⚠️  สคริปต์นี้สำหรับ Linux VPS — รันบนเครื่อง Ubuntu บน cloud"
  exit 1
fi

echo "📦 อัปเดตระบบ..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ufw

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]]; then
  echo "📦 ติดตั้ง Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

echo "✓ Node $(node -v)"

echo "📦 ติดตั้ง dependencies..."
npm install --omit=dev

if ! command -v pm2 &>/dev/null; then
  echo "📦 ติดตั้ง PM2..."
  sudo npm install -g pm2
fi

echo "🚀 เริ่มเกมด้วย PM2..."
pm2 delete jenga-game 2>/dev/null || true
PORT="$PORT" pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "🔧 ตั้ง PM2 ให้รันอัตโนมัติเมื่อ reboot..."
STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" | grep "sudo env" || true)
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD"
fi

echo ""
echo "🔥 เปิด firewall พอร์ต $PORT..."
sudo ufw allow OpenSSH
sudo ufw allow "$PORT/tcp"
sudo ufw --force enable

PUBLIC_IP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "══════════════════════════════════════════"
echo "  ✅ ติดตั้งเสร็จแล้ว!"
echo "══════════════════════════════════════════"
echo ""
echo "  เล่นได้ที่:  http://${PUBLIC_IP}:${PORT}"
echo "  Health:      http://${PUBLIC_IP}:${PORT}/health"
echo ""
echo "  คำสั่งที่มีประโยชน์:"
echo "    pm2 status          — ดูสถานะ"
echo "    pm2 logs jenga-game — ดู log"
echo "    pm2 restart jenga-game"
echo ""
echo "  ⚠️  Oracle Cloud: เปิดพอร์ต $PORT ใน Security List ด้วย"
echo "     VPC → Security List → Ingress → TCP $PORT จาก 0.0.0.0/0"
echo ""
echo "  ถ้ามีโดเมน + HTTPS ใช้ Caddy/nginx reverse proxy ภายหลังได้"
echo "══════════════════════════════════════════"