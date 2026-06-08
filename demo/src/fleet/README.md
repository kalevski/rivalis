# `@rivalis/fleet` demo — orchestrator & matchmaker

A self-contained **control plane**: an **Orchestrator** (the fleet control
plane) plus a **Matchmaker** built on the fleet API. It does **not** start game
instances — the demo game server registers itself as one when you run it with
its `FleetAgent` enabled.

It walks the two jobs the fleet does:

- **Orchestrator** — discovers instances, creates/destroys rooms on them
  remotely (acknowledged commands), and drains an instance for a deploy.
- **Matchmaker** — pairs players and asks the fleet to place each match room
  "somewhere sensible": least-loaded by default, or pinned to a region.

> Matchmaking *logic* (queues, ranking) is a non-goal of `@rivalis/fleet` — you
> build it on top of the fleet API, which is exactly what `Matchmaker.ts` shows.

## Run

Two processes. First the orchestrator (from the repo root):

```bash
npm run fleet -w @rivalis/demo
```

Then, in another terminal, the demo server **with its FleetAgent enabled** so it
self-registers as a game instance:

```bash
FLEET=1 npm run dev:server -w @rivalis/demo
```

Optionally name the instance and tag a region (for region-pinned placement):

```bash
FLEET=1 FLEET_INSTANCE_NAME=eu1 FLEET_REGION=eu npm run dev:server -w @rivalis/demo
```

## Server env vars

The server attaches a `FleetAgent` only when `FLEET` is set:

| Variable             | Default                  | Notes                                  |
|----------------------|--------------------------|----------------------------------------|
| `FLEET`              | (unset → no agent)       | Any value enables the agent.           |
| `FLEET_ORCH_URL`     | `ws://localhost:7350`    | Orchestrator WS control-plane URL.     |
| `FLEET_AGENT_KEY`    | demo agent key           | Must match the orchestrator's agentKey.|
| `FLEET_INSTANCE_NAME`| `demo`                   | Human-readable instance name.          |
| `FLEET_REGION`       | (none)                   | Sets the `region` placement label.     |

## What you'll see

1. **Discovery** — the orchestrator waits; when the server registers it lists 1
   instance (plus its local rooms: lobby/counter/ttt/arena).
2. **Matchmaking** — players are paired and a `match` room is placed per pair
   (least-loaded). The output shows which instance each match landed on.
3. **Control plane** — the orchestrator lingers (Ctrl-C to stop) so you can poke
   the REST `/v1` API while it runs.

## Ports

| Component     | Port | Notes                                   |
|---------------|------|-----------------------------------------|
| Orchestrator  | 7350 | agent WS + REST `/v1` (control plane)   |
| Demo server   | 2334 | game-client WS + static client          |

## Poke the REST control plane

While it runs, the same orchestrator serves the admin REST API:

```bash
curl -H "Authorization: Bearer fleet-demo-admin-key-change-me!!" \
  http://localhost:7350/v1/instances
```

## Files

| File              | Role                                                        |
|-------------------|-------------------------------------------------------------|
| `index.ts`        | Starts the orchestrator and runs the matchmaking scenario.  |
| `Matchmaker.ts`   | Queue + placement built on `orchestrator.fleet`.            |
| `protocol.ts`     | Shared constants (ports, keys, `match` room type) + codec.  |
| `util.ts`         | `waitFor` read-model convergence + fleet table printer.     |

The game instance itself (the `FleetAgent` + `match` room) lives in
`demo/src/server` (`index.ts`, `MatchRoom.ts`).

Keys here are dev placeholders — load real ones from env in production (the
fleet refuses weak or audience-crossing keys when `NODE_ENV=production`).
