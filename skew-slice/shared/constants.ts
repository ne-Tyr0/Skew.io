// SKEW.IO — shared constants.
// Anything that both the server sim and the client sim need to agree on lives
// here. If a number exists in two places, the two sims WILL diverge eventually.

export const BOARD_W = 128;
export const BOARD_H = 128;
export const CELL_COUNT = BOARD_W * BOARD_H;
export const CELL_PX = 24;

// ---- Time base -------------------------------------------------------------
// A "beat" is the player-facing unit: one orthogonal cell = one beat.
// A "tick" is the simulation unit: 1/12 of a beat. Ticks exist so that a
// diagonal step can cost sqrt(2) beats without touching a float.
export const TICKS_PER_BEAT = 12;
export const BEAT_MS = 125; // 8 beats/sec => a measure is exactly 1 second
export const TICK_MS = BEAT_MS / TICKS_PER_BEAT; // ~10.4167ms (clock only, never sim)
export const BEATS_PER_MEASURE = 8;
export const TICKS_PER_MEASURE = TICKS_PER_BEAT * BEATS_PER_MEASURE;

// Sources fire on this cadence (was once per measure). 6 beats = 0.75s: livelier
// than the original 1s but calmer than 0.5s (which read as too frantic). Node hold
// income + jammers still tick per measure. Fire Now (F) covers impatience.
export const FIRE_EVERY_BEATS = 6;

// "Fire Now" (key F): launch an extra pulse from your source on demand. No score
// cost and no tier gate — it's a basic agency verb — just a short cooldown so it's
// a deliberate injection, not spam.
export const FIRE_NOW_COOLDOWN_MS = 2000;

// ---- Rounds ----------------------------------------------------------------
export const ROUND_BEATS = 1920;     // 240s @ 8 beats/sec = a 4-minute round
export const INTERMISSION_MS = 8000; // client-side winner banner after a reset

// ---- Netcode ---------------------------------------------------------------
// How far in the future the server schedules an accepted intent. This is the
// entire latency budget: every client must receive the event before this beat
// arrives on its own clock.
export const COMMIT_DELAY_BEATS = 3; // 375ms

export const KEYFRAME_EVERY_BEATS = 8; // hash + scores, 1/sec
export const SNAPSHOT_EVERY_BEATS = 8; // client rollback checkpoints
export const SNAPSHOT_RING = 6; // ~6s of rollback headroom

export const MAX_PATH_CELLS = 96; // per commit, anti-spam + bounded message size
export const INTENT_MIN_GAP_MS = 60; // per-player rate limit

// ---- Economy (slice values, tune freely) -----------------------------------
export const MAX_NODES = 28;
export const NODE_CAPTURE = 25;
export const NODE_REFRESH = 4;
export const NODE_HOLD_INCOME = 2; // per measure, to the holder

// ---- Trace decay -----------------------------------------------------------
// Every wire cell carries a "life" that a passing pulse refreshes to full and
// that ticks down once per measure; at 0 the cell is cleared. So an actively
// pulsed network never dies, but abandoned sprawl fades out in LIFE_MAX seconds.
// This is the maintenance pressure that keeps the late game from clogging.
export const LIFE_MAX = 15; // ~15s for an unused wire to vanish (decays 1/measure)

// ---- Progression & attacks -------------------------------------------------
// Tiers are a pure function of score: a brand-new player is defence-only, so
// they can't be farmed the instant they spawn. Attacks cost score (ammo, tied
// to the economy) AND sit behind a wall-clock cooldown enforced server-side.
// The MIN_SCORE gate and the COST are applied inside the deterministic sim; the
// COOLDOWN is wall-clock and lives only on the server (the sim has no clock).
export const SURGE_MIN_SCORE = 120;   // Tier 1 unlock
export const SURGE_COST = 15;
export const SURGE_COOLDOWN_MS = 6000;
export const SURGE_RADIUS = 2;        // Chebyshev blast radius (5×5 = 25 cells max)

export const VIA_MIN_SCORE = 400;     // Tier 2 unlock
export const VIA_COST = 40;
export const VIA_COOLDOWN_MS = 12000;

export const JAMMER_MIN_SCORE = 900;  // Tier 3 unlock
export const JAMMER_COST = 80;
export const JAMMER_COOLDOWN_MS = 20000;
export const JAMMER_RADIUS = 2;       // recurring EMI blast, once per measure
// The Jammer is permanent — it stays until a rival's Surge or Via Blower clears
// its cell — so it carries no lifetime here.

/** Tier index from a score: 0 = Etcher (defence), 1 = Surge, 2 = Via, 3 = Jammer. */
export function tierForScore(score: number): number {
  if (score >= JAMMER_MIN_SCORE) return 3;
  if (score >= VIA_MIN_SCORE) return 2;
  if (score >= SURGE_MIN_SCORE) return 1;
  return 0;
}

// ---- Palette ---------------------------------------------------------------
// cyan, amber, magenta, lime, coral, violet, ice, sulfur
export const HUES = [
  '#22E1E1',
  '#FFB020',
  '#FF3DA5',
  '#9BE31A',
  '#FF6B4A',
  '#9C6BFF',
  '#7FD8FF',
  '#E8E33A',
] as const;

export const BG = '#0B0A09';
export const GRID_DOT = '#242119';
