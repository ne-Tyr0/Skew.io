import {
  CELL_PX, MAX_PATH_CELLS,
  SURGE_MIN_SCORE, SURGE_COST, SURGE_COOLDOWN_MS,
  VIA_MIN_SCORE, VIA_COST, VIA_COOLDOWN_MS,
  JAMMER_MIN_SCORE, JAMMER_COST, JAMMER_COOLDOWN_MS,
} from '../../shared/constants';
import { cellIndex, cellX, cellY, inBounds, dirFromDelta, DX, DY, pathTicks } from '../../shared/grid';
import { KIND_EMPTY, KIND_NODE, type Sim } from '../../shared/sim';
import { settings } from './settings';
import { audio } from './audio';
import type { Net } from './net';
import type { Camera } from './render';

export interface Ghost {
  start: number;
  dirs: number[];
  cells: number[];
  bornMs: number;
  resolvedBeat: number | null;
}

/**
 * The drag is freehand but the trace is a lattice path. Every pointermove
 * extends greedily from the current head toward the cursor cell, one legal
 * 8-direction step at a time. Because moves fire every few pixels, the path
 * ends up tracing the actual shape of the player's gesture — which is what
 * makes serpentine detours drawable later.
 */
export class Input {
  drawing = false;
  start = -1;
  dirs: number[] = [];
  cells: number[] = [];
  hoverCell = -1;
  hasDrawn = false; // cleared until the first committed drag — gates the onboarding hint
  ghosts: Ghost[] = [];
  pan = { x: 0, y: 0 };
  private keys = new Set<string>();

  constructor(
    private canvas: HTMLCanvasElement,
    private net: Net,
    private cam: Camera,
  ) {
    canvas.addEventListener('pointerdown', this.down);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('keydown', (e) => this.onAttackKey(e));
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Attacks target the cell under the cursor. Space = Surge (must originate on a
   * cell you own); V = Via Blower (must target a rival cell). Client-side gates
   * mirror the server so we don't fire pointless packets; the server re-checks
   * everything authoritatively.
   */
  private onAttackKey(e: KeyboardEvent): void {
    if (e.repeat) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
    const net = this.net;
    const me = net.sim.players.get(net.slot);
    if (!me) return;
    const cell = this.hoverCell;
    if (cell < 0) return;

    if (e.code === 'Space') {
      if (net.sim.owner[cell] !== net.slot) return;                 // surge from your own net
      if (me.score < SURGE_MIN_SCORE || me.score < SURGE_COST) return;
      if (performance.now() - net.lastSurgeSentMs < SURGE_COOLDOWN_MS) return;
      e.preventDefault();
      net.sendSurge(cell);
      audio.buzz();
    } else if (e.key.toLowerCase() === 'v') {
      const o = net.sim.owner[cell];
      if (o === 0 || o === net.slot) return;                        // must be a rival cell
      if (me.score < VIA_MIN_SCORE || me.score < VIA_COST) return;
      if (performance.now() - net.lastViaSentMs < VIA_COOLDOWN_MS) return;
      e.preventDefault();
      net.sendViaBlow(cell);
      audio.buzz();
    } else if (e.key.toLowerCase() === 'g') {
      if (net.sim.owner[cell] !== 0 || net.sim.kind[cell] !== KIND_EMPTY) return; // empty cell only
      if (me.score < JAMMER_MIN_SCORE || me.score < JAMMER_COST) return;
      if (performance.now() - net.lastJammerSentMs < JAMMER_COOLDOWN_MS) return;
      e.preventDefault();
      net.sendJammer(cell);
      audio.buzz();
    }
  }

  private toCell(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const z = this.cam.zoom;
    const wx = this.cam.x + ((e.clientX - r.left) - r.width / 2) / z;
    const wy = this.cam.y + ((e.clientY - r.top) - r.height / 2) / z;
    return { x: Math.floor(wx / CELL_PX), y: Math.floor(wy / CELL_PX) };
  }

  // Wheel zooms toward the cursor: the world point under the pointer stays put.
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const z0 = this.cam.zoom;
    const z1 = Math.max(0.4, Math.min(2.6, z0 * Math.exp(-e.deltaY * 0.0015)));
    const mx = (e.clientX - r.left) - r.width / 2;
    const my = (e.clientY - r.top) - r.height / 2;
    this.cam.x += mx / z0 - mx / z1;
    this.cam.y += my / z0 - my / z1;
    this.cam.zoom = z1;
  };

