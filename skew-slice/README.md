# SKEW.IO — vertical slice

Proves the hard part: **beat-synchronised pulse propagation over live
multiplayer, feeling responsive rather than laggy.**

Architecture and reasoning: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
shared/       the deterministic sim — imported unmodified by BOTH sides
  constants   time base, board size, netcode tuning, palette
  grid        direction tables, integer step costs (ortho 12, diagonal 17)
  sim         Sim class: tick, propagate, commit, hash, checkpoint
  protocol    wire message types + encode/decode seam
server/
  index       http static + ws upgrade + dev latency injection
  room        authoritative sim, drift-corrected loop, validation, broadcast
client/src/
  net         clock sync, event scheduling, rollback, drift detection
  input       freehand drag → legal 8-direction lattice path
  render      two-canvas renderer (batched traces / additive pulse trails)
  main        bootstrap + frame loop + HUD
tools/
  headless    N real clients in Node, asserts hash agreement under latency
  probe       one client, one route: does the pulse arrive on the predicted beat
  jammertest  sim-level determinism proof for the persistent Jammer entity
```

## Run it

```bash
npm install
npm run dev          # server :8787 + vite :5173
```

Open **http://localhost:5173** in two tabs.

Production-ish (server serves the built client on one port):

```bash
npm run build && npm start   # http://localhost:8787
```

## Menu & shell

Opening the page now lands on a **menu**, not straight in the board — but the fast
path is one click (`▶ PLAY`), so "meaningful in 10 seconds" is intact.

- **Callsign** — persisted in `localStorage`, sent as the `name` query param the
  server already reads. The socket opens on Play, not on load.
- **Settings** (all persisted): master mute, music/SFX volume (Section 3),
  **theme**, camera pan speed. Re-open any time.
- **Themes** — alternate accent palettes on the dark base (Graphite / Deep Sea /
  Ember / Signal). The renderer's glow is additive over near-black, so themes vary
  the dark tone and accents, never go light. Colours never touch the sim or its
  hash.
- **Leaderboard** — top-right in-game, built entirely from data the client already
  has (hash-verified keyframe scores + sim names/hues). No new server traffic.
- **Avatar** — upload a square image for your source glyph. Center-cropped
  client-side and **broadcast to every player** over a cosmetic side-channel that
  is deliberately kept off the deterministic sim (see ARCHITECTURE §9).
- **How to play** — dismissible tutorial overlay, shown once on first play and
  re-openable from Settings.

## Audio

Fully **synthesized** with the Web Audio API — no sample files, so it adds ~1 KB
gzipped and keeps the instant-play bundle. The board *is* the sequencer:

- an ambient **pad** drifts through a 4-chord progression on measure boundaries;
- per-beat **plucks** get denser as more pulses fly (a busy board sounds busy);
- a subtle **tick** on each measure boundary, a bright **chime** on node capture
  (higher/brighter when it's yours), and a flat **buzz** on your crosstalk Surge.

All of it is a pure read of derived state, driven from the render loop — it never
touches the sim. Master mute + music/SFX volumes live in Settings and are applied
live. The AudioContext opens on the Play click (browsers require a user gesture).

## Play

- **Drag from your own trace or source** to etch. You start with just a source
  (the diamond) — your first drag has to start on it.
- Sources fire on **beat 0 of every measure**, so the whole board pulses in
  unison. Watch the pips.
- Route into a **square node** to capture it. It then pays you every measure
  until someone else's pulse arrives.
- **Drag back over the path you're drawing to rub it out.** That's the undo.
- **WASD / arrows** pan.
- The `β` number at the head of your drag is the path's cost in beats. That
  number is the whole game.

## Progression & attacks

Attacks are **gated by score**, so a brand-new player is defence-only and can't be
farmed the instant they spawn — sprawl wins early, offence comes later.

| Tier | Score | Verb | Key | Cost | Cooldown |
|---|---|---|---|---|---|
| 0 · Etcher | 0 | — (defence only) | — | — | — |
| 1 · Surge | **120** | crosstalk — fry rival traces in a 5×5 blast around one of *your* cells | **Space** | 15 | 6s |
| 2 · Via Blower | **400** | precise strike on one rival fan-out junction (a via) | **V** | 40 | 12s |
| 3 · Jammer | **900** | drop a **permanent** EMI source that fries hostile traces + pulses in radius **every measure** | **G** | 80 | 20s |

Attacks target the **cell under your cursor**: hover a cell you own and press Space
to Surge; hover an enemy junction and press V to blow it; hover an empty cell and
press G to plant a Jammer. All **cost score** (ammo, tied to the economy) and sit
behind a cooldown. The tier meter + ability chips at the bottom show your progress
and what's armed.

A Jammer is permanent — it keeps disrupting until a rival destroys its cell, which
is exactly what **Surge** (area) and the **Via Blower** (targeted) can now also do.
So the attack ladder answers itself.

The design boundary that matters: the **effect and the score cost live in the
deterministic sim** (so every machine derives the identical result), while the
**tier gate and cooldown are enforced server-side** (the sim has no clock). A stale
gate can only make an attack whiff, never desync — the sim re-validates at the
commit beat and no-ops otherwise. The Jammer is the one attack that adds
*persistent* state, so it is threaded through the hash, snapshots, and rollback
checkpoints; a dedicated test (`npm run simtest`) proves it stays bit-identical
across sims and round-trips.

## Test it — what to check when you open two tabs

Do these in order. Each one isolates a different failure.

**1. Is the metronome shared?**
Put both tabs side by side. The 8 beat pips must advance in lockstep. If one tab
visibly leads, clock sync is broken — everything else is meaningless.

**2. Does your own input feel instant?**
Drag a trace in tab A. The bright dashed ghost must appear **under your cursor
with no perceptible delay**, then hand over to a solid trace ~375ms later. If
the ghost lags the cursor, it's a render bug. If there's a visible gap where
neither ghost nor trace exists, the handover timing is off.

**3. Do both tabs commit on the same beat?**
Watch tab B while tab A releases a drag. A's ghost solidifying and B's trace
appearing should happen on the *same beat*, not merely "about the same time."
This is the commit horizon working.

**4. Does the timing contract hold?**
Count the cells from your source to a node. Watch the spark. It should arrive
that many beats later (diagonals count 1.42). Automated version:

```bash
npx tsx tools/probe.ts        # prints predicted vs actual arrival tick
npx tsx tools/probe.ts 200    # same, with 200ms symmetric latency injected
```

Typical output — a 12-cell route with diagonals costs 179 ticks (14.92 beats)
and the pulse lands on the tick the path length says it will:

```
route: 12 cells, 179 ticks = 14.92 beats
committed on beat 1183; first source firing after that is tick 14208
predicted capture at tick 14387 (beat 1198.92)
actual capture observed at tick 14387
error: 0 ticks (0.00 beats)
RESULT: PASS — arrival matched path length
```

**5. Does it survive a bad connection?**
The server injects latency per socket, which is the only honest way to test this
— DevTools throttling won't touch a WebSocket.

```
http://localhost:5173/?lag=180&jitter=60     # realistic long-distance
http://localhost:5173/?lag=420&jitter=100    # past the 375ms commit horizon
```

At 180ms the game should feel identical. At 420ms, watch `rb` (rollbacks) climb
in the bottom-right — and `SYNC` must stay green. Rollbacks are the recovery
path doing its job, not a failure.

**6. Does it stay in sync over time?**
Leave two tabs running for five minutes with occasional drawing. `SYNC` must
read **LIVE** the whole time. If it flips to **DRIFT**, the two sims disagreed
on a state hash — that is a real determinism bug and it will be reproducible.

**7. Background tab recovery.**
Switch away for 30 seconds, come back. It should resync (`rs` increments), not
freeze or fast-forward through 2,000 ticks.

**8. Everything at once, automated.**

```bash
npm run headless -- 8 20 180 60     # 8 clients, 20s, 180±60ms each way
```

PASS means every client independently computed the same state hash as the
server, once per second, for the whole run. (The soak's bots also fire Surge /
Via / Jammer once they cross the score gates, so hash agreement covers the
attacks too.)

**9. Jammer determinism (sim-level unit proof).**

```bash
npm run simtest
```

The Jammer is the one persistent entity, so it's proven separately: two sims stay
hash-identical across 400 ticks with jammers active, and a jammer survives
snapshot + checkpoint round-trips with an unchanged hash.

## HUD

```
SCORE   your derived score (never sent to you — computed locally, hash-verified)
BEAT    position in the 8-beat measure
RTT     round-trip, min-filtered
SYNC    LIVE = hashes agree · DRIFT = divergence detected · LOST = disconnected
t… rb… rs…   local tick · rollbacks · resyncs
TIER    current tier + progress to the next; Surge / Via chips show armed / cooldown
```

## Deferred, on purpose

COINCIDE / clocked / inverter nodes · repeaters and fan-out decay · vias ·
power budget and brownout · trace decay and congestion · round timer ·
full palette polish · mobile.

(The full Surge / Via Blower / Jammer attack ladder, the menu / leaderboard /
avatars, synthesized audio, and zoom + minimap + onboarding hints are now
**built** — see the sections above.)

See `docs/ARCHITECTURE.md` §8 for the parts that will genuinely be hard.
