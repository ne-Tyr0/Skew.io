import {
  TICK_MS, TICKS_PER_BEAT, SNAPSHOT_EVERY_BEATS, SNAPSHOT_RING, KEYFRAME_EVERY_BEATS,
} from '../../shared/constants';
import { Sim, type Checkpoint, type SimEvent } from '../../shared/sim';
import { encode, decode, type ClientMsg, type ServerMsg } from '../../shared/protocol';

const SNAP_TICKS = SNAPSHOT_EVERY_BEATS * TICKS_PER_BEAT;
const KEY_TICKS = KEYFRAME_EVERY_BEATS * TICKS_PER_BEAT;

export class Net {
  sim = new Sim();
  ws: WebSocket | null = null;

  slot = 0;
  hueIdx = 0;
  connected = false;
  status: 'connecting' | 'live' | 'drift' | 'lost' = 'connecting';

  // clock
  originMs = 0;
  offset = 0;          // clientPerfNow + offset ≈ serverPerfNow
  rttMs = 0;
  private samples: { rtt: number; offset: number }[] = [];

  // integrity / recovery
  private maxSeq = 0;
  private log: SimEvent[] = [];
  private checkpoints: Checkpoint[] = [];
  private myHashes = new Map<number, number>();
  private pendingKeys = new Map<number, number>();
  private lastResyncMs = 0;
  rollbacks = 0;
  resyncs = 0;
  bytesIn = 0;
  msgsIn = 0;
  authoritativeScores = new Map<number, number>();
  // Cosmetic only, off the deterministic path: slot -> decoded avatar image.
  avatars = new Map<number, HTMLImageElement>();

