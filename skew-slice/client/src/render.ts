import { CELL_PX, BOARD_W, BOARD_H, TICKS_PER_BEAT, JAMMER_RADIUS } from '../../shared/constants';
import { DX, DY, DIR_COST, cellIndex, cellX, cellY } from '../../shared/grid';
import { KIND_NODE, KIND_SOURCE, type Sim } from '../../shared/sim';
import { activeTheme } from './theme';
import type { Net } from './net';
import type { Input } from './input';

export interface Camera { x: number; y: number; zoom: number }

/**
 * Two canvases, and the split is the whole trick.
 *
 *  base  — dots, traces, nodes, sources. Cleared and redrawn every frame, but
 *          only over the visible cell window (~3.5k cells), batched into one
 *          stroke() per hue. Cheap enough that dirty-tracking isn't worth it.
 *
 *  pulse — never cleared. Each frame it gets a translucent fill of the
 *          background colour, so whatever was drawn before decays. Then pulses
 *          are blitted with 'lighter'. That gives the hot core + trailing
 *          falloff from the art direction for free, and dodges shadowBlur,
 *          which is the single slowest thing in Canvas2D.
 */
export class Renderer {
  base: HTMLCanvasElement;
  pulse: HTMLCanvasElement;
  private bc: CanvasRenderingContext2D;
  private pc: CanvasRenderingContext2D;
  private sprites: HTMLCanvasElement[] = [];
  private spriteThemeId = '';
  private lastCam = { x: 0, y: 0 };
  w = 0; h = 0; dpr = 1;

  constructor(base: HTMLCanvasElement, pulse: HTMLCanvasElement) {
    this.base = base; this.pulse = pulse;
    this.bc = base.getContext('2d')!;
    this.pc = pulse.getContext('2d')!;
    this.buildSprites();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // Pulse glow sprites are baked per hue, so they must be rebuilt when the
  // active theme swaps its accent palette.
  private buildSprites(): void {
    this.sprites = activeTheme.hues.map((h) => makeSprite(h));
    this.spriteThemeId = activeTheme.id;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight;
    for (const c of [this.base, this.pulse]) {
      c.width = Math.floor(this.w * this.dpr);
      c.height = Math.floor(this.h * this.dpr);
      c.style.width = this.w + 'px';
      c.style.height = this.h + 'px';
    }
    this.bc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.pc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // pulse layer starts transparent so the base board shows through
    this.pc.clearRect(0, 0, this.w, this.h);
  }

  frame(sim: Sim, net: Net, input: Input, cam: Camera): void {
    if (this.spriteThemeId !== activeTheme.id) this.buildSprites();
    const moved = Math.abs(cam.x - this.lastCam.x) + Math.abs(cam.y - this.lastCam.y);
    this.lastCam = { ...cam };
    this.drawBase(sim, net, input, cam);
    this.drawPulses(sim, net, cam, moved);
  }

  private drawBase(sim: Sim, net: Net, input: Input, cam: Camera): void {
    const g = this.bc;
    const z = cam.zoom;
    g.fillStyle = activeTheme.bg;
    g.fillRect(0, 0, this.w, this.h);

    // Visible cell window in world space (widens as you zoom out).
    const halfW = this.w / 2 / z, halfH = this.h / 2 / z;
    const x0 = Math.max(0, Math.floor((cam.x - halfW) / CELL_PX) - 1);
    const y0 = Math.max(0, Math.floor((cam.y - halfH) / CELL_PX) - 1);
    const x1 = Math.min(BOARD_W - 1, Math.ceil((cam.x + halfW) / CELL_PX) + 1);
    const y1 = Math.min(BOARD_H - 1, Math.ceil((cam.y + halfH) / CELL_PX) + 1);

    // From here on we draw in WORLD pixels; the CTM handles pan + zoom, so ox/oy
    // are 0 and every position is just `cell * CELL_PX`.
    g.save();
    g.translate(this.w / 2, this.h / 2);
    g.scale(z, z);
    g.translate(-cam.x, -cam.y);
    const ox = 0, oy = 0;

    // the beat grid — this is also the ruler players measure time with
    g.fillStyle = activeTheme.gridDot;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        g.fillRect(ox + x * CELL_PX + CELL_PX / 2 - 1, oy + y * CELL_PX + CELL_PX / 2 - 1, 2, 2);
      }
    }

