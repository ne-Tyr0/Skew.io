// Generative audio, entirely synthesized with the Web Audio API — no sample
// assets, so it costs the bundle nothing but code. The board is the sequencer:
// a pad drifts through a chord progression on measure boundaries, and per-beat
// plucks get denser as more pulses fly. One-shots (measure tick, capture chime,
// crosstalk buzz) ride an SFX bus. Nothing here touches the sim; audio is a pure
// read of derived state, driven from the frame loop.
//
// Buses:  master (mute) → destination ;  music bus (pad+plucks) ;  sfx bus (one-shots)
// Levels are pulled from settings.ts every frame so the sliders are live.

import { settings } from './settings';

type Ctx = AudioContext;

class Engine {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private padOscs: OscillatorNode[] = [];
  private started = false;

  // A2 root, pentatonic-minor voices for plucks, a gentle 4-chord drift for the pad.
  private readonly base = 110;
  private readonly penta = [0, 3, 5, 7, 10, 12, 15];
  private readonly chordRoots = [0, -2, 3, -4];
  private measureIdx = 0;
  private currentRoot = 0;

  /** Must be called from a user gesture (the Play click) or the context stays suspended. */
  start(): void {
    if (this.started) return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.started = true;
    this.syncVolumes();
    this.startPad();
    void this.ctx.resume();
  }

  /** Pull the live mixer levels from settings. Cheap; called every frame. */
  syncVolumes(): void {
    if (!this.ctx) return;
    this.master.gain.value = settings.masterMute ? 0 : 0.9;
    this.musicBus.gain.value = settings.musicVol;
    this.sfxBus.gain.value = settings.sfxVol;
  }

  private noteHz(semi: number): number { return this.base * Math.pow(2, semi / 12); }

  private startPad(): void {
    const ctx = this.ctx!;
    const g = ctx.createGain(); g.gain.value = 0.09;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    const a = ctx.createOscillator(); a.type = 'sine'; a.frequency.value = this.base;
    const b = ctx.createOscillator(); b.type = 'triangle'; b.frequency.value = this.base; b.detune.value = 8;
    a.connect(g); b.connect(g); g.connect(lp); lp.connect(this.musicBus);
    const t = ctx.currentTime;
    a.start(t); b.start(t);
    this.padOscs = [a, b];
  }

  /** A short enveloped oscillator blip. The workhorse for plucks and bells. */
  private blip(dest: AudioNode, freq: number, type: OscillatorType, peak: number, dur: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // ---- beat-clock hooks (called from the frame loop) -----------------------

  /** Every beat. `activity` = pulses in flight; density scales the sequencer. */
  onBeat(_beat: number, activity: number): void {
    if (!this.ctx) return;
    const vel = Math.min(1, activity / 30);
    if (Math.random() < 0.32 + vel * 0.4) {
      const semi = this.penta[(Math.random() * this.penta.length) | 0];
      this.blip(this.musicBus, this.noteHz(this.currentRoot + semi + 12), 'sine', 0.12 * (0.4 + vel * 0.6), 0.28);
    }
  }

  /** Measure boundary (beat % 8 === 0): drift the pad chord + a subtle tick. */
  onMeasure(_beat: number): void {
    if (!this.ctx) return;
    this.measureIdx = (this.measureIdx + 1) % this.chordRoots.length;
    this.currentRoot = this.chordRoots[this.measureIdx];
    const f = this.noteHz(this.currentRoot);
    for (const o of this.padOscs) o.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.4);
    this.blip(this.sfxBus, 1400, 'sine', 0.05, 0.05); // measure tick
  }

  /** Node capture — a bright bell, pitched higher/brighter when it's yours. */
  capture(own: boolean): void {
    if (!this.ctx) return;
    const f = own ? 880 : 587;
    this.blip(this.sfxBus, f, 'sine', 0.22, 0.5);
    this.blip(this.sfxBus, f * 2.01, 'sine', 0.11, 0.45);
    if (own) this.blip(this.sfxBus, f * 3.0, 'sine', 0.06, 0.4);
  }

  /** Fire Now — a short upward blip acknowledging a manual pulse launch. */
  fire(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.18);
  }

  /** You got hit — a darker, nastier version of the buzz. Fired when your own
   *  territory is torn out by someone else's attack. */
  hit(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.28);
    bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.26, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.36);
  }

  /** Crosstalk — a flat, harsh buzz that pitches down. Fired on your own attack. */
  buzz(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.2);
    bp.type = 'bandpass'; bp.frequency.value = 450; bp.Q.value = 6;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.26);
  }
}

export const audio = new Engine();
