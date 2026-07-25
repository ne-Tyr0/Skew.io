# SKEW.IO

**A real-time, browser-based multiplayer `.io` game about routing signals on a shared grid.**
Draw wires from your base to the glowing squares, capture them for points, and disrupt
your rivals — all in lockstep over the network, with bots to fill the arena.

![bundle](https://img.shields.io/badge/client_bundle-~12KB_gzipped-brightgreen)
![netcode](https://img.shields.io/badge/netcode-deterministic_lockstep-blue)
![stack](https://img.shields.io/badge/TypeScript-Node%20%2B%20Vite-3178c6)
![deps](https://img.shields.io/badge/runtime_deps-1_(ws)-lightgrey)

---

## 🎮 Live demo

_No hosted demo yet — you can put one online in about 5 minutes (free). See **[Deploy a live demo](#-deploy-a-live-demo)** below, then drop your URL here._

## What is it?

Everyone shares one board. **Your goal:** draw wires from your diamond (your base) to the
glowing squares. Reaching a square captures it, and it pays you points every few seconds —
hold the most to win. As your score climbs you unlock attacks to wreck rivals' wires.

The interesting part is under the hood: the whole game is **server-authoritative
deterministic lockstep**. The network never sends where anything *is* — only the handful of
player *intents* ("draw a wire here") — and every client recomputes the identical world from
them, verified by a state hash every second. That's what keeps 40 players on a 128×128 board
inside a ~12 KB gzipped client with ~1 Mbit/s of total server traffic.

## Features

- **Live multiplayer** on one shared board, with a ghost-render trick that hides the network
  delay so your own input feels instant.
- **AI bots** (`--bots N`) that fill the arena — they run in-process and emit the same events
  as humans, so they cost nothing in determinism.
- **A three-tier attack ladder** — Blast (area), Snipe (one junction), and a permanent Jammer
  — unlocked by score, so new players get a grace period.
- **Generative audio** synthesized in the browser (no sample files): the busier the board,
  the busier the music.
- **Menu, themes, avatars, leaderboard, zoom + minimap, onboarding hints.**
- **A real test suite for the netcode** — a headless soak that runs N real clients and asserts
  bit-identical state, a timing probe, and a determinism unit test.

## Quick start (run it locally)

> The project lives in the [`skew-slice/`](skew-slice/) subfolder.

```bash
cd skew-slice
npm install
npm run dev -- --bots 6        # server :8787 + client :5173, with 6 AI players
```

Open **http://localhost:5173** — the tutorial explains the rest. Open a second tab (or share
with a friend) to see real multiplayer.

Handy scripts (run from `skew-slice/`):

```bash
npm run dev            # local dev, no bots
npm run build          # build the client for production
npm start              # production: one Node process serves client + WebSocket on :8787
npm run check          # typecheck
npm run headless -- 6 18 150 50   # netcode soak: 6 clients, 18s, 150±50ms latency
npm run simtest        # determinism unit test
```

## 🚀 Deploy a live demo

The production build is **one Node process** that serves the built client *and* the WebSocket
on a single port — perfect for a free host like **Render**, **Railway**, or **Fly.io**.

The fastest path (Render, free tier, ~5 min) — full click-by-click steps are in the
[detailed README](skew-slice/README.md#deploy) — is essentially:

1. Push this repo to GitHub (already done).
2. New **Web Service** → connect this repo → set **Root Directory** to `skew-slice`.
3. **Build:** `npm install --include=dev && npm run build` · **Start:** `npm start`
4. Add env var `BOTS=6` (so the demo isn't empty). `PORT` is provided by the host.
5. Deploy, then share the URL.

## How it works / go deeper

- **[`skew-slice/README.md`](skew-slice/README.md)** — the hands-on guide: controls, what to
  test, the progression/attack system, the HUD, and deployment details.
- **[`skew-slice/docs/ARCHITECTURE.md`](skew-slice/docs/ARCHITECTURE.md)** — the real design
  doc: the determinism model, the state-sync math, the netcode, rendering, and every hard part
  called out on purpose.

## Repo layout

```
skew-slice/            ← the project (run all commands from here)
  shared/    the deterministic sim, imported unmodified by BOTH client and server
  server/    authoritative game loop + WebSocket + bots
  client/    Canvas2D renderer, input, netcode, menu, audio
  tools/     headless soak · timing probe · determinism test
  docs/      ARCHITECTURE.md
```

## Tech

TypeScript · Node 22 + [`ws`](https://github.com/websockets/ws) · Vite · Canvas2D · Web Audio.
One shared `Sim` class runs identically on the server and every client — that shared
determinism, not discipline, is what keeps them from drifting apart.