    // traces, batched by hue: 8 stroke() calls no matter how busy the board is
    const lanes: number[][] = activeTheme.hues.map(() => []);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = cellIndex(x, y);
        const m = sim.out[i];
        if (m === 0) continue;
        const pl = sim.players.get(sim.owner[i]);
        const lane = lanes[pl ? pl.hueIdx : 0];
        const sx = ox + x * CELL_PX + CELL_PX / 2;
        const sy = oy + y * CELL_PX + CELL_PX / 2;
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d))) continue;
          lane.push(sx, sy, sx + DX[d] * CELL_PX, sy + DY[d] * CELL_PX);
        }
      }
    }
    g.lineWidth = 2;
    g.lineCap = 'round';
    for (let h = 0; h < lanes.length; h++) {
      const lane = lanes[h];
      if (!lane.length) continue;
      g.strokeStyle = activeTheme.hues[h];
      g.globalAlpha = 0.3;
      g.beginPath();
      for (let k = 0; k < lane.length; k += 4) {
        g.moveTo(lane[k], lane[k + 1]);
        g.lineTo(lane[k + 2], lane[k + 3]);
      }
      g.stroke();
    }
    g.globalAlpha = 1;

    // demand nodes
    for (const [cell, holder] of sim.nodes) {
      const x = cellX(cell), y = cellY(cell);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const sx = ox + x * CELL_PX + CELL_PX / 2;
      const sy = oy + y * CELL_PX + CELL_PX / 2;
      const pl = holder ? sim.players.get(holder) : undefined;
      const col = pl ? activeTheme.hues[pl.hueIdx] : '#6E6A5E';
      g.strokeStyle = col;
      g.globalAlpha = holder ? 0.9 : 0.55;
      g.lineWidth = 2;
      g.strokeRect(sx - 7, sy - 7, 14, 14);
      g.fillStyle = col;              // the "1" glyph: one dot, one pulse
      g.globalAlpha = holder ? 0.9 : 0.4;
      g.fillRect(sx - 2, sy - 2, 4, 4);
    }
    g.globalAlpha = 1;

    // jammers — persistent EMI source: a pulsing hazard ring + its blast footprint
    for (const [cell, owner] of sim.jammers) {
      const x = cellX(cell), y = cellY(cell);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const sx = ox + x * CELL_PX + CELL_PX / 2;
      const sy = oy + y * CELL_PX + CELL_PX / 2;
      const pl = sim.players.get(owner);
      const col = pl ? activeTheme.hues[pl.hueIdx] : '#FF6B4A';
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
      const rad = (JAMMER_RADIUS + 0.5) * CELL_PX;
      g.save();
      g.strokeStyle = col;
      g.globalAlpha = 0.12 + 0.1 * pulse;
      g.lineWidth = 1;
      g.strokeRect(sx - rad, sy - rad, rad * 2, rad * 2);
      g.globalAlpha = 0.5 + 0.4 * pulse;
      g.lineWidth = 2;
      g.beginPath(); g.arc(sx, sy, 6 + 3 * pulse, 0, Math.PI * 2); g.stroke();
      g.fillStyle = col; g.globalAlpha = 0.95;
      g.fillRect(sx - 2, sy - 2, 4, 4);
      g.restore();
    }
    g.globalAlpha = 1;

    // sources — a broadcast avatar (cosmetic, off the deterministic channel)
    // replaces the flat diamond when one has arrived for that slot.
    for (const p of sim.players.values()) {
      const x = cellX(p.source), y = cellY(p.source);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const sx = ox + x * CELL_PX + CELL_PX / 2;
      const sy = oy + y * CELL_PX + CELL_PX / 2;
      const hue = activeTheme.hues[p.hueIdx];
      const img = net.avatars.get(p.slot);
      g.save();
      g.translate(sx, sy);
      g.globalAlpha = p.slot === net.slot ? 1 : 0.8;
      if (img && img.complete && img.naturalWidth) {
        g.save();
        g.rotate(Math.PI / 4);
        g.beginPath(); g.rect(-8, -8, 16, 16); g.clip(); // diamond-shaped window
        g.rotate(-Math.PI / 4);
        g.drawImage(img, -12, -12, 24, 24);              // upright inside the clip
        g.restore();
        g.rotate(Math.PI / 4);
        g.lineWidth = 2; g.strokeStyle = hue;
        g.strokeRect(-8, -8, 16, 16);
      } else {
        g.rotate(Math.PI / 4);
        g.fillStyle = hue;
        g.fillRect(-6, -6, 12, 12);
      }
      g.restore();
    }
    g.globalAlpha = 1;

    this.drawGhosts(g, input, net, ox, oy);
    this.drawHints(g, sim, net, input, ox, oy);
    g.restore();
  }

  /**
   * Onboarding + targeting affordances. New players don't know a drag must start
   * on a cell they own, so: pulse a "drag from here" ring on the source until the
   * first commit, and outline the hovered cell in your hue when it's a legal
   * anchor (dim grey when it isn't). Costs a handful of draw calls.
   */
  private drawHints(g: CanvasRenderingContext2D, sim: Sim, net: Net, input: Input, ox: number, oy: number): void {
    const me = sim.players.get(net.slot);
    if (!me) return;
    const now = performance.now();

    if (!input.hasDrawn && !input.drawing) {
      const sx = ox + cellX(me.source) * CELL_PX + CELL_PX / 2;
      const sy = oy + cellY(me.source) * CELL_PX + CELL_PX / 2;
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      const r = 14 + 6 * pulse;
      g.save();
      g.strokeStyle = activeTheme.hues[me.hueIdx];
      g.globalAlpha = 0.3 + 0.4 * pulse;
      g.lineWidth = 2;
      g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 0.9;
      g.fillStyle = activeTheme.hues[me.hueIdx];
      g.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      g.textAlign = 'center';
      g.fillText('drag from here', sx, sy - r - 7);
      g.restore();
    }

    if (!input.drawing && input.hoverCell >= 0) {
      const c = input.hoverCell;
      const sx = ox + cellX(c) * CELL_PX + CELL_PX / 2;
      const sy = oy + cellY(c) * CELL_PX + CELL_PX / 2;
      const mine = sim.owner[c] === net.slot;
      g.save();
      g.globalAlpha = mine ? 0.9 : 0.5;
      g.strokeStyle = mine ? activeTheme.hues[me.hueIdx] : '#6E6A5E';
      g.lineWidth = mine ? 2 : 1;
      g.strokeRect(sx - CELL_PX / 2 + 2, sy - CELL_PX / 2 + 2, CELL_PX - 4, CELL_PX - 4);
      g.restore();
    }
  }

  private drawGhosts(g: CanvasRenderingContext2D, input: Input, net: Net, ox: number, oy: number): void {
    const hue = activeTheme.hues[net.hueIdx];
    g.setLineDash([4, 5]);
    g.lineWidth = 2;
    g.strokeStyle = hue;

    const strokePath = (start: number, dirs: number[], alpha: number) => {
      g.globalAlpha = alpha;
      g.beginPath();
      let x = cellX(start), y = cellY(start);
      g.moveTo(ox + x * CELL_PX + CELL_PX / 2, oy + y * CELL_PX + CELL_PX / 2);
      for (const d of dirs) {
        x += DX[d]; y += DY[d];
        g.lineTo(ox + x * CELL_PX + CELL_PX / 2, oy + y * CELL_PX + CELL_PX / 2);
      }
      g.stroke();
    };

    // in-progress drag: instant, full brightness. This is the lie that makes
    // the 375ms commit horizon invisible.
    if (input.drawing && input.dirs.length) strokePath(input.start, input.dirs, 0.85);
    // sent, not yet committed: dimmer
    for (const gh of input.ghosts) strokePath(gh.start, gh.dirs, 0.4);
    g.setLineDash([]);
    g.globalAlpha = 1;

    // live beat cost readout at the head of the drag
    if (input.drawing && input.dirs.length) {
      let x = cellX(input.start), y = cellY(input.start);
      for (const d of input.dirs) { x += DX[d]; y += DY[d]; }
      g.fillStyle = hue;
      g.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      g.fillText(`${input.pendingBeats.toFixed(2)}β`, ox + x * CELL_PX + 12, oy + y * CELL_PX + 4);
    }
  }

  private drawPulses(sim: Sim, net: Net, cam: Camera, camMoved: number): void {
    const g = this.pc;
    const z = cam.zoom;

    // decay the previous frame instead of clearing it => free motion trails.
    // This layer sits ON TOP of the base canvas, so the decay must fade its own
    // alpha toward transparent (destination-out) — painting opaque BG here would
    // accumulate to a solid sheet and hide the board beneath. Done in device
    // space, BEFORE the world transform, so it always covers the whole canvas.
    g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = camMoved > 1.5 ? 0.9 : 0.34;
    g.fillStyle = '#000'; // colour is irrelevant under destination-out; only alpha matters
    g.fillRect(0, 0, this.w, this.h);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'lighter';

    g.save();
    g.translate(this.w / 2, this.h / 2);
    g.scale(z, z);
    g.translate(-cam.x, -cam.y);
    const halfW = this.w / 2 / z + 40, halfH = this.h / 2 / z + 40;
    const frac = net.tickFraction();
    for (const p of sim.pulses) {
      const pl = sim.players.get(p.owner);
      if (!pl) continue;
      const t = (p.acc + frac) / DIR_COST[p.dir];
      const wx = (cellX(p.cell) + 0.5 + DX[p.dir] * t) * CELL_PX;
      const wy = (cellY(p.cell) + 0.5 + DY[p.dir] * t) * CELL_PX;
      if (wx < cam.x - halfW || wx > cam.x + halfW || wy < cam.y - halfH || wy > cam.y + halfH) continue;
      const sp = this.sprites[pl.hueIdx];
      g.drawImage(sp, wx - 20, wy - 20, 40, 40); // world-sized; the CTM scales it
    }
    g.restore();
    g.globalCompositeOperation = 'source-over';
  }
}

function makeSprite(hue: string): HTMLCanvasElement {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.18, hue);
  grad.addColorStop(0.45, hexA(hue, 0.35));
  grad.addColorStop(1, hexA(hue, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export { TICKS_PER_BEAT, KIND_NODE, KIND_SOURCE };
