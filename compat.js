// Bootstrap — ตรวจสอบอุปกรณ์ก่อนโหลดเกม (มือถือสเปคต่ำ / WebGL / CDN)
(function () {
  const boot = document.getElementById('boot-screen');
  const bootMsg = document.getElementById('boot-message');
  const bootErr = document.getElementById('boot-error');
  const bootRetry = document.getElementById('boot-retry');

  function setMsg(text) {
    if (bootMsg) bootMsg.textContent = text;
  }

  function showError(title, detail, tips) {
    if (boot) boot.classList.add('boot-error');
    if (bootErr) {
      bootErr.innerHTML = `<strong>${title}</strong><p>${detail}</p>${tips ? `<ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}`;
      bootErr.classList.remove('hidden');
    }
    if (bootRetry) bootRetry.classList.remove('hidden');
  }

  function hideBoot() {
    if (boot) boot.classList.add('hidden');
  }

  function hasWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return false;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
        if (/swiftshader|llvmpipe|software/i.test(renderer)) return 'software';
      }
      return true;
    } catch {
      return false;
    }
  }

  function detectLiteMode() {
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const mem = navigator.deviceMemory;
    const cores = navigator.hardwareConcurrency;
    const lowMem = typeof mem === 'number' && mem <= 3;
    const lowCores = typeof cores === 'number' && cores <= 4;
    const smallScreen = Math.min(screen.width, screen.height) <= 480;
    const oldAndroid = /Android\s([4-7]\.)/i.test(navigator.userAgent);
    return mobile || lowMem || lowCores || smallScreen || oldAndroid;
  }

  window.JENGA_LITE = detectLiteMode();

  const webgl = hasWebGL();
  if (!webgl) {
    showError(
      'เครื่องนี้ไม่รองรับกราฟิก 3D',
      'เบราว์เซอร์ไม่เปิด WebGL ได้ — เกมจังก้า 3D เล่นไม่ได้บนเครื่องนี้',
      [
        'ลองเปิดด้วย Chrome หรือ Safari เวอร์ชันล่าสุด',
        'ปิดแท็บอื่นเพื่อเพิ่มหน่วยความจำ',
        'ใช้มือถือรุ่นใหม่กว่าหรือคอมพิวเตอร์',
      ]
    );
    if (bootRetry) {
      bootRetry.addEventListener('click', () => location.reload());
    }
    return;
  }

  if (webgl === 'software') {
    window.JENGA_LITE = true;
  }

  async function loadGame() {
    setMsg(window.JENGA_LITE ? 'โหมดเบา — กำลังโหลดเกม...' : 'กำลังโหลดเกม...');
    const timeout = window.JENGA_LITE ? 90000 : 60000;
    const timer = setTimeout(() => {
      showError(
        'โหลดช้าเกินไป',
        'ไฟล์เกมโหลดไม่เสร็จ — มักเกิดกับเน็ตช้าหรือเซิร์ฟเวอร์กำลังตื่น (Render ฟรี)',
        [
          'รอ 30–60 วินาที แล้วกด "ลองใหม่"',
          'ใช้ Wi‑Fi แทน 4G ถ้าเน็ตช้า',
          'ปิดแอปอื่นเพื่อเพิ่มหน่วยความจำ',
        ]
      );
    }, timeout);

    try {
      await import('./game.js');
      clearTimeout(timer);
      hideBoot();
    } catch (err) {
      clearTimeout(timer);
      const msg = err?.message || String(err);
      const cdnHint = /fetch|import|module|network/i.test(msg);
      showError(
        'โหลดเกมไม่สำเร็จ',
        cdnHint
          ? 'ดาวน์โหลดไฟล์เกมล้มเหลว — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'
          : `เกิดข้อผิดพลาด: ${msg}`,
        [
          'กด "ลองใหม่" อีกครั้ง',
          'ถ้าเปิดลิงก์ครั้งแรก รอเซิร์ฟเวอร์ตื่น ~1 นาที',
          'ลอง Chrome แทนเบราว์เซอร์ในแอป (Facebook/LINE)',
        ]
      );
      console.error('[JENGA boot]', err);
    }
  }

  if (bootRetry) {
    bootRetry.addEventListener('click', () => location.reload());
  }

  loadGame();
})();