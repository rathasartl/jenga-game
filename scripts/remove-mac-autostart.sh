#!/bin/bash
# ยกเลิกรันอัตโนมัติเมื่อเปิด Mac
set -euo pipefail
LABEL="com.jenga.game"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
echo "✅ ยกเลิกรันอัตโนมัติแล้ว"