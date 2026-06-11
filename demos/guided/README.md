# Rivalis — Guided Tutorial Series

A step-by-step tutorial ladder that walks through the Rivalis API one capability
at a time. Start at level 01 and work through to 06; each level builds on what
came before it.

## Levels

| # | Directory | What it teaches | Key APIs introduced |
|---|-----------|-----------------|---------------------|
| 01 | `01-hello-room` | Stand up the simplest possible Rivalis server, connect a single actor, and exchange one message | `Rivalis`, `Room`, `Actor`, `Transport`, `Client` |
| 02 | `02-topics-and-broadcast` | Publish to named topics and broadcast to all connected actors | `Topic`, `broadcast` |
| 03 | `03-auth-and-limits` | Require actor authentication and enforce per-room connection limits | `AuthProvider`, `RoomOptions` |
| 04 | `04-shared-state-tlayer` | Synchronise shared room state across all clients using the T-layer | `StateLayer`, `StateMap` |
| 05 | `05-multi-room-manager` | Create, route between, and dispose rooms on demand with an orchestrator | `RoomManager` |
| 06 | `06-capstone-realtime` | Combine every capability into a single real-time application | all of the above |

## How to run a level

All tutorial packages are wired into the root npm workspace. After a single
install from the repo root:

```sh
npm install
```

run any level by targeting its workspace package. Every level defines a `start`
script and a `dev` script (live-reload via nodemon):

```sh
# replace <level> with e.g. 01-hello-room
npm run dev -w @rivalis/guided-<level>
```

For levels that include a separate client process, the same package exposes a
`client` script:

```sh
npm run client -w @rivalis/guided-<level>
```

Read each level's own README for the exact commands and a walkthrough of the
code.
