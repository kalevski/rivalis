# `@rivalis/node`

> Node.js `RTCTransport` and `RTCClient` for Rivalis — WebRTC data channels over `node-datachannel`.

`@rivalis/node` lets a Node process act as a **P2P game host** (`RTCTransport`) or as a
**Node peer** (`RTCClient`) connecting to a host. Game logic is unchanged: `Room` subclasses
written for `WSTransport` run over WebRTC without modification.

```
peer (RTCClient)           @rivalis/signal           host (RTCTransport)
  │  WS connect + ticket ──────────►│                       │
  │◄── signal:welcome {iceServers} ──────────────────────────│
  │  signal:offer ─────────────────►│──── relay ────────────►│
  │◄─────────── signal:answer ───────────────────────────────│
  │  ICE (trickle, both ways via SignalRoom)                  │
  │═══════════════ DataChannel OPEN (DTLS-encrypted) ════════│
  │◄══════════════ game frames (handshake codec) ════════════►│
```

After the channel opens, the signal server sees zero game traffic.

## Install

```sh
npm install @rivalis/node
```

Peer dependencies (must be installed by the host application):

```json
"@rivalis/core": ">=7 <8",
"@rivalis/handshake": ">=6 <7",
"@toolcase/base": "3.x",
"@toolcase/logging": "3.x",
"ws": "8.x"
```

`node-datachannel` is a direct dependency (prebuilt native binary). `werift` (pure TypeScript,
no native build) is an optional dev/CI fallback selected via `RIVALIS_WEBRTC_BACKEND=werift`.

## Quick start — host

```ts
import { Rivalis } from '@rivalis/core'
import { WSTransport } from '@rivalis/core/transports/ws'
import { RTCTransport } from '@rivalis/node'

// Same Room subclass works over both transports — no changes.
const rivalis = new Rivalis<ActorData>({
    transports: [new RTCTransport({ signalUrl: 'ws://signal:9000', ticket: hostTicket })],
    authMiddleware: new ArenaAuthMiddleware(),
})
rivalis.rooms.define('ttt', TttRoom)
rivalis.rooms.create('ttt', 'game-1')
```

Swap to `WSTransport` (or add both to the array) without touching `TttRoom`.

## Quick start — Node peer

```ts
import { RTCClient } from '@rivalis/node'

const client = new RTCClient('ws://signal:9000')
client.on('client:connect', () => console.log('connected'))
client.on('ttt:state', (payload) => render(decode(payload)))
client.connect(ticket)   // ticket validated by the host's AuthMiddleware
client.send('place', encode({ index: 4 }))
```

The `RTCClient` API is identical to `@rivalis/browser`'s `RTCClient` — same `connect`,
`disconnect`, `send`, `on`/`once`/`off`, and the same `ClientEvent` set.

## API

### `RTCTransport`

```ts
import { RTCTransport } from '@rivalis/node'

class RTCTransport extends Transport {
    constructor(options: RTCTransportOptions)
    get sockets(): number          // number of open data channels post-handshake
    dispose(): Promise<void>       // closes all channels, peer connections, and the signal client
}

type RTCTransportOptions = {
    signalUrl: string              // WebSocket URL of @rivalis/signal
    ticket: string                 // host's signaling ticket (identifies this process as the host)
    channelLabel?: string          // data channel label; default 'rivalis'
    maxFrameBytes?: number         // enforce a frame-size ceiling; default RTC_MAX_FRAME_BYTES (16 KiB)
    peerLimiter?: ConnectionLimiter  // optional per-peerId pre-admission gate (see Security)
    unreliableTopics?: ReadonlySet<string> | ((topic: string) => boolean)  // Phase 4 dual-channel
}
```

`RTCTransport` implements the same five-step `Transport` seam as `WSTransport` — `grantAccess`,
inbound `handleMessage`, outbound `on('message')`, `on('kick')`, and `handleClose`. The host
`Room` receives an `Actor` with no indication of which transport admitted it.

**Ticket protocol:** because `RTCDataChannel` has no equivalent of the WebSocket handshake
header, the peer sends its game-room auth ticket as the **first binary message** on the data
channel. `RTCTransport` reads that message, calls `grantAccess(ticket, { kind:'webrtc',
remoteId: peerId })`, then switches to normal game-frame forwarding.

### `RTCClient`

```ts
import { RTCClient } from '@rivalis/node'

class RTCClient<TTopics extends string = string> extends Client<TTopics> {
    constructor(signalUrl: string, options?: RTCClientOptions)
    get connected(): boolean
    connect(ticket?: string): void
    disconnect(): void
    send(topic: string, payload?: Uint8Array | string): void
    // on / once / off — same ClientEvent taxonomy as WSClient
}

type RTCClientOptions = {
    reconnect?: boolean | RTCClientReconnectOptions
    getTicket?: () => string | Promise<string>
    channelReliability?: ChannelReliability    // default { ordered: true }
    dualChannel?: boolean                      // Phase 4; default false
    unreliableTopics?: ReadonlySet<string> | ((topic: string) => boolean)
    adapters?: Partial<RTCAdapters>            // override createPeerConnection for testing
}
```

**Events** — the full `ClientEvent` set:

