// Client-only theming. The renderer's glow is additive ('lighter') over a dark
// base, so every theme here keeps a near-black background — we vary the exact
// dark tone, the grid dot, and the 8 accent hues. Colours never enter the sim
// or its hash (hash() mixes hueIdx, never the colour value), so this is safe to
// change at runtime with zero determinism impact.

import { HUES as DEFAULT_HUES, BG as DEFAULT_BG, GRID_DOT as DEFAULT_DOT } from '../../shared/constants';

export interface Theme {
  id: string;
  label: string;
  bg: string;
  gridDot: string;
  hues: readonly string[]; // 8 accents, indexed by player hueIdx
}

export const THEMES: Theme[] = [
  {
    id: 'graphite', label: 'Graphite',
    bg: DEFAULT_BG, gridDot: DEFAULT_DOT, hues: DEFAULT_HUES,
  },
  {
    id: 'deepsea', label: 'Deep Sea',
    bg: '#05080D', gridDot: '#122029',
    hues: ['#2BE0D6', '#39A0FF', '#B06BFF', '#6BE38A', '#FF6E9A', '#59C7FF', '#8FF0E0', '#E6D65A'],
  },
  {
    id: 'ember', label: 'Ember',
    bg: '#0C0705', gridDot: '#2A1810',
    hues: ['#FFB020', '#FF6B4A', '#FF3DA5', '#E8E33A', '#22E1E1', '#FF8C42', '#FFD37F', '#9BE31A'],
  },
  {
    id: 'signal', label: 'Signal',
    bg: '#060708', gridDot: '#161B1E',
    hues: ['#22E1E1', '#9BE31A', '#7FD8FF', '#E8E33A', '#2BE0D6', '#59C7FF', '#8FF0E0', '#B6FF7A'],
  },
];

// Live palette the renderer reads. Mutated in place so existing imports of the
// object stay valid — render.ts holds a reference to `activeTheme`.
export const activeTheme: Theme = { ...THEMES[0] };

export function applyTheme(id: string): void {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  Object.assign(activeTheme, t);
  const root = document.documentElement.style;
  root.setProperty('--bg', t.bg);
  root.setProperty('--dot', t.gridDot);
}
