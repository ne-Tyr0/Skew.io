# SKEW.IO — system architecture

Written against the design doc as spec of record. Numbers marked **measured**
come from the vertical slice in this repo, not from estimation.

---

## 0. The one decision everything else falls out of

Pulses move at a fixed rate along a fixed topology. That means **a pulse's
position at any moment is a pure function of (topology, spawn schedule, tick
number)**. Nothing about it is negotiable, random, or player-influenced once the
trace exists.

So the network never sends pulse positions. It sends the handful of things that
are *not* derivable — someone joined, someone etched a trace, the server rolled
a new demand node — and every machine recomputes the rest identically.

That single property decides the netcode, the bandwidth budget, the data model,
and the anti-cheat surface. Everything below is downstream of it.

```
NOT SENT (derived on every machine, every tick)
  pulse positions · fan-out splits · arrival beats · node capture · scores

SENT (server-stamped events, ~30 bytes each)
  join · leave · commit(trace path) · nodeSpawn · nodeDespawn
```

---

## 1. Authoritative simulation model

**Committed: server-authoritative lockstep with a scheduled commit horizon.**
Not client prediction with rollback reconciliation.

### How it works

1. Client drags a path. It renders the path **immediately** as a bright dashed
   ghost. Nothing is committed.
2. On release the client sends an *intent*: `{start: cellIndex, dirs: [0..7]}`.
   That is the only game input that exists in the entire protocol.
3. Server validates, stamps it with `beat = currentBeat + COMMIT_DELAY_BEATS`
   (3 beats = 375ms) and a monotonic `seq`, applies it to its own sim, and
   broadcasts it.
4. Every client schedules the event at that exact beat. When their playhead
   reaches it, they apply it. The ghost hands over to the real trace.

```
        intent sent                      commit beat (B+3)
             │                                  │
 client A ───┼────────ghost visible─────────────┼──── real trace ────►
             │                                  │
             └──►server──► broadcast ──────────►│
                                                │
 client B ───────────────────────────nothing────┼──── real trace ────►
                                                │
             |◄──────── 375ms budget ──────────►|
                     one-way latency must fit in here
```

### Why not client prediction + server reconciliation

Prediction/reconciliation exists to make *your own continuously-moving avatar*
feel instant. SKEW has no such thing. Your cursor is pure local rendering with
zero gameplay authority; the only entities with authority are pulses, and pulses
are on rails.

So the FPS-style model would buy nothing and cost a rollback system on the hot
path. The RTS-style model (Age of Empires' 1997 lockstep design — every client
runs the same deterministic sim on delayed input) fits the shape of this game
exactly, and the ghost hides the input delay the same way an RTS hides it behind
a unit acknowledgement bark.

### Fairness

A client cannot fake a faster pulse, because a client never *tells* anyone where
its pulses are. It can only say "trace here." The entire cheat surface is:

- claiming cells it shouldn't → server checks ownership and occupancy at the
  commit beat, and `applyCommit` truncates at the first illegal cell;
- intent spam → rate-limited per player (`INTENT_MIN_GAP_MS`), path length
  capped (`MAX_PATH_CELLS`);
- bot play → unsolvable in this genre, ignore it.

Low ping does **not** buy a faster commit. Everyone lands on the horizon. It buys
you a better chance of making the *deadline* for a given beat, which is a real
but bounded advantage, and it degrades gracefully: miss the deadline and you
slide to the next beat rather than desyncing.

Simultaneous claims resolve by `(commitBeat, seq)` — server receipt order,
replicated to every client, so all machines agree on who won the corridor.

### Latency handling, three layers

| Layer | Handles | Cost |
|---|---|---|
| Ghost rendering | *All* perceived input latency | free |
| Commit horizon (375ms) | Normal jitter, up to ~350ms one-way | 3 beats of delay |
| Checkpoint rollback | Events that arrive after their beat | ~0.3ms per rollback |
| Keyframe hash + resync | Anything the above missed, or a bug | 32KB snapshot |

The rollback layer is only affordable *because* the sim is deterministic and
cheap: restore a checkpoint from up to 8 beats back, re-insert the late event in
seq order, replay ~96 ticks. **Measured: 5.1µs per tick** at a saturated board,
so a full replay is well under a millisecond.

**Measured under injected symmetric latency, 3 clients, 14s, actively etching:**