| Event | Payload | When |
|---|---|---|
| `client:connect` | – | Data channel open (P2P handshake complete) |
| `client:disconnect` | `Uint8Array` | Connection closed (data channel or peer connection) |
| `client:kicked` | `{ code: number, reason: string }` | Host sent a kick (4xxx close code) |
| `client:reconnecting` | `Uint8Array` | Reconnect attempt scheduled |
| `client:reconnect_failed` | – | `maxAttempts` exhausted or `getTicket` threw |
| `client:error` | `Error` | Underlying transport error |
| `<your topic>` | `Uint8Array` | Inbound frame from the host |

Reconnect is opt-in (`reconnect: true`) and reruns the full WebRTC negotiation per attempt.
The same `NO_RECONNECT_CODES` gate as `WSClient` skips reconnect on terminal kicks
(`INVALID_TICKET`, `KICKED`, `ROOM_REJECTED`).

### `SignalClient`

Internal to `RTCTransport` and `RTCClient`; not typically used directly. Wraps the node
`WSClient` for `@rivalis/signal` with typed `signal:*` topics.

## Frame size and chunking

`RTCDataChannel` caps a single SCTP message to ~16 KiB across implementations. Frames larger
than `RTC_MAX_FRAME_BYTES = 16 384` bytes are automatically **chunked before sending and
reassembled before delivery** using the internal topic `__rivalis:chunk`. Chunk/reassemble is
transparent — `Room.broadcast` and `client.on('topic', …)` see full frames only.

**Oversized frames** (>255 chunks, i.e. >~4 MiB) are logged at `warning` level and **dropped
without sending** — never silently truncated. Frames ≤ 16 KiB bypass chunking entirely with no
allocation overhead.

For **unreliable/unordered channels** (Phase 4 dual-channel), frames larger than `RTC_MAX_FRAME_BYTES`
are also dropped with a warning — chunk reassembly depends on ordered delivery and cannot work on
an unordered channel.

## WebRTC backend

The default backend is `node-datachannel` (libdatachannel, prebuilt native binary). For
dev/CI environments without native builds, set:

```sh
RIVALIS_WEBRTC_BACKEND=werift
```

`werift` is a pure-TypeScript WebRTC implementation installed as an optional dependency. Both
backends implement the same `RTCPeerLike` / `RTCDataChannelLike` adapter interfaces, so
`RTCTransport` and `RTCClient` are backend-agnostic.

## Security

### DTLS encryption — no extra work

WebRTC data channels are **DTLS-encrypted by default**. Every byte of game traffic between
a peer and the host is encrypted end-to-end at the transport layer — no configuration required,
no certificates to provision on your side. DTLS is part of the WebRTC specification and is
enforced by both `node-datachannel` and `werift`.

This applies to both legs:

- **Direct connection** (STUN path, peer ↔ host) — DTLS-encrypted.
- **Relayed connection** (TURN path via coturn) — DTLS-encrypted between the peer and the
  TURN server and between the TURN server and the host. The TURN relay sees encrypted bytes
  only; it cannot read game traffic.

There is no opt-out and nothing to enable. If you are auditing traffic between a `RTCClient`
and an `RTCTransport` host, expect to see DTLS records, not plaintext.

### Authentication

Peers are authenticated through `RTCTransport` via `AuthMiddleware.authenticate` — the same
mechanism as `WSTransport`. The peer's game-room ticket is sent as the first binary message on
the data channel (after the DTLS handshake), so the ticket itself is encrypted in transit.
`ConnectionContext { kind: 'webrtc', remoteId: peerId }` is forwarded to
`authenticate`, allowing transport-aware admission decisions.

Use constant-time comparison for ticket secrets — `timingSafeCompare` is exported from
`@rivalis/core`.

### Pre-admission throttle

RTC connections pass through two admission gates before `AuthMiddleware` runs:

| Hop | Where | Mechanism |
|-----|-------|-----------|
| **1 — signaling** | `@rivalis/signal` `WSTransport` | `ConnectionLimiter` per remote IP |
| **2 — game host** | `RTCTransport` | optional `peerLimiter?: ConnectionLimiter` per signaling `peerId` |

The signaling gate is always active. The game-host gate is opt-in:

```ts
import { ConnectionLimiter } from '@rivalis/core'

new RTCTransport({
    signalUrl,
    ticket,
    peerLimiter: new ConnectionLimiter({ maxConnections: 5, windowMs: 60_000 }),
})
```

When the limiter returns `false`, the channel is closed with `CloseCode.RATE_LIMITED` before
`AuthMiddleware` is ever invoked.

### Rate limiting

Game-traffic rate limiting runs inside `TLayer.handleMessage` using the `RateLimiter`
configured on the `Rivalis` instance (`TokenBucketRateLimiter`, default 30 tokens / 30 per
second). This applies to WebRTC peers automatically — no transport-specific work.

### Node host vs browser host

A **Node host** (`RTCTransport` in a Node process) runs in a trusted, controlled environment.
Peers cannot inspect or tamper with its in-memory room state. Use it for competitive or
authoritative games.

A **browser host** (Phase 3, `RTCTransport` from `@rivalis/browser`) runs inside the same
JavaScript environment as every other peer. Suited for casual or co-operative play only. See
`browser/README.md §"Browser-as-host (Phase 3): trust note"` for details.

## License

MIT
