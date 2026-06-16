// ╔══════════════════════════════════════════════════════════╗
// ║  JENGA 3D — Multiplayer Game Engine                     ║
// ║  Three.js + Cannon-es Physics                           ║
// ╚══════════════════════════════════════════════════════════╝

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';
import { MultiplayerClient } from './multiplayer.js';

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────
const BLOCK_W = 1.0;
const BLOCK_H = 0.6;
const BLOCK_L = 3.0;
const HALF_W = BLOCK_W / 2;
const HALF_H = BLOCK_H / 2;
const HALF_L = BLOCK_L / 2;
const ROWS = 18;
const BPR = 3; // blocks per row
const TABLE_Y = 0.3;
const PLACE_TIME_LIMIT = 15; // วินาที — หมดเวลาแล้วบล็อกร่วงตามฟิสิกส์
const STABILITY_MAX_WAIT = 10; // รอฟิสิกส์นิ่งสูงสุดก่อนตัดสินผล
const COLLAPSE_STREAK_NEED = 6; // เฟรมติดกันที่ตรวจพบถล่ม (กันสัญญาณหลอก)
const GAME_START_GRACE_MS = 2500; // ช่วงเริ่มเกม — ยังไม่ตรวจถล่ม

const PLAYER_COLORS = ['#a855f7', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444'];

// Jewel-tone palette — hue shifts per row, luminance varies per column
function getBlockColor(row, col) {
  const hue = (row * 24 + col * 52) % 360;
  const sat = 0.68 + (col * 0.06);
  const lit = 0.48 + ((row + col) % 3) * 0.06;
  return new THREE.Color().setHSL(hue / 360, Math.min(sat, 0.82), lit);
}

const State = Object.freeze({
  SETUP: 0,
  PLAYING: 1,
  SELECTED: 2,
  PULLING: 3,
  PLACING: 4,
  CHECKING: 5,
  GAME_OVER: 6,
  PLACE_SELECT: 7,
});

// ─────────────────────────────────────────────────────────
// Jenga Game Class
// ─────────────────────────────────────────────────────────
class JengaGame {
  constructor() {
    this.state = State.SETUP;
    this.players = [];
    this.currentPlayerIdx = 0;
    this.blocks = [];
    this.selectedBlock = null;
    this.hoveredBlock = null;
    this.topRow = ROWS;
    this.topRowBlockCount = 0;
    this.moveCount = 0;
    this.blockIdCounter = 0;

    // Online multiplayer
    this.onlineMode = false;
    this.mp = new MultiplayerClient(this);
    this.playMode = 'local';
    this.liteMode = !!window.JENGA_LITE;

    // Three.js
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;

    // Cannon.js
    this.world = null;
    this.blockMat = null;
    this.floorMat = null;

    // Raycasting
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-999, -999);

    // Animation
    this.animations = [];
    this.checkStartTime = 0;
    this._lastBlockSync = 0;
    this.placeTimerStart = 0;
    this.floatingBlock = null;
    this.placeSpots = [];
    this.placeGhostMeshes = [];
    this.hoveredPlaceGhost = null;
    this.placeIsHorizontal = true;
    this._placeResolved = false;
    this.clock = new THREE.Clock();

    // Particles
    this.particles = [];

    // Camera shake
    this.shakeIntensity = 0;
    this.cameraBasePos = new THREE.Vector3();

    // Touch
    this.touchStart = null;

    // Loop control
    this.running = false;
    this.rafId = null;

    // Event handlers (for cleanup)
    this._boundResize = null;
    this._boundMouseMove = null;
    this._boundClick = null;
    this._boundTouchStart = null;
    this._boundTouchEnd = null;
    this._boundKeyDown = null;

    // Bind
    this._animate = this._animate.bind(this);

    // Init UI
    this._setupUI();
  }

  // ═══════════════════════════════════════════════════════
  // UI Setup
  // ═══════════════════════════════════════════════════════
  _setupUI() {
    const startBtn = document.getElementById('start-btn');
    const countSelect = document.getElementById('player-count');
    const pullBtn = document.getElementById('btn-pull');
    const cancelBtn = document.getElementById('btn-cancel');
    const menuBtn = document.getElementById('menu-btn');

    startBtn.addEventListener('click', () => this._startGame());
    countSelect.addEventListener('change', (e) => this._updatePlayerInputs(+e.target.value));
    menuBtn.addEventListener('click', () => this._restart());
    document.getElementById('rematch-btn').addEventListener('click', () => this._requestRematch());
    document.getElementById('leave-game-btn').addEventListener('click', () => this._leaveAfterGame());
    document.getElementById('menu-game-btn').addEventListener('click', () => this._restart());
    pullBtn.addEventListener('click', () => this._confirmPull());
    cancelBtn.addEventListener('click', () => this._cancelSelection());
    document.getElementById('btn-rotate-place')?.addEventListener('click', () => this._rotatePlaceOrientation());

    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => this._setPlayMode(tab.dataset.mode));
    });

    document.getElementById('create-room-btn').addEventListener('click', () => this._createRoom());
    document.getElementById('join-room-btn').addEventListener('click', () => this._joinRoom());
    document.getElementById('lobby-start-btn').addEventListener('click', () => this.mp.startGame());
    document.getElementById('leave-room-btn').addEventListener('click', () => this._leaveRoom());
    document.getElementById('copy-link-btn').addEventListener('click', () => this._copyShareLink());

    const roomInput = document.getElementById('room-code-input');
    roomInput.addEventListener('input', () => {
      roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });

    this._boundKeyDown = (e) => {
      if (e.key === 'Escape' && this.state === State.SELECTED) {
        this._cancelSelection();
        return;
      }
      if (this.state === State.PLACE_SELECT && this._canInteract()) {
        if (e.key === 'r' || e.key === 'R') {
          this._rotatePlaceOrientation();
          return;
        }
        const idx = '123'.indexOf(e.key);
        if (idx >= 0 && idx < this.placeSpots.length) {
          this._confirmPlace(this.floatingBlock, this.placeSpots[idx]);
        }
      }
    };
    window.addEventListener('keydown', this._boundKeyDown);

    this._updatePlayerInputs(2);
    this._setPlayMode('local');

    this._initFromShareLink();
  }

  _getRoomCodeFromUrl() {
    const params = new URLSearchParams(location.search);
    const hashMatch = location.hash.match(/room=([A-Z0-9]{4})/i);
    const code = (params.get('room') || hashMatch?.[1] || '').toUpperCase();
    return code.length === 4 ? code : null;
  }

  _savePlayerName(name) {
    localStorage.setItem('jenga-name', name);
  }

  async _initFromShareLink() {
    const code = this._getRoomCodeFromUrl();
    if (!code) return;

    this._setPlayMode('online');
    document.getElementById('room-code-input').value = code;

    const savedName = localStorage.getItem('jenga-name');
    if (savedName) {
      document.getElementById('online-name-input').value = savedName;
    }

    await this._autoJoinRoom(code);
  }

  async _autoJoinRoom(code) {
    const nameInput = document.getElementById('online-name-input');
    let name = nameInput.value.trim();
    if (!name) {
      name = `ผู้เล่น ${Math.floor(Math.random() * 89) + 10}`;
      nameInput.value = name;
    }
    this._savePlayerName(name);

    const status = document.getElementById('connection-status');
    status.textContent = '⏳ กำลังเข้าห้องอัตโนมัติ...';

    try {
      await this.mp.joinRoom(code, name);
      status.textContent = '🟢 เข้าห้องแล้ว';
    } catch {
      status.textContent = '🔴 เข้าห้องไม่ได้';
      this._showOnlineError('เข้าห้องอัตโนมัติไม่ได้ — รอเซิร์ฟเวอร์ตื่น ~1 นาที แล้วกด "เข้าร่วม" อีกครั้ง');
    }
  }

  _setPlayMode(mode) {
    this.playMode = mode;
    document.querySelectorAll('.mode-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.mode === mode);
    });
    document.getElementById('local-setup').classList.toggle('hidden', mode !== 'local');
    document.getElementById('online-setup').classList.toggle('hidden', mode !== 'online');
  }

  async _createRoom() {
    const name = document.getElementById('online-name-input').value.trim() || 'ผู้เล่น 1';
    this._savePlayerName(name);
    const btn = document.getElementById('create-room-btn');
    btn.disabled = true;
    btn.textContent = '⏳ กำลังสร้างห้อง...';
    try {
      await this.mp.createRoom(name);
    } catch {
      this._showOnlineError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — รอ 30–60 วินาที (เซิร์ฟเวอร์อาจกำลังตื่น) แล้วลองอีกครั้ง');
    } finally {
      btn.disabled = false;
      btn.textContent = '🏠 สร้างห้อง';
    }
  }

  async _joinRoom() {
    const code = document.getElementById('room-code-input').value.trim();
    const name = document.getElementById('online-name-input').value.trim() || 'ผู้เล่น';
    this._savePlayerName(name);
    if (code.length !== 4) {
      this._showOnlineError('กรอกรหัสห้อง 4 ตัวอักษร');
      return;
    }
    const btn = document.getElementById('join-room-btn');
    btn.disabled = true;
    btn.textContent = '⏳ กำลังเข้าห้อง...';
    try {
      await this.mp.joinRoom(code, name);
    } catch {
      this._showOnlineError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — รอ 30–60 วินาที (เซิร์ฟเวอร์อาจกำลังตื่น) แล้วลองอีกครั้ง');
    } finally {
      btn.disabled = false;
      btn.textContent = '🚪 เข้าร่วม';
    }
  }

  _leaveRoom() {
    this.mp.leaveRoom();
    document.getElementById('online-menu').classList.remove('hidden');
    document.getElementById('lobby-panel').classList.add('hidden');
    document.getElementById('online-error').textContent = '';
    this.onlineMode = false;
  }

  _showLobby(msg) {
    document.getElementById('online-menu').classList.add('hidden');
    document.getElementById('lobby-panel').classList.remove('hidden');
    document.getElementById('room-code-display').textContent = msg.roomCode;
    history.replaceState(null, '', this._getShareUrl(msg.roomCode));
    this._updateShareLink(msg.roomCode);
    this._updateLobby(msg.players, msg.started);
    this._setLobbyStatus(
      this.mp.isHost
        ? (window.JENGA_LITE
          ? '⚠️ เครื่องนี้สเปคต่ำ — เพื่อนอาจรู้สึกกระตุก แนะนำให้เครื่องแรงกว่าสร้างห้อง'
          : 'ส่งลิงก์ให้เพื่อน — รอผู้เล่นเข้าร่วม (เล่นได้จากที่ไหนก็ได้)')
        : 'รอเจ้าของห้องเริ่มเกม...'
    );
  }

  _getShareUrl(roomCode) {
    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('room', roomCode);
    return url.toString();
  }

  _updateShareLink(roomCode) {
    const input = document.getElementById('share-link');
    if (input) input.value = this._getShareUrl(roomCode);
  }

  async _copyShareLink() {
    const url = document.getElementById('share-link')?.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('copy-link-btn');
      const orig = btn.textContent;
      btn.textContent = '✓ คัดลอกแล้ว!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch {
      document.getElementById('share-link').select();
      this._showOnlineError('กด Ctrl+C เพื่อคัดลอกลิงก์');
    }
  }

  _getRankMedal(rank) {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  }

  _getRankings(loserIdx = null) {
    const items = this.players.map((p, i) => ({
      idx: i,
      name: p.name,
      color: p.color,
      score: p.pulls,
      isActive: i === this.currentPlayerIdx,
      isLoser: loserIdx !== null && i === loserIdx,
    }));

    const winners = items.filter((x) => !x.isLoser);
    const loser = items.find((x) => x.isLoser);

    winners.sort((a, b) => b.score - a.score);

    const ranked = [];
    let rank = 1;
    for (let i = 0; i < winners.length; i++) {
      if (i > 0 && winners[i].score < winners[i - 1].score) rank = i + 1;
      ranked.push({ ...winners[i], rank });
    }

    if (loser) ranked.push({ ...loser, rank: items.length });

    return ranked;
  }

  _getWinnerRankings(loserIdx) {
    return this._getRankings(loserIdx).filter((r) => !r.isLoser);
  }

  /** อันดับคะแนนทุกคนในห้อง — คะแนนสูงสุด = อันดับ 1 */
  _getFullScoreRankings(loserIdx = null) {
    const items = this.players.map((p, i) => ({
      idx: i,
      name: p.name,
      color: p.color,
      score: p.pulls,
      isLoser: loserIdx !== null && i === loserIdx,
    }));

    items.sort((a, b) => b.score - a.score);

    const ranked = [];
    let rank = 1;
    for (let i = 0; i < items.length; i++) {
      if (i > 0 && items[i].score < items[i - 1].score) rank = i + 1;
      ranked.push({ ...items[i], rank });
    }
    return ranked;
  }

  _updateLobby(players, started) {
    const list = document.getElementById('lobby-players');
    const focusedName = document.activeElement?.classList?.contains('lobby-name-edit')
      ? document.activeElement.value : null;

    list.innerHTML = '';
    players.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'lobby-player-card';
      const color = PLAYER_COLORS[p.idx % PLAYER_COLORS.length];
      const isMe = p.id === this.mp.playerId;
      const canEdit = isMe && !started;

      card.innerHTML = `
        <span class="player-dot" style="background:${color}"></span>
        ${canEdit
          ? `<input type="text" class="lobby-name-edit" maxlength="20" value="${this._escHtml(p.name)}" placeholder="ชื่อของคุณ">`
          : `<span class="lobby-player-name">${this._escHtml(p.name)}</span>`}
        ${p.isHost ? '<span class="lobby-host-badge">เจ้าของห้อง</span>' : ''}
        ${isMe ? '<span class="lobby-you-badge">คุณ</span>' : ''}
      `;

      if (canEdit) {
        const input = card.querySelector('.lobby-name-edit');
        const saveName = () => {
          const name = input.value.trim();
          if (name && name !== p.name) {
            this._savePlayerName(name);
            this.mp.updateName(name);
          }
        };
        input.addEventListener('change', saveName);
        input.addEventListener('blur', saveName);
        if (focusedName !== null) {
          input.value = focusedName;
          input.focus();
        }
      }

      list.appendChild(card);
    });
    this._updateLobbyStartButton(players.length, started);
  }

  _escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  _updateLobbyStartButton(count = 0, started = false) {
    const btn = document.getElementById('lobby-start-btn');
    if (this.mp.isHost && !started) {
      btn.classList.remove('hidden');
      btn.disabled = count < 2;
      btn.textContent = count < 2 ? '⏳ รอผู้เล่น (ต้องมี 2 คน+)' : '🏗️ เริ่มเกม';
    } else {
      btn.classList.add('hidden');
    }
  }

  _setLobbyStatus(text) {
    document.getElementById('lobby-status').textContent = text;
  }

  _showOnlineError(msg) {
    document.getElementById('online-error').textContent = msg;
  }

  _startOnlineGame(remotePlayers) {
    this.players = remotePlayers.map((p) => ({
      name: p.name,
      color: PLAYER_COLORS[p.colorIdx % PLAYER_COLORS.length],
      pulls: 0,
      id: p.id,
    }));

    this.mp.myPlayerIdx = this.players.findIndex((p) => p.id === this.mp.playerId);
    this.onlineMode = true;

    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('lobby-panel').classList.add('hidden');

    this._beginGame();
  }

  _canInteract() {
    if (!this.onlineMode) return true;
    return this.mp.myPlayerIdx === this.currentPlayerIdx;
  }

  /** เลือก/เปลี่ยนบล็อกได้ตอนรอเล่นหรือเลือกไว้แล้วแต่ยังไม่ดึง */
  _canSelectBlock() {
    return (this.state === State.PLAYING || this.state === State.SELECTED) && this._canInteract();
  }

  _updatePlayerInputs(count) {
    const container = document.getElementById('player-inputs');
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'player-input-row';
      row.innerHTML = `
        <span class="player-color-dot" style="background:${PLAYER_COLORS[i]};color:${PLAYER_COLORS[i]}"></span>
        <input type="text" class="player-name-input" data-idx="${i}"
               placeholder="ผู้เล่น ${i + 1}" value="ผู้เล่น ${i + 1}">
      `;
      container.appendChild(row);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Start Game
  // ═══════════════════════════════════════════════════════
  _startGame() {
    const inputs = document.querySelectorAll('.player-name-input');
    this.players = [];
    inputs.forEach((inp, i) => {
      this.players.push({
        name: inp.value.trim() || `ผู้เล่น ${i + 1}`,
        color: PLAYER_COLORS[i],
        pulls: 0,
      });
    });

    const btn = document.getElementById('start-btn');
    btn.textContent = '⏳ กำลังสร้างตึก...';
    btn.disabled = true;

    setTimeout(() => {
      this.onlineMode = false;
      this._beginGame();
      btn.textContent = '🏗️ เริ่มเกม';
      btn.disabled = false;
    }, 80);
  }

  _beginGame() {
    if (this.renderer) this._disposeEngine();

    this.currentPlayerIdx = 0;
    this.moveCount = 0;
    this.topRow = ROWS;
    this.topRowBlockCount = 0;
    this.selectedBlock = null;
    this.hoveredBlock = null;
    this.shakeIntensity = 0;
    this.blockIdCounter = 0;
    this._loserAnnounced = false;
    this._stabilityFinished = false;
    this._collapseHandled = false;
    this._collapseStreak = 0;
    this._lateCollapseStreak = 0;
    this._gameReadyAt = performance.now() + GAME_START_GRACE_MS;

    this._initThree();
    this._initPhysics();
    this._buildTower();
    this._updateGameUI();

    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('game-ui').classList.remove('hidden');
    document.getElementById('game-over-overlay').classList.add('hidden');
    document.getElementById('confirm-panel').classList.add('hidden');
    document.getElementById('place-panel')?.classList.add('hidden');

    this.state = State.PLAYING;
    this.running = true;
    this._animate();
  }

  // ═══════════════════════════════════════════════════════
  // Three.js Initialization
  // ═══════════════════════════════════════════════════════
  _createRenderer(canvas) {
    const lite = this.liteMode;
    const attempts = lite
      ? [{ antialias: false, shadows: false }, { antialias: false, shadows: false, powerPreference: 'low-power' }]
      : [{ antialias: true, shadows: true }, { antialias: false, shadows: true }, { antialias: false, shadows: false }];

    for (const opts of attempts) {
      try {
        const renderer = new THREE.WebGLRenderer({
          antialias: opts.antialias,
          powerPreference: opts.powerPreference || (lite ? 'low-power' : 'default'),
          alpha: false,
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(lite ? 1 : Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = opts.shadows;
        if (opts.shadows) {
          renderer.shadowMap.type = lite ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
        }
        if (!lite) {
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.1;
        }
        this._rendererShadows = opts.shadows;
        return renderer;
      } catch {
        // try next profile
      }
    }
    throw new Error('WebGL สร้างไม่ได้ — ลองปิดแอปอื่นแล้วรีเฟรช');
  }

  _initThree() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080816);
    if (!this.liteMode) {
      this.scene.fog = new THREE.FogExp2(0x080816, 0.025);
    }

    // Camera
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.1, 100);
    this.camera.position.set(10, 10, 10);
    this.camera.lookAt(0, 5, 0);

    // Renderer
    const canvas = document.getElementById('game-canvas');
    this.renderer = this._createRenderer(canvas);
    canvas.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 5.5, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 28;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minPolarAngle = 0.2;
    this.controls.update();

    // ── Lights ──
    // Warm ambient
    this.scene.add(new THREE.AmbientLight(0x3a2850, 0.95));

    // Key light
    const keyLight = new THREE.DirectionalLight(0xfff5ee, 2.0);
    keyLight.position.set(6, 18, 6);
    const shadowSize = this.liteMode ? 512 : 2048;
    keyLight.castShadow = !!this._rendererShadows;
    if (keyLight.castShadow) {
      keyLight.shadow.mapSize.set(shadowSize, shadowSize);
    }
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 40;
    keyLight.shadow.camera.left = -8;
    keyLight.shadow.camera.right = 8;
    keyLight.shadow.camera.top = 15;
    keyLight.shadow.camera.bottom = -4;
    keyLight.shadow.bias = -0.001;
    this.scene.add(keyLight);

    // Fill light — cool tint for color contrast
    const fill = new THREE.DirectionalLight(0x88aaff, 0.55);
    fill.position.set(-6, 8, -4);
    this.scene.add(fill);

    // Rim light — warm edge highlight
    const rim = new THREE.DirectionalLight(0xff80c0, 0.45);
    rim.position.set(-3, 2, 8);
    this.scene.add(rim);

    // ── Ground ──
    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0e0e1e,
      roughness: 0.9,
      metalness: 0.1,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = !!this._rendererShadows;
    this.scene.add(ground);

    // ── Table ──
    const tableSegs = this.liteMode ? 24 : 48;
    const tableGeo = new THREE.CylinderGeometry(4.5, 5, 0.35, tableSegs);
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x2a1f14,
      roughness: 0.55,
      metalness: 0.15,
    });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.y = 0.175;
    table.receiveShadow = !!this._rendererShadows;
    table.castShadow = !!this._rendererShadows;
    this.scene.add(table);

    // Table edge glow ring
    const ringGeo = new THREE.TorusGeometry(4.5, 0.04, 8, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x553320, transparent: true, opacity: 0.4 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = TABLE_Y + 0.02;
    this.scene.add(ring);

    // ── Events ──
    this._boundResize = () => this._onResize();
    this._boundMouseMove = (e) => this._onMouseMove(e);
    this._boundClick = (e) => this._onClick(e);
    this._boundTouchStart = (e) => this._onTouchStart(e);
    this._boundTouchEnd = (e) => this._onTouchEnd(e);

    window.addEventListener('resize', this._boundResize);
    const el = this.renderer.domElement;
    el.addEventListener('mousemove', this._boundMouseMove);
    el.addEventListener('click', this._boundClick);
    el.addEventListener('touchstart', this._boundTouchStart, { passive: false });
    el.addEventListener('touchend', this._boundTouchEnd);
  }

  // ═══════════════════════════════════════════════════════
  // Physics Initialization
  // ═══════════════════════════════════════════════════════
  _initPhysics() {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.82, 0),
    });
    this.world.solver.iterations = this.liteMode ? 15 : 30;
    this.world.solver.tolerance = 0.0001;
    this.world.allowSleep = true;

    // Materials
    this.blockMat = new CANNON.Material('block');
    this.floorMat = new CANNON.Material('floor');

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.blockMat, this.blockMat,
      { friction: 0.55, restitution: 0.02 }
    ));
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.floorMat, this.blockMat,
      { friction: 0.85, restitution: 0.01 }
    ));

    // Ground plane at y=0 (catches fallen blocks)
    const groundBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      material: this.floorMat,
      shape: new CANNON.Plane(),
    });
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    this.world.addBody(groundBody);

    // Table surface — box at y = TABLE_Y
    const tableBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      material: this.floorMat,
    });
    tableBody.addShape(
      new CANNON.Box(new CANNON.Vec3(4.5, TABLE_Y / 2, 4.5)),
      new CANNON.Vec3(0, TABLE_Y / 2, 0)
    );
    this.world.addBody(tableBody);
  }

  // ═══════════════════════════════════════════════════════
  // Tower Construction
  // ═══════════════════════════════════════════════════════
  _buildTower() {
    this.blocks = [];
    this.blockIdCounter = 0;
    this.topRow = ROWS;
    this.topRowBlockCount = 0;
    this.moveCount = 0;

    for (let row = 0; row < ROWS; row++) {
      const isEven = row % 2 === 0;
      const y = TABLE_Y + HALF_H + row * BLOCK_H;

      for (let col = 0; col < BPR; col++) {
        const offset = (col - 1) * BLOCK_W;
        const x = isEven ? offset : 0;
        const z = isEven ? 0 : offset;
        this._createBlock(x, y, z, row, col, isEven);
      }
    }

    // Settle physics
    for (let i = 0; i < 360; i++) {
      this.world.step(1 / 60);
    }

    // Sync and sleep all
    for (const b of this.blocks) {
      b.mesh.position.copy(b.body.position);
      b.mesh.quaternion.copy(b.body.quaternion);
      b.body.sleep();
    }
  }

  _createBlock(x, y, z, row, col, isEven) {
    // ── Visual ──
    const geo = new THREE.BoxGeometry(BLOCK_W * 0.96, BLOCK_H * 0.94, BLOCK_L * 0.96);
    const blockColor = getBlockColor(row, col);
    const mat = new THREE.MeshStandardMaterial({
      color: blockColor,
      roughness: 0.32,
      metalness: 0.18,
      emissive: blockColor,
      emissiveIntensity: 0.04,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !!this._rendererShadows;
    mesh.receiveShadow = !!this._rendererShadows;
    mesh.position.set(x, y, z);
    if (!isEven) mesh.rotation.y = Math.PI / 2;
    this.scene.add(mesh);

    // ── Physics ──
    const shape = new CANNON.Box(new CANNON.Vec3(HALF_W, HALF_H, HALF_L));
    const body = new CANNON.Body({
      mass: 1,
      material: this.blockMat,
      shape,
      sleepSpeedLimit: 0.08,
      sleepTimeLimit: 0.8,
      linearDamping: 0.05,
      angularDamping: 0.05,
    });
    body.position.set(x, y, z);
    if (!isEven) {
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
    }
    this.world.addBody(body);

    const blockData = {
      id: this.blockIdCounter++,
      mesh,
      body,
      row,
      col,
      isEven,
      originalColor: blockColor.clone(),
      animating: false,
    };
    mesh.userData.block = blockData;
    this.blocks.push(blockData);
  }

  // ═══════════════════════════════════════════════════════
  // Main Animation Loop
  // ═══════════════════════════════════════════════════════
  _animate() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this._animate);

    const dt = Math.min(this.clock.getDelta(), 0.05);

    // ออนไลน์: เฉพาะเจ้าของห้องรันฟิสิกส์ — คนอื่นรับ snapshot จาก host
    const runPhysics = this.state !== State.SETUP
      && this.state !== State.GAME_OVER
      && this.state !== State.PLACE_SELECT
      && this._shouldRunPhysics();
    if (runPhysics) {
      this.world.step(1 / 60, dt, 3);

      for (const b of this.blocks) {
        if (b.body && !b.animating) {
          b.mesh.position.copy(b.body.position);
          b.mesh.quaternion.copy(b.body.quaternion);
        }
      }
    }

    // Update tweens
    this._updateAnimations();

    // Update particles
    this._updateParticles(dt);

    // เลือกจุดวาง + จับเวลา
    if (this.state === State.PLACE_SELECT && this.floatingBlock) {
      const elapsed = (performance.now() - this.placeTimerStart) / 1000;
      const remaining = PLACE_TIME_LIMIT - elapsed;
      this._updatePlaceTimerUI(remaining);

      const base = this.floatingBlock.mesh.userData.floatBase;
      if (base) {
        const bob = Math.sin(performance.now() * 0.004) * 0.07;
        this.floatingBlock.mesh.position.y = base.y + bob;
      }

      if (remaining <= 0) {
        this._dropFloatingBlock(this.floatingBlock);
      }
    }

    // Stability check — รอฟิสิกส์นิ่งก่อนตัดสิน (ไม่ตัดที่ 4 วิตายๆ)
    if (this.state === State.CHECKING) {
      const elapsed = (performance.now() - this.checkStartTime) / 1000;
      const settled = this._blocksAreSettled();
      const collapsed = this._canDetectCollapse() && elapsed >= 0.6 && this._isTowerCollapsed();

      if (this.onlineMode && !this.mp.isHost) {
        if (collapsed) {
          this._setStatus('💥 ตึกถล่ม! รอประกาศผลจากเจ้าของห้อง...');
        } else if (!settled) {
          this._setStatus(`⏳ บล็อกยังเคลื่อนไหว... ${Math.max(0, STABILITY_MAX_WAIT - elapsed).toFixed(0)}s`);
        } else {
          this._setStatus('⏳ รอผลจากเจ้าของห้อง...');
        }
        if (elapsed > STABILITY_MAX_WAIT + 8 && !this._collapseHandled) {
          this._setStatus('⚠️ รอผลนานเกินไป — ลองรีเฟรชหน้าเว็บ');
        }
      } else {
        if (collapsed) {
          this._collapseStreak++;
          if (this._collapseStreak >= COLLAPSE_STREAK_NEED) {
            this._handleCollapse();
          } else {
            this._setStatus(`💥 ตรวจพบตึกถล่ม... (${this._collapseStreak}/${COLLAPSE_STREAK_NEED})`);
          }
        } else {
          this._collapseStreak = 0;
          if (settled && elapsed >= 1.2) {
            this._handleStabilityPass();
          } else if (elapsed >= STABILITY_MAX_WAIT) {
            if (this._isTowerCollapsed()) this._handleCollapse();
            else this._handleStabilityPass();
          } else {
            this._setStatus(
              settled
                ? '⏳ ตรวจสอบความมั่นคง...'
                : `⏳ รอบล็อกนิ่ง... ${Math.max(0, STABILITY_MAX_WAIT - elapsed).toFixed(0)}s`,
            );
          }
        }

        if (this.onlineMode && this.mp.isHost) {
          const now = performance.now();
          if (now - this._lastBlockSync > 280) {
            this._lastBlockSync = now;
            this.mp.broadcastBlockSync(this._collectBlockSnapshot());
          }
        }
      }
    }

    // จับตึกถล่มหลังจบ CHECKING แล้ว (เฉพาะหลังมีการเล่นอย่างน้อย 1 ตา)
    if (
      this._canDetectCollapse()
      && this._shouldRunPhysics()
      && this.state === State.PLAYING
      && this.moveCount > 0
    ) {
      if (this._isTowerCollapsed()) {
        this._lateCollapseStreak++;
        if (this._lateCollapseStreak >= 10) this._handleCollapse();
      } else {
        this._lateCollapseStreak = 0;
      }
    }

    // Camera shake
    if (this.shakeIntensity > 0.001) {
      const t = performance.now() * 0.01;
      this.camera.position.x = this.cameraBasePos.x + Math.sin(t * 5.3) * this.shakeIntensity;
      this.camera.position.y = this.cameraBasePos.y + Math.cos(t * 7.1) * this.shakeIntensity * 0.5;
      this.camera.position.z = this.cameraBasePos.z + Math.sin(t * 6.7) * this.shakeIntensity * 0.7;
      this.shakeIntensity *= 0.94;
    }

    // ออนไลน์ (ไม่ใช่ host): ขยับบล็อกแบบลื่น แทนการกระโดดทุก 280ms
    if (this.onlineMode && !this.mp.isHost) {
      this._lerpSyncedBlocks();
    }

    // Controls
    this.controls.update();

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  // ═══════════════════════════════════════════════════════
  // Animation System
  // ═══════════════════════════════════════════════════════
  _animateTo(mesh, targetPos, targetQuat, duration, onComplete) {
    this.animations.push({
      mesh,
      startPos: mesh.position.clone(),
      targetPos: targetPos.clone(),
      startQuat: mesh.quaternion.clone(),
      targetQuat: targetQuat ? targetQuat.clone() : mesh.quaternion.clone(),
      startTime: performance.now(),
      duration: duration * 1000,
      onComplete,
    });
  }

  _updateAnimations() {
    const now = performance.now();
    for (let i = this.animations.length - 1; i >= 0; i--) {
      const a = this.animations[i];
      const t = Math.min((now - a.startTime) / a.duration, 1);
      const e = this._easeInOutCubic(t);

      a.mesh.position.lerpVectors(a.startPos, a.targetPos, e);
      a.mesh.quaternion.slerpQuaternions(a.startQuat, a.targetQuat, e);

      if (t >= 1) {
        this.animations.splice(i, 1);
        if (a.onComplete) a.onComplete();
      }
    }
  }

  _easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // ═══════════════════════════════════════════════════════
  // Particle System
  // ═══════════════════════════════════════════════════════
  _spawnDust(position, color = 0xddc090, count = 20) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const vels = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      vels.push(new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 3 + 1,
        (Math.random() - 0.5) * 4,
      ));
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.08,
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    this.scene.add(points);

    this.particles.push({
      points, vels, startTime: performance.now(), life: 1.5,
    });
  }

  _updateParticles(dt) {
    const now = performance.now();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const elapsed = (now - p.startTime) / 1000;
      const t = elapsed / p.life;

      if (t >= 1) {
        this.scene.remove(p.points);
        p.points.geometry.dispose();
        p.points.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }

      p.points.material.opacity = 1 - t;
      const posArr = p.points.geometry.attributes.position.array;
      for (let j = 0; j < p.vels.length; j++) {
        posArr[j * 3] += p.vels[j].x * dt;
        posArr[j * 3 + 1] += p.vels[j].y * dt;
        posArr[j * 3 + 2] += p.vels[j].z * dt;
        p.vels[j].y -= 4 * dt; // gravity
      }
      p.points.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ═══════════════════════════════════════════════════════
  // Input Handling
  // ═══════════════════════════════════════════════════════
  _getMouseNDC(clientX, clientY) {
    return new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
  }

  _onMouseMove(e) {
    this.mouse = this._getMouseNDC(e.clientX, e.clientY);

    if (this.state === State.PLACE_SELECT) {
      this._updatePlaceHover();
      return;
    }

    if (this.state !== State.PLAYING && this.state !== State.SELECTED) return;
    if (!this._canInteract() && this.state !== State.SELECTED) return;
    this._updateHover();
  }

  _onClick(e) {
    this.mouse = this._getMouseNDC(e.clientX, e.clientY);

    if (this.state === State.PLACE_SELECT) {
      this._tryPlaceSelect();
      return;
    }

    if (this._canSelectBlock()) {
      this._trySelect();
    }
  }

  _updatePlaceHover() {
    if (!this._canInteract()) {
      this.renderer.domElement.style.cursor = 'default';
      return;
    }

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.placeGhostMeshes);

    if (this.hoveredPlaceGhost) {
      this._highlightPlaceGhost(this.hoveredPlaceGhost, false);
      this.hoveredPlaceGhost = null;
    }

    if (hits.length > 0) {
      this.hoveredPlaceGhost = hits[0].object;
      this._highlightPlaceGhost(this.hoveredPlaceGhost, true);
      this.renderer.domElement.style.cursor = 'pointer';
    } else {
      this.renderer.domElement.style.cursor = 'default';
    }
  }

  _onTouchStart(e) {
    if (e.touches.length === 1) {
      this.touchStart = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: performance.now(),
      };
    }
  }

  _onTouchEnd(e) {
    if (!this.touchStart) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - this.touchStart.x;
    const dy = touch.clientY - this.touchStart.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = performance.now() - this.touchStart.time;

    // Treat as tap if short distance and time
    if (dist < 15 && elapsed < 400) {
      this.mouse = this._getMouseNDC(touch.clientX, touch.clientY);
      if (this.state === State.PLACE_SELECT) {
        this._tryPlaceSelect();
      } else if (this._canSelectBlock()) {
        this._trySelect();
      }
    }
    this.touchStart = null;
  }

  // ═══════════════════════════════════════════════════════
  // Block Selection & Interaction
  // ═══════════════════════════════════════════════════════
  _getBlockMeshes() {
    return this.blocks
      .filter(b => b.body && !b.animating)
      .map(b => b.mesh);
  }

  _updateHover() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = this._getBlockMeshes();
    const hits = this.raycaster.intersectObjects(meshes);

    // Unhighlight current
    if (this.hoveredBlock && this.hoveredBlock !== this.selectedBlock) {
      this._unhighlight(this.hoveredBlock);
    }

    if (hits.length > 0) {
      const block = hits[0].object.userData.block;
      if (block && this._isRemovable(block) && block !== this.selectedBlock) {
        this.hoveredBlock = block;
        const hoverColor = this.state === State.SELECTED ? 0xffcc66 : 0xffee88;
        this._highlight(block, hoverColor, this.state === State.SELECTED ? 0.22 : 0.15);
        this.renderer.domElement.style.cursor = 'pointer';
      } else if (block === this.selectedBlock) {
        this.hoveredBlock = null;
        this.renderer.domElement.style.cursor = 'pointer';
      } else {
        this.hoveredBlock = null;
        this.renderer.domElement.style.cursor = 'default';
      }
    } else {
      this.hoveredBlock = null;
      this.renderer.domElement.style.cursor = 'default';
    }
  }

  _trySelect() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = this._getBlockMeshes();
    const hits = this.raycaster.intersectObjects(meshes);

    if (hits.length > 0) {
      const block = hits[0].object.userData.block;
      if (block && this._isRemovable(block)) {
        // คลิกบล็อกเดิมอีกครั้ง = ยืนยันดึง
        if (this.selectedBlock === block) {
          this._confirmPull();
          return;
        }

        const changedSelection = !!this.selectedBlock;

        // เปลี่ยนใจ — ยกเลิกไฮไลต์บล็อกเดิมก่อน
        if (this.selectedBlock) {
          this._unhighlight(this.selectedBlock);
        }

        this.selectedBlock = block;
        const pColor = new THREE.Color(this.players[this.currentPlayerIdx].color);
        this._highlight(block, pColor, 0.4);
        this.state = State.SELECTED;

        document.getElementById('confirm-panel').classList.remove('hidden');
        this._setStatus(
          changedSelection
            ? '🔄 เปลี่ยนบล็อกแล้ว — คลิกบล็อกนี้อีกครั้งหรือกด "ดึง" เพื่อยืนยัน'
            : '📌 เลือกบล็อกแล้ว — คลิกบล็อกอื่นเพื่อเปลี่ยนใจ หรือกด "ดึง" เพื่อยืนยัน',
        );
      }
    }
  }

  _cancelSelection() {
    if (this.selectedBlock) {
      this._unhighlight(this.selectedBlock);
      this.selectedBlock = null;
    }
    document.getElementById('confirm-panel').classList.add('hidden');
    this.state = State.PLAYING;
    this._setTurnStatus();
    if (this.onlineMode) this.mp.broadcastCancel();
  }

  _remoteCancelSelection() {
    if (this.selectedBlock) {
      this._unhighlight(this.selectedBlock);
      this.selectedBlock = null;
    }
    document.getElementById('confirm-panel').classList.add('hidden');
    if (this.state === State.SELECTED) this.state = State.PLAYING;
  }

  _isRemovable(block) {
    if (!block.body || block.animating) return false;
    // Find highest row that has blocks
    let maxRow = 0;
    for (const b of this.blocks) {
      if (b.body && !b.animating) {
        maxRow = Math.max(maxRow, b.row);
      }
    }
    // Can't remove from the topmost row
    return block.row < maxRow;
  }

  _highlight(block, color, emissiveIntensity) {
    if (color instanceof THREE.Color) {
      block.mesh.material.emissive = color;
    } else {
      block.mesh.material.emissive.setHex(color);
    }
    block.mesh.material.emissiveIntensity = emissiveIntensity;
  }

  _unhighlight(block) {
    block.mesh.material.emissive.copy(block.originalColor);
    block.mesh.material.emissiveIntensity = 0.04;
  }

  // ═══════════════════════════════════════════════════════
  // Pull & Place
  // ═══════════════════════════════════════════════════════
  _confirmPull() {
    const block = this.selectedBlock;
    if (!block || !this._canInteract()) return;
    if (this.onlineMode) this.mp.broadcastPull(block.id);
    this._doPull(block);
  }

  _executeRemotePull(blockId, playerIdx) {
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || !block.body || block.animating) return;
    this.currentPlayerIdx = playerIdx;
    this._updateGameUI();
    this._doPull(block);
  }

  _doPull(block) {
    document.getElementById('confirm-panel').classList.add('hidden');
    this.state = State.PULLING;
    block.animating = true;
    this.selectedBlock = null;

    this.world.removeBody(block.body);
    block.body = null;

    this._spawnDust(block.mesh.position.clone(), block.originalColor.getHex());
    this._wakeAll();

    const pullDist = 5;
    const pullDir = block.isEven
      ? new THREE.Vector3(pullDist, 0.5, 0)
      : new THREE.Vector3(0, 0.5, pullDist);
    const pullTarget = block.mesh.position.clone().add(pullDir);

    this._setStatus(`🔄 ${this.players[this.currentPlayerIdx].name} กำลังดึงบล็อก...`);

    this._animateTo(block.mesh, pullTarget, null, 0.7, () => {
      block.animating = false;
      block.mesh.userData.floatBase = block.mesh.position.clone();
      this._startPlaceSelect(block);
    });
  }

  _getPlacementRowInfo() {
    let row = this.topRow;
    let startSlot = this.topRowBlockCount;
    if (startSlot >= BPR) {
      row++;
      startSlot = 0;
    }
    return { row, startSlot };
  }

  _getTowerTopY() {
    let maxY = TABLE_Y;
    for (const b of this.blocks) {
      if (b === this.floatingBlock) continue;
      const pos = b.body?.position || b.mesh?.position;
      if (pos) maxY = Math.max(maxY, pos.y);
    }
    return maxY;
  }

  /** จังก้าจริง — ชั้นใหม่ตั้งฉากกับชั้นล่าง */
  _getDefaultPlaceOrientation() {
    const { row } = this._getPlacementRowInfo();
    return row % 2 === 0;
  }

  _getValidPlaceSpots(orientEven = this.placeIsHorizontal) {
    const spots = [];
    const maxY = this._getTowerTopY();
    const { row, startSlot } = this._getPlacementRowInfo();
    const y = startSlot === 0 ? maxY + BLOCK_H : maxY;

    for (let slot = startSlot; slot < BPR; slot++) {
      const offset = (slot - 1) * BLOCK_W;
      const x = orientEven ? offset : 0;
      const z = orientEven ? 0 : offset;

      spots.push({
        slotIndex: slot,
        row,
        isEven: orientEven,
        position: new THREE.Vector3(x, y, z),
      });
    }

    return spots;
  }

  _getPlaceQuaternion(isHorizontal) {
    const quat = new THREE.Quaternion();
    if (!isHorizontal) quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    return quat;
  }

  _animateQuaternion(mesh, targetQuat, duration, onComplete) {
    this.animations.push({
      mesh,
      startPos: mesh.position.clone(),
      targetPos: mesh.position.clone(),
      startQuat: mesh.quaternion.clone(),
      targetQuat: targetQuat.clone(),
      startTime: performance.now(),
      duration: duration * 1000,
      onComplete,
    });
  }

  _startPlaceSelect(block) {
    this.floatingBlock = block;
    this._placeResolved = false;
    this.placeIsHorizontal = this._getDefaultPlaceOrientation();
    this.placeSpots = this._getValidPlaceSpots(this.placeIsHorizontal);
    this.placeTimerStart = performance.now();
    this.state = State.PLACE_SELECT;

    this._showPlaceGhosts();
    this._applyPlaceOrientationPreview();
    this._showPlaceUI();

    if (this._canInteract()) {
      this._setStatus(`📍 เลือกจุดวาง — ทิศทางตั้งฉากชั้นล่าง (🔄 หมุนได้) (${PLACE_TIME_LIMIT}s)`);
    } else {
      this._setStatus(`⏳ รอ ${this.players[this.currentPlayerIdx].name} เลือกจุดวาง...`);
    }
  }

  _applyPlaceOrientationPreview() {
    if (!this.floatingBlock) return;
    const quat = this._getPlaceQuaternion(this.placeIsHorizontal);
    this.floatingBlock.mesh.quaternion.copy(quat);

    for (const ghost of this.placeGhostMeshes) {
      ghost.quaternion.copy(quat);
    }

    const label = document.getElementById('place-orient-label');
    if (label) label.textContent = this.placeIsHorizontal ? 'แนวนอน ↔' : 'แนวตั้ง ↕';
  }

  _rotatePlaceOrientation() {
    if (this.state !== State.PLACE_SELECT || !this._canInteract() || !this.floatingBlock) return;

    this.placeIsHorizontal = !this.placeIsHorizontal;
    this.placeSpots = this._getValidPlaceSpots(this.placeIsHorizontal);
    this._refreshPlaceGhostsAnimated();

    if (this.onlineMode) this.mp.broadcastPlaceRotate(this.placeIsHorizontal);

    const orient = this.placeIsHorizontal ? 'แนวนอน ↔' : 'แนวตั้ง ↕';
    this._setStatus(`🔄 หมุนเป็น${orient} — จุดวางปรับตามทิศทางบล็อก`);
  }

  _executeRemotePlaceRotate(isHorizontal, playerIdx) {
    if (this.state !== State.PLACE_SELECT) return;
    this.currentPlayerIdx = playerIdx;
    this.placeIsHorizontal = isHorizontal;
    this.placeSpots = this._getValidPlaceSpots(this.placeIsHorizontal);
    this._refreshPlaceGhostsAnimated();
  }

  _refreshPlaceGhostsAnimated() {
    const quat = this._getPlaceQuaternion(this.placeIsHorizontal);
    const label = document.getElementById('place-orient-label');
    if (label) label.textContent = this.placeIsHorizontal ? 'แนวนอน ↔' : 'แนวตั้ง ↕';

    if (this.floatingBlock) {
      this._animateQuaternion(this.floatingBlock.mesh, quat, 0.38);
    }

    if (this.placeGhostMeshes.length !== this.placeSpots.length) {
      this._showPlaceGhosts();
      this._applyPlaceOrientationPreview();
      return;
    }

    for (let i = 0; i < this.placeGhostMeshes.length; i++) {
      const ghost = this.placeGhostMeshes[i];
      const spot = this.placeSpots[i];
      ghost.userData.placeSpot = spot;
      this._animateTo(ghost, spot.position, quat, 0.38);
    }
  }

  _buildFinalSpot(spot) {
    const quat = this._getPlaceQuaternion(this.placeIsHorizontal);
    return {
      slotIndex: spot.slotIndex,
      row: spot.row,
      isEven: this.placeIsHorizontal,
      position: spot.position,
      quaternion: quat,
    };
  }

  _showPlaceUI() {
    const panel = document.getElementById('place-panel');
    const hint = document.getElementById('place-hint');
    if (!panel) return;

    panel.classList.remove('hidden');
    if (hint) {
      hint.textContent = this._canInteract()
        ? 'แตะจุดวาง — บล็อกตั้งฉากชั้นล่าง (กด 🔄 / R หมุนทิศ) — หมดเวลาจะร่วงตามฟิสิกส์!'
        : `รอ ${this.players[this.currentPlayerIdx].name} เลือกจุดวาง...`;
    }
    const rotateBtn = document.getElementById('btn-rotate-place');
    if (rotateBtn) rotateBtn.disabled = !this._canInteract();
    this._updatePlaceTimerUI(PLACE_TIME_LIMIT);
  }

  _updatePlaceTimerUI(remaining) {
    const bar = document.getElementById('place-timer-bar');
    if (!bar) return;

    const pct = Math.max(0, (remaining / PLACE_TIME_LIMIT) * 100);
    bar.style.width = `${pct}%`;
    bar.classList.toggle('urgent', remaining <= 5);
  }

  _clearPlaceUI() {
    document.getElementById('place-panel')?.classList.add('hidden');
    this._clearPlaceGhosts();
    this.placeTimerStart = 0;
  }

  _clearPlaceGhosts() {
    for (const ghost of this.placeGhostMeshes) {
      this.scene.remove(ghost);
      ghost.geometry.dispose();
      ghost.material.dispose();
    }
    this.placeGhostMeshes = [];
    this.hoveredPlaceGhost = null;
  }

  _showPlaceGhosts() {
    this._clearPlaceGhosts();
    const geo = new THREE.BoxGeometry(BLOCK_W * 0.96, BLOCK_H * 0.94, BLOCK_L * 0.96);
    const playerColor = new THREE.Color(this.players[this.currentPlayerIdx].color);

    for (const spot of this.placeSpots) {
      const mat = new THREE.MeshStandardMaterial({
        color: playerColor,
        transparent: true,
        opacity: 0.38,
        emissive: playerColor,
        emissiveIntensity: 0.35,
        depthWrite: false,
      });
      const ghost = new THREE.Mesh(geo, mat);
      ghost.position.copy(spot.position);
      ghost.userData.placeSpot = spot;
      this.scene.add(ghost);
      this.placeGhostMeshes.push(ghost);
    }
  }

  _highlightPlaceGhost(ghost, on) {
    if (!ghost) return;
    ghost.material.opacity = on ? 0.72 : 0.38;
    ghost.material.emissiveIntensity = on ? 0.65 : 0.35;
    ghost.scale.setScalar(on ? 1.06 : 1);
  }

  _tryPlaceSelect() {
    if (this.state !== State.PLACE_SELECT || !this._canInteract() || !this.floatingBlock) return;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.placeGhostMeshes);
    if (hits.length > 0) {
      const spot = hits[0].object.userData.placeSpot;
      this._confirmPlace(this.floatingBlock, spot);
    }
  }

  _confirmPlace(block, spot) {
    if (!this._placeResolve() || block !== this.floatingBlock) return;

    const finalSpot = this._buildFinalSpot(spot);
    this._clearPlaceUI();
    if (this.onlineMode) this.mp.broadcastPlace(block.id, finalSpot);
    this._commitPlaceAtSpot(block, finalSpot);
  }

  _executeRemotePlace(blockId, spotData, playerIdx) {
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block) return;

    this.currentPlayerIdx = playerIdx;
    this._updateGameUI();
    this._placeResolve();
    this._clearPlaceUI();
    this._commitPlaceAtSpot(block, this._spotFromNetwork(spotData));
  }

  _executeRemoteDrop(msg) {
    const block = this.blocks.find((b) => b.id === msg.blockId);
    if (!block) return;

    this.currentPlayerIdx = msg.playerIdx;
    this._updateGameUI();
    this._placeResolve();
    this._clearPlaceUI();

    const pos = new THREE.Vector3(msg.x, msg.y, msg.z);
    const quat = new THREE.Quaternion(msg.qx, msg.qy, msg.qz, msg.qw);
    this._releaseFloatingBlock(block, pos, quat);
  }

  _dropFloatingBlock(block) {
    if (!this._placeResolve() || block !== this.floatingBlock) return;

    this._clearPlaceUI();
    const pos = block.mesh.position.clone();
    const quat = block.mesh.quaternion.clone();

    if (this.onlineMode && this._canInteract()) {
      this.mp.broadcastPlaceTimeout(block.id, pos, quat);
    }

    this._setStatus('💨 หมดเวลา! บล็อกร่วงลง...');
    this._releaseFloatingBlock(block, pos, quat);
  }

  _releaseFloatingBlock(block, pos, quat) {
    this.floatingBlock = null;
    block.animating = false;
    block.mesh.position.copy(pos);
    block.mesh.quaternion.copy(quat);

    const shape = new CANNON.Box(new CANNON.Vec3(HALF_W, HALF_H, HALF_L));
    const body = new CANNON.Body({
      mass: 1,
      material: this.blockMat,
      shape,
      sleepSpeedLimit: 0.08,
      sleepTimeLimit: 0.8,
      linearDamping: 0.05,
      angularDamping: 0.05,
    });
    body.position.set(pos.x, pos.y, pos.z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    this.world.addBody(body);
    block.body = body;
    this._wakeAll();
    this._beginStabilityCheck();
  }

  _commitPlaceAtSpot(block, spot) {
    this.state = State.PLACING;
    this.floatingBlock = null;

    block.row = spot.row;
    block.isEven = spot.isEven;
    block.col = spot.slotIndex;
    block.animating = true;

    this.topRow = spot.row;
    this.topRowBlockCount = spot.slotIndex + 1;
    if (this.topRowBlockCount >= BPR) {
      this.topRow++;
      this.topRowBlockCount = 0;
    }

    const targetPos = spot.position;
    const targetQuat = spot.quaternion;
    const approachPos = targetPos.clone().add(new THREE.Vector3(0, 0.55, 0));

    this._setStatus('📦 กำลังวางบล็อก...');
    this._animateTo(block.mesh, approachPos, targetQuat, 0.42, () => {
      this._dropBlockWithPhysics(block, targetPos, targetQuat);
    });
  }

  _stylePlacedBlock(block) {
    const playerColor = new THREE.Color(this.players[this.currentPlayerIdx].color);
    block.mesh.material.color.copy(block.originalColor).lerp(playerColor, 0.38);
    block.originalColor.copy(block.mesh.material.color);
    block.mesh.material.emissive.copy(block.originalColor);
    block.mesh.material.emissiveIntensity = 0.06;
  }

  _createBlockBody(pos, quat) {
    const shape = new CANNON.Box(new CANNON.Vec3(HALF_W, HALF_H, HALF_L));
    const body = new CANNON.Body({
      mass: 1,
      material: this.blockMat,
      shape,
      sleepSpeedLimit: 0.08,
      sleepTimeLimit: 0.8,
      linearDamping: 0.05,
      angularDamping: 0.05,
    });
    body.position.set(pos.x, pos.y, pos.z);
    if (quat) body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    return body;
  }

  _attachBlockBody(block, body) {
    this.world.addBody(body);
    block.body = body;
    block.animating = false;
    block.mesh.position.copy(body.position);
    block.mesh.quaternion.copy(body.quaternion);
  }

  /** ปล่อยบล็อกให้ตกลงชั้นล่างตามฟิสิกส์ (host / ออฟไลน์) */
  _dropBlockWithPhysics(block, targetPos, targetQuat) {
    if (this._shouldRunPhysics()) {
      const body = this._createBlockBody(
        new THREE.Vector3(targetPos.x, targetPos.y + 0.22, targetPos.z),
        targetQuat,
      );
      body.velocity.set(0, -1.4, 0);
      body.angularVelocity.set(
        (Math.random() - 0.5) * 0.15,
        0,
        (Math.random() - 0.5) * 0.15,
      );
      this._attachBlockBody(block, body);
      this._stylePlacedBlock(block);
      this._spawnDust(targetPos.clone(), block.originalColor.getHex(), 12);
      this._wakeAll();
      this._unhighlight(block);
      this._beginStabilityCheck();
      return;
    }

    this._tweenDropSettle(block, targetPos, targetQuat);
  }

  /** ออนไลน์ (ไม่ใช่ host): จำลองการตกลงให้ดูสมจริง */
  _tweenDropSettle(block, targetPos, targetQuat) {
    const settlePos = targetPos.clone().add(new THREE.Vector3(0, 0.04, 0));
    this._animateTo(block.mesh, settlePos, targetQuat, 0.22, () => {
      this._snapPlacedBlock(block, targetPos, targetQuat);
    });
  }

  _snapPlacedBlock(block, targetPos, targetQuat) {
    const body = this._createBlockBody(targetPos, targetQuat);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    this._sleepBody(body);
    this._attachBlockBody(block, body);
    this._stylePlacedBlock(block);
    this._spawnDust(targetPos.clone(), block.originalColor.getHex(), 12);
    this._wakeAll();
    this._unhighlight(block);
    this._beginStabilityCheck();
  }

  _placeResolve() {
    if (this._placeResolved) return false;
    this._placeResolved = true;
    return true;
  }

  _beginStabilityCheck() {
    this.state = State.CHECKING;
    this.checkStartTime = performance.now();
    this._collapseStreak = 0;
    this._stabilityFinished = false;
    this._collapseHandled = false;
    this._loserAnnounced = false;
    this.selectedBlock = null;
  }

  _shouldRunPhysics() {
    if (!this.onlineMode) return true;
    if (this.mp.isHost) return true;
    // ช่วงวางบล็อก — ให้เห็นการตกลงแบบฟิสิกส์บนเครื่องตัวเอง
    if (this.state === State.PLACING && this.mp.myPlayerIdx === this.currentPlayerIdx) {
      return true;
    }
    return false;
  }

  _collectBlockSnapshot() {
    return this.blocks.map((b) => {
      const src = b.body || b.mesh;
      const p = src.position;
      const q = src.quaternion;
      return {
        id: b.id,
        row: b.row,
        isEven: b.isEven,
        active: !!b.body,
        x: p.x,
        y: p.y,
        z: p.z,
        qx: q.x,
        qy: q.y,
        qz: q.z,
        qw: q.w,
      };
    });
  }

  _lerpSyncedBlocks() {
    const now = performance.now();
    for (const b of this.blocks) {
      const L = b._syncLerp;
      if (!L) continue;
      const t = Math.min(1, (now - L.start) / L.duration);
      b.mesh.position.lerpVectors(L.fromPos, L.toPos, t);
      b.mesh.quaternion.slerpQuaternions(L.fromQuat, L.toQuat, t);
      if (t >= 1) delete b._syncLerp;
    }
  }

  _applyBlockSnapshot(snaps, opts = {}) {
    if (!snaps?.length) return;
    const { visualOnly = false, smooth = false } = opts;

    for (const s of snaps) {
      const block = this.blocks.find((b) => b.id === s.id);
      if (!block) continue;

      block.row = s.row;
      block.isEven = s.isEven;
      block.animating = false;

      const toPos = new THREE.Vector3(s.x, s.y, s.z);
      const toQuat = new THREE.Quaternion(s.qx, s.qy, s.qz, s.qw);

      if (smooth) {
        block._syncLerp = {
          fromPos: block.mesh.position.clone(),
          fromQuat: block.mesh.quaternion.clone(),
          toPos,
          toQuat,
          start: performance.now(),
          duration: 240,
        };
      } else {
        delete block._syncLerp;
        block.mesh.position.copy(toPos);
        block.mesh.quaternion.copy(toQuat);
      }

      if (visualOnly) continue;

      if (s.active && !block.body) {
        const shape = new CANNON.Box(new CANNON.Vec3(HALF_W, HALF_H, HALF_L));
        const body = new CANNON.Body({
          mass: 1,
          material: this.blockMat,
          shape,
          sleepSpeedLimit: 0.08,
          sleepTimeLimit: 0.8,
          linearDamping: 0.05,
          angularDamping: 0.05,
        });
        body.position.set(s.x, s.y, s.z);
        body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        this._sleepBody(body);
        this.world.addBody(body);
        block.body = body;
      } else if (!s.active && block.body) {
        this.world.removeBody(block.body);
        block.body = null;
      } else if (block.body) {
        block.body.position.set(s.x, s.y, s.z);
        block.body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
        block.body.velocity.set(0, 0, 0);
        block.body.angularVelocity.set(0, 0, 0);
        this._sleepBody(block.body);
      }
    }
  }

  _sleepBody(body) {
    if (!body) return;
    try {
      if (typeof body.sleep === 'function') body.sleep();
      else body.sleepState = CANNON.Body.SLEEPING;
    } catch {
      body.velocity?.set(0, 0, 0);
      body.angularVelocity?.set(0, 0, 0);
    }
  }

  _spotFromNetwork(spotData) {
    return {
      slotIndex: spotData.slotIndex,
      row: spotData.row,
      isEven: spotData.isEven,
      position: new THREE.Vector3(spotData.x, spotData.y, spotData.z),
      quaternion: new THREE.Quaternion(spotData.qx, spotData.qy, spotData.qz, spotData.qw),
    };
  }

  // ═══════════════════════════════════════════════════════
  // Stability Check
  // ═══════════════════════════════════════════════════════
  _wakeAll() {
    for (const b of this.blocks) {
      if (b.body) b.body.wakeUp();
    }
  }

  _announceLoser() {
    if (this._loserAnnounced) return;
    this._loserAnnounced = true;
    const loser = this.players[this.currentPlayerIdx];
    loser.eliminated = true;
    this._setStatus(`💥 ${loser.name} ทำตึกถล่ม — แพ้!`);
  }

  _handleCollapse() {
    if (this._collapseHandled) return;

    const data = {
      loserIdx: this.currentPlayerIdx,
      pulls: this.players.map((p) => p.pulls),
      blocks: this._collectBlockSnapshot(),
    };

    if (this.onlineMode) {
      if (this.mp.isHost) {
        this.mp.broadcastGameOver(data);
      }
      this._applyGameOver(data);
      return;
    }

    this._applyGameOver(data);
  }

  _handleStabilityPass() {
    if (this._stabilityFinished) return;
    if (!this.onlineMode || this.mp.isHost) {
      this._finishStabilityCheck();
    }
  }

  _finishStabilityCheck() {
    if (this._stabilityFinished) return;

    const collapsed = this._isTowerCollapsed();
    if (collapsed) {
      this._handleCollapse();
      return;
    }

    this._stabilityFinished = true;
    this.players[this.currentPlayerIdx].pulls++;
    this.moveCount++;
    const nextIdx = (this.currentPlayerIdx + 1) % this.players.length;
    const payload = {
      collapsed: false,
      currentPlayerIdx: nextIdx,
      pulls: this.players.map((p) => p.pulls),
      topRow: this.topRow,
      topRowBlockCount: this.topRowBlockCount,
      moveCount: this.moveCount,
      blocks: this._collectBlockSnapshot(),
    };

    if (this.onlineMode && this.mp.isHost) {
      this.mp.broadcastMoveResult(payload);
    }

    this._applyMoveResult(payload);
  }

  _applyMoveResult(data) {
    this.players.forEach((p, i) => { p.pulls = data.pulls[i]; });
    this.currentPlayerIdx = data.currentPlayerIdx;
    this.topRow = data.topRow;
    this.topRowBlockCount = data.topRowBlockCount;
    this.moveCount = data.moveCount;
    this._applyBlockSnapshot(data.blocks);
    this._stabilityFinished = false;
    this._collapseStreak = 0;
    this._collapseHandled = false;
    this._loserAnnounced = false;
    this.state = State.PLAYING;
    this._updateGameUI();
    this._setTurnStatus();
  }

  _applyGameOver(data) {
    const wasOver = this.state === State.GAME_OVER;
    this.state = State.GAME_OVER;
    this._stabilityFinished = true;
    this._collapseHandled = true;
    this._collapseStreak = 0;
    this._lateCollapseStreak = 0;
    this._gameReadyAt = performance.now() + GAME_START_GRACE_MS;

    this._clearPlaceUI();
    document.getElementById('confirm-panel')?.classList.add('hidden');
    document.getElementById('place-panel')?.classList.add('hidden');

    if (data?.pulls) {
      this.players.forEach((p, i) => {
        if (data.pulls[i] !== undefined) p.pulls = data.pulls[i];
      });
    }
    if (data?.loserIdx !== undefined) {
      this.currentPlayerIdx = data.loserIdx;
    }

    try {
      if (data?.blocks?.length) this._applyBlockSnapshot(data.blocks);
    } catch (err) {
      console.error('applyBlockSnapshot failed', err);
    }

    this._announceLoser();

    if (!wasOver) {
      this.cameraBasePos.copy(this.camera.position);
      this.shakeIntensity = 0.8;
      for (let i = 0; i < 5; i++) {
        this._spawnDust(
          new THREE.Vector3(
            (Math.random() - 0.5) * 2,
            3 + Math.random() * 5,
            (Math.random() - 0.5) * 2
          ),
          0xff8844,
          30
        );
      }
    }

    this._renderGameOverModal();
  }

  _canDetectCollapse() {
    if (performance.now() < this._gameReadyAt) return false;
    if (this.state === State.CHECKING) return true;
    return this.moveCount > 0;
  }

  _expectedBlockY(row) {
    return TABLE_Y + HALF_H + row * BLOCK_H;
  }

  _blocksAreSettled() {
    let bodies = 0;
    let moving = 0;
    for (const b of this.blocks) {
      if (!b.body || b.animating) continue;
      bodies++;
      const v = b.body.velocity;
      const av = b.body.angularVelocity;
      if (v.lengthSquared() + av.lengthSquared() > 0.08) moving++;
    }
    return bodies === 0 || moving === 0;
  }

  /** ถล่มจริง = หลุดโต๊ะ / ลงพื้น / ชั้นบนตกต่ำผิดปกติ (ไม่นับชั้นล่างปกติ) */
  _isTowerCollapsed() {
    let active = 0;
    let offTable = 0;
    let onFloor = 0;
    let heavilyDisplaced = 0;

    const tableEdge = 4.6;
    const floorY = TABLE_Y - 0.12;

    for (const b of this.blocks) {
      if (!b.body || b.animating) continue;
      active++;

      const { x, y, z } = b.body.position;
      const dist = Math.sqrt(x * x + z * z);
      const expectedY = this._expectedBlockY(b.row);
      const drop = expectedY - y;

      if (y < floorY) onFloor++;
      if (dist > tableEdge && y < TABLE_Y + BLOCK_H * 1.5) offTable++;
      if (b.row >= 4 && drop > BLOCK_H * 2.2) heavilyDisplaced++;
      if (b.row >= 10 && drop > BLOCK_H * 1.4) heavilyDisplaced++;
    }

    if (active === 0) return false;
    if (onFloor >= 1) return true;
    if (offTable >= 2) return true;
    if (heavilyDisplaced >= 4) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════════
  // Turn Management
  // ═══════════════════════════════════════════════════════
  _nextTurn() {
    this.currentPlayerIdx = (this.currentPlayerIdx + 1) % this.players.length;
    this.state = State.PLAYING;
    this._updateGameUI();
    this._setTurnStatus();
  }

  _setTurnStatus() {
    if (this.onlineMode && !this._canInteract()) {
      const current = this.players[this.currentPlayerIdx];
      this._setStatus(`⏳ รอ ${current.name} เล่น...`);
    } else {
      this._setStatus('คลิกบล็อกที่ต้องการดึง — เลือกแล้วคลิกบล็อกอื่นเพื่อเปลี่ยนใจได้');
    }
  }

  _gameOver() {
    if (this.state === State.GAME_OVER) return;
    this.state = State.GAME_OVER;

    this.cameraBasePos.copy(this.camera.position);
    this.shakeIntensity = 0.8;

    for (let i = 0; i < 5; i++) {
      this._spawnDust(
        new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          3 + Math.random() * 5,
          (Math.random() - 0.5) * 2
        ),
        0xff8844,
        30
      );
    }

    this._renderGameOverModal();
  }

  _renderGameOverModal() {
    const loserIdx = this.currentPlayerIdx;
    const loser = this.players[loserIdx];
    if (!loser) {
      console.error('[JENGA] game over modal: invalid loserIdx', loserIdx);
      return;
    }
    const rankings = this._getFullScoreRankings(loserIdx);

    document.getElementById('loser-banner').innerHTML = `
      <span class="loser-badge">แพ้</span>
      <span class="loser-name" style="color:${loser.color}">${loser.name}</span>
      <span class="loser-reason">ทำตึกถล่ม!</span>
    `;

    const winnerList = document.getElementById('winner-list');
    winnerList.innerHTML = '';

    rankings.forEach((r) => {
      const medal = this._getRankMedal(r.rank);
      winnerList.innerHTML += `
        <div class="winner-item${r.isLoser ? ' is-loser-row' : ''}">
          <span class="rank-medal">${medal}</span>
          <span class="winner-rank-label">#${r.rank}</span>
          <span class="winner-name" style="color:${r.color}">${r.name}</span>
          <span class="rank-score">${r.score} คะแนน</span>
        </div>
      `;
    });

    this._showGameOverActions();
    const overlay = document.getElementById('game-over-overlay');
    overlay.classList.remove('hidden');
    overlay.scrollTop = 0;
  }

  _showGameOverActions() {
    const rematchBtn = document.getElementById('rematch-btn');
    const leaveBtn = document.getElementById('leave-game-btn');
    const menuBtn = document.getElementById('menu-game-btn');

    if (this.onlineMode) {
      leaveBtn.classList.remove('hidden');
      menuBtn.classList.add('hidden');
      if (this.mp.isHost) {
        rematchBtn.disabled = false;
        rematchBtn.textContent = '🔄 เล่นใหม่';
      } else {
        rematchBtn.disabled = true;
        rematchBtn.textContent = '⏳ รอเจ้าของห้องเริ่มใหม่';
      }
    } else {
      leaveBtn.classList.add('hidden');
      menuBtn.classList.remove('hidden');
      rematchBtn.disabled = false;
      rematchBtn.textContent = '🔄 เล่นใหม่';
    }
  }

  _hideGameOver() {
    document.getElementById('game-over-overlay').classList.add('hidden');
  }

  _requestRematch() {
    if (this.onlineMode && !this.mp.isHost) return;
    if (this.onlineMode) this.mp.requestRematch();
    this._rematch();
  }

  _rematch() {
    this._hideGameOver();
    this.state = State.SETUP;
    this.players.forEach((p) => {
      p.pulls = 0;
      delete p.eliminated;
    });
    this.currentPlayerIdx = 0;
    this.moveCount = 0;
    this.topRow = ROWS;
    this.topRowBlockCount = 0;
    this._loserAnnounced = false;
    this._stabilityFinished = false;
    this._collapseHandled = false;
    this.selectedBlock = null;
    this.hoveredBlock = null;
    this._beginGame();
  }

  _leaveAfterGame() {
    this._hideGameOver();
    this._disposeEngine();
    document.getElementById('game-ui').classList.add('hidden');
    document.getElementById('confirm-panel').classList.add('hidden');
    this.onlineMode = false;
    this.state = State.SETUP;

    if (this.mp.inRoom) {
      const code = this.mp.roomCode;
      this.mp.leaveRoom();
      this._setPlayMode('online');
      document.getElementById('setup-screen').classList.remove('hidden');
      document.getElementById('online-menu').classList.remove('hidden');
      document.getElementById('lobby-panel').classList.add('hidden');
      if (code) {
        document.getElementById('room-code-input').value = code;
        history.replaceState(null, '', this._getShareUrl(code));
      }
    } else {
      this._restart();
    }
  }

  // ═══════════════════════════════════════════════════════
  // Restart
  // ═══════════════════════════════════════════════════════
  _restart() {
    this._disposeEngine();

    if (this.mp.inRoom) this._leaveRoom();

    document.getElementById('game-over-overlay').classList.add('hidden');
    document.getElementById('game-ui').classList.add('hidden');
    document.getElementById('confirm-panel').classList.add('hidden');

    this.selectedBlock = null;
    this.hoveredBlock = null;
    this.shakeIntensity = 0;
    this.currentPlayerIdx = 0;
    this.moveCount = 0;
    this.topRow = ROWS;
    this.topRowBlockCount = 0;
    this.onlineMode = false;

    const btn = document.getElementById('start-btn');
    btn.textContent = '🏗️ เริ่มเกม';
    btn.disabled = false;

    document.getElementById('setup-screen').classList.remove('hidden');
    this.state = State.SETUP;
  }

  _disposeEngine() {
    this.running = false;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._clearPlaceUI();
    this.floatingBlock = null;

    for (const b of this.blocks) {
      if (b.mesh && this.scene) {
        this.scene.remove(b.mesh);
        b.mesh.geometry?.dispose();
        b.mesh.material?.dispose();
      }
      if (b.body && this.world) this.world.removeBody(b.body);
    }
    this.blocks = [];

    for (const p of this.particles) {
      if (this.scene) this.scene.remove(p.points);
      p.points.geometry?.dispose();
      p.points.material?.dispose();
    }
    this.particles = [];
    this.animations = [];

    if (this._boundResize) {
      window.removeEventListener('resize', this._boundResize);
      this._boundResize = null;
    }

    if (this.renderer) {
      const el = this.renderer.domElement;
      if (this._boundMouseMove) el.removeEventListener('mousemove', this._boundMouseMove);
      if (this._boundClick) el.removeEventListener('click', this._boundClick);
      if (this._boundTouchStart) el.removeEventListener('touchstart', this._boundTouchStart);
      if (this._boundTouchEnd) el.removeEventListener('touchend', this._boundTouchEnd);
      el.parentNode?.removeChild(el);
      this.renderer.dispose();
    }

    if (this.controls) this.controls.dispose();

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.world = null;
    this.blockMat = null;
    this.floorMat = null;
    this._boundMouseMove = null;
    this._boundClick = null;
    this._boundTouchStart = null;
    this._boundTouchEnd = null;
  }

  // ═══════════════════════════════════════════════════════
  // UI Updates
  // ═══════════════════════════════════════════════════════
  _updateGameUI() {
    const list = document.getElementById('player-list');
    list.innerHTML = '';
    const rankings = this._getRankings();

    rankings.forEach((r) => {
      const card = document.createElement('div');
      card.className = `player-card${r.isActive ? ' active' : ''}`;
      card.style.setProperty('--player-color', r.color);
      card.innerHTML = `
        <span class="player-rank">${this._getRankMedal(r.rank)}</span>
        <span class="player-dot" style="background:${r.color};color:${r.color}"></span>
        <span class="player-name">${r.name}</span>
        <span class="player-score" title="คะแนน">${r.score}</span>
      `;
      list.appendChild(card);
    });

    // Turn indicator
    const current = this.players[this.currentPlayerIdx];
    const turnName = document.getElementById('turn-player-name');
    turnName.textContent = current.name;
    turnName.style.color = current.color;

    this._setTurnStatus();

    const roomBadge = document.getElementById('room-badge');
    if (this.onlineMode && this.mp.roomCode) {
      roomBadge.classList.remove('hidden');
      roomBadge.textContent = `ห้อง ${this.mp.roomCode}`;
    } else {
      roomBadge.classList.add('hidden');
    }
  }

  _setStatus(text) {
    document.getElementById('status-text').textContent = text;
  }

  // ═══════════════════════════════════════════════════════
  // Resize
  // ═══════════════════════════════════════════════════════
  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(this.liteMode ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  }
}

// ─────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────
const game = new JengaGame();
window.game = game;
