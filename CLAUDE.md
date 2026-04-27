# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

npm workspaces monorepo with three packages:

- `core/` — `@rivalis/core`: NodeJS server framework (published)
- `browser/` — `@rivalis/browser`: browser-side WebSocket client (published)
- `demo/` — `@rivalis/demo`: end-to-end example wiring server + client (private)

Source is authored in JavaScript (`.js`) with JSDoc types. The published packages emit:
- bundled JS via **Parcel** (`lib/main.js`, `lib/module.js`) using each package's `source` field
- ambient `.d.ts` files via **tsc** in `--allowJs --emitDeclarationOnly` mode (no JS compilation by tsc)

There is no `tsconfig.json` — declaration generation flags are passed inline in each package's `build:tsd` script. Editing JSDoc annotations is the only way to influence the generated types.

## Commands

From the repo root:
- `npm install` — install all workspace dependencies
- `npm run build` — build all workspaces (`--workspaces --if-present`); runs `parcel build` then `tsc -d` in each
- `npm run demo` — start the demo (runs `dev` in `@rivalis/demo`, which uses `concurrently` to launch ts-node server + parcel watch client)

Per-workspace (run with `npm run <script> -w @rivalis/core` or by `cd`-ing in):
- `npm run dev` (core/browser) — `nodemon` watches `src/` and re-runs `npm run build` on change
- `npm run build:src` — Parcel bundle only
- `npm run build:tsd` — TypeScript declaration emission only

Demo-specific:
- `npm run dev:server` — ts-node + nodemon on `demo/src/server/index.ts`
- `npm run dev:client` — Parcel watch on `demo/src/client/index.html` → `demo/build/`

There is no test runner, linter, or type-check script configured.

## Core architecture

The runtime is a layered pipeline that separates **transports** (how bytes arrive) from **rooms** (where game/app logic lives). Understanding this split is required to make non-trivial changes.

```
Client socket ─► Transport (e.g. WSTransport) ─► TLayer ─► RoomManager ─► Room ─► Actor handlers
```

**`Rivalis`** (`core/src/Rivalis.js`) — entrypoint. Constructed with a `Config` containing an array of `Transport` instances and an `AuthMiddleware`. It owns one `TLayer` and one `RoomManager`, and calls `transport.onInitialize(transportLayer)` on each transport so they bind to the same shared layer.

**`TLayer`** (`core/src/TLayer.js`) — the transport-agnostic boundary. Every transport calls into TLayer with three lifecycle hooks: `grantAccess(ticket)` on connect, `handleMessage(actorId, bytes)` on incoming frame, `handleClose(actorId)` on disconnect. Outgoing traffic is delivered through an internal `EventEmitter` keyed by `${event}:${actorId}` (events: `message`, `kick`) — transports subscribe per-actor in their connect handler. Adding a new transport means subclassing `Transport`, calling these four methods, and listening on the emitter.

**`AuthMiddleware`** (`core/src/AuthMiddleware.js`) — abstract; subclasses implement `validateTicket`, `extractPayload`, and `getRoomId`. `TLayer.grantAccess` calls all three to validate the ticket, find the target room, and stamp arbitrary actor data. The "ticket" is whatever string the transport extracts from the connection (for `WSTransport` it's the `?ticket=` query param, configurable).

**`RoomManager`** (`core/src/RoomManager.js`) — registry of room *classes* (`define(key, RoomClass)`) and room *instances* (`create(key, [roomId])`). Rooms must extend `Room`; ids are 32-char generated unless provided. Rooms are not auto-created on join — the application must `create()` them before any actor with a matching `getRoomId` ticket connects, or `grantAccess` rejects with `room id=... does not exist`.

**`Room`** (`core/src/Room.js`) — the user-extensible unit. Lifecycle hooks (`onCreate`, `onJoin`, `onLeave`, `onDestroy`) and a topic registry (`bind(topic, listener)`, `unbind`). Inbound dispatch falls back to a `'*'` topic listener if registered; missing both kicks the actor with `invalid_message`. Use `send(actor, topic, payload)` for unicast and `broadcast(topic, payload)` for everyone in the room. Payloads accept `Uint8Array` or `string` (UTF-8 encoded for you).

**`Actor`** (`core/src/Actor.js`) — per-connection handle inside a room. Holds the auth `data` from `extractPayload`, plus a per-actor `Map` storage (`save`/`get`) for stashing room-local state. Wraps `room.send`/`room.kick` for convenience.

**Wire format** (`core/src/serializer.js`, `browser/src/serializer.js`) — both sides use `@toolcase/base`'s `Serializer` with the schema `{ topic: string, payload: bytes }` and model name `'realtime_message'`. Both files must stay in sync; any change to the schema or model name breaks the wire. There is no JSON layer — everything is binary frames.

## Conventions worth knowing

- Logging uses `@toolcase/logging` via the singleton `CustomLoggerFactory.Instance` exposed as `rivalis.logging`. Set the level with `rivalis.logging.level = 'debug' | 'verbose' | ...`.
- IDs (actor, room) come from `generateId(n)` in `@toolcase/base`. Actor ids are 16 chars, room ids 32 chars.
- WebSocket close codes carry meaning: `4001` = bad/missing ticket, `4002` = non-binary frame received, `4003` = kicked (with payload as reason).
- The build pipeline does not optimize/minify (`--no-optimize`); both `main` and `module` targets are emitted unminified. Don't add minification without checking that consumers expect this.
- The `core` and `browser` packages declare `@toolcase/base` and `@toolcase/logging` as **peer** dependencies — both must be installed by the consumer (the root `package.json` has `@toolcase/base` for the workspace).
