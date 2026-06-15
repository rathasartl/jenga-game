#!/bin/bash
# ตั้งให้เกม JENGA รันอัตโนมัติเมื่อเปิด Mac (login)
# ใช้: bash scripts/setup-mac-autostart.sh

set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
PORT="${PORT:-8080}"
LABEL="com.jenga.game"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(command -v node)"
START_SCRIPT="${APP_DIR}/scripts/start-server.sh"
LOG_DIR="${APP_DIR}/logs"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "สคริปต์นี้สำหรับ macOS เท่านั้น"
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "ไม่พบ Node.js — ติดตั้งจาก https://nodejs.org ก่อน"
  exit 1
fi

chmod +x "$START_SCRIPT"
mkdir -p "$LOG_DIR"

# หยุด service เดิมถ้ามี
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${START_SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

sleep 2
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo ""
  echo "✅ ตั้งค่าเสร็จ — เกมรันอัตโนมัติเมื่อเปิด Mac แล้ว"
  echo ""
  echo "  เล่นที่:  http://localhost:${PORT}"
  echo "  Health:  http://localhost:${PORT}/health"
  echo ""
  echo "  คำสั่ง:"
  echo "    launchctl print gui/\$(id -u)/${LABEL}  — ดูสถานะ"
  echo "    bash scripts/remove-mac-autostart.sh    — ยกเลิกอัตโนมัติ"
  echo ""
  echo "  ออนไลน์ (ไม่ต้องเปิดคอม): https://jenga-game-rztj.onrender.com"
else
  echo "⚠️  ตั้งค่าแล้ว แต่ยัง ping ไม่ได้ — ดู log: ${LOG_DIR}/stderr.log"
fi