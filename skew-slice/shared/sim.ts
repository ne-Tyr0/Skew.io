// SKEW.IO — the deterministic simulation core.
//
// THIS FILE RUNS ON BOTH THE SERVER AND EVERY CLIENT, UNMODIFIED.
//
// Rules that keep it deterministic. Break one and you get drift bugs that only
// appear after four minutes with three players, which is the worst class of bug
// there is:
//   1. No floating point. Ever. Time is integer ticks, space is integer cells.
//   2. No Math.random(). Every non-derivable decision arrives as an event.
//   3. No Date.now(). The sim has no idea what time it is; it only has `tick`.
//   4. No iteration over unsorted Maps where order affects state.

import {
  BOARD_W, CELL_COUNT, TICKS_PER_BEAT, BEATS_PER_MEASURE, FIRE_EVERY_BEATS,
  NODE_CAPTURE, NODE_REFRESH, NODE_HOLD_INCOME, LIFE_MAX,
  SURGE_COST, SURGE_RADIUS, VIA_COST, JAMMER_COST, JAMMER_RADIUS,
} from './constants';
import { DX, DY, DIR_COST, cellIndex, cellX, cellY, inBounds } from './grid';

export const KIND_EMPTY = 0;
export const KIND_WIRE = 1;
export const KIND_SOURCE = 2;
export const KIND_NODE = 3;
export const KIND_JAMMER = 4;

export interface Pulse {
  id: number;
  owner: number; // player slot
  cell: number;  // cell it currently sits on
  dir: number;   // direction it is travelling toward
  acc: number;   // ticks accumulated toward the next cell
}

export interface PlayerState {
  slot: number;
  hueIdx: number;
  source: number;
  score: number;
  name: string;
}

// Every event carries the beat it applies on and a server-assigned sequence
// number. seq is the tiebreak: two commits landing on the same beat resolve in
// the order the server received them, identically on every machine.
export type SimEvent =
  | { t: 'join'; beat: number; seq: number; slot: number; hueIdx: number; source: number; name: string }
  | { t: 'leave'; beat: number; seq: number; slot: number }
  | { t: 'commit'; beat: number; seq: number; slot: number; start: number; dirs: number[] }
  | { t: 'node'; beat: number; seq: number; cell: number }
  | { t: 'nodeGone'; beat: number; seq: number; cell: number }
  // Attacks. Effect + score cost live here so every machine derives them
  // identically; the tier gate and cooldown are enforced server-side before the
  // event is ever emitted. Neither adds persistent state, so hash/snapshot/
  // checkpoint are unchanged — they mutate owner/out/kind/pulses/score, all
  // already covered.
  | { t: 'surge'; beat: number; seq: number; slot: number; cell: number }
  | { t: 'viaBlow'; beat: number; seq: number; slot: number; cell: number }
  | { t: 'jammer'; beat: number; seq: number; slot: number; cell: number }
  // Manual extra pulse from a player's source (the "Fire Now" verb).
  | { t: 'fireNow'; beat: number; seq: number; slot: number }
  // Round boundary: wipe the board, zero scores, keep players + re-seed nodes.
  | { t: 'reset'; beat: number; seq: number; nodes: number[] };

export interface SimSnapshot {
  tick: number;
  round: number;
  roundStartTick: number;
  nextPulseId: number;
  owner: number[]; // run-length encoded, see rle()
  out: number[];
  kind: number[];
  life: number[];
  pulses: Pulse[];
  players: PlayerState[];
  nodes: [number, number][]; // [cell, holderSlot]
  jammers: [number, number][]; // [cell, ownerSlot]
  pending: SimEvent[];
}

