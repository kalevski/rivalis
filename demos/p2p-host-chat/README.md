# P2P host-star chat

Where the [`p2p-chat`](../p2p-chat) demo builds a **full mesh** (every peer
dials every other peer directly), this demo shows the other common P2P shape:
a **host star**, where a single node acts as the authority and every other
peer connects only to it.

```
          ┌──────────────┐   WebRTC DataChannel
  alice ──►              ◄── bob
          │     host     │
  carol ──►  (ChatRoom)  ◄── dave
          └──────────────┘
```

All chat messages flow **peer → host → all other peers**. The host relays;
peers never open connections to each other.

## How it works

| | `p2p-chat` (mesh) | `p2p-host-chat` (star) |
|---|---|---|
| Topology | full mesh | host star |
| Rivalis role | signalling only | signalling **+** game host |
| Game traffic path | direct between every pair | through the single host |
| Connections per peer | `n − 1` DataChannels | **1** DataChannel (to host) |
| Host is an actor? | no dedicated host | no — host runs the Room |

### Three processes

```
  ┌───────────────┐  WebSocket (SDP/ICE relay)
  │ @rivalis/     │◄────────────────────┬──────────────────┐
  │ signal server │                     │                  │
  │ (SignalRoom)  │                     │                  │
  └───────────────┘                     ▼                  ▼
                                ┌──────────┐       ┌──────────┐
                                │  peer A  │       │  peer B  │
                                │ RTCClient│       │ RTCClient│
                                └────┬─────┘       └─────┬────┘
                                     │  WebRTC DC         │
                                     ▼                    ▼
                              ┌───────────────────────────────┐
                              │  host (Rivalis + RTCTransport)│
                              │       ChatRoom                │
                              └───────────────────────────────┘
```

1. **Signal server** (`src/signal/`) — a minimal Rivalis WS app wrapping
   `@rivalis/signal`'s `SignalRoom`. Its only job is WebRTC negotiation: it
   relays SDP offers/answers and ICE candidates between the host and each
   connecting peer. Zero game traffic passes through it after the DataChannel
   opens.

2. **Host** (`src/host/`) — a Rivalis app with `RTCTransport`. It connects to
   the signal server first, becoming the WebRTC negotiation host (the first
   actor in `SignalRoom` is elected host). It defines and creates a `ChatRoom`
   that relays messages to all connected peers and announces join/leave events.

3. **Peer** (`src/peer/`) — an `RTCClient` that connects to the signal server,
   negotiates WebRTC with the host, opens a DataChannel, and then sends and
   receives chat messages directly over that channel — the signal server is no
   longer involved.

### Ticket format

Both the signal server and the game room use the same ticket string:

```
"chat:<name>"   →   roomId = "chat",  name = "<name>"
```

The signal server uses `roomId` to route the connector into the right
`SignalRoom`. The host's `RTCTransport` receives the same ticket as the first
binary message on the DataChannel and passes it to `ChatAuthMiddleware`, which
extracts `name` and joins the actor to the `"chat"` game room.

## Run it

From the **repo root**, install and build once:

```sh
npm install
npm run build
```

Then, from `demos/p2p-host-chat/`, open **four terminals**:

**Terminal 1 — signal server:**
```sh
npm run signal
```

**Terminal 2 — host** (connect BEFORE any peers so it becomes WebRTC host):
```sh
npm run host
```

**Terminal 3, 4, 5 … — peers** (each with a distinct name):
```sh
npm run peer -- alice
npm run peer -- bob
npm run peer -- carol
```

Type in any peer terminal and the line appears in every other peer. The host
terminal logs join/leave events. Close a peer (`Ctrl+C`) and the remaining
peers print `* <name> left`.

### Running from the repo root

```sh
npm run signal -w @rivalis/demo-p2p-host-chat
npm run host   -w @rivalis/demo-p2p-host-chat
npm run peer   -w @rivalis/demo-p2p-host-chat -- alice
```

### Options

| Env var | Default | Description |
|---|---|---|
| `PORT` | `8081` | Signal server listen port |
| `SIGNAL_URL` | `ws://localhost:8081` | URL that host and peers connect to |
| `ICE_STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs |
| `NAME` | random `peer-NNNN` | Peer display name (fallback for arg 1) |

> **Offline use:** set `ICE_STUN_URLS=stun:localhost:3478` and start a local
> STUN responder (e.g. `RIVALIS_STUN_DEV=true` if using `SignalServer` from
> `@rivalis/signal`). On a single machine, host candidates alone usually
> suffice and no STUN server is needed.

## Contrast with `p2p-chat`

| Concern | `p2p-chat` (mesh) | `p2p-host-chat` (star) |
|---|---|---|
| Programming model | Rivalis as a discovery registry only; no `Room` game logic | Full `Room` subclass on the host; standard Rivalis patterns |
| Message delivery | direct between every pair, never through server | host relays to all — one hop from sender, one hop to each recipient |
| Failure mode | losing one peer only breaks links to that peer | losing the host disconnects everyone |
| Scalability | O(n²) connections | O(n) connections; host is the bottleneck |
| When to use | low latency peer-to-peer; no authoritative state needed | authoritative game state; one trusted host |
