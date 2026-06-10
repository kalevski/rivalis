# Orchestrator chat

Where the [simple client/server chat](../client-server-chat) hosts one
hard-coded room, this demo shows Rivalis' **orchestration layer**: rooms are
created, routed to, and torn down *dynamically*.

A single server registers one room *class* and then never pre-creates anything.
An `Orchestrator` reacts to demand instead:

- the first client to ask for a room name causes the orchestrator to **spin
  that room up**,
- every client is **routed** into the room named in its ticket,
- when a room's **last actor leaves**, the orchestrator **disposes** it, so the
  server never holds idle rooms.

Because each room only broadcasts to its own actors, messages are **scoped per
room**: two clients in different rooms never see each other's chat, while two in
the same room do — that contrast is the whole point of the demo.

## How it works

Both server and client are plain Node processes:

- the **server** uses [`@rivalis/core`](../../core) (`Rivalis` + `WSTransport`
  + a `Room` + the `rooms` registry),
- the **client** is a CLI that uses the Node WebSocket client that ships inside
  `@rivalis/core` as `Clients.WSClient`.

The moving parts:

- **Ticket** — a client connects with `"<name>|<room>"`. `ChatAuthMiddleware`
  validates it and, crucially, calls `orchestrator.ensureRoom(room)` *before*
  returning the room id — `TLayer.grantAccess` rejects a join whose target
  room does not yet exist, so on-demand creation has to happen in the auth step.
- **Orchestrator** (`src/server/Orchestrator.ts`) — owns room lifecycle on top
  of the `rivalis.rooms` registry: `ensureRoom` calls `rooms.create(...)` on
  first reference (idempotent for repeat joiners); `releaseIfEmpty` calls
  `rooms.destroy(...)` once a room's `actorCount` hits zero.
- **ChatRoom** (`src/server/ChatRoom.ts`) — one instance per live room, its id
  being the room name. It sets `presence = true` for free join/leave
  notifications, re-broadcasts `chat` frames to its own actors, and in
  `onLeave` hands itself back to the orchestrator for disposal when it empties.

The orchestrator is shared via a small module singleton because the `Room`
constructor signature is fixed by the framework and cannot take an injected
reference. Payloads are opaque bytes to Rivalis; `src/protocol.ts` encodes and
decodes the small JSON shapes both sides share.

## Run it

From the **repo root**, install once so every workspace (including this demo)
is linked, then build so `@rivalis/core` produces the `lib/` output this demo
imports:

```sh
npm install
npm run build
```

Then, from this directory (`demos/orchestrator-chat/`):

**1. Start the server** (terminal 1):

```sh
npm start
```

You should see `orchestrator chat server listening on ws://localhost:8080`. No
rooms exist yet — they appear as clients connect.

**2. Two clients in the *same* room** (terminals 2 and 3):

```sh
npm run client -- alice red
npm run client -- bob red
```

Type in either — the message shows up in the other, and each prints
`* <name> joined` / `* <name> left`. The server logs
`[orchestrator] spun up room "red"` when the first one connects.

**3. A client in a *different* room** (terminal 4):

```sh
npm run client -- carol blue
```

Carol is in `blue`. Messages between Alice and Bob (`red`) never reach her, and
hers never reach them — routing is per-room. The server logs a second
`spun up room "blue"`.

**4. Watch teardown.** Close Carol (`Ctrl+C` or `Ctrl+D`). She was the only one
in `blue`, so the server logs `[orchestrator] disposed empty room "blue"`. Close
Alice and Bob and `red` is disposed too — the server returns to holding zero
rooms.

> Each client runs in its own terminal because it is interactive (each owns its
> stdin). Open as many as you like, in as many rooms as you like.

### Running from the repo root

You can target the workspace by name instead of `cd`-ing in:

```sh
npm start -w @rivalis/demo-orchestrator-chat
npm run client -w @rivalis/demo-orchestrator-chat -- alice red
```

### Options

- arg 1 — display name (1–20 chars, letters/digits/`_`/`-`). Default: a random
  `guest-NNNN`.
- arg 2 — room name (1–32 chars, same charset). Default: `lobby`.
- `PORT` — server listen port (default `8080`).
- `RIVALIS_URL` — client connection URL (default `ws://localhost:8080`).
- `NAME` / `ROOM` — env-var fallbacks for the two positional args.
- `npm run dev` — like `npm start`, but restarts the server on source changes.

## Contrast with the simple chat demo

| | [client-server-chat](../client-server-chat) | orchestrator-chat |
| --- | --- | --- |
| Rooms | one, pre-created at boot | many, created on demand |
| Routing | everyone in the same room | routed by room name in the ticket |
| Teardown | room lives for the server's lifetime | disposed when its last actor leaves |
| Point | "hello world" broadcast | **dynamic room management** |
