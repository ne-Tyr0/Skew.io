import {
  CELL_PX, BOARD_W, BOARD_H, BEATS_PER_MEASURE, TICKS_PER_BEAT, TICK_MS, tierForScore, NODE_CAPTURE,
  SURGE_MIN_SCORE, SURGE_COST, SURGE_COOLDOWN_MS,
  VIA_MIN_SCORE, VIA_COST, VIA_COOLDOWN_MS,
  JAMMER_MIN_SCORE, JAMMER_COST, JAMMER_COOLDOWN_MS,
  ROUND_BEATS, INTERMISSION_MS,
} from '../../shared/constants';
import { cellX, cellY } from '../../shared/grid';
import { Net } from './net';
import { Input } from './input';
import { Renderer, type Camera } from './render';
import { activeTheme } from './theme';
import { settings } from './settings';
import { initMenu } from './menu';
import { audio } from './audio';

const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';

const base = document.getElementById('base') as HTMLCanvasElement;
const pulse = document.getElementById('pulse') as HTMLCanvasElement;
const hud = {
  score: document.getElementById('score')!,
  ping: document.getElementById('ping')!,
  sync: document.getElementById('sync')!,
  players: document.getElementById('players')!,
  beat: document.getElementById('beat')!,
  board: document.getElementById('board')!,
};
const leaderboard = document.getElementById('leaderboard')!;
const lbList = document.getElementById('lbList')!;
const hitFlash = document.getElementById('hitFlash')!;
const minimap = document.getElementById('minimap') as HTMLCanvasElement;
const mmctx = minimap.getContext('2d')!;
const rankEl = document.getElementById('rank')!;
const roundTimerEl = document.getElementById('roundTimer')!;
const roundClockEl = document.getElementById('roundClock')!;
const winnerEl = document.getElementById('winner')!;
const winnerNameEl = document.getElementById('winnerName')!;
const winnerListEl = document.getElementById('winnerList')!;
const winnerNextEl = document.getElementById('winnerNext')!;
const ab = {
  wrap: document.getElementById('abilities')!,
  tierName: document.getElementById('tierName')!,
  tierFill: document.getElementById('tierFill') as HTMLElement,
  tierNext: document.getElementById('tierNext')!,
  surge: document.getElementById('abSurge')!,
  via: document.getElementById('abVia')!,
  jammer: document.getElementById('abJammer')!,
};

const cam: Camera = { x: 0, y: 0, zoom: 1 };
const net = new Net();
const renderer = new Renderer(base, pulse);
const input = new Input(base, net, cam);

let centred = false;
let avatarSent = false;

// Click the minimap to recentre the camera on that patch of board.
minimap.addEventListener('click', (e) => {
  const r = minimap.getBoundingClientRect();
  cam.x = ((e.clientX - r.left) / r.width) * BOARD_W * CELL_PX;
  cam.y = ((e.clientY - r.top) / r.height) * BOARD_H * CELL_PX;
});

// The socket doesn't open until the player hits Play — the menu owns the
// callsign, and we fold it into the `name` query param the server already reads.
initMenu({
  net,
  onPlay(name: string) {
    audio.start(); // the Play click is our user gesture to open the AudioContext
    const params = new URLSearchParams(location.search); // preserve ?lag/?jitter
    params.set('name', name);
    net.connect(`${wsProto}//${location.host}/ws?${params.toString()}`);
  },
});

// pips for the 8-beat measure
const pips: HTMLElement[] = [];
for (let i = 0; i < BEATS_PER_MEASURE; i++) {
  const el = document.createElement('span');
  el.className = 'pip';
  hud.beat.appendChild(el);
  pips.push(el);
}

// Watch our own commits come back so the ghost can hand over to the real trace
const origSchedule = net.sim.schedule.bind(net.sim);
net.sim.schedule = (ev) => {
  if (ev.t === 'commit' && ev.slot === net.slot) input.resolveOldestGhost(ev.beat);
  origSchedule(ev);
};

