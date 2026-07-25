import type { SimEvent, SimSnapshot } from './sim';

// JSON for the slice. Every message goes through encode/decode so the whole
// thing can be swapped to a binary codec later without touching game code.
// At the measured event rate (~1 KB/s for the entire room) JSON costs nothing
// and being able to read the traffic in DevTools is worth a lot right now.

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'ping'; c0: number }
  | { t: 'intent'; start: number; dirs: number[] }
  | { t: 'surge'; cell: number }   // Tier 1 attack; server gates, sim applies
  | { t: 'viaBlow'; cell: number } // Tier 2 attack
  | { t: 'jammer'; cell: number }  // Tier 3 placeable
  | { t: 'fireNow' }               // launch an extra pulse from your source
  | { t: 'avatar'; data: string }  // cosmetic source glyph, relayed not simulated
  | { t: 'resync' };

export type ServerMsg =
  | { t: 'welcome'; slot: number; hueIdx: number; originMs: number; serverMs: number; maxSeq: number; snap: SimSnapshot }
  | { t: 'pong'; c0: number; serverMs: number }
  | { t: 'ev'; ev: SimEvent }
  | { t: 'key'; beat: number; hash: number; scores: [number, number][] }
  | { t: 'snap'; originMs: number; serverMs: number; maxSeq: number; snap: SimSnapshot }
  // Cosmetic avatar broadcast. Deliberately NOT a SimEvent: image data must never
  // enter the deterministic sim, its hash, or its snapshots.
  | { t: 'avatar'; slot: number; data: string }
  | { t: 'reject'; reason: string };

export const encode = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);
export const decode = <T>(s: string): T => JSON.parse(s) as T;
