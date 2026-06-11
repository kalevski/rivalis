# p2p-host-session

**Host-authoritative shared session** — the most complex P2P scenario in the
Rivalis demo suite.  One peer acts as host, owns the authoritative shared
state, applies peer inputs on a fixed tick, and broadcasts consistent snapshots
to every connected peer.  This is the P2P analogue of an authoritative game
server, but with a single peer filling that role.

## What it demonstrates

| Concept | Where |
|---------|-------|
| Host-authoritative state | `WorldRoom` holds scores; only the host mutates them |
| Fixed server tick | `setInterval(TICK_MS)` in `WorldRoom.onCreate` |
| Full-state broadcast | `broadcast(TOPIC.SNAPSHOT, ...)` after every tick |
| Late-join sync | `onJoin` sends the current snapshot before the next tick |
| More than two peers | Run as many `npm run peer` processes as you like |
| Host-departure handling | `SESSION_END` broadcast + `rivalis.shutdown()` |

## Architecture

```
Signal server (WSTransport + SignalRoom)
    │
    │  WebSocket (SDP / ICE relay only)
    │
    ▼
Host (Rivalis + RTCTransport + WorldRoom)
    │
    │  WebRTC DataChannel (per peer)
    ├──────────────────────► Peer A (RTCClient)
    ├──────────────────────► Peer B (RTCClient)
    └──────────────────────► Peer C (RTCClient)
```

After the WebRTC handshake the signal server sees **zero** game traffic.  All
state flows directly over the DataChannels.

## Authoritative-host model

The host runs a `Room` backed by `RTCTransport`.  Peers are actors in that
room.  The host is **not** an actor — it is the authority.

```
Peer → (world:input)  → Host: applies input, updates score
Host → (world:snapshot) → All peers: full state every tick
```

Only the host calls `this.scores.set(...)`.  Peers send commands; the host
decides what effect they have.  This prevents any peer from cheating by
sending an inflated score.

### Tick / sync flow

```
setInterval(TICK_MS)
   └─ tick++
   └─ broadcast(TOPIC.SNAPSHOT, buildSnapshot())
         └─ actor.send() for every connected peer
              └─ RTCTransport encodes + sends over DataChannel
```

`TICK_MS` defaults to **1 000 ms** (1 Hz).  Adjust `TICK_MS` in
`src/constants.ts` to change the tick rate.

### Late-join sync

`onJoin` sends the current snapshot **immediately** when a peer connects,
before the next tick fires:

```ts
protected override onJoin(actor: Actor<ActorData>): void {
    this.scores.set(actor.id, 0)
    actor.send(TOPIC.SNAPSHOT, encode(this.buildSnapshot()))
    // ...
}
```

The newcomer sees the current scoreboard at once rather than waiting up to
`TICK_MS` for the next broadcast.

### What happens when the host leaves

The host is the **single point of authority** in the star topology.  When it
leaves, every peer loses its session.  The sequence:

1. Host catches `SIGINT`.
2. Host calls `room.broadcast(TOPIC.SESSION_END, { reason: 'host is shutting down' })`.
   All connected peers receive the session-end message over their open
   DataChannels.
3. Host calls `rivalis.shutdown()`:
   - `rooms.destroy(ROOM_ID)` — kicks every actor with reason `ROOM_DESTROYED`.
   - `transport.dispose()` — sends a `§3.4 __rivalis:close` control frame with
     code `SERVER_SHUTDOWN` over each DataChannel, then closes the channel.
4. Each peer's `RTCClient`:
   - emits `client:kicked` with reason `server_shutdown`.
   - emits `client:disconnect`.
   - The reconnect loop is suppressed by `NO_RECONNECT_CODES` (SERVER_SHUTDOWN
     is in that set), so the peer exits cleanly rather than retrying forever.

The peer process in this demo listens for `SESSION_END` to print a human-readable
message, then exits on the subsequent `client:kicked` / `client:disconnect`.

**There is currently no host-handoff / host-election mechanism** in this demo.
If you need session continuity after the host leaves, see `p2p.md §12 Phase 3`
(host handoff, not yet implemented) or migrate to a dedicated server using
`WSTransport`.

## Protocol topics

| Topic | Direction | Payload |
|-------|-----------|---------|
| `world:input` | peer → host | `{ action: 'up' \| 'down' }` |
| `world:snapshot` | host → all | `{ tick, peers: [{ id, name, score }] }` |
| `world:peer_join` | host → all | `{ id, name }` |
| `world:peer_leave` | host → all | `{ id, name }` |
| `world:session_end` | host → all | `{ reason }` |

## How to run

You need three terminal windows.

### 1 — Signal server

```
npm run signal
```

Starts on `ws://localhost:8082`.  Leave this running throughout.

### 2 — Host

```
npm run host
```

The host connects to the signal server **first** so it is elected the WebRTC
negotiation host in `SignalRoom`.  It creates the authoritative `WorldRoom` and
waits for peers.

### 3+ — Peers

Open a new terminal for each peer:

```
npm run peer -- alice
npm run peer -- bob
npm run peer -- carol
```

Or use the `NAME` env variable:

```
NAME=dave npm run peer
```

Once connected, each peer sees a live scoreboard that updates every second.
Type `up` or `down` and press Enter to change your score.  The host applies
the input; the next snapshot tick will reflect the change for all peers.

### Stopping

Press `Ctrl-C` in the **host** window to shut down the session.  All peer
terminals will print the session-end message and exit automatically.

Press `Ctrl-C` in a **peer** window to disconnect that peer only; other peers
remain connected.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNAL_URL` | `ws://localhost:8082` | Signal server URL (host + peers) |
| `PORT` | `8082` | Signal server listen port |
| `ICE_STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs |
| `NAME` | random `peer-NNNN` | Peer display name |