let last = performance.now();
let lbTimer = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  net.pump();
  input.updatePan(dt);

  const me = net.sim.players.get(net.slot);
  if (me && !centred) {
    cam.x = (cellX(me.source) + 0.5) * CELL_PX;
    cam.y = (cellY(me.source) + 0.5) * CELL_PX;
    centred = true;
    document.documentElement.style.setProperty('--me', activeTheme.hues[me.hueIdx]);
  }
  // Publish our chosen avatar once we know our slot (server echoes it back).
  if (me && !avatarSent && settings.avatar) { net.sendAvatar(settings.avatar); avatarSent = true; }

  input.reapGhosts(net.sim.beat, now);
  renderer.frame(net.sim, net, input, cam);
  drawHud();
  updateLeaderboard(now);
  updateAbilities(now, me);
  driveAudio();
  detectHits(now);
  drawMinimap(now);
  updateRound(now);
  requestAnimationFrame(frame);
}

// Round timer, rank/gap cue, and the winner banner on reset.
let prevRound = -1;
let winnerUntil = 0;
let lastBoard: { name: string; score: number; slot: number; hue: string }[] = [];
function updateRound(now: number): void {
  const players = [...net.sim.players.values()];
  const me = net.sim.players.get(net.slot);
  const live = net.status === 'live' && players.length > 0;

  // countdown
  if (live) {
    const remainTicks = net.sim.roundStartTick + ROUND_BEATS * TICKS_PER_BEAT - net.sim.tick;
    const secs = Math.max(0, Math.floor((remainTicks * TICK_MS) / 1000));
    roundTimerEl.removeAttribute('hidden');
    roundClockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  } else {
    roundTimerEl.setAttribute('hidden', '');
  }

  // rank + gap
  if (me && players.length) {
    const better = players.filter((p) => p.score > me.score).length;
    const leader = Math.max(...players.map((p) => p.score));
    const gap = leader - me.score;
    rankEl.textContent = `${better + 1}/${players.length}${gap > 0 ? ` · ${gap} behind` : ' · leading'}`;
  } else {
    rankEl.textContent = '–';
  }

  // winner banner: fires when the round counter ticks up (board just reset)
  const board = players
    .map((p) => ({ name: p.name || `#${p.slot}`, score: p.score, slot: p.slot, hue: activeTheme.hues[p.hueIdx] }))
    .sort((a, b) => b.score - a.score);
  if (prevRound < 0) prevRound = net.sim.round;
  if (net.sim.round > prevRound) {
    prevRound = net.sim.round;
    if (lastBoard.length && lastBoard[0].score > 0) { showWinner(lastBoard); winnerUntil = now + INTERMISSION_MS; }
  }
  if (winnerUntil > now) {
    winnerEl.classList.add('show');
    winnerNextEl.textContent = `next round underway · ${Math.ceil((winnerUntil - now) / 1000)}s`;
  } else {
    winnerEl.classList.remove('show');
  }
  lastBoard = board;
}

function showWinner(board: { name: string; score: number; slot: number; hue: string }[]): void {
  winnerNameEl.textContent = `🏆 ${board[0].name} · ${board[0].score}`;
  winnerListEl.replaceChildren(...board.slice(0, 5).map((r, i) => {
    const li = document.createElement('li');
    if (r.slot === net.slot) li.className = 'me';
    const n = document.createElement('span'); n.className = 'wn'; n.textContent = `${i + 1}. ${r.name}`;
    const s = document.createElement('span'); s.textContent = String(r.score);
    li.append(n, s);
    return li;
  }));
}