  connect(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.ping();
      setInterval(() => this.ping(), 1500);
    };
    ws.onclose = () => { this.connected = false; this.status = 'lost'; };
    ws.onmessage = (e) => {
      const raw = String(e.data);
      this.bytesIn += raw.length; this.msgsIn++;
      this.onMessage(decode<ServerMsg>(raw));
    };
  }

  private send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encode(m));
  }

  private ping(): void { this.send({ t: 'ping', c0: performance.now() }); }

  // ---- clock ---------------------------------------------------------------
  // Classic min-RTT filter. The average is worse than the minimum here: a
  // sample that took 40ms each way is far more informative about the true
  // offset than one that sat in a buffer for 200ms.
  private onPong(c0: number, serverMs: number): void {
    const now = performance.now();
    const rtt = now - c0;
    const offset = serverMs + rtt / 2 - now;
    this.samples.push({ rtt, offset });
    if (this.samples.length > 8) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rttMs = rtt;
  }

  /** Where the server's playhead is, as far as we can tell. */
  targetTick(): number {
    return Math.floor((performance.now() + this.offset - this.originMs) / TICK_MS);
  }
  /** Fractional position inside the current tick, for smooth pulse motion. */
  tickFraction(): number {
    const x = (performance.now() + this.offset - this.originMs) / TICK_MS;
    return x - Math.floor(x);
  }

  // ---- messages ------------------------------------------------------------
  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.slot = m.slot;
        this.hueIdx = m.hueIdx;
        this.originMs = m.originMs;
        this.offset = m.serverMs - performance.now();
        this.hardLoad(m.snap, m.maxSeq);
        this.status = 'live';
        break;
      case 'snap':
        this.originMs = m.originMs;
        this.hardLoad(m.snap, m.maxSeq);
        this.status = 'live';
        break;
      case 'pong': this.onPong(m.c0, m.serverMs); break;
      case 'ev': this.onEvent(m.ev); break;
      case 'key':
        this.pendingKeys.set(m.beat, m.hash);
        this.authoritativeScores = new Map(m.scores);
        this.checkKeys();
        break;
      case 'avatar': this.setAvatar(m.slot, m.data); break;
      case 'reject': this.status = 'lost'; break;
    }
  }

  private setAvatar(slot: number, data: string): void {
    const img = new Image();
    img.src = data;
    this.avatars.set(slot, img);
  }

  /** Publish our own source-glyph avatar to the room (cosmetic side-channel). */
  sendAvatar(data: string): void { this.send({ t: 'avatar', data }); }

  private hardLoad(snap: Parameters<Sim['restore']>[0], maxSeq: number): void {
    this.sim.restore(snap);
    this.maxSeq = maxSeq;
    this.log = [...snap.pending];
    this.checkpoints = [];
    this.myHashes.clear();
    this.pendingKeys.clear();
    this.resyncs++;
  }

  private onEvent(ev: SimEvent): void {
    if (ev.seq <= this.maxSeq) return; // already folded into the snapshot
    this.maxSeq = ev.seq;
    this.log.push(ev);
    const evTick = ev.beat * TICKS_PER_BEAT;
    if (evTick <= this.sim.tick) this.rollbackTo(evTick); // arrived late
    else this.sim.schedule(ev);
  }

  /**
   * The payoff for determinism. A late event does not mean a desync — it means
   * we rewind to a checkpoint, re-insert it in the right place, and replay. A
   * full replay of 8 beats is ~96 ticks over a few hundred pulses: well under a
   * millisecond. If we have no checkpoint old enough, we ask for a snapshot.
   */
  private rollbackTo(evTick: number): void {
    let cp: Checkpoint | null = null;
    for (const c of this.checkpoints) if (c.tick <= evTick && (!cp || c.tick > cp.tick)) cp = c;
    if (!cp) { this.requestResync(); return; }

    const resume = this.sim.tick;
    this.sim.restoreCheckpoint(cp);
    this.checkpoints = this.checkpoints.filter((c) => c.tick <= cp!.tick);
    for (const [beat] of this.myHashes) if (beat * TICKS_PER_BEAT >= cp.tick) this.myHashes.delete(beat);
    for (const e of this.log) if (e.beat * TICKS_PER_BEAT >= cp.tick) this.sim.schedule(e);
    this.advanceTo(resume);
    this.rollbacks++;
  }

  private requestResync(): void {
    const now = performance.now();
    if (now - this.lastResyncMs < 2000) return;
    this.lastResyncMs = now;
    this.send({ t: 'resync' });
  }

  // ---- stepping ------------------------------------------------------------
  /** Pull the local sim up to the estimated server tick. Called once per frame. */
  pump(): void {
    if (!this.originMs) return;
    const target = this.targetTick();
    const behind = target - this.sim.tick;
    if (behind > 720) { this.requestResync(); return; } // >7.5s: backgrounded tab
    if (behind <= 0) return;
    this.advanceTo(target);
    this.checkKeys();
  }

  private advanceTo(target: number): void {
    while (this.sim.tick < target) {
      const t = this.sim.tick;
      if (t % SNAP_TICKS === 0) {
        this.checkpoints.push(this.sim.checkpoint());
        if (this.checkpoints.length > SNAPSHOT_RING) this.checkpoints.shift();
        const oldest = this.checkpoints[0].tick;
        this.log = this.log.filter((e) => e.beat * TICKS_PER_BEAT >= oldest);
      }
      if (t % KEY_TICKS === 0) this.myHashes.set(t / TICKS_PER_BEAT, this.sim.hash());
      this.sim.stepTick();
    }
  }

  /**
   * Divergence detection. Every second the server sends a hash of its entire
   * state. If ours differs, the two sims have parted ways and the honest move
   * is to say so loudly and resync — silent drift is how you lose a weekend.
   */
  private checkKeys(): void {
    for (const [beat, hash] of [...this.pendingKeys]) {
      const mine = this.myHashes.get(beat);
      if (mine === undefined) continue;
      this.pendingKeys.delete(beat);
      if (mine !== hash) { this.status = 'drift'; this.requestResync(); }
      else if (this.status === 'drift') this.status = 'live';
      for (const [b] of this.myHashes) if (b < beat - 32) this.myHashes.delete(b);
    }
  }

  sendIntent(start: number, dirs: number[]): void { this.send({ t: 'intent', start, dirs }); }

  // Attacks. We stamp the local send time purely so the HUD can show an
  // approximate cooldown sweep; the authoritative gate is the server's.
  lastSurgeSentMs = 0;
  lastViaSentMs = 0;
  lastJammerSentMs = 0;
  sendSurge(cell: number): void { this.lastSurgeSentMs = performance.now(); this.send({ t: 'surge', cell }); }
  sendViaBlow(cell: number): void { this.lastViaSentMs = performance.now(); this.send({ t: 'viaBlow', cell }); }
  sendJammer(cell: number): void { this.lastJammerSentMs = performance.now(); this.send({ t: 'jammer', cell }); }
}
