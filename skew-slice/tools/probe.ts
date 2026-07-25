/**
 * Timing probe. One client, one deliberate route from its source to the nearest
 * demand node, then: does the pulse arrive on exactly the beat the path length
 * says it should?
 *
 * This is the assertion the whole game rests on. If predicted !== actual, the
 * "cells are beats" contract is broken and nothing above it works.
 *
 *   npm run headless is the soak; this is the unit proof.
 *   npx tsx tools/probe.ts [lagMs]
 */
import { Net } from '../client/src/net';
import { TICKS_PER_BEAT, FIRE_EVERY_BEATS } from '../shared/constants';

const FIRE_TICKS = FIRE_EVERY_BEATS * TICKS_PER_BEAT; // sources fire on this cadence
import { DX, DY, cellIndex, cellX, cellY, inBounds, dirFromDelta, DIR_COST } from '../shared/grid';
import { KIND_EMPTY, KIND_NODE } from '../shared/sim';

const LAG = Number(process.argv[2] ?? 0);
const net = new Net();
net.connect(`ws://localhost:8787/ws?name=probe&lag=${LAG}&jitter=${LAG ? 40 : 0}`);
setInterval(() => net.pump(), 16);

let phase: 'wait' | 'routed' | 'done' = 'wait';
let predictedTick = -1;
let routeTicks = 0;
let targetNode = -1;

// Predict from the commit beat the SERVER actually chose, not from our own
// estimate of it at send time. Those differ by a beat or so depending on when
// the intent lands, and if that difference straddles a measure boundary the
// trace misses one firing and the prediction is off by a whole measure. The
// event tells us the truth; use it.
const schedule = net.sim.schedule.bind(net.sim);
net.sim.schedule = (ev) => {
  if (ev.t === 'commit' && ev.slot === net.slot && predictedTick < 0) {
    const commitTick = ev.beat * TICKS_PER_BEAT;
    const fireTick = Math.ceil(commitTick / FIRE_TICKS) * FIRE_TICKS;
    predictedTick = fireTick + routeTicks;
    console.log(`committed on beat ${ev.beat}; first source firing after that is tick ${fireTick}`);
    console.log(`predicted capture at tick ${predictedTick} (beat ${(predictedTick / TICKS_PER_BEAT).toFixed(2)})`);
  }
  schedule(ev);
};

setInterval(() => {
  const sim = net.sim;
  const me = sim.players.get(net.slot);
  if (!me) return;

  if (phase === 'wait') {
    // nearest unheld node to our source, by Chebyshev distance
    const sx = cellX(me.source), sy = cellY(me.source);
    let best = -1, bestD = 1e9;
    for (const [cell] of sim.nodes) {
      const d = Math.max(Math.abs(cellX(cell) - sx), Math.abs(cellY(cell) - sy));
      if (d < bestD) { bestD = d; best = cell; }
    }
    if (best < 0) return;

    const dirs: number[] = [];
    let x = sx, y = sy;
    const tx = cellX(best), ty = cellY(best);
    for (let k = 0; k < 90 && (x !== tx || y !== ty); k++) {
      const d = dirFromDelta(Math.sign(tx - x), Math.sign(ty - y));
      if (d < 0) break;
      const nx = x + DX[d], ny = y + DY[d];
      if (!inBounds(nx, ny)) break;
      const c = cellIndex(nx, ny);
      if (sim.kind[c] === KIND_NODE) { dirs.push(d); x = nx; y = ny; break; }
      if (sim.owner[c] !== 0 || sim.kind[c] !== KIND_EMPTY) break;
      dirs.push(d); x = nx; y = ny;
    }
    if (!dirs.length || cellIndex(x, y) !== best) return; // blocked, wait for another

    net.sendIntent(me.source, dirs);
    routeTicks = dirs.reduce((a, d) => a + DIR_COST[d], 0);
    targetNode = best;
    phase = 'routed';
    console.log(`route: ${dirs.length} cells, ${routeTicks} ticks = ${(routeTicks / TICKS_PER_BEAT).toFixed(2)} beats`);
    return;
  }

  if (phase === 'routed' && predictedTick > 0 && me.score > 0) {
    phase = 'done';
    const actual = sim.tick;
    const err = actual - predictedTick;
    console.log(`actual capture observed at tick ${actual} (poll granularity ±2 ticks)`);
    console.log(`error: ${err} ticks (${(err / TICKS_PER_BEAT).toFixed(2)} beats)`);
    console.log(`node holder: slot ${sim.nodes.get(targetNode)} · our score ${me.score} · server ${net.authoritativeScores.get(net.slot) ?? '—'}`);
    console.log(`sync=${net.status} rollbacks=${net.rollbacks} rtt=${Math.round(net.rttMs)}ms`);
    console.log(Math.abs(err) <= 3 ? 'RESULT: PASS — arrival matched path length' : 'RESULT: FAIL — timing contract broken');
    process.exit(Math.abs(err) <= 3 ? 0 : 1);
  }
}, 20);

setTimeout(() => { console.log(`RESULT: TIMEOUT in phase=${phase}`); process.exit(1); }, 30000);
