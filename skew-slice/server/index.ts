import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room';
import { decode, type ClientMsg } from '../shared/protocol';

const PORT = Number(process.env.PORT ?? 8787);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist/client');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  if (!fs.existsSync(DIST)) { res.writeHead(404).end('run `npm run dev` (vite serves the client on :5173)'); return; }
  const url = (req.url ?? '/').split('?')[0];
  let file = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!file.startsWith(DIST) || !fs.existsSync(file)) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const room = new Room();
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Dev knobs: ws://host/ws?lag=200&jitter=60 — this is how you actually test
  // whether the commit horizon is doing its job.
  const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
  const lag = Math.max(0, Math.min(2000, Number(q.get('lag') ?? 0)));
  const jitter = Math.max(0, Math.min(1000, Number(q.get('jitter') ?? 0)));
  const name = (q.get('name') ?? 'etcher').slice(0, 16);

  const slot = room.join(ws, name, lag, jitter);
  if (slot === null) { ws.send(JSON.stringify({ t: 'reject', reason: 'board full' })); ws.close(); return; }
  console.log(`[join] slot=${slot} name=${name} lag=${lag}±${jitter} players=${room.playerCount}`);

  // Inbound half of the artificial latency. It has to be symmetric: if only the
  // downstream is delayed, the client's rtt/2 offset estimate is biased by
  // exactly the amount of the delay and silently cancels it out, and the test
  // passes for the wrong reason. Ask me how I know.
  let inboundReadyAt = 0;
  ws.on('message', (buf) => {
    let msg: ClientMsg;
    try { msg = decode<ClientMsg>(String(buf)); } catch { return; }
    if (lag <= 0 && jitter <= 0) { room.handle(slot, msg); return; }
    const now = Date.now();
    const at = Math.max(now + lag + Math.random() * jitter, inboundReadyAt);
    inboundReadyAt = at;
    setTimeout(() => room.handle(slot, msg), at - now);
  });
  ws.on('close', () => { room.leave(slot); console.log(`[left] slot=${slot} players=${room.playerCount}`); });
  ws.on('error', () => { /* close handler cleans up */ });
});

server.listen(PORT, () => console.log(`SKEW.IO server on :${PORT}  (ws://localhost:${PORT}/ws)`));