  private down = (e: PointerEvent) => {
    const { x, y } = this.toCell(e);
    if (!inBounds(x, y)) return;
    const c = cellIndex(x, y);
    if (this.net.sim.owner[c] !== this.net.slot) return; // must anchor on your own net
    this.drawing = true;
    this.start = c;
    this.dirs = [];
    this.cells = [c];
    this.canvas.setPointerCapture(e.pointerId);
  };

  private move = (e: PointerEvent) => {
    const { x, y } = this.toCell(e);
    this.hoverCell = inBounds(x, y) ? cellIndex(x, y) : -1;
    if (!this.drawing) return;
    if (!inBounds(x, y)) return;
    this.extendTo(this.net.sim, x, y);
  };

  private up = () => {
    if (!this.drawing) return;
    this.drawing = false;
    if (this.dirs.length > 0) {
      this.hasDrawn = true;
      this.net.sendIntent(this.start, this.dirs);
      this.ghosts.push({
        start: this.start, dirs: [...this.dirs], cells: [...this.cells],
        bornMs: performance.now(), resolvedBeat: null,
      });
    }
    this.start = -1; this.dirs = []; this.cells = [];
  };

  private extendTo(sim: Sim, tx: number, ty: number): void {
    // Dragging back over the path you just drew rubs it out. This is the whole
    // undo affordance and it needs no button.
    const target = cellIndex(tx, ty);
    const back = this.cells.indexOf(target);
    if (back >= 0) { this.cells.length = back + 1; this.dirs.length = back; return; }

    let guard = 0;
    while (this.dirs.length < MAX_PATH_CELLS && guard++ < 256) {
      const cur = this.cells[this.cells.length - 1];
      const cx = cellX(cur), cy = cellY(cur);
      if (cx === tx && cy === ty) break;
      const d = dirFromDelta(Math.sign(tx - cx), Math.sign(ty - cy));
      if (d < 0) break;
      const nx = cx + DX[d], ny = cy + DY[d];
      if (!inBounds(nx, ny)) break;
      const c = cellIndex(nx, ny);
      if (sim.kind[c] === KIND_NODE) { this.dirs.push(d); this.cells.push(c); break; }
      if (sim.owner[c] !== 0 || sim.kind[c] !== KIND_EMPTY) break;
      if (this.cells.includes(c)) break;
      this.dirs.push(d); this.cells.push(c);
    }
  }

  /** Beat cost of the path being drawn — the number the player learns to read. */
  get pendingBeats(): number { return pathTicks(this.dirs) / 12; }

  updatePan(dt: number): void {
    // Pan speed is in screen pixels, so divide by zoom to keep it constant on
    // screen regardless of how far in/out you are.
    const s = settings.panSpeed * dt / this.cam.zoom;
    if (this.keys.has('a') || this.keys.has('arrowleft')) this.cam.x -= s;
    if (this.keys.has('d') || this.keys.has('arrowright')) this.cam.x += s;
    if (this.keys.has('w') || this.keys.has('arrowup')) this.cam.y -= s;
    if (this.keys.has('s') || this.keys.has('arrowdown')) this.cam.y += s;
    // keyboard zoom: '=' / '+' in, '-' out (around screen centre)
    const zk = (this.keys.has('=') || this.keys.has('+')) ? 1 : (this.keys.has('-') ? -1 : 0);
    if (zk) this.cam.zoom = Math.max(0.4, Math.min(2.6, this.cam.zoom * (1 + zk * 1.6 * dt)));
  }

  /** Drop ghosts once the real committed trace has taken their place. */
  reapGhosts(beat: number, now: number): void {
    this.ghosts = this.ghosts.filter((g) => {
      if (g.resolvedBeat !== null && beat >= g.resolvedBeat) return false;
      return now - g.bornMs < 3000;
    });
  }

  /** Called when our own commit event comes back from the server. */
  resolveOldestGhost(beat: number): void {
    const g = this.ghosts.find((x) => x.resolvedBeat === null);
    if (g) g.resolvedBeat = beat;
  }
}