| One-way latency | Rollbacks | Hash mismatches | Playhead spread |
|---|---|---|---|
| 0ms | 0 | 0 | 0 ticks |
| 150 ± 40ms | 0 | 0 | 1 tick (0.08 beats) |
| 260 ± 60ms | 0 | 0 | 1 tick |
| 420 ± 100ms | 14–18 | **0** | 2 ticks |

The horizon absorbs everything up to ~350ms one-way with zero recovery work.
Past that the rollback path engages and clients *still* stay bit-identical with
the server. That is the result worth trusting.

### Clock sync

The sim is integer-exact and has no idea what time it is — it only has `tick`.
The *only* estimated quantity in the whole system is where the playhead is:

```
offset  = serverMs + rtt/2 − clientMs          (min-RTT sample of the last 8)
tickNow = floor((performance.now() + offset − originMs) / TICK_MS)
```

Min-RTT rather than average, because a sample that took 40ms each way tells you
far more about the true offset than one that sat in a buffer for 200ms. Being
±1 tick off is harmless: it shifts the render playhead, never the state.

---

## 2. State sync strategy — and the actual math

Three candidates, at 40 players on a 128×128 board (16,384 cells), 8 beats/sec:

**A. Full board snapshot per beat.** 16,384 cells × 3 bytes = 49KB per snapshot
× 8/s × 40 players = **15.7 MB/s egress.** Dead on arrival.

**B. Occupied cells only.** Late game maybe 12,000 owned cells × 5 bytes = 60KB
× 8/s × 40 = **19 MB/s.** Worse, because "occupied" grows toward "everything."

**C. Event deltas** — what this repo does.

**Measured, 8 concurrent clients drawing a fresh 18-cell trace every 900ms
(far more aggressive than a human), uncompressed JSON:**

```
0.66 KB/s downstream per client · 6.7 messages/sec
```

Linear extrapolation to 40 players — event rate scales with player count, and
every event goes to every client, so per-client cost scales linearly:

```
per client   ≈ 3.3 KB/s      (≈26 kbit/s — fine on 3G)
server egress ≈ 130 KB/s     (≈1 Mbit/s for the entire game)
```

That is **two orders of magnitude** under option A, and it is JSON. Binary
framing would cut it another 5–8×, which is why it isn't worth doing yet.

### So where *is* the ceiling?

Not bandwidth. In order:

1. **Join cost.** A newcomer needs the whole board. Run-length encoded (a board
   is mostly empty, and RLE on a saturated 40-player board is still **measured
   31.9 KB of JSON, 2.0ms to build**). One-time, trivial.
2. **Client hash cost.** The integrity hash walks all 16,384 cells: **measured
   3.18ms.** At once per second that is a ~3ms hitch, 19% of a 60fps frame.
   Fine now; fix before launch by maintaining an occupied-cell list, hashing
   every 4s instead of 1s, or moving it to a Worker. Flagging it because it is
   the only thing in the slice that touches the frame budget.
3. **Server CPU.** **Measured: 60 seconds of game time with 40 players and 560
   pulses in flight simulates in 29.6ms — 0.05% of the beat budget.** Crosstalk
   (deferred) is the expensive future feature; see §8.
4. **Design.** ~40–60 players is where one board stops being legible. The tech
   would hold several hundred. **The ceiling is a design limit, not a technical
   one**, which is the right place for it to be.

---

## 3. Time base — and the one place the design fought the machine

The design doc says a diagonal costs 1.41 beats. Floats in a deterministic sim
are how you get drift bugs that only appear after four minutes with three
players. So:

```
1 beat  = 12 ticks          (TICKS_PER_BEAT)
1 beat  = 125ms             → 8 beats/sec, a measure is exactly 1 second
orthogonal step = 12 ticks  = 1.000 beats
diagonal   step = 17 ticks  = 1.4167 beats   (√2 to within 0.2%)
```

Everything in the sim is an integer. The tick exists solely so `√2` can be a
ratio. **Verified end to end**: a 14-cell mixed ortho/diagonal route predicted
218 ticks to the node; observed arrival within 2 ticks (the test's own polling
granularity). The "cells are beats" contract holds.

**This has a design consequence you should decide on deliberately, not by
accident:** diagonal-heavy paths accumulate fractional beat offsets. When
COINCIDE junctions land, two feeds will rarely align to the exact tick — they
will align to the same *beat bucket*. That is a tolerance window, i.e. setup and
hold time, which is arguably more faithful to the real thing than exact equality
would be. But it means the COINCIDE rule is "same 12-tick bucket," not "same
tick," and `17` is a tuning lever on how hard timing-matching feels.

