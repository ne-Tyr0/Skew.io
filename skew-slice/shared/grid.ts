import { BOARD_W, BOARD_H } from './constants';

// Direction index 0..7, starting East, going counter-clockwise on screen
// (y grows downward, so "north" is -y).
export const DX = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY = [0, -1, -1, -1, 0, 1, 1, 1];

// Cost in ticks. 12 ticks = 1 beat. 17/12 = 1.4167, which is sqrt(2) to
// within 0.2%. Integer costs are the whole reason the sim is deterministic.
export const DIR_COST = [12, 17, 12, 17, 12, 17, 12, 17];

export const isDiagonal = (d: number) => (d & 1) === 1;

export const cellIndex = (x: number, y: number) => y * BOARD_W + x;
export const cellX = (i: number) => i % BOARD_W;
export const cellY = (i: number) => (i / BOARD_W) | 0;
export const inBounds = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < BOARD_W && y < BOARD_H;

/** Unit step delta -> direction index, or -1 if it is not a single legal step. */
export function dirFromDelta(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return -1;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return -1;
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}

/** Total tick cost of a direction list. */
export function pathTicks(dirs: number[]): number {
  let t = 0;
  for (const d of dirs) t += DIR_COST[d];
  return t;
}
