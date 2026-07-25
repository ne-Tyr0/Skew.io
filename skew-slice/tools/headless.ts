/**
 * Headless soak test.
 *
 * This imports the ACTUAL client netcode (client/src/net.ts) and runs N copies
 * of it against a live server in Node. Node 22 ships a global WebSocket, and
 * net.ts touches no DOM, so the thing under test is the real thing — not a
 * simplified stand-in that could pass while the browser build diverges.
 *
 *   npm run headless -- <clients> <seconds> <lagMs> <jitterMs>
 *   npm run headless -- 4 25 180 60
 *
 * PASS means: every client's independently-computed state hash matched the
 * server's, once per second, for the whole run — while committing traces.
 */
import { Net } from '../client/src/net';
import { CELL_COUNT, TICKS_PER_BEAT, SURGE_MIN_SCORE, VIA_MIN_SCORE, JAMMER_MIN_SCORE } from '../shared/constants';
import { DX, DY, cellIndex, cellX, cellY, inBounds } from '../shared/grid';
import { KIND_EMPTY, KIND_NODE, KIND_WIRE } from '../shared/sim';

const N = Number(process.argv[2] ?? 2);
const SECONDS = Number(process.argv[3] ?? 20);
const LAG = Number(process.argv[4] ?? 0);
const JITTER = Number(process.argv[5] ?? 0);
const HOST = process.env.SKEW_HOST ?? 'localhost:8787';

const bots = Array.from({ length: N }, (_, i) => {
  const n = new Net();
  n.connect(`ws://${HOST}/ws?name=bot${i}&lag=${LAG}&jitter=${JITTER}`);
  return { net: n, drift: 0, id: i };
});

// Draw a plausible trace: anchor on a random owned cell, walk in a mostly
// straight line, occasionally turning. Enough to exercise commits, fan-out
// (multiple branches off one cell) and node capture.
function botDraw(net: Net): void {
  const sim = net.sim;
  const mine: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) if (sim.owner[i] === net.slot) mine.push(i);
  if (!mine.length) return;
  const start = mine[Math.floor(Math.random() * mine.length)];
  let x = cellX(start), y = cellY(start);
  let d = Math.floor(Math.random() * 8);
  const dirs: number[] = [];
  for (let k = 0; k < 18; k++) {
    if (Math.random() < 0.25) d = (d + (Math.random() < 0.5 ? 1 : 7)) % 8;
    const nx = x + DX[d], ny = y + DY[d];
    if (!inBounds(nx, ny)) break;
    const c = cellIndex(nx, ny);
    if (sim.kind[c] === KIND_NODE) { dirs.push(d); break; }
    if (sim.owner[c] !== 0 || sim.kind[c] !== KIND_EMPTY) break;
    dirs.push(d); x = nx; y = ny;
  }
  if (dirs.length) net.sendIntent(start, dirs);
}

// Fire attacks once eligible, so the soak's hash-agreement check actually
// exercises the surge/viaBlow events. If these applied non-deterministically on
// any client the next keyframe hash would mismatch and the run would FAIL.
function botAttack(net: Net): void {
  const sim = net.sim;
  const me = sim.players.get(net.slot);
  if (!me) return;
  if (me.score >= SURGE_MIN_SCORE && Math.random() < 0.5) {
    const mine: number[] = [];
    for (let i = 0; i < CELL_COUNT; i++) if (sim.owner[i] === net.slot) mine.push(i);
    if (mine.length) net.sendSurge(mine[Math.floor(Math.random() * mine.length)]);
  }
  if (me.score >= VIA_MIN_SCORE && Math.random() < 0.5) {
    for (let tries = 0; tries < 40; tries++) {
      const c = Math.floor(Math.random() * CELL_COUNT);
      const o = sim.owner[c];
      let bits = 0; for (let d = 0; d < 8; d++) if (sim.out[c] & (1 << d)) bits++;
      if (o !== 0 && o !== net.slot && sim.kind[c] === KIND_WIRE && bits >= 2) { net.sendViaBlow(c); break; }
    }
  }
  if (me.score >= JAMMER_MIN_SCORE && Math.random() < 0.3) {
    for (let tries = 0; tries < 40; tries++) {
      const c = Math.floor(Math.random() * CELL_COUNT);
      if (sim.owner[c] === 0 && sim.kind[c] === KIND_EMPTY) { net.sendJammer(c); break; }
    }
  }
}

const pump = setInterval(() => { for (const b of bots) b.net.pump(); }, 16);
const draw = setInterval(() => { for (const b of bots) if (Math.random() < 0.7) botDraw(b.net); }, 900);
const atk = setInterval(() => { for (const b of bots) botAttack(b.net); }, 700);
const watch = setInterval(() => {
  for (const b of bots) if (b.net.status === 'drift') b.drift++;
}, 100);

setTimeout(() => {
  clearInterval(pump); clearInterval(draw); clearInterval(atk); clearInterval(watch);
  console.log('\n─── SKEW.IO headless report ───');
  console.log(`clients=${N}  duration=${SECONDS}s  injected lag=${LAG}±${JITTER}ms\n`);
  let fail = false;
  for (const b of bots) {
    const sim = b.net.sim;
    const me = sim.players.get(b.net.slot);
    const authoritative = b.net.authoritativeScores.get(b.net.slot);
    const derived = me?.score ?? 0;
    // Score equality is already covered by the hash (scores are hashed), so the
    // pass condition is hash agreement. The printed server score is from the
    // last keyframe and is therefore ~1s + latency stale by design.
    const ok = b.drift === 0 && b.net.status === 'live';
    if (!ok) fail = true;
    console.log(
      `bot${b.id} slot=${b.net.slot} tick=${sim.tick} beat=${sim.beat} ` +
      `rtt=${Math.round(b.net.rttMs)}ms score=${derived} (last keyframe ${authoritative ?? '—'}) ` +
      `rollbacks=${b.net.rollbacks} resyncs=${b.net.resyncs} drift=${b.drift} ${ok ? 'OK' : 'FAIL'}\n` +
      `        downstream: ${(b.net.bytesIn / 1024).toFixed(1)} KB total, ${(b.net.bytesIn / SECONDS / 1024).toFixed(2)} KB/s, ${(b.net.msgsIn / SECONDS).toFixed(1)} msg/s`,
    );
  }
  const ticks = bots.map((b) => b.net.sim.tick);
  console.log(`\ntick spread across clients: ${Math.max(...ticks) - Math.min(...ticks)} ticks ` +
    `(${((Math.max(...ticks) - Math.min(...ticks)) / TICKS_PER_BEAT).toFixed(2)} beats)`);
  console.log(fail ? '\nRESULT: FAIL — a client diverged from the server hash' : '\nRESULT: PASS — every client hash matched the server, every second');
  process.exit(fail ? 1 : 0);
}, SECONDS * 1000);
