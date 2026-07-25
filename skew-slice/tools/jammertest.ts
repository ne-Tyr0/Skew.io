/**
 * Focused determinism test for the Jammer (Tier 3) persistent entity. The soak
 * can't reliably reach the 900 gate, so this drives the sim directly and asserts
 * the three things the change touches:
 *   1. jammerEmit clears hostile wire + is order-stable across two sims,
 *   2. a jammer survives snapshot()/restore() with an identical hash,
 *   3. a jammer survives checkpoint()/restoreCheckpoint() with an identical hash.
 *
 *   npx tsx tools/jammertest.ts
 */
import { Sim, KIND_WIRE, KIND_JAMMER } from '../shared/sim';
import { cellIndex } from '../shared/grid';
import { JAMMER_COST } from '../shared/constants';

let failed = false;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
};

function build(): Sim {
  const s = new Sim();
  s.applyEvent({ t: 'join', beat: 0, seq: 1, slot: 1, hueIdx: 0, source: cellIndex(20, 20), name: 'a' });
  s.applyEvent({ t: 'join', beat: 0, seq: 2, slot: 2, hueIdx: 1, source: cellIndex(60, 60), name: 'b' });
  s.players.get(1)!.score = 1000;
  s.players.get(2)!.score = 1000;
  // player 2 lays a little wire that player 1's jammer will sit next to
  for (const [x, y] of [[28, 20], [27, 20], [26, 20]] as const) {
    const c = cellIndex(x, y);
    s.owner[c] = 2; s.kind[c] = KIND_WIRE; s.out[c] = 1;
  }
  // two jammers (from different players) so jammerEmit has to iterate in order
  s.applyEvent({ t: 'jammer', beat: 0, seq: 3, slot: 1, cell: cellIndex(28, 21) });
  s.applyEvent({ t: 'jammer', beat: 0, seq: 4, slot: 2, cell: cellIndex(50, 50) });
  return s;
}

// --- 0. placement bookkeeping ---
const a = build();
check('placement: two jammers registered', a.jammers.size === 2);
check('placement: grid marks a jammer cell', a.kind[cellIndex(28, 21)] === KIND_JAMMER);
check('placement: cost deducted', a.players.get(1)!.score === 1000 - JAMMER_COST);

// --- 1. jammerEmit runs at the measure boundary (tick 0) and clears hostile wire ---
a.stepTick(); // crosses beat 0 → emitSources/payHolders/jammerEmit
check('jammerEmit: hostile wire in radius cleared', a.owner[cellIndex(28, 20)] === 0 && a.owner[cellIndex(26, 20)] === 0);
check('jammerEmit: the jammer itself survives', a.jammers.size === 2);

// --- lockstep: an independent sim built + stepped identically must match ---
const b = build();
b.stepTick();
let lockstep = true;
for (let i = 0; i < 400; i++) { a.stepTick(); b.stepTick(); if (a.hash() !== b.hash()) { lockstep = false; break; } }
check('lockstep: two sims agree on hash across 400 ticks (with jammers active)', lockstep);

// --- 2. snapshot round-trip preserves the jammer + hash ---
const snap = a.snapshot();
const c = new Sim();
c.restore(snap);
check('snapshot: jammers restored', c.jammers.size === a.jammers.size);
check('snapshot: hash identical after restore', c.hash() === a.hash());

// --- 3. checkpoint round-trip preserves the jammer + hash ---
const h0 = a.hash();
const cp = a.checkpoint();
a.applyEvent({ t: 'jammer', beat: 0, seq: 9, slot: 1, cell: cellIndex(10, 10) }); // perturb
check('checkpoint: perturbation changed the hash', a.hash() !== h0);
a.restoreCheckpoint(cp);
check('checkpoint: hash identical after restore', a.hash() === h0 && a.jammers.size === c.jammers.size);

console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS — jammer is deterministic across sims, snapshots, and checkpoints');
process.exit(failed ? 1 : 0);