---

## 4. Grid & trace data model

Structure-of-arrays, flat, zero allocation per tick:

```
owner : Uint8Array[16384]   0 = unowned, else player slot 1..64
out   : Uint8Array[16384]   bitmask of outgoing directions (bit d = dir d)
kind  : Uint8Array[16384]   EMPTY | WIRE | SOURCE | NODE
                            ────────────
                            48 KB for the entire world
```

Why this shape:

- **Propagation** is `acc++`, one compare, one bitmask read. No pointer chasing,
  no object graph, cache-friendly.
- **Collision / occupancy** is one array read. Racing commits resolve by the
  loser's path truncating at the contested cell — see `Sim.applyCommit`, which
  is deliberately tolerant rather than all-or-nothing.
- **Crosstalk (deferred)** becomes "for each cell of the overdriven trace, look
  at its 8 neighbours' `owner`" — O(trace length), no quadtree, no spatial hash.
  This is the main reason the grid beats a graph-of-segments representation.
- **Congestion (deferred)** is a windowed count over `owner != 0`.

Traces are **directed**: draw order is flow direction, and commits must anchor
on a cell you already own. The network is therefore a forest rooted at each
player's source — no cycles, no back-flow, no cycle detection needed anywhere.

Fan-out is implicit: a cell with N out-bits splits the pulse into N. Repeaters
and strength decay (deferred) slot in as one more `Uint8Array`.

---

## 5. Client rendering

**Committed: Canvas2D, two stacked canvases.** Not WebGL for the slice.

```
base   cleared + redrawn every frame, but ONLY over the visible cell window
       (~3.5k cells at 1080p), with all trace segments batched into ONE
       beginPath()/stroke() per hue → ≤8 draw calls regardless of board load

pulse  NEVER cleared. Each frame: fillRect the whole thing with the background
       colour at ~0.34 alpha, so the previous frame decays. Then blit pulses
       with globalCompositeOperation='lighter' using a pre-rendered radial
       sprite per hue.
```

That second layer is the whole art direction for free. "Hot core with a short
trailing falloff" is literally what an alpha-decay buffer produces, and it
sidesteps `shadowBlur`, which is the slowest thing in Canvas2D by a wide margin
and would be the obvious wrong way to get glow.

Batching by hue matters more than it looks: 4,000 individual `stroke()` calls
will drop frames, 8 will not, and the cost of the batch is the cell-window walk
(~3.5k array reads) rather than the geometry.

**Switch to WebGL/PixiJS when, and only when, this measures badly** — the trigger
is sustained draw-phase frame time above ~8ms, most likely from >6k visible
segments. The renderer takes `(sim, net, input, camera)` and nothing else, so
swapping it is a file, not a refactor. Committing to Canvas2D now buys faster
iteration on the thing that's actually uncertain (is the loop fun), not on the
thing that isn't (can a browser draw 4,000 lines).

Bundle: **17KB of JS, 6.5KB gzipped, measured.** That is an .io-appropriate
instant-play footprint and it should stay that way.

---

## 6. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Transport | `ws` (Node) | Boring, correct, ~200 concurrent sockets without thinking about it. `uWebSockets.js` is 3–5× faster but has a worse API and worse deploy story; move only if you exceed ~500 concurrent, which is a *good* problem. |
| Codec | JSON behind `encode()`/`decode()` | At 0.66 KB/s per client, binary framing optimises a non-problem while making every bug harder to see in DevTools. The two functions are the seam; swap them later. |
| Loop | absolute-schedule `setTimeout` | `setInterval` drifts and Node timers are only good to a few ms. The loop targets `origin + n·BEAT_MS` and catches up. |
| Runtime | Node 22 + `tsx` | Global `WebSocket` in Node 22 means the *real client netcode* runs headless in tests. That is worth more than Bun's throughput here. |
| Client render | Canvas2D | §5. |
| Bundler | Vite | Zero config, instant HMR, `/ws` proxy in dev so the client has one code path for dev and prod. |
| Shared | plain `shared/` folder, TS path resolution | Not just shared *types* — the shared **simulation**. `Sim` is imported unmodified by server and client. |
| Deploy | one Node process serving static + WS on one port | Fly.io / Railway / Render. Note the regional caveat in §8. |

