#!/bin/bash
# ช่วยตั้ง Render แผนฟรีให้ไม่หลับ (ping /health ทุก 14 นาที)
# ใช้ cron-job.org ฟรี — ไม่ต้องเขียนโค้ดเพิ่ม

set -euo pipefail

URL="${1:-}"

if [[ -z "$URL" ]]; then
  echo ""
  echo "ใช้: bash scripts/render-keepalive.sh https://your-app.onrender.com"
  echo ""
  echo "หรือ deploy บน Render ก่อน แล้วคัดลอก URL จาก Dashboard"
  exit 1
fi

URL="${URL%/}"
PING_URL="${URL}/health"

echo ""
echo "══════════════════════════════════════════"
echo "  Render ฟรี — กันหลับ (เกือบ 24 ชม.)"
echo "══════════════════════════════════════════"
echo ""
echo "  URL ที่ต้อง ping:"
echo "    ${PING_URL}"
echo ""
echo "  ขั้นตอน (cron-job.org ฟรี):"
echo "    1. ไปที่ https://cron-job.org/en/ สมัครฟรี"
echo "    2. Create cronjob"
echo "    3. URL: ${PING_URL}"
echo "    4. Schedule: ทุก 14 นาที  →  */14 * * * *"
echo "    5. บันทึก"
echo ""
echo "  หมายเหตุ:"
echo "    • Render ฟรีมี 750 ชม./เดือน — พอรันค้าง ~31 วัน"
echo "    • ห้องเล่นหายเมื่อเซิร์ฟเวอร์ restart"
echo "    • คนแรกหลัง cold start อาจรอ ~1 นาที"
echo ""
echo "  Deploy บน Render:"
echo "    1. Push โค้ดขึ้น GitHub"
echo "    2. render.com → New → Blueprint → เลือก repo"
echo "    3. ใช้ไฟล์ render.yaml ในโปรเจกต์"
echo "══════════════════════════════════════════"