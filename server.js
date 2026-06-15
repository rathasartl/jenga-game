const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { randomBytes } = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[randomBytes(1)[0] % chars.length];
  }
  return rooms.has(code) ? genRoomCode() : code;
}

function genPlayerId() {
  return randomBytes(8).toString('hex');
}

function getRoomList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    idx: p.idx,
    isHost: p.id === room.hostId,
  }));
}

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}, exceptWs = null) {
  for (const [ws] of room.players) {
    if (ws !== exceptWs) send(ws, type, payload);
  }
}

function leaveRoom(ws) {
  const roomCode = ws.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) {
    ws.roomCode = null;
    return;
  }

  const player = room.players.get(ws);
  room.players.delete(ws);
  ws.roomCode = null;

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (player && player.id === room.hostId) {
    const [newHostWs] = room.players.keys();
    const newHost = room.players.get(newHostWs);
    room.hostId = newHost.id;
    send(newHostWs, 'became_host', { roomCode });
  }

  const players = getRoomList(room);
  for (const [clientWs, p] of room.players) {
    send(clientWs, 'room_update', {
      roomCode,
      players,
      isHost: p.id === room.hostId,
      started: room.started,
    });
  }
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, 'error', { message: 'ข้อมูลไม่ถูกต้อง' });
      return;
    }

    const { type } = msg;

    if (type === 'create_room') {
      if (ws.roomCode) {
        send(ws, 'error', { message: 'คุณอยู่ในห้องแล้ว' });
        return;
      }

      const name = (msg.name || 'ผู้เล่น 1').trim().slice(0, 20) || 'ผู้เล่น 1';
      const roomCode = genRoomCode();
      const playerId = genPlayerId();

      const room = {
        code: roomCode,
        hostId: playerId,
        started: false,
        players: new Map(),
      };

      room.players.set(ws, { id: playerId, name, idx: 0 });
      ws.playerId = playerId;
      ws.roomCode = roomCode;
      rooms.set(roomCode, room);

      const players = getRoomList(room);
      send(ws, 'room_joined', {
        roomCode,
        playerId,
        playerIdx: 0,
        isHost: true,
        players,
        started: false,
      });
      return;
    }

    if (type === 'join_room') {
      if (ws.roomCode) {
        send(ws, 'error', { message: 'คุณอยู่ในห้องแล้ว' });
        return;
      }

      const roomCode = (msg.roomCode || '').toUpperCase().trim();
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, 'error', { message: 'ไม่พบห้องนี้' });
        return;
      }
      if (room.started) {
        send(ws, 'error', { message: 'เกมเริ่มแล้ว — ไม่สามารถเข้าร่วมได้' });
        return;
      }
      if (room.players.size >= 6) {
        send(ws, 'error', { message: 'ห้องเต็มแล้ว (สูงสุด 6 คน)' });
        return;
      }

      const name = (msg.name || `ผู้เล่น ${room.players.size + 1}`).trim().slice(0, 20)
        || `ผู้เล่น ${room.players.size + 1}`;
      const playerId = genPlayerId();
      const playerIdx = room.players.size;

      room.players.set(ws, { id: playerId, name, idx: playerIdx });
      ws.playerId = playerId;
      ws.roomCode = roomCode;

      const players = getRoomList(room);

      send(ws, 'room_joined', {
        roomCode,
        playerId,
        playerIdx,
        isHost: false,
        players,
        started: false,
      });

      broadcast(room, 'room_update', { roomCode, players, started: false }, ws);
      return;
    }

    if (type === 'leave_room') {
      leaveRoom(ws);
      send(ws, 'left_room', {});
      return;
    }

    if (type === 'update_name') {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started) return;
      const player = room.players.get(ws);
      if (!player) return;
      const name = (msg.name || '').trim().slice(0, 20);
      if (!name) return;
      player.name = name;
      const players = getRoomList(room);
      for (const [clientWs] of room.players) {
        send(clientWs, 'room_update', { roomCode: room.code, players, started: room.started });
      }
      return;
    }

    if (type === 'start_game') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (ws.playerId !== room.hostId) {
        send(ws, 'error', { message: 'เฉพาะเจ้าของห้องเท่านั้นที่เริ่มเกมได้' });
        return;
      }
      if (room.players.size < 2) {
        send(ws, 'error', { message: 'ต้องมีผู้เล่นอย่างน้อย 2 คน' });
        return;
      }

      room.started = true;
      const players = getRoomList(room);

      for (const [clientWs, p] of room.players) {
        send(clientWs, 'game_started', {
          roomCode: room.code,
          players: players.map((pl) => ({
            id: pl.id,
            name: pl.name,
            idx: pl.idx,
            colorIdx: pl.idx,
          })),
        });
      }
      return;
    }

    // Relay in-game actions to other players in the same room
    if (type === 'rematch') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      if (ws.playerId !== room.hostId) {
        send(ws, 'error', { message: 'เฉพาะเจ้าของห้องเท่านั้นที่เริ่มเกมใหม่ได้' });
        return;
      }
      broadcast(room, 'rematch', {});
      return;
    }

    if (type === 'game_over') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      if (ws.playerId !== room.hostId) return;
      for (const [clientWs] of room.players) {
        send(clientWs, 'game_over', {
          loserIdx: msg.loserIdx,
          pulls: msg.pulls,
          blocks: msg.blocks,
        });
      }
      return;
    }

    const relayTypes = ['pull_block', 'place_block', 'place_rotate', 'place_timeout', 'cancel_selection', 'move_result', 'block_sync'];
    if (relayTypes.includes(type)) {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      broadcast(room, type, msg, ws);
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JENGA server → http://localhost:${PORT}`);
  console.log(`WebSocket     → ws://localhost:${PORT}`);
  console.log(`เล่นข้ามเครือข่าย → npm run tunnel`);
  console.log(`Deploy 24ชม.ฟรี → bash scripts/setup-vps.sh (Oracle VPS)`);
  console.log(`Render ฟรี    → npm run render:keepalive <url>`);
});