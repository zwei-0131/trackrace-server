const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX = { race: 4, duel: 2 };
const lobbies = new Map(); // id -> { id, type, isPrivate, code, players: Map }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Highway race server running');
});
const wss = new WebSocketServer({ server });

function lobbyStatus(l) {
  if (l.players.size >= MAX[l.type]) return 'full';
  if (l.isPrivate) return 'private';
  if (l.players.size >= 2) return 'about to race';
  return 'open';
}

function lobbyList() {
  return [...lobbies.values()]
    .filter(l => !l.isPrivate)
    .map(l => ({ id: l.id, type: l.type, count: l.players.size, max: MAX[l.type], status: lobbyStatus(l) }));
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastLobbies() {
  const msg = { type: 'lobbies', lobbies: lobbyList() };
  wss.clients.forEach(ws => sendTo(ws, msg));
}

function sendToLobby(l, msg, except) {
  l.players.forEach((p, ws) => { if (ws !== except) sendTo(ws, msg); });
}

function leaveLobby(ws) {
  if (!ws.lobbyId) return;
  const l = lobbies.get(ws.lobbyId);
  ws.lobbyId = null;
  if (!l) return;
  l.players.delete(ws);
  sendToLobby(l, { type: 'players', count: l.players.size });
  if (l.players.size === 0) lobbies.delete(l.id);
  broadcastLobbies();
}

wss.on('connection', ws => {
  ws.lobbyId = null;
  sendTo(ws, { type: 'lobbies', lobbies: lobbyList() });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'create') {
      leaveLobby(ws);
      const id = Math.random().toString(36).slice(2, 8);
      const type = MAX[m.lobbyType] ? m.lobbyType : 'race';
      const isPrivate = !!m.isPrivate;
      const code = isPrivate ? String(Math.floor(1000 + Math.random() * 9000)) : null;
      const l = { id, type, isPrivate, code, players: new Map() };
      lobbies.set(id, l);
      l.players.set(ws, { name: m.name || 'Player', x: 0, z: 0, h: 0, speed: 0 });
      ws.lobbyId = id;
      sendTo(ws, { type: 'joined', id, code, lobbyType: type });
      broadcastLobbies();
    }

    else if (m.type === 'join') {
      const l = lobbies.get(m.id);
      if (!l) return sendTo(ws, { type: 'error', message: 'Lobby not found' });
      if (l.isPrivate && l.code !== String(m.code)) return sendTo(ws, { type: 'error', message: 'Wrong code' });
      if (l.players.size >= MAX[l.type]) return sendTo(ws, { type: 'error', message: 'Lobby is full' });
      leaveLobby(ws);
      l.players.set(ws, { name: m.name || 'Player', x: 0, z: 0, h: 0, speed: 0 });
      ws.lobbyId = l.id;
      sendTo(ws, { type: 'joined', id: l.id, code: l.code, lobbyType: l.type });
      sendToLobby(l, { type: 'players', count: l.players.size }, ws);
      broadcastLobbies();
    }

    else if (m.type === 'leave') {
      leaveLobby(ws);
      sendTo(ws, { type: 'left' });
    }

    else if (m.type === 'state') {
      const l = lobbies.get(ws.lobbyId);
      if (!l) return;
      const p = l.players.get(ws);
      Object.assign(p, { x: m.x, z: m.z, h: m.h, speed: m.speed, braking: !!m.braking });
      sendToLobby(l, { type: 'car', from: l.players.get(ws).name, x: m.x, z: m.z, h: m.h, speed: m.speed, braking: !!m.braking }, ws);
    }

    else if (m.type === 'list') {
      sendTo(ws, { type: 'lobbies', lobbies: lobbyList() });
    }
  });

  ws.on('close', () => { leaveLobby(ws); });
});

server.listen(PORT, () => console.log('Listening on ' + PORT));