The anti-divergence argument is the important one: the classic failure mode in
this style of netcode is a server sim and a client sim that agree at commit time
and disagree by minute four. The defence isn't discipline, it's making it
*impossible* — one `Sim` class, one `constants.ts`, no duplicated rules, plus a
hash comparison every second that makes any divergence loud immediately.

---

## 7. Vertical slice scope

**Built:** shared board · server-side metronome · drag-to-route on the 8-direction
lattice · pulse propagation at 1 cell/beat with fan-out · one node type (plain
`1`) · capture scoring + hold income · N players live on one board · ghost
rendering · clock sync · checkpoint rollback · hash-based divergence detection ·
injectable latency/jitter for testing · headless soak + timing probe.

**Since the slice**, three passes have landed on top of the above: a menu/settings/
theme/avatar **client shell** (§9), a score-gated **progression + attack** system —
Surge and Via Blower — (§10), and a **leaderboard**. All re-verified against the
determinism suite.

**Deliberately not built, named so they don't get silently forgotten:**
COINCIDE (`2`) and clocked (`◷n`) node specs · inverter (`¬`) nodes · repeaters,
fan-out strength decay, buffer insertion · vias and crossing · power budget and
brownout · trace decay and congestion pressure · round timer · the full 8-hue
polish pass · mobile input.

---

## 8. What will actually be hard — read this part twice

1. **Clock sync is where the "it feels laggy" bugs live, not the netcode.** The
   sim can be perfect while the *playhead estimate* wobbles, and it presents as
   pulses that stutter or jump. Symptoms to watch: `rtt` spiking, playhead spread
   between tabs growing past ~2 ticks. Mitigation already in: min-RTT filtering.
   Likely future need: slew the offset gradually instead of snapping it.

2. **Background tabs.** `requestAnimationFrame` stops when hidden and timers
   throttle to 1Hz. Come back after 30s and a naive client tries to simulate
   14,000 ticks in one frame. Handled here by bailing to a resync past 720 ticks
   behind — but every future feature must respect that path.

3. **The diagonal 17/12 ratio is a design decision wearing a tech costume.**
   See §3. Decide the COINCIDE tolerance window on purpose.

4. **Crosstalk is the expensive future feature.** Everything in the slice is
   O(pulses). Crosstalk is O(overdriven trace length × 8) *per tick*, and if
   surges are common late-round with 40 players it is the first thing that
   will actually cost server CPU. It's still cheap in absolute terms on the flat
   grid — but it's the one deferred mechanic that changes the performance shape,
   so prototype it with the bench, not by feel.

5. **One shared board means one region.** A single arena on one host gives
   Manila 250ms+ against Virginia. The commit horizon makes that *fair* (both
   players wait the same 375ms) but not *equal* — the far player misses more
   beat deadlines in a corridor race. Regional boards are the answer, and
   "regional boards" means the whole leaderboard/identity story changes. Worth
   deciding early, not after the arena code hardens.

6. **Freehand drag → lattice path is fussier than it looks.** It's ~60 lines
   here and it's the single most-touched piece of UX in the game. The serpentine
   detour — the game's best moment per the design doc — is *entirely* an input
   problem. Budget real time for it; it will need undo, snapping, and probably
   a shift-to-constrain modifier.

7. **Griefing by enclosure.** Nothing stops a player walling a rival's source in.
   The design's answer is trace decay and the power budget making sprawl costly;
   neither is built yet. Don't playtest "is it fun" with strangers until at least
   decay exists.

8. **Deleting your own traces isn't designed yet.** Pruning is core to the power
   budget mechanic and there is currently no verb for it. That's a design gap the
   slice exposed, not a bug.

---

## 9. Client shell — menu, cosmetics, and the one channel that isn't the sim

The menu/settings/leaderboard/tutorial are pure client state (`settings.ts` →
`localStorage`, `theme.ts`, `menu.ts`). None of it enters the sim: themes only
remap render colours (the hash mixes `hueIdx`, never the colour value), and the
socket simply opens later, with the chosen callsign in the existing `name` param.

**Audio** (`audio.ts`) is the same shape: a pure read of derived state, driven
from the render loop, entirely synthesized (Web Audio, no samples, ~1 KB gz). The
one subtlety is rollback-safety — beat/measure hooks fire off a per-frame beat
diff (a rollback that rewinds and replays inside one frame is invisible to it),
and captures are detected by diffing node holders per frame rather than hooking
`applyEvent` (which replays would double-trigger). It never calls into the sim.

