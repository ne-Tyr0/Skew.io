// Client-only persisted settings. None of this touches the deterministic sim —
// it is pure local preference (identity, audio, theme, camera, cosmetics).

const KEY = 'skew.settings.v1';

export interface Settings {
  name: string;
  masterMute: boolean;
  musicVol: number;   // 0..1
  sfxVol: number;     // 0..1
  theme: string;      // theme id, see theme.ts
  panSpeed: number;   // camera px/sec, base 900
  avatar: string | null; // dataURL of the source glyph, or null for the flat diamond
  seenTutorial: boolean;
}

const DEFAULTS: Settings = {
  name: '',
  masterMute: false,
  musicVol: 0.5,
  sfxVol: 0.7,
  theme: 'graphite',
  panSpeed: 900,
  avatar: null,
  seenTutorial: false,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();

export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode, ignore */ }
}

/** Mutate + persist in one call. */
export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  saveSettings();
}
