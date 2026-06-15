# Pac-Man

A real-time, multiplayer Pac-Man that shows off Rivalis's **authoritative
server** model: the server owns and simulates the entire game — the maze,
the pellets, the ghosts, and every player's Pac-Man — and broadcasts the
state 30 times a second. Browser clients send only *intent* (the direction
you'd like to go) and render whatever authoritative snapshot they receive.

Open it in two tabs and you'll see both Pac-Men move around the same maze in
real time, eating pellets and dodging four ghosts.

- the **server** uses [`@rivalis/core`](../../core) (`Rivalis` + `WSTransport`
  + a ticking `Room`),
- the **client** is a plain-TypeScript `<canvas>` app that uses
  [`@rivalis/browser`](../../browser)'s `WSClient`.

## How it works

- **One room, server-owned simulation.** `PacmanRoom` runs a fixed-rate
  (`setInterval`, 30 Hz) loop that moves every entity tile-by-tile through the
  maze, eats pellets, runs the ghost AI, and resolves ghost↔player collisions.
  Nothing about positions is trusted from clients.
- **Clients send intent, not positions.** Pressing <kbd>WASD</kbd> /
  <kbd>arrow keys</kbd> sends a tiny `input` frame *only when your desired
  direction changes*. The server stores it as your Pac-Man's "wanted"
  direction and turns you down that corridor at the next junction — exactly
  like the arcade game.
- **The maze is shared, not streamed.** The static grid lives in
  `src/protocol.ts` and both sides import it, so each tick only carries the
  dynamic bits: entity positions, scores, and pellet events. A freshly-joined
  client gets a one-off `welcome` frame listing already-eaten pellets so its
  board matches everyone else's.
- **Scoring.** Pellets are worth 10, power pellets 50. A ghost catching you
  respawns your Pac-Man and costs 20 points (floored at 0). Clear the board
  and it refills so play continues.

Payloads are opaque bytes to Rivalis; `src/protocol.ts` holds the small JSON
shapes both sides share, plus the maze and game constants.

## Run it

From the **repo root**, install once so every workspace is linked, then build
so `@rivalis/core` and `@rivalis/browser` produce the `lib/` output this demo
imports:

```sh
npm install
npm run build
```

Then pick either way to play.

### Option A — dev mode (auto-reload)

From this directory (`demos/pacman/`):

```sh
npm run dev
```

This starts two things at once:

- the **game server** on `http://localhost:2335` (also the WebSocket
  endpoint), and
- the **Vite dev client** on `http://localhost:5173`.

Open **http://localhost:5173 in two browser tabs**, pick a name in each, and
play. The server restarts on source changes.

### Option B — built client

Build the client to `build/`, then start the server that serves it:

```sh
npm run build      # already done above if you ran the repo-root build
npm start
```

Open **http://localhost:2335 in two browser tabs** and play.

> The WebSocket server always listens on `:2335`, whether the page is served
> by Vite (dev) or by the game server (built) — open as many tabs/players as
> you like.

### Running from the repo root

You can target the workspace by name instead of `cd`-ing in:

```sh
npm run dev -w @rivalis/demo-pacman
npm start  -w @rivalis/demo-pacman
```

### Options

- `PORT` — server listen port (default `2335`). If you change it, update the
  `2335` in `src/client/index.ts` to match.

## Controls

- **Move:** <kbd>W</kbd>/<kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd> or the arrow
  keys.
- Eat every pellet, avoid the ghosts.