// Whole-board minimap: occupied cells by hue, nodes, and the current viewport
// rectangle. 1 canvas pixel per cell, redrawn at ~8Hz to stay off the frame budget.
let mmTimer = 0;
function drawMinimap(now: number): void {
  if (now - mmTimer < 120) return;
  mmTimer = now;
  if (net.sim.players.size === 0) { minimap.setAttribute('hidden', ''); return; }
  minimap.removeAttribute('hidden');
  mmctx.fillStyle = activeTheme.bg;
  mmctx.fillRect(0, 0, BOARD_W, BOARD_H);
  const o = net.sim.owner;
  for (let i = 0; i < o.length; i++) {
    const s = o[i];
    if (s === 0) continue;
    const pl = net.sim.players.get(s);
    if (!pl) continue;
    mmctx.fillStyle = activeTheme.hues[pl.hueIdx];
    mmctx.fillRect(i % BOARD_W, (i / BOARD_W) | 0, 1, 1);
  }
  mmctx.fillStyle = '#9A948A';
  for (const [cell] of net.sim.nodes) mmctx.fillRect(cell % BOARD_W, (cell / BOARD_W) | 0, 1, 1);
  // viewport rectangle, in cells
  const halfW = window.innerWidth / 2 / cam.zoom / CELL_PX;
  const halfH = window.innerHeight / 2 / cam.zoom / CELL_PX;
  const me = net.sim.players.get(net.slot);
  mmctx.strokeStyle = me ? activeTheme.hues[me.hueIdx] : '#FFFFFF';
  mmctx.lineWidth = 1;
  mmctx.strokeRect(cam.x / CELL_PX - halfW, cam.y / CELL_PX - halfH, halfW * 2, halfH * 2);
}

// Incoming-attack feedback. Your owned-cell count only ever drops because someone
// else tore it out (there's no self-delete verb), so a drop while live — and not
// during a resync — means you were hit. Sampled at 4Hz to keep the full-board
// scan off the per-frame budget.
let prevOwned = -1;
let prevResyncs = 0;
let ownedTimer = 0;
let flashOff = 0;
function detectHits(now: number): void {
  if (now - ownedTimer < 250) return;
  ownedTimer = now;
  if (net.slot === 0 || net.status !== 'live') { prevOwned = -1; prevResyncs = net.resyncs; return; }
  const o = net.sim.owner;
  let owned = 0;
  for (let i = 0; i < o.length; i++) if (o[i] === net.slot) owned++;
  const resynced = net.resyncs !== prevResyncs;
  prevResyncs = net.resyncs;
  if (prevOwned >= 0 && !resynced && owned < prevOwned) {
    audio.hit();
    hitFlash.classList.add('on');
    clearTimeout(flashOff);
    flashOff = window.setTimeout(() => hitFlash.classList.remove('on'), 90);
  }
  prevOwned = owned;
}

// Turn derived state into sound. Beat/measure hooks fire once per real beat
// (per-frame diff is rollback-safe); captures are read from node-holder changes.
let lastAudioBeat = -1;
const prevHolders = new Map<number, number>();
function driveAudio(): void {
  audio.syncVolumes();
  const beat = net.sim.beat;
  if (lastAudioBeat < 0) lastAudioBeat = beat;
  const gap = beat - lastAudioBeat;
  if (gap > 0) {
    if (gap <= 3) { // a normal advance; a big jump (bg tab / resync) stays silent
      for (let b = lastAudioBeat + 1; b <= beat; b++) {
        audio.onBeat(b, net.sim.pulses.length);
        if (b % BEATS_PER_MEASURE === 0) audio.onMeasure(b);
      }
    }
    lastAudioBeat = beat;
  }
  for (const [cell, holder] of net.sim.nodes) {
    const prev = prevHolders.get(cell);
    if (holder !== 0 && prev !== undefined && prev !== holder) {
      audio.capture(holder === net.slot);
      const pl = net.sim.players.get(holder);
      const hue = pl ? activeTheme.hues[pl.hueIdx] : '#FFFFFF';
      renderer.addEffect(cell, `+${NODE_CAPTURE}`, hue, 'float');
      renderer.addEffect(cell, '', hue, 'burst');
    }
    prevHolders.set(cell, holder);
  }
}
requestAnimationFrame(frame);

function drawHud(): void {
  const me = net.sim.players.get(net.slot);
  hud.score.textContent = String(me ? me.score : 0);
  hud.ping.textContent = `${Math.round(net.rttMs)}ms`;
  hud.players.textContent = String(net.sim.players.size);
  hud.sync.textContent = net.status.toUpperCase();
  hud.sync.className = net.status;
  hud.board.textContent = `t${net.sim.tick} · rb${net.rollbacks} · rs${net.resyncs}`;
  const b = net.sim.beat % BEATS_PER_MEASURE;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i === b);
}