The one genuinely new wire feature is **broadcast avatars**, and the important
decision is what it is *not*: it is **not** a `SimEvent`. Image data must never
enter the deterministic core, because everything there is hashed, snapshotted,
and checkpointed 8×/second — a few KB of JPEG per player would bloat every
snapshot and put non-determinism-relevant bytes inside the integrity hash.

So avatars ride a separate cosmetic channel:

```
client → { t:'avatar', data }         room stores slot→dataURL, relays to all
server → { t:'avatar', slot, data }    also replayed to each newcomer on join
```

`room.ts` validates shape + a hard `AVATAR_MAX_CHARS` size cap and stores the map
outside `Sim`; `net.ts` keeps a slot→`Image` map the renderer reads when drawing
sources. Headless soak + timing probe are unaffected (bots send no avatars, and
the channel touches no simulated state) and were re-run green after the change.
**Known gap:** there is a size/type guard but no real content moderation — that is
required before exposing avatars to strangers.

---

## 10. Progression & attacks — where the split falls

Attacks (Surge, Via Blower) are the first mechanic to write to the board on
someone else's behalf, so they are also the first real test of the "one `Sim`,
everything derived" discipline. The rule the whole netcode rests on — a client
never states an outcome, only an intent — still holds: an attack is a one-line
intent (`{t:'surge', cell}` / `{t:'viaBlow', cell}`), and the server turns it into
a stamped `SimEvent` on the same 375ms commit horizon as a trace. Every client
then applies that event through the identical `applySurge` / `applyViaBlow`.

The design decision that keeps it deterministic is **where each rule lives**:

```
lives in the SIM (pure, hashed, replicated identically everywhere)
  the effect          clear hostile WIRE in a 5×5 blast / remove one enemy via
  the score cost      p.score -= COST, deducted at the commit beat
  target re-validation own-origin / is-a-via / affordability → else clean no-op

lives on the SERVER only (has a wall clock; must NOT touch the sim)
  the tier gate        score ≥ SURGE_MIN_SCORE / VIA_MIN_SCORE
  the cooldown         performance.now() − lastFireMs, like INTENT_MIN_GAP_MS
```

Putting the cost and effect in the sim means all machines agree on the result;
keeping the cooldown out of the sim respects rule #3 (the sim has no clock). A
stale gate — server said yes, but by the commit beat the target moved or the
score dropped — can only make the attack **whiff**, because the sim re-checks and
no-ops. It can never desync. Crucially, **no new persistent state** was added, so
`hash()`, `snapshot()`, and `checkpoint()` are untouched; the events only mutate
`owner`/`out`/`kind`/`pulses`/`score`, all already covered.

This is verified, not asserted: the headless soak was extended to fire surges and
via-blows once bots cross the score gates, and a 60s / 4-client / 150±50ms run
with a bot reaching 557 (both attacks firing repeatedly) held **0 drift, 0
rollbacks, every hash matched every second**. The `17/12` cost stays the tuning
lever on timing; `SURGE_RADIUS` and the score costs are the levers on how brutal
offence feels.

### The Jammer — the one persistent entity

Surge and Via Blower touch only state that was already hashed. The **Jammer**
(Tier 3, permanent, recurring EMI once per measure) is the exception: it is the
first entity that *lives on the board over time*, so it is the first thing that
had to be threaded through all three persistence surfaces —

```
hash()             adds the sorted jammers map to the digest
snapshot/restore   carries jammers[] (join / resync)
checkpoint/rollback carries jammers[] (the ≤8-beat rewrite path)
jammerEmit()       iterates jammers in cell order → identical on every machine
```

It is counterable rather than eternal: a rival's Surge (area) or Via Blower
(targeted) clears its cell, so the ladder answers itself. Because the soak can't
reliably reach the 900 gate, determinism here is proven directly by
`npm run simtest` (`tools/jammertest.ts`): two independent sims stay hash-identical
across 400 ticks with jammers active, and a placed jammer survives snapshot and
checkpoint round-trips with an unchanged hash. This is the template for every
future persistent mechanic (repeaters, decay, the power budget): if it survives a
tick, it goes in the hash, the snapshot, and the checkpoint, or it will desync.
