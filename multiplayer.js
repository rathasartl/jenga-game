// ╔══════════════════════════════════════════════════════════╗
// ║  JENGA — Online Room Client (WebSocket)                  ║
// ╚══════════════════════════════════════════════════════════╝

export class MultiplayerClient {
  constructor(game) {
    this.game = game;
    this.ws = null;
    this.playerId = null;
    this.roomCode = null;
    this.isHost = false;
    this.myPlayerIdx = 0;
    this.inRoom = false;
    this.reconnectTimer = null;
  }

  _getWsUrl() {
    const custom = (
      window.JENGA_WS_URL
      || document.querySelector('meta[name="jenga-ws-url"]')?.content
      || ''
    ).trim();
    if (custom) return custom.replace(/\/$/, '');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  async _wakeServer(maxAttempts = 4) {
    const base = location.origin;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const res = await fetch(`${base}/health`, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (res.ok) return true;
      } catch {
        // Render free tier cold start — retry
      }
      await new Promise((r) => setTimeout(r, 2000 + i * 1500));
    }
    return false;
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const url = this._getWsUrl();
      const ws = new WebSocket(url);
      const timeoutMs = window.JENGA_LITE ? 35000 : 20000;
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('หมดเวลาเชื่อมต่อ — เซิร์ฟเวอร์อาจกำลังตื่น ลองอีกครั้ง'));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        this._setConnectionStatus(true);
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timer);
        this._setConnectionStatus(false);
        reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'));
      };

      ws.onclose = () => {
        this._setConnectionStatus(false);
        if (this.inRoom && this.game.onlineMode) {
          this.game._setStatus('⚠️ ขาดการเชื่อมต่อ — กำลังลองใหม่...');
        }
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        this._handleMessage(msg);
      };
    });
  }

  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    await this._wakeServer();

    const attempts = window.JENGA_LITE ? 4 : 3;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await this._connectOnce();
        return;
      } catch (err) {
        lastErr = err;
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
        await new Promise((r) => setTimeout(r, 1500 + i * 2000));
        await this._wakeServer(2);
      }
    }
    throw lastErr || new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  }

  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  async createRoom(name) {
    await this.connect();
    this.send('create_room', { name });
  }

  async joinRoom(code, name) {
    await this.connect();
    this.send('join_room', { roomCode: code.toUpperCase().trim(), name });
  }

  leaveRoom() {
    this.send('leave_room');
    this.inRoom = false;
    this.roomCode = null;
    this.playerId = null;
    this.isHost = false;
    this.myPlayerIdx = 0;
    this.game.onlineMode = false;
  }

  startGame() {
    this.send('start_game');
  }

  broadcastPull(blockId) {
    this.send('pull_block', { blockId, playerIdx: this.myPlayerIdx });
  }

  broadcastPlace(blockId, spot) {
    this.send('place_block', {
      blockId,
      playerIdx: this.myPlayerIdx,
      spot: {
        slotIndex: spot.slotIndex,
        row: spot.row,
        isEven: spot.isEven,
        x: spot.position.x,
        y: spot.position.y,
        z: spot.position.z,
        qx: spot.quaternion.x,
        qy: spot.quaternion.y,
        qz: spot.quaternion.z,
        qw: spot.quaternion.w,
      },
    });
  }

  broadcastPlaceRotate(isHorizontal) {
    this.send('place_rotate', { isHorizontal, playerIdx: this.myPlayerIdx });
  }

  broadcastPlaceTimeout(blockId, pos, quat) {
    this.send('place_timeout', {
      blockId,
      playerIdx: this.myPlayerIdx,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      qx: quat.x,
      qy: quat.y,
      qz: quat.z,
      qw: quat.w,
    });
  }

  broadcastCancel() {
    this.send('cancel_selection', { playerIdx: this.myPlayerIdx });
  }

  broadcastMoveResult(data) {
    this.send('move_result', data);
  }

  broadcastBlockSync(blocks) {
    this.send('block_sync', { blocks });
  }

  broadcastGameOver(data) {
    this.send('game_over', data);
  }

  requestRematch() {
    this.send('rematch');
  }

  updateName(name) {
    this.send('update_name', { name });
  }

  _handleMessage(msg) {
    const g = this.game;

    switch (msg.type) {
      case 'room_joined':
        this.inRoom = true;
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        this.myPlayerIdx = msg.playerIdx;
        this.isHost = msg.isHost;
        g.onlineMode = true;
        g._showLobby(msg);
        break;

      case 'room_update':
        g._updateLobby(msg.players, msg.started);
        if (msg.isHost !== undefined) this.isHost = msg.isHost;
        break;

      case 'became_host':
        this.isHost = true;
        g._updateLobbyStartButton();
        g._setLobbyStatus('คุณเป็นเจ้าของห้อง — กดเริ่มเกมเมื่อพร้อม');
        break;

      case 'left_room':
        this.inRoom = false;
        break;

      case 'game_started':
        g._startOnlineGame(msg.players);
        break;

      case 'pull_block':
        if (msg.playerIdx !== this.myPlayerIdx) {
          g._executeRemotePull(msg.blockId, msg.playerIdx);
        }
        break;

      case 'place_block':
        if (msg.playerIdx !== this.myPlayerIdx) {
          g._executeRemotePlace(msg.blockId, msg.spot, msg.playerIdx);
        }
        break;

      case 'place_rotate':
        if (msg.playerIdx !== this.myPlayerIdx) {
          g._executeRemotePlaceRotate(msg.isHorizontal, msg.playerIdx);
        }
        break;

      case 'place_timeout':
        if (msg.playerIdx !== this.myPlayerIdx) {
          g._executeRemoteDrop(msg);
        }
        break;

      case 'cancel_selection':
        if (msg.playerIdx !== this.myPlayerIdx) {
          g._remoteCancelSelection();
        }
        break;

      case 'move_result':
        if (!this.isHost) {
          g._applyMoveResult(msg);
        }
        break;

      case 'block_sync':
        if (!this.isHost) {
          g._applyBlockSnapshot(msg.blocks);
        }
        break;

      case 'game_over':
        g._applyGameOver(msg);
        break;

      case 'rematch':
        g._rematch();
        break;

      case 'error':
        g._showOnlineError(msg.message);
        break;
    }
  }

  _setConnectionStatus(connected) {
    const el = document.getElementById('connection-status');
    if (!el) return;
    el.textContent = connected ? '🟢 เชื่อมต่อแล้ว' : '🔴 ไม่ได้เชื่อมต่อ';
    el.classList.toggle('connected', connected);
  }
}