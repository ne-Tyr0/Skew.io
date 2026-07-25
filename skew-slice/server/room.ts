import { performance } from 'node:perf_hooks';
import type { WebSocket } from 'ws';
import {
  BEAT_MS, TICKS_PER_BEAT, COMMIT_DELAY_BEATS, KEYFRAME_EVERY_BEATS,
  MAX_PATH_CELLS, INTENT_MIN_GAP_MS, MAX_NODES, HUES, BOARD_W, BOARD_H, BEATS_PER_MEASURE, CELL_COUNT,
  SURGE_MIN_SCORE, SURGE_COST, SURGE_COOLDOWN_MS,
  VIA_MIN_SCORE, VIA_COST, VIA_COOLDOWN_MS,
  JAMMER_MIN_SCORE, JAMMER_COST, JAMMER_COOLDOWN_MS,
  ROUND_BEATS,
} from '../shared/constants';
import { cellIndex, cellX, cellY, inBounds, DX, DY, dirFromDelta } from '../shared/grid';
import { Sim, KIND_EMPTY, KIND_NODE, type SimEvent } from '../shared/sim';
import { encode, type ClientMsg, type ServerMsg } from '../shared/protocol';

// Hard cap on a broadcast avatar. A 96x96 JPEG dataURL is a few KB; this bounds
// the worst case so one client can't blast large images at the whole room. Real
// content moderation is a known gap (see docs/ARCHITECTURE.md §8).
const AVATAR_MAX_CHARS = 24_000;

interface Client {
  ws: WebSocket;
  slot: number;
  name: string;
  lastIntentMs: number;
  lastSurgeMs: number;
  lastViaMs: number;
  lastJammerMs: number;
  lagMs: number;
  jitterMs: number;
  queue: { at: number; data: string }[]; // ordered artificial-latency queue
}

// A server-side AI player. It occupies a slot and a source exactly like a human,
// but has no socket — it reads the sim directly and produces the same intent/
// attack events a human would, through the same emit() path. Clients cannot tell
// the difference, and determinism is untouched (bots only emit events).
interface Bot {
  slot: number;
  name: string;
  source: number;
  lastActMs: number;
  actGapMs: number;
  lastAtkMs: number;
}

const BOT_NAMES = ['Ace', 'Nova', 'Echo', 'Rin', 'Kip', 'Vex', 'Juno', 'Pax', 'Zed', 'Mara', 'Odin', 'Wren', 'Bex', 'Cyra', 'Dax', 'Fable'];

