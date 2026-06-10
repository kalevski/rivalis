# Peer-to-peer chat (max 10)

Where the [simple client/server chat](../client-server-chat) routes every
message through an always-on room server, this demo shows Rivalis in a
**peer-to-peer** topology: chat messages travel **directly between peers**, and
Rivalis is used **only for signalling** — the handshake that lets peers find
each other.

Each peer:

- runs its own tiny **direct-link WebSocket endpoint** that other peers dial,
- connects to a small **signalling server** ([`@rivalis/core`](../../core)) just
  long enough to announce its address and learn about the other peers,
- then opens **direct links** to those peers and broadcasts chat across them —
  one hop, sender → recipient, never through the server.

The result is a full mesh: with _n_ peers there are _n × (n−1) / 2_ direct
links, and the signalling server never sees a single chat line.

## The 10-participant cap

The headline constraint — **at most 10 peers per mesh** — is a single named
constant, [`MAX_PEERS`](./src/constants.ts), and it is enforced with Rivalis'
own room primitive rather than any hand-rolled counting:

```ts
class SignalingRoom extends Room<ActorData> {
    override maxActors: number = MAX_PEERS   // the framework does the rest
}
```

When a room sets `maxActors`, the framework's `TLayer.grantAccess` rejects the
next join with reason `room_full` **before** the actor enters the room. Every
peer must register with the signalling server to discover the mesh, so capping
signalling membership caps the mesh. The 11th peer's signalling client receives
a `client:disconnect` whose reason is `room_full`, prints a clear **"room
full"** message, and exits.

## How it works

| Channel | Transport | Carries |
| --- | --- | --- |
| Signalling | Rivalis (`@rivalis/core`) | discovery only: `announce`, `roster`, `peer:join`, `peer:leave` |
| Mesh link | direct peer-to-peer WebSocket (`ws`) | the chat itself: `hello`, `chat` |

The moving parts:

- **`src/signaling/`** — the rendezvous server. `SignalingRoom` keeps a small
  table of announced peers; on `announce` it hands the newcomer the current
  roster and tells everyone else about the newcomer; on leave it broadcasts
  `peer:leave`. It sets `maxActors = MAX_PEERS` and nothing else enforces the
  cap.
- **`src/peer/`** — the peer CLI. `Mesh` owns one inbound `WebSocketServer`
  plus the outbound `WebSocket` clients it dials, and `broadcast()` writes a
  chat frame to every link. To keep exactly one socket per pair, a stable rule
  picks the dialer: the peer with the greater signalling id dials, the other
  waits for the inbound connection.
- **`src/protocol.ts`** / **`src/constants.ts`** — the shared wire shapes and
  knobs (including `MAX_PEERS`).

## Run it

From the **repo root**, install once so every workspace (including this demo)
is linked, then build so `@rivalis/core` produces the `lib/` output this demo
imports:

```sh
npm install
npm run build
```

Then, from this directory (`demos/p2p-chat/`):

**1. Start the signalling server** (terminal 1):

```sh
npm start
```

You should see `p2p signalling server listening on ws://localhost:8080`.

**2. Start a few peers**, each in its own terminal, with a **distinct direct-link
port** (second argument):

```sh
npm run peer -- alice 9001
npm run peer -- bob   9002
npm run peer -- carol 9003
```

Each peer prints `* <name> joined` as others appear and opens a direct link to
them. Type in any peer and the line shows up in **every** other peer — delivered
directly, not via the server. Close one (`Ctrl+C` or `Ctrl+D`) and the rest
print `* <name> left`.

**3. Observe the 10-user limit.** Start ten peers (ports `9001`–`9010`), then
try an eleventh:

```sh
npm run peer -- kilroy 9011
```

The eleventh is refused at signalling and prints:

```
room full — the mesh already has the maximum of 10 participants. Try again once someone leaves.
```

Close any one of the ten and a fresh peer can take the freed slot.

> Each peer runs in its own terminal because it is interactive (each owns its
> stdin). The chat is genuinely peer-to-peer: stop the signalling server after
> everyone has connected and existing peers keep chatting — only new joins and
> leave notifications need it.

### Running from the repo root

You can target the workspace by name instead of `cd`-ing in:

```sh
npm start -w @rivalis/demo-p2p-chat
npm run peer -w @rivalis/demo-p2p-chat -- alice 9001
```

### Options

- arg 1 — display name (1–20 chars). Default: a random `peer-NNNN`.
- arg 2 — this peer's direct-link port (must be free and unique per peer on one
  machine). Default: `9000`.
- `PORT` — signalling server listen port (default `8080`).
- `RIVALIS_URL` — signalling URL the peer connects to (default
  `ws://localhost:8080`).
- `PEER_HOST` — address this peer advertises for direct links (default
  `127.0.0.1`).
- `PEER_PORT` / `NAME` — env-var fallbacks for the two positional args.
- `npm run dev` — like `npm start`, but restarts the signalling server on source
  changes.

## Contrast with the other chat demos

| | [client-server-chat](../client-server-chat) | [orchestrator-chat](../orchestrator-chat) | p2p-chat |
| --- | --- | --- | --- |
| Who relays chat | one server | one server, many rooms | **nobody — direct peer links** |
| Rivalis' role | full transport | full transport + room lifecycle | **signalling / discovery only** |
| Cap | none | none | **`maxActors = 10`, framework-enforced** |
