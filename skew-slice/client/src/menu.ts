// Pre-game shell: menu, settings, tutorial, avatar crop. All client-only and
// backed by localStorage (see settings.ts). The one job that reaches the game is
// onPlay(name), which lets main.ts open the socket with the chosen callsign.

import { settings, updateSettings } from './settings';
import { THEMES, applyTheme } from './theme';
import type { Net } from './net';

export interface MenuHooks {
  onPlay: (name: string) => void;
  net: Net;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const AVATAR_PX = 96; // square glyph resolution; JPEG-encoded, well under the wire cap

export function initMenu(hooks: MenuHooks): void {
  const menu = $('menu');
  const settingsPanel = $('settings');
  const tutorial = $('tutorial');

  const show = (el: HTMLElement) => el.removeAttribute('hidden');
  const hide = (el: HTMLElement) => el.setAttribute('hidden', '');

  // ---- theme select ----
  const themeSel = $<HTMLSelectElement>('setTheme');
  for (const t of THEMES) {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.label;
    themeSel.appendChild(opt);
  }
  applyTheme(settings.theme);

  // ---- callsign ----
  const nameInput = $<HTMLInputElement>('nameInput');
  nameInput.value = settings.name;

  // ---- settings controls, bound to the live settings object ----
  const mute = $<HTMLInputElement>('setMute');
  const music = $<HTMLInputElement>('setMusic');
  const musicNum = $('setMusicNum');
  const sfx = $<HTMLInputElement>('setSfx');
  const sfxNum = $('setSfxNum');
  const pan = $<HTMLInputElement>('setPan');
  const panNum = $('setPanNum');

  mute.checked = settings.masterMute;
  music.value = String(Math.round(settings.musicVol * 100));
  sfx.value = String(Math.round(settings.sfxVol * 100));
  pan.value = String(settings.panSpeed);
  themeSel.value = settings.theme;
  musicNum.textContent = music.value;
  sfxNum.textContent = sfx.value;
  panNum.textContent = pan.value;

  mute.addEventListener('change', () => updateSettings({ masterMute: mute.checked }));
  music.addEventListener('input', () => { musicNum.textContent = music.value; updateSettings({ musicVol: +music.value / 100 }); });
  sfx.addEventListener('input', () => { sfxNum.textContent = sfx.value; updateSettings({ sfxVol: +sfx.value / 100 }); });
  pan.addEventListener('input', () => { panNum.textContent = pan.value; updateSettings({ panSpeed: +pan.value }); });
  themeSel.addEventListener('change', () => { applyTheme(themeSel.value); updateSettings({ theme: themeSel.value }); });

  // ---- avatar upload + center-crop ----
  const preview = $('avatarPreview');
  const fileInput = $<HTMLInputElement>('avatarFile');
  const setPreview = (data: string | null) => {
    preview.style.backgroundImage = data ? `url(${data})` : 'none';
  };
  setPreview(settings.avatar);

  $('avatarPick').addEventListener('click', () => fileInput.click());
  $('avatarClear').addEventListener('click', () => {
    updateSettings({ avatar: null });
    setPreview(null);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // allow re-picking the same file later
    if (!file) return;
    cropSquare(file, AVATAR_PX).then((data) => {
      if (!data) return;
      updateSettings({ avatar: data });
      setPreview(data);
      hooks.net.sendAvatar(data); // instant if already in-game; harmless pre-game
    }).catch(() => { /* bad image, ignore */ });
  });

  // ---- navigation ----
  $('settingsBtn').addEventListener('click', () => show(settingsPanel));
  $('setClose').addEventListener('click', () => hide(settingsPanel));
  $('howBtn').addEventListener('click', () => show(tutorial));
  $('setHow').addEventListener('click', () => show(tutorial));
  $('tutClose').addEventListener('click', () => { hide(tutorial); updateSettings({ seenTutorial: true }); });

  const play = () => {
    const name = nameInput.value.trim() || 'etcher';
    updateSettings({ name });
    nameInput.blur(); // release focus so Space/V reach the game, not the field
    hide(menu);
    hooks.onPlay(name);
    if (!settings.seenTutorial) show(tutorial); // first-run only, re-openable from settings
  };
  $('playBtn').addEventListener('click', play);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });

  nameInput.focus();
}

/** Load an image file, center-crop to a square, return a JPEG dataURL. */
function cropSquare(file: File, size: number): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      if (!g) { resolve(null); return; }
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - s) / 2;
      const sy = (img.naturalHeight - s) / 2;
      g.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