// Server-only RNG. Never call this from shared/sim.ts — every roll must leave
// the server as an event so all clients derive the same world.
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Room {
  sim = new Sim();
  clients = new Map<number, Client>();
  seq = 1;
  originMs = performance.now();
  private nextBeatAt = this.originMs;
  private rng = mulberry32(0xC1A0DE);
  private freeSlots: number[] = [];
  private lastKeyframeBeat = -1;
  private roundEndsBeat = ROUND_BEATS; // beat the current round wraps up on
  // Cosmetic avatars, kept entirely off the deterministic sim. slot -> dataURL.
  private avatars = new Map<number, string>();
  // AI fill-players. Count comes from the BOTS env var (0 = off, keeps tests clean).
  private bots = new Map<number, Bot>();
  private botTarget = Math.max(0, Math.min(40, Number(process.env.BOTS ?? 0)));
  private botNameIdx = 0;

  constructor() {
    for (let s = 64; s >= 1; s--) this.freeSlots.push(s); // pop() gives 1,2,3...
    this.seedNodes(14);
    for (let i = 0; i < this.botTarget; i++) this.spawnBot();
    if (this.botTarget > 0) console.log(`[bots] spawned ${this.bots.size}`);
    setTimeout(() => this.loop(), 0);
  }

  // ---- the loop ------------------------------------------------------------
  // setInterval drifts and Node timers are only accurate to a few ms. So we
  // keep an absolute schedule (originMs + n*BEAT_MS) and catch up whenever the
  // event loop hands control back late. The tick counter is the only thing that
  // defines game time; wall clock just decides when we compute it.
  private loop = (): void => {
    const now = performance.now();
    let guard = 0;
    while (now >= this.nextBeatAt && guard < 32) {
      for (let i = 0; i < TICKS_PER_BEAT; i++) this.sim.stepTick();
      this.nextBeatAt += BEAT_MS;
      this.onBeat(this.sim.beat);
      guard++;
    }
    if (guard >= 32) {
      // Fell hopelessly behind (laptop slept, GC pause). Skip forward instead
      // of spiralling. Clients resync off the next keyframe hash mismatch.
      console.warn('[room] hard resync: dropped', Math.round((performance.now() - this.nextBeatAt) / BEAT_MS), 'beats');
      this.nextBeatAt = performance.now() + BEAT_MS;
    }
    this.botTick(performance.now());
    this.flushQueues(performance.now());
    const delay = this.nextBeatAt - performance.now();
    setTimeout(this.loop, Math.max(0, Math.min(delay, 8)));
  };

  private onBeat(beat: number): void {
    if (beat >= this.roundEndsBeat) {
      const resetBeat = beat + COMMIT_DELAY_BEATS;
      this.emit({ t: 'reset', beat: resetBeat, seq: 0, nodes: this.rollResetNodes() });
      this.roundEndsBeat = resetBeat + ROUND_BEATS;
      console.log(`[round] reset scheduled at beat ${resetBeat}; next round ends ${this.roundEndsBeat}`);
    }
    if (beat % BEATS_PER_MEASURE === 0 && this.sim.nodes.size < MAX_NODES) {
      const cell = this.findNodeSpot();
      if (cell >= 0) this.emit({ t: 'node', beat: beat + 1, seq: 0, cell });
    }
    if (beat % KEYFRAME_EVERY_BEATS === 0 && beat !== this.lastKeyframeBeat) {
      this.lastKeyframeBeat = beat;
      const scores: [number, number][] = [...this.sim.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((p) => [p.slot, p.score]);
      this.broadcast({ t: 'key', beat, hash: this.sim.hash(), scores });
    }
  }

  /** Stamp, apply locally, broadcast. The only way state ever changes. */
  private emit(ev: SimEvent): void {
    ev.seq = this.seq++;
    this.sim.schedule(ev);
    this.broadcast({ t: 'ev', ev });
  }

  // ---- connections ---------------------------------------------------------
  join(ws: WebSocket, name: string, lagMs: number, jitterMs: number): number | null {
    // A human takes priority over a bot: if the board is full but bots hold
    // slots, evict one to make room.
    if (this.freeSlots.length === 0) this.removeBot();
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    const source = this.findSpawn();
    if (source < 0) { this.freeSlots.push(slot); return null; }

    const c: Client = { ws, slot, name, lastIntentMs: 0, lastSurgeMs: 0, lastViaMs: 0, lastJammerMs: 0, lagMs, jitterMs, queue: [] };
    this.clients.set(slot, c);

    // The joiner's own arrival is an event like any other, so every client's
    // sim agrees on the exact beat this player appeared.
    this.emit({
      t: 'join', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0,
      slot, hueIdx: (slot - 1) % HUES.length, source, name,
    });

    this.send(c, {
      t: 'welcome', slot, hueIdx: (slot - 1) % HUES.length,
      originMs: this.originMs, serverMs: performance.now(),
      maxSeq: this.seq - 1, snap: this.sim.snapshot(),
    });
    // Bring the newcomer up to date on everyone's cosmetic avatar.
    for (const [s, data] of this.avatars) this.send(c, { t: 'avatar', slot: s, data });
    return slot;
  }

  leave(slot: number): void {
    if (!this.clients.has(slot)) return;
    this.clients.delete(slot);
    this.avatars.delete(slot);
    this.freeSlots.push(slot);
    this.emit({ t: 'leave', beat: this.sim.beat + 1, seq: 0, slot });
  }

  handle(slot: number, msg: ClientMsg): void {
    const c = this.clients.get(slot);
    if (!c) return;
    switch (msg.t) {
      case 'ping':
        this.send(c, { t: 'pong', c0: msg.c0, serverMs: performance.now() });
        break;
      case 'intent':
        this.handleIntent(c, msg.start, msg.dirs);
        break;
      case 'surge':
        this.handleSurge(c, msg.cell);
        break;
      case 'viaBlow':
        this.handleViaBlow(c, msg.cell);
        break;
      case 'jammer':
        this.handleJammer(c, msg.cell);
        break;
      case 'avatar':
        this.handleAvatar(c, msg.data);
        break;
      case 'resync':
        this.send(c, {
          t: 'snap', originMs: this.originMs, serverMs: performance.now(),
          maxSeq: this.seq - 1, snap: this.sim.snapshot(),
        });
        break;
    }
  }

  /**
   * Anti-cheat lives here and nowhere else. A client can only ever say "I would
   * like a trace from cell X in directions [...]". It cannot say where its
   * pulses are, when they arrive, or what it scored — all of that is derived.
   * So the entire cheat surface is: claiming cells you shouldn't get, and spam.
   */
  private handleIntent(c: Client, start: number, dirs: number[]): void {
    const now = performance.now();
    if (now - c.lastIntentMs < INTENT_MIN_GAP_MS) return;
    if (!Number.isInteger(start) || start < 0 || start >= BOARD_W * BOARD_H) return;
    if (!Array.isArray(dirs) || dirs.length === 0 || dirs.length > MAX_PATH_CELLS) return;
    for (const d of dirs) if (!Number.isInteger(d) || d < 0 || d > 7) return;
    // Ownership is checked against the state at the COMMIT beat, not now — but
    // a cheap pre-check here rejects the obvious garbage without burning a slot
    // in the event stream.
    if (this.sim.owner[start] !== c.slot) return;
    c.lastIntentMs = now;
    this.emit({
      t: 'commit', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0,
      slot: c.slot, start, dirs,
    });
  }

  /**
   * Attack gating. The tier (score) check and the wall-clock cooldown live HERE,
   * not in the sim — the sim has no clock and must stay a pure function of
   * events. The sim re-checks affordability + target validity at the commit beat
   * and no-ops otherwise, so a stale gate can never desync, only whiff.
   */
  private handleSurge(c: Client, cell: unknown): void {
    if (!this.validCell(cell)) return;
    const p = this.sim.players.get(c.slot);
    if (!p || p.score < SURGE_MIN_SCORE || p.score < SURGE_COST) return; // Tier 1 + ammo
    if (this.sim.owner[cell] !== c.slot) return;                          // must own the origin
    const now = performance.now();
    if (now - c.lastSurgeMs < SURGE_COOLDOWN_MS) return;
    c.lastSurgeMs = now;
    this.emit({ t: 'surge', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0, slot: c.slot, cell });
  }

  private handleViaBlow(c: Client, cell: unknown): void {
    if (!this.validCell(cell)) return;
    const p = this.sim.players.get(c.slot);
    if (!p || p.score < VIA_MIN_SCORE || p.score < VIA_COST) return;      // Tier 2 + ammo
    const owner = this.sim.owner[cell];
    if (owner === 0 || owner === c.slot) return;                          // must target a rival
    const now = performance.now();
    if (now - c.lastViaMs < VIA_COOLDOWN_MS) return;
    c.lastViaMs = now;
    this.emit({ t: 'viaBlow', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0, slot: c.slot, cell });
  }

  private handleJammer(c: Client, cell: unknown): void {
    if (!this.validCell(cell)) return;
    const p = this.sim.players.get(c.slot);
    if (!p || p.score < JAMMER_MIN_SCORE || p.score < JAMMER_COST) return; // Tier 3 + ammo
    if (this.sim.owner[cell] !== 0 || this.sim.kind[cell] !== KIND_EMPTY) return; // empty cell only
    const now = performance.now();
    if (now - c.lastJammerMs < JAMMER_COOLDOWN_MS) return;
    c.lastJammerMs = now;
    this.emit({ t: 'jammer', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0, slot: c.slot, cell });
  }

  private validCell(cell: unknown): cell is number {
    return Number.isInteger(cell) && (cell as number) >= 0 && (cell as number) < BOARD_W * BOARD_H;
  }

  // ---- bots ----------------------------------------------------------------
  // A bot is a slot + source with no socket. It reads the sim and emits the same
  // events a human would; clients replay them identically, so there is no
  // determinism cost. Trusted server-side input, so it skips the rate limits.

  private spawnBot(): void {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return;
    const source = this.findSpawn();
    if (source < 0) { this.freeSlots.push(slot); return; }
    const name = BOT_NAMES[this.botNameIdx++ % BOT_NAMES.length];
    this.bots.set(slot, { slot, name, source, lastActMs: 0, actGapMs: 500 + Math.random() * 700, lastAtkMs: 0 });
    this.emit({
      t: 'join', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0,
      slot, hueIdx: (slot - 1) % HUES.length, source, name,
    });
  }

  private removeBot(): void {
    const slot = this.bots.keys().next();
    if (slot.done) return;
    this.bots.delete(slot.value);
    this.freeSlots.push(slot.value);
    this.emit({ t: 'leave', beat: this.sim.beat + 1, seq: 0, slot: slot.value });
  }

  /** Give each bot a turn on its own stagger, so they don't all act in lockstep. */
  private botTick(now: number): void {
    if (this.bots.size === 0) return;
    for (const b of this.bots.values()) {
      if (now - b.lastActMs < b.actGapMs) continue;
      b.lastActMs = now;
      b.actGapMs = 500 + Math.random() * 900;
      this.botAct(b, now);
    }
  }

  private botAct(b: Bot, now: number): void {
    const sim = this.sim;
    const me = sim.players.get(b.slot);
    if (!me) return; // join not applied yet
    if (this.botMaybeAttack(b, me.score, now)) return;

    // Grow toward the nearest square we don't already hold. Anchor on a random
    // owned cell so the network branches instead of always extending the tip.
    const mine: number[] = [];
    for (let i = 0; i < CELL_COUNT; i++) if (sim.owner[i] === b.slot) mine.push(i);
    if (mine.length === 0) return;
    const start = mine[(Math.random() * mine.length) | 0];
    const target = this.nearestNode(start, b.slot);
    if (target < 0) return;
    const dirs = this.botRoute(start, target);
    if (dirs.length) this.commitFor(b.slot, start, dirs);
  }

  /** Bots use Blast (Surge) when they can afford it and sit next to a rival. */
  private botMaybeAttack(b: Bot, score: number, now: number): boolean {
    if (score < SURGE_MIN_SCORE || now - b.lastAtkMs < 5000) return false;
    if (Math.random() > 0.5) return false;
    const spot = this.botSurgeSpot(b.slot);
    if (spot < 0) return false;
    b.lastAtkMs = now;
    this.emit({ t: 'surge', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0, slot: b.slot, cell: spot });
    return true;
  }

  /** One of our cells that borders an enemy — the useful place to Blast from. */
  private botSurgeSpot(slot: number): number {
    for (let i = 0; i < CELL_COUNT; i++) {
      if (this.sim.owner[i] !== slot) continue;
      const x = cellX(i), y = cellY(i);
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inBounds(nx, ny)) continue;
        const o = this.sim.owner[cellIndex(nx, ny)];
        if (o !== 0 && o !== slot) return i;
      }
    }
    return -1;
  }

  private nearestNode(from: number, slot: number): number {
    const fx = cellX(from), fy = cellY(from);
    let best = -1, bestD = 1e9;
    for (const [cell, holder] of this.sim.nodes) {
      if (holder === slot) continue; // already ours — no gain
      const d = Math.max(Math.abs(cellX(cell) - fx), Math.abs(cellY(cell) - fy));
      if (d < bestD) { bestD = d; best = cell; }
    }
    return best;
  }

  /** Greedy 8-direction walk toward a target, stopping at the node or an obstacle. */
  private botRoute(start: number, target: number): number[] {
    const sim = this.sim;
    const dirs: number[] = [];
    let x = cellX(start), y = cellY(start);
    const tx = cellX(target), ty = cellY(target);
    for (let k = 0; k < 40 && (x !== tx || y !== ty); k++) {
      const d = dirFromDelta(Math.sign(tx - x), Math.sign(ty - y));
      if (d < 0) break;
      const nx = x + DX[d], ny = y + DY[d];
      if (!inBounds(nx, ny)) break;
      const c = cellIndex(nx, ny);
      if (sim.kind[c] === KIND_NODE) { dirs.push(d); break; } // link into the node
      if (sim.owner[c] !== 0 || sim.kind[c] !== KIND_EMPTY) break; // blocked
      dirs.push(d); x = nx; y = ny;
    }
    return dirs;
  }

  /** Trusted commit for bots — same ownership check as handleIntent, no rate limit. */
  private commitFor(slot: number, start: number, dirs: number[]): void {
    if (dirs.length === 0 || dirs.length > MAX_PATH_CELLS) return;
    if (this.sim.owner[start] !== slot) return;
    this.emit({ t: 'commit', beat: this.sim.beat + COMMIT_DELAY_BEATS, seq: 0, slot, start, dirs });
  }

  /**
   * Cosmetic only. Validated for shape + size, stored, and relayed to everyone —
   * never fed into the sim, so it cannot affect state, the hash, or snapshots.
   */
  private handleAvatar(c: Client, data: unknown): void {
    if (typeof data !== 'string') return;
    if (data.length > AVATAR_MAX_CHARS) return;
    if (!data.startsWith('data:image/')) return;
    this.avatars.set(c.slot, data);
    this.broadcast({ t: 'avatar', slot: c.slot, data });
  }

  // ---- world seeding -------------------------------------------------------
  private findSpawn(): number {
    let fallback = -1;
    for (let attempt = 0; attempt < 400; attempt++) {
      const x = 6 + Math.floor(this.rng() * (BOARD_W - 12));
      const y = 6 + Math.floor(this.rng() * (BOARD_H - 12));
      if (!this.areaClear(x, y, 5)) continue;
      const cell = cellIndex(x, y);
      if (fallback < 0) fallback = cell;
      // Prefer a spawn with a demand node within ~14 cells, so a new player's
      // first route is short and scores within a few seconds.
      if (this.nearestNodeDist(x, y) <= 14) return cell;
    }
    return fallback;
  }

  private nearestNodeDist(x: number, y: number): number {
    let best = 1e9;
    for (const cell of this.sim.nodes.keys()) {
      const d = Math.max(Math.abs(cellX(cell) - x), Math.abs(cellY(cell) - y));
      if (d < best) best = d;
    }
    return best;
  }

  private findNodeSpot(): number {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = 2 + Math.floor(this.rng() * (BOARD_W - 4));
      const y = 2 + Math.floor(this.rng() * (BOARD_H - 4));
      if (this.areaClear(x, y, 2)) return cellIndex(x, y);
    }
    return -1;
  }

  private areaClear(cx: number, cy: number, r: number): boolean {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!inBounds(x, y)) return false;
        const i = cellIndex(x, y);
        if (this.sim.owner[i] !== 0 || this.sim.kind[i] !== KIND_EMPTY) return false;
      }
    }
    return true;
  }

  /** Fresh node cells for a round reset — avoids landing on a player's source. */
  private rollResetNodes(): number[] {
    const sources = new Set([...this.sim.players.values()].map((p) => p.source));
    const out: number[] = [];
    for (let i = 0; i < 14; i++) {
      for (let a = 0; a < 200; a++) {
        const x = 2 + Math.floor(this.rng() * (BOARD_W - 4));
        const y = 2 + Math.floor(this.rng() * (BOARD_H - 4));
        const c = cellIndex(x, y);
        if (!sources.has(c) && !out.includes(c)) { out.push(c); break; }
      }
    }
    return out;
  }

  private seedNodes(n: number): void {
    for (let i = 0; i < n; i++) {
      const cell = this.findNodeSpot();
      if (cell >= 0) { const ev: SimEvent = { t: 'node', beat: 0, seq: this.seq++, cell }; this.sim.applyEvent(ev); }
    }
  }

  // ---- transport -----------------------------------------------------------
  private broadcast(m: ServerMsg): void {
    const data = encode(m);
    for (const c of this.clients.values()) this.raw(c, data);
  }
  private send(c: Client, m: ServerMsg): void { this.raw(c, encode(m)); }

  private raw(c: Client, data: string): void {
    if (c.lagMs <= 0 && c.jitterMs <= 0) { this.write(c, data); return; }
    // Ordered delay queue: FIFO like TCP, but late. Reordering would be a lie.
    const jitter = c.jitterMs > 0 ? Math.random() * c.jitterMs : 0;
    const at = Math.max(
      performance.now() + c.lagMs + jitter,
      c.queue.length ? c.queue[c.queue.length - 1].at : 0,
    );
    c.queue.push({ at, data });
  }

  private flushQueues(now: number): void {
    for (const c of this.clients.values()) {
      while (c.queue.length && c.queue[0].at <= now) this.write(c, c.queue.shift()!.data);
    }
  }

  private write(c: Client, data: string): void {
    if (c.ws.readyState === 1) c.ws.send(data);
  }

  get playerCount(): number { return this.clients.size; }
}

export { cellX, cellY };