// Live leaderboard from data net.ts already receives: authoritative (hash-verified)
// scores from the keyframe, names/hues from the sim. No new server traffic.
function updateLeaderboard(now: number): void {
  if (now - lbTimer < 500) return;
  lbTimer = now;
  const players = net.sim.players;
  if (players.size === 0) { leaderboard.setAttribute('hidden', ''); return; }
  leaderboard.removeAttribute('hidden');
  const rows = [...players.values()]
    .map((p) => ({
      slot: p.slot,
      name: p.name || `#${p.slot}`,
      hue: activeTheme.hues[p.hueIdx],
      score: net.authoritativeScores.get(p.slot) ?? p.score,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  lbList.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    if (r.slot === net.slot) li.className = 'me';
    const dot = document.createElement('span'); dot.className = 'lb-dot'; dot.style.background = r.hue;
    const name = document.createElement('span'); name.className = 'lb-name'; name.textContent = r.name;
    const score = document.createElement('span'); score.className = 'lb-score'; score.textContent = String(r.score);
    li.append(dot, name, score);
    return li;
  }));
}

// Tier meter + ability chips. Tier is a pure function of the locally-derived
// score; the cooldown sweep is approximate (from our own send time) since the
// authoritative gate is the server's.
const TIER_NAMES = ['ETCHER', 'BLAST', 'SNIPE', 'JAMMER'];
function updateAbilities(now: number, me: { score: number } | undefined): void {
  if (!me) { ab.wrap.setAttribute('hidden', ''); return; }
  ab.wrap.removeAttribute('hidden');
  const score = me.score;
  const tier = tierForScore(score);
  ab.tierName.textContent = `TIER ${tier} · ${TIER_NAMES[tier]}`;

  let floor = 0, ceil = SURGE_MIN_SCORE;
  if (tier === 1) { floor = SURGE_MIN_SCORE; ceil = VIA_MIN_SCORE; }
  else if (tier === 2) { floor = VIA_MIN_SCORE; ceil = JAMMER_MIN_SCORE; }
  else if (tier === 3) { floor = JAMMER_MIN_SCORE; ceil = JAMMER_MIN_SCORE; }
  const pct = ceil > floor ? Math.min(100, Math.max(0, ((score - floor) / (ceil - floor)) * 100)) : 100;
  ab.tierFill.style.width = pct + '%';
  ab.tierNext.textContent = tier === 3 ? 'MAX' : `${Math.max(0, ceil - score)} to next`;

  chip(ab.surge, score >= SURGE_MIN_SCORE, SURGE_COST, score, SURGE_COOLDOWN_MS - (now - net.lastSurgeSentMs), SURGE_MIN_SCORE);
  chip(ab.via, score >= VIA_MIN_SCORE, VIA_COST, score, VIA_COOLDOWN_MS - (now - net.lastViaSentMs), VIA_MIN_SCORE);
  chip(ab.jammer, score >= JAMMER_MIN_SCORE, JAMMER_COST, score, JAMMER_COOLDOWN_MS - (now - net.lastJammerSentMs), JAMMER_MIN_SCORE);
}

function chip(el: HTMLElement, unlocked: boolean, cost: number, score: number, cdRemain: number, unlockAt: number): void {
  const state = el.querySelector('.ab-state') as HTMLElement;
  el.classList.remove('ready', 'locked', 'cooldown', 'poor');
  if (!unlocked) { el.classList.add('locked'); state.textContent = `▲${unlockAt}`; return; }
  if (cdRemain > 0) { el.classList.add('cooldown'); state.textContent = `${Math.ceil(cdRemain / 1000)}s`; return; }
  if (score < cost) { el.classList.add('poor'); state.textContent = `${cost}`; return; }
  el.classList.add('ready'); state.textContent = `${cost}`;
}

export { TICKS_PER_BEAT };
