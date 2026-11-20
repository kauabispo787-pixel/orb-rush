// Orb Rush 3D - servidor: entrega o jogo e conecta os jogadores pelo codigo da sala.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
// Aceita o index.html dentro de /public ou solto ao lado do server.js
const candidatos = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
const arquivo = candidatos.find(f => fs.existsSync(f));
if (!arquivo) { console.error('index.html nao encontrado'); process.exit(1); }
const page = fs.readFileSync(arquivo);

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok v4'); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(page);
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: 16384 });
const rooms = new Map(); // nome da sala -> Map(id -> cliente)
// Quando dois jogadores digitam o codigo um do outro, os dois codigos viram a mesma sala.
const alias = new Map(); // codigo -> sala unificada
const root = n => { let i = 0; while (alias.has(n) && i++ < 50) n = alias.get(n); return n; };
let nextId = 1;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const num = (v, min, max) => { v = +v; return isFinite(v) ? Math.max(min, Math.min(max, v)) : 0; };

// Aceita so os campos esperados (ninguem consegue mandar lixo para os outros)
function clean(p) {
  if (!p || typeof p !== 'object') return null;
  const o = {
    x: num(p.x, -100, 100), z: num(p.z, -100, 100), r: num(p.r, -7, 7),
    s: Math.floor(num(p.s, 0, 999)), h: num(p.h, 0, 1),
    n: typeof p.n === 'string' ? p.n.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 12) : '',
    a: typeof p.a === 'string' && /^g\d{1,2}$/.test(p.a) ? p.a : ''
  };
  if (Array.isArray(p.e) && p.e.length === 2) o.e = [Math.floor(num(p.e[0], 0, 9)), Math.floor(num(p.e[1], 0, 1e9))];
  if (Array.isArray(p.g)) {
    o.g = p.g.slice(0, 6)
      .map(a => Array.isArray(a) ? [Math.floor(num(a[0], 0, 99)), Math.floor(num(a[1], 0, 1e6)), num(a[2], 0, 1e14)] : null)
      .filter(Boolean);
  }
  return o;
}

function broadcast(room, from, msg) {
  const r = rooms.get(room);
  if (!r) return;
  r.forEach(c => { if (c !== from) send(c, msg); });
}

// Move todo mundo de uma sala para outra (usado quando duas salas viram uma)
function moveAll(from, to) {
  const src = rooms.get(from);
  if (!src || src.size === 0) return;
  let dst = rooms.get(to);
  if (!dst) { dst = new Map(); rooms.set(to, dst); }
  [...src.values()].forEach(c => {
    src.delete(c.id);
    c.room = to;
    const others = [...dst.values()].filter(o => o.p).map(o => ({ id: o.id, p: o.p }));
    dst.set(c.id, c);
    send(c, { t: 'moved', room: to, peers: others });
  });
  if (src.size === 0) rooms.delete(from);
}

wss.on('connection', ws => {
  ws.id = nextId++;
  ws.room = null;
  ws.p = null;
  ws.alive = true;
  ws.tokens = 120;
  ws.t = Date.now();
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', data => {
    const now = Date.now();
    ws.tokens = Math.min(120, ws.tokens + (now - ws.t) / 1000 * 80); ws.t = now;
    if (ws.tokens < 1) return;
    ws.tokens--;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !ws.room) {
      let name = String(m.room || '').toLowerCase();
      if (!/^[a-z0-9-]{3,24}$/.test(name)) { ws.close(); return; }
      let own = String(m.own || '').toLowerCase();
      if (!/^[a-z0-9-]{3,24}$/.test(own)) own = '';
      if (own && name.startsWith('g-') && !own.startsWith('g-')) own = 'g-' + own;
      if (own && own === name) {
        alias.delete(own); // esta criando a propria sala
      } else if (own) {
        // quem digitou o codigo entra na sala do dono, e as duas salas viram uma
        const ro = root(own), rn = root(name);
        if (ro !== rn) {
          const src = rooms.get(ro), dst = rooms.get(rn);
          const total = (src ? src.size : 0) + (dst ? dst.size : 0);
          if (total <= MAX_PLAYERS) {
            if (alias.size > 2000) alias.clear();
            alias.set(ro, rn);
            if (src && src.size) moveAll(ro, rn);
          }
        }
      }
      name = root(name);
      let r = rooms.get(name);
      if (!r) { r = new Map(); rooms.set(name, r); }
      if (r.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      ws.room = name;
      send(ws, { t: 'welcome', id: ws.id, room: name, peers: [...r.values()].filter(c => c.p).map(c => ({ id: c.id, p: c.p })) });
      r.set(ws.id, ws);
    } else if (m.t === 'sig' && ws.room) {
      // sinalizacao do chat de voz: so repassa para outro jogador da mesma sala
      const r = rooms.get(ws.room);
      const to = r && r.get(+m.to);
      if (to && to !== ws && m.d && typeof m.d === 'object') send(to, { t: 'sig', from: ws.id, d: m.d });
    } else if (m.t === 'p' && ws.room) {
      const p = clean(m.p);
      if (!p) return;
      ws.p = p;
      broadcast(ws.room, ws, { t: 'p', id: ws.id, p });
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const r = rooms.get(ws.room);
    if (!r) return;
    r.delete(ws.id);
    if (r.size === 0) {
      const R = ws.room;
      rooms.delete(R);
      for (const k of [...alias.keys()]) if (root(k) === R) alias.delete(k);
    } else broadcast(ws.room, ws, { t: 'left', id: ws.id });
  });
});

// Derruba conexoes mortas
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Orb Rush 3D rodando na porta ' + PORT));