// --- tiny run-length codec for the 16k-cell arrays --------------------------
// A late-game board is ~90% empty, so RLE turns a 16KB array into a few hundred
// numbers. Only used for snapshots (join / resync), never per-tick.
export function rle(a: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let n = 1;
    while (i + n < a.length && a[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}
export function unrle(src: number[], dst: Uint8Array): void {
  let i = 0;
  for (let k = 0; k < src.length; k += 2) {
    const v = src[k], n = src[k + 1];
    dst.fill(v, i, i + n);
    i += n;
  }
}

/** Popcount of an 8-bit direction mask — how many ways a cell fans out. */
function bitCount(m: number): number {
  let n = 0;
  for (let d = 0; d < 8; d++) if (m & (1 << d)) n++;
  return n;
}

export class Sim {
  owner = new Uint8Array(CELL_COUNT); // 0 = unowned, else player slot
  out = new Uint8Array(CELL_COUNT);   // bitmask of outgoing directions
  kind = new Uint8Array(CELL_COUNT);
  life = new Uint8Array(CELL_COUNT);  // wire freshness; pulses refresh, decay clears

  pulses: Pulse[] = [];
  nextPulseId = 1;

  players = new Map<number, PlayerState>();
  nodes = new Map<number, number>(); // cell -> holder slot (0 = unheld)
  jammers = new Map<number, number>(); // cell -> owner slot (persistent EMI sources)

  round = 0;          // increments on each reset
  roundStartTick = 0; // tick the current round began — clients derive the timer from this

  tick = 0;
  /** Events waiting for their beat. beat -> events sorted by seq. */
  pending = new Map<number, SimEvent[]>();

  get beat(): number { return Math.floor(this.tick / TICKS_PER_BEAT); }

  schedule(ev: SimEvent): void {
    let list = this.pending.get(ev.beat);
    if (!list) { list = []; this.pending.set(ev.beat, list); }
    // insertion sort by seq — lists are tiny (usually 1)
    let i = list.length;
    while (i > 0 && list[i - 1].seq > ev.seq) i--;
    list.splice(i, 0, ev);
  }

  clearPending(): void { this.pending.clear(); }

  // ---- the tick ------------------------------------------------------------
  stepTick(): void {
    if (this.tick % TICKS_PER_BEAT === 0) {
      const b = this.tick / TICKS_PER_BEAT;
      const evs = this.pending.get(b);
      if (evs) {
        for (const e of evs) this.applyEvent(e);
        this.pending.delete(b);
      }
      if (b % FIRE_EVERY_BEATS === 0) this.emitSources();     // pulses: faster cadence
      if (b % BEATS_PER_MEASURE === 0) {                       // economy: per measure
        this.payHolders();
        this.jammerEmit();
        this.decayTraces();
      }
    }
    this.stepPulses();
    this.tick++;
  }

  advanceTo(targetTick: number, maxSteps = 4096): number {
    let n = 0;
    while (this.tick < targetTick && n < maxSteps) { this.stepTick(); n++; }
    return n;
  }

  // Every source fires on the measure boundary. The whole board is one clock
  // domain, which is why COINCIDE junctions will be meaningful later.
  private emitSources(): void {
    for (const slot of [...this.players.keys()].sort((a, b) => a - b)) this.fireSource(slot);
  }

  /** Spawn a pulse down each outgoing direction of one player's source. Shared by
   *  the automatic cadence and the manual "Fire Now" verb. */
  private fireSource(slot: number): void {
    const p = this.players.get(slot);
    if (!p) return;
    const m = this.out[p.source];
    for (let d = 0; d < 8; d++) {
      if (m & (1 << d)) this.pulses.push({ id: this.nextPulseId++, owner: slot, cell: p.source, dir: d, acc: 0 });
    }
  }

  private payHolders(): void {
    const cells = [...this.nodes.keys()].sort((a, b) => a - b);
    for (const c of cells) {
      const holder = this.nodes.get(c)!;
      if (holder === 0) continue;
      const pl = this.players.get(holder);
      if (pl) pl.score += NODE_HOLD_INCOME;
    }
  }

  /** Once per measure: age every wire. A passing pulse resets life to full, so
   *  only abandoned wire runs out and is cleared. Keeps the board from silting up. */
  private decayTraces(): void {
    for (let i = 0; i < CELL_COUNT; i++) {
      if (this.kind[i] !== KIND_WIRE) continue;
      const v = this.life[i] - 1;
      if (v <= 0) { this.owner[i] = 0; this.kind[i] = KIND_EMPTY; this.out[i] = 0; this.life[i] = 0; }
      else this.life[i] = v;
    }
  }

  private stepPulses(): void {
    const spawned: Pulse[] = [];
    let w = 0;
    for (let i = 0; i < this.pulses.length; i++) {
      const p = this.pulses[i];
      let alive = true;
      p.acc++;
      if (p.acc >= DIR_COST[p.dir]) {
        const nx = cellX(p.cell) + DX[p.dir];
        const ny = cellY(p.cell) + DY[p.dir];
        if (!inBounds(nx, ny)) {
          alive = false;
        } else {
          const c = cellIndex(nx, ny);
          if (this.kind[c] === KIND_NODE) {
            this.resolveNode(c, p.owner);
            alive = false;                       // demand nodes are terminal
          } else if (this.owner[c] !== p.owner) {
            alive = false;                       // ran off the end of the net
          } else {
            p.cell = c;
            p.acc = 0;
            this.life[c] = LIFE_MAX; // a live pulse keeps this wire fresh
            const m = this.out[c];
            if (m === 0) {
              alive = false;                     // dead-end stub
            } else {
              let first = -1;
              for (let d = 0; d < 8; d++) {
                if (!(m & (1 << d))) continue;
                if (first < 0) first = d;
                else spawned.push({ id: this.nextPulseId++, owner: p.owner, cell: c, dir: d, acc: 0 });
              }
              p.dir = first;
            }
          }
        }
      }
      if (alive) this.pulses[w++] = p;
    }
    this.pulses.length = w;
    for (const s of spawned) this.pulses.push(s);
  }

  private resolveNode(cell: number, slot: number): void {
    const holder = this.nodes.get(cell);
    if (holder === undefined) return;
    const pl = this.players.get(slot);
    if (!pl) return;
    if (holder !== slot) { this.nodes.set(cell, slot); pl.score += NODE_CAPTURE; }
    else pl.score += NODE_REFRESH;
  }

  // ---- events --------------------------------------------------------------
  applyEvent(ev: SimEvent): void {
    switch (ev.t) {
      case 'join': {
        this.players.set(ev.slot, {
          slot: ev.slot, hueIdx: ev.hueIdx, source: ev.source, score: 0, name: ev.name,
        });
        this.owner[ev.source] = ev.slot;
        this.kind[ev.source] = KIND_SOURCE;
        this.out[ev.source] = 0;
        break;
      }
      case 'leave': {
        for (let i = 0; i < CELL_COUNT; i++) {
          if (this.owner[i] === ev.slot) { this.owner[i] = 0; this.out[i] = 0; this.kind[i] = KIND_EMPTY; this.life[i] = 0; }
        }
        this.pulses = this.pulses.filter((p) => p.owner !== ev.slot);
        for (const [c, h] of this.nodes) if (h === ev.slot) this.nodes.set(c, 0);
        for (const [c, o] of this.jammers) if (o === ev.slot) this.jammers.delete(c);
        this.players.delete(ev.slot);
        break;
      }
      case 'commit': this.applyCommit(ev.slot, ev.start, ev.dirs); break;
      case 'node': this.nodes.set(ev.cell, 0); this.kind[ev.cell] = KIND_NODE; break;
      case 'nodeGone': this.nodes.delete(ev.cell); this.kind[ev.cell] = KIND_EMPTY; break;
      case 'surge': this.applySurge(ev.slot, ev.cell); break;
      case 'viaBlow': this.applyViaBlow(ev.slot, ev.cell); break;
      case 'jammer': this.applyJammer(ev.slot, ev.cell); break;
      case 'fireNow': this.fireSource(ev.slot); break;
      case 'reset': this.applyReset(ev.nodes); break;
    }
  }

  /**
   * Round reset. Wipes all wires, pulses, jammers, and scores, keeps every player
   * anchored on a re-marked source, and seeds a fresh set of nodes from the event
   * (so the seed is identical on every machine). Deterministic and idempotent.
   */
  private applyReset(nodeCells: number[]): void {
    this.owner.fill(0); this.out.fill(0); this.kind.fill(0); this.life.fill(0);
    this.pulses.length = 0;
    this.jammers.clear();
    for (const p of this.players.values()) {
      p.score = 0;
      this.owner[p.source] = p.slot;
      this.kind[p.source] = KIND_SOURCE;
      this.out[p.source] = 0;
    }
    this.nodes = new Map();
    for (const c of nodeCells) {
      if (this.owner[c] !== 0) continue; // never drop a node on a source
      this.nodes.set(c, 0);
      this.kind[c] = KIND_NODE;
    }
    this.round++;
    this.roundStartTick = this.tick;
  }

  /**
   * Place a Jammer — a stationary EMI source — on an empty cell. It is permanent:
   * it keeps disrupting every measure (jammerEmit) until a rival's Surge or Via
   * Blower clears its cell. Tolerant: no-op if the cell isn't empty or you can't
   * afford it, so a stale placement can never desync.
   */
  private applyJammer(slot: number, cell: number): void {
    const p = this.players.get(slot);
    if (!p) return;
    if (p.score < JAMMER_COST) return;
    if (this.owner[cell] !== 0 || this.kind[cell] !== KIND_EMPTY) return; // empty cell only
    p.score -= JAMMER_COST;
    this.owner[cell] = slot; this.kind[cell] = KIND_JAMMER; this.out[cell] = 0;
    this.jammers.set(cell, slot);
  }

  /** Once per measure, every Jammer clears hostile wire and fries hostile pulses
   *  within its radius. Iterated in cell order so it is identical everywhere. */
  private jammerEmit(): void {
    if (this.jammers.size === 0) return;
    for (const jc of [...this.jammers.keys()].sort((a, b) => a - b)) {
      const owner = this.jammers.get(jc)!;
      const cx = cellX(jc), cy = cellY(jc);
      for (let y = cy - JAMMER_RADIUS; y <= cy + JAMMER_RADIUS; y++) {
        for (let x = cx - JAMMER_RADIUS; x <= cx + JAMMER_RADIUS; x++) {
          if (!inBounds(x, y)) continue;
          const c = cellIndex(x, y);
          if (this.kind[c] === KIND_WIRE && this.owner[c] !== 0 && this.owner[c] !== owner) {
            this.owner[c] = 0; this.kind[c] = KIND_EMPTY; this.out[c] = 0; this.life[c] = 0;
          }
        }
      }
      this.pulses = this.pulses.filter((pu) =>
        pu.owner === owner ||
        Math.max(Math.abs(cellX(pu.cell) - cx), Math.abs(cellY(pu.cell) - cy)) > JAMMER_RADIUS);
    }
  }

  /**
   * Surge — induced crosstalk. Emanates from one of YOUR cells and corrupts
   * hostile WIRE in a small blast radius: those traces go dark and enemy pulses
   * caught in the blast are lost. Sources and nodes are immune. Tolerant like
   * applyCommit — if the preconditions fail at the commit beat it is a clean
   * no-op on every machine (no cost, no effect), never a divergence.
   */
  private applySurge(slot: number, cell: number): void {
    const p = this.players.get(slot);
    if (!p) return;
    if (this.owner[cell] !== slot) return;   // must originate from your own net
    if (p.score < SURGE_COST) return;        // can't afford → no-op
    p.score -= SURGE_COST;
    const cx = cellX(cell), cy = cellY(cell);
    for (let y = cy - SURGE_RADIUS; y <= cy + SURGE_RADIUS; y++) {
      for (let x = cx - SURGE_RADIUS; x <= cx + SURGE_RADIUS; x++) {
        if (!inBounds(x, y)) continue;
        const c = cellIndex(x, y);
        const k = this.kind[c];
        if ((k === KIND_WIRE || k === KIND_JAMMER) && this.owner[c] !== 0 && this.owner[c] !== slot) {
          this.owner[c] = 0; this.kind[c] = KIND_EMPTY; this.out[c] = 0; this.life[c] = 0;
          if (k === KIND_JAMMER) this.jammers.delete(c); // Surge also kills a rival jammer
        }
      }
    }
    // Hostile pulses inside the blast are fried too.
    this.pulses = this.pulses.filter((pu) => {
      if (pu.owner === slot) return true;
      return Math.max(Math.abs(cellX(pu.cell) - cx), Math.abs(cellY(pu.cell) - cy)) > SURGE_RADIUS;
    });
  }

  /**
   * Via Blower — a precise strike on one rival fan-out junction (a wire cell
   * with ≥2 outgoing directions). Collapses the split: the cell is removed and
   * any pulse on it is lost. No-op on anything that isn't a genuine enemy via.
   */
  private applyViaBlow(slot: number, cell: number): void {
    const p = this.players.get(slot);
    if (!p) return;
    if (p.score < VIA_COST) return;
    const target = this.owner[cell];
    if (target === 0 || target === slot) return;       // must be someone else's
    const isVia = this.kind[cell] === KIND_WIRE && bitCount(this.out[cell]) >= 2;
    const isJammer = this.kind[cell] === KIND_JAMMER;  // Via can also snipe a jammer
    if (!isVia && !isJammer) return;                   // source/node/plain wire are immune
    p.score -= VIA_COST;
    this.owner[cell] = 0; this.kind[cell] = KIND_EMPTY; this.out[cell] = 0; this.life[cell] = 0;
    if (isJammer) this.jammers.delete(cell);
    this.pulses = this.pulses.filter((pu) => pu.cell !== cell);
  }

  /**
   * Etch a path. Deliberately TOLERANT rather than all-or-nothing: it lays down
   * every legal cell and stops at the first illegal one. That is what makes
   * two players racing for the same corridor resolve gracefully — the loser's
   * trace simply stops one cell short instead of vanishing entirely.
   */
  applyCommit(slot: number, start: number, dirs: number[]): number {
    if (this.owner[start] !== slot) return 0;
    let cur = start;
    let laid = 0;
    for (const d of dirs) {
      const nx = cellX(cur) + DX[d];
      const ny = cellY(cur) + DY[d];
      if (!inBounds(nx, ny)) break;
      const c = cellIndex(nx, ny);
      if (this.kind[c] === KIND_NODE) {
        this.out[cur] |= (1 << d); // link into the node, terminal
        laid++;
        break;
      }
      if (this.owner[c] !== 0 || this.kind[c] !== KIND_EMPTY) break;
      this.owner[c] = slot;
      this.kind[c] = KIND_WIRE;
      this.life[c] = LIFE_MAX; // freshly etched wire starts at full life
      this.out[cur] |= (1 << d);
      cur = c;
      laid++;
    }
    return laid;
  }

  // ---- integrity -----------------------------------------------------------
  /** FNV-1a over everything that matters. Cheap enough to run once a second. */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= v & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
    };
    mix(this.tick);
    mix(this.round); mix(this.roundStartTick);
    for (let i = 0; i < CELL_COUNT; i++) {
      if (this.owner[i] === 0 && this.out[i] === 0 && this.kind[i] === 0) continue;
      mix(i); mix(this.owner[i] | (this.out[i] << 8) | (this.kind[i] << 16)); mix(this.life[i]);
    }
    const ps = [...this.pulses].sort((a, b) => a.id - b.id);
    for (const p of ps) { mix(p.id); mix(p.cell); mix(p.dir | (p.acc << 8) | (p.owner << 16)); }
    for (const slot of [...this.players.keys()].sort((a, b) => a - b)) {
      mix(slot); mix(this.players.get(slot)!.score);
    }
    for (const c of [...this.nodes.keys()].sort((a, b) => a - b)) { mix(c); mix(this.nodes.get(c)!); }
    for (const c of [...this.jammers.keys()].sort((a, b) => a - b)) { mix(c); mix(this.jammers.get(c)!); }
    return h >>> 0;
  }

  snapshot(): SimSnapshot {
    return {
      tick: this.tick,
      round: this.round,
      roundStartTick: this.roundStartTick,
      nextPulseId: this.nextPulseId,
      owner: rle(this.owner),
      out: rle(this.out),
      kind: rle(this.kind),
      life: rle(this.life),
      pulses: this.pulses.map((p) => ({ ...p })),
      players: [...this.players.values()].map((p) => ({ ...p })),
      nodes: [...this.nodes.entries()].sort((a, b) => a[0] - b[0]),
      jammers: [...this.jammers.entries()].sort((a, b) => a[0] - b[0]),
      pending: [...this.pending.values()].flat().sort((a, b) => a.seq - b.seq),
    };
  }

  restore(s: SimSnapshot): void {
    this.tick = s.tick;
    this.round = s.round ?? 0;
    this.roundStartTick = s.roundStartTick ?? 0;
    this.nextPulseId = s.nextPulseId;
    unrle(s.owner, this.owner);
    unrle(s.out, this.out);
    unrle(s.kind, this.kind);
    if (s.life) unrle(s.life, this.life); else this.life.fill(0);
    this.pulses = s.pulses.map((p) => ({ ...p }));
    this.players = new Map(s.players.map((p) => [p.slot, { ...p }]));
    this.nodes = new Map(s.nodes);
    this.jammers = new Map(s.jammers ?? []);
    this.pending.clear();
    for (const ev of s.pending) this.schedule(ev);
  }

  /** Fast in-memory checkpoint for client rollback (no RLE, no JSON). */
  checkpoint(): Checkpoint {
    return {
      tick: this.tick,
      round: this.round,
      roundStartTick: this.roundStartTick,
      nextPulseId: this.nextPulseId,
      owner: this.owner.slice(),
      out: this.out.slice(),
      kind: this.kind.slice(),
      life: this.life.slice(),
      pulses: this.pulses.map((p) => ({ ...p })),
      players: [...this.players.values()].map((p) => ({ ...p })),
      nodes: [...this.nodes.entries()],
      jammers: [...this.jammers.entries()],
    };
  }

  restoreCheckpoint(c: Checkpoint): void {
    this.tick = c.tick;
    this.round = c.round;
    this.roundStartTick = c.roundStartTick;
    this.nextPulseId = c.nextPulseId;
    this.owner.set(c.owner);
    this.out.set(c.out);
    this.kind.set(c.kind);
    this.life.set(c.life);
    this.pulses = c.pulses.map((p) => ({ ...p }));
    this.players = new Map(c.players.map((p) => [p.slot, { ...p }]));
    this.nodes = new Map(c.nodes);
    this.jammers = new Map(c.jammers);
    this.pending.clear();
  }
}

export interface Checkpoint {
  tick: number;
  round: number;
  roundStartTick: number;
  nextPulseId: number;
  owner: Uint8Array;
  out: Uint8Array;
  kind: Uint8Array;
  life: Uint8Array;
  pulses: Pulse[];
  players: PlayerState[];
  nodes: [number, number][];
  jammers: [number, number][];
}

export { BOARD_W };
