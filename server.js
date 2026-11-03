// TrackRace lobby server: duels (2 players, same car) and races (up to 4 players).
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

const MAX_PLAYERS = { duel: 2, race: 4 };
const COUNTDOWN_MS = 10000;
const lobbies = new Map(); // id -> lobby
const codes = new Map();   // private code -> lobby id
let nextId = 1;

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (codes.has(c)); // never reuse a code while its lobby is active
  return c;
}

function publicList() {
  const out = [];
  for (const l of lobbies.values()) {
    if (l.private) continue;
    out.push(summary(l));
  }
  return out;
}

function summary(l) {
  return {
    id: l.id, type: l.type, host: l.players[0]?.name || '', laps: l.laps, car: l.car,
    count: l.players.length, max: MAX_PLAYERS[l.type], isPrivate: l.private,
    startsAt: l.startsAt || null, started: !!l.started,
  };
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(l, msg) { l.players.forEach(p => send(p.ws, msg)); }
function lobbyState(l) {
  return { type: 'lobby', lobby: summary(l), code: l.private ? l.code : null,
    players: l.players.map(p => ({ id: p.id, name: p.name })) };
}

function startCountdown(l) {
  if (l.startsAt) return;
  l.startsAt = Date.now() + COUNTDOWN_MS;
  broadcast(l, { type: 'countdown', startsAt: l.startsAt });
  l.timer = setTimeout(() => {
    l.started = true;
    broadcast(l, { type: 'start' });
    setTimeout(() => removeLobby(l.id), 1000); // lobby closes once race has begun
  }, COUNTDOWN_MS);
  pushLists();
}

function removeLobby(id) {
  const l = lobbies.get(id);
  if (!l) return;
  clearTimeout(l.timer);
  if (l.code) codes.delete(l.code);
  lobbies.delete(id);
  pushLists();
}

function pushLists() {
  for (const ws of wss.clients) {
    if (ws.inLobby) continue;
    send(ws, { type: 'lists', lobbies: publicList() });
  }
}

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).slice(2);
  ws.inLobby = null;
  send(ws, { type: 'lists', lobbies: publicList() });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'list') {
      send(ws, { type: 'lists', lobbies: publicList() });
    }

    if (m.type === 'create') {
      if (ws.inLobby) return;
      const type = m.kind === 'duel' ? 'duel' : 'race';
      const laps = Math.min(10, Math.max(1, parseInt(m.laps) || 1));
      const isPrivate = !!m.private;
      const id = String(nextId++);
      const l = { id, type, laps, car: m.car || 0, private: isPrivate, code: null,
        players: [], startsAt: null, started: false, timer: null };
      if (isPrivate) { l.code = makeCode(); codes.set(l.code, id); }
      lobbies.set(id, l);
      join(ws, l, m.name);
    }

    if (m.type === 'join') {
      if (ws.inLobby) return;
      let l = null;
      if (m.code) {
        const id = codes.get(String(m.code).toUpperCase());
        l = id && lobbies.get(id);
      } else {
        l = lobbies.get(String(m.id));
        if (l && l.private) l = null; // private lobbies need the code
      }
      if (!l) return send(ws, { type: 'error', message: 'Lobby not found' });
      if (l.started || l.players.length >= MAX_PLAYERS[l.type]) {
        return send(ws, { type: 'error', message: 'Lobby is full or already racing' });
      }
      join(ws, l, m.name);
    }

    if (m.type === 'leave') leave(ws);

    // Host starts the 10 second countdown for a race (duels start automatically when full).
    if (m.type === 'start' && ws.inLobby) {
      const l = lobbies.get(ws.inLobby);
      if (l && l.type === 'race' && l.players[0]?.ws === ws && l.players.length >= 1) startCountdown(l);
    }

    if (m.type === 'state' && ws.inLobby) {
      const l = lobbies.get(ws.inLobby);
      if (!l || !l.started) return;
      const p = l.players.find(x => x.ws === ws);
      if (!p) return;
      p.state = m.s;
      l.players.forEach(o => { if (o !== p) send(o.ws, { type: 'peer', id: p.id, s: m.s }); });
    }
  });

  ws.on('close', () => leave(ws));
});

function join(ws, l, name) {
  const p = { ws, id: ws.id, name: String(name || 'Player').slice(0, 16) };
  l.players.push(p);
  ws.inLobby = l.id;
  broadcast(l, lobbyState(l));
  if (l.players.length === MAX_PLAYERS[l.type] && l.type === 'duel') startCountdown(l);
  pushLists();
}

function leave(ws) {
  if (!ws.inLobby) return;
  const l = lobbies.get(ws.inLobby);
  ws.inLobby = null;
  if (!l) return;
  l.players = l.players.filter(p => p.ws !== ws);
  if (l.players.length === 0 || (!l.started && l.players.length === 0)) return removeLobby(l.id);
  broadcast(l, lobbyState(l));
  pushLists();
}

wss.on('listening', () => console.log('TrackRace server on ' + PORT));
    
