# @rivalis/core

[![GitHub](https://img.shields.io/github/license/kalevski/rivalis?style=for-the-badge)](https://github.com/kalevski/rivalis/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@rivalis/core?color=teal&label=VERSION&style=for-the-badge)](https://www.npmjs.com/package/@rivalis/core)
[![npm downloads](https://img.shields.io/npm/dw/@rivalis/core?label=downloads&style=for-the-badge)](https://www.npmjs.com/package/@rivalis/core)

The Node.js server framework for [Rivalis](https://github.com/kalevski/rivalis) — rooms, actors, auth middleware, WebSocket transport, and a binary wire protocol.

## ⭐ Features

- **Rooms** — extend `Room`, bind topics to handlers, broadcast / send / kick.
- **Actors** — per-connection state with auth-supplied data carried throughout the connection's lifetime.
- **Pluggable transport** — `WSTransport` ships out of the box; the `Transport` base class lets you add your own.
- **Pluggable auth** — implement one method (`authenticate(ticket)`) to validate and route every connection.
- **Built-in defaults that don't need tuning** — token-bucket rate limiting, heartbeats, frame & topic size caps.
- **Opt-in protections for the rough edges** — origin allow-list, per-IP connection limiting, ticket-via-subprotocol.
- **Graceful shutdown** — `rivalis.shutdown()` destroys rooms, kicks actors, and disposes transports with a timeout.
- **TypeScript-first** — strict mode + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. Generic over your auth payload type.

## 🚀 Install

```bash
npm install @rivalis/core
```

`@rivalis/core` declares its dependencies as **peers** so you control the versions:

```bash
npm install ws @toolcase/base @toolcase/logging @toolcase/serializer
```

## 🚀 Hello world

A minimal echo server with one chat room:

```ts
import http from 'http'
import {
    Rivalis, Transports, Room, AuthMiddleware,
    type AuthResult, type Actor
} from '@rivalis/core'

type ActorData = { name: string }

class ChatRoom extends Room<ActorData> {
    protected override presence = true   // auto-broadcast __presence:join / leave

    protected override onCreate() {
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor<ActorData>) {
        actor.send('welcome', JSON.stringify({ youAre: actor.data?.name ?? '' }))
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array) {
        // Re-broadcast every chat frame to everyone in the room.
        this.broadcast('chat', payload)
    }
}

class Auth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name || name.length > 20) return null
        return { data: { name }, roomId: 'global' }
    }
}

const server = http.createServer()
const rivalis = new Rivalis<ActorData>({
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new Auth()
})
rivalis.rooms.define('chat', ChatRoom)
rivalis.rooms.create('chat', 'global')
server.listen(8080, () => console.log('ws://localhost:8080'))

process.on('SIGINT', async () => { await rivalis.shutdown(); process.exit(0) })
```

## 🧠 Concepts

### Rivalis

The entrypoint. Owns one `TLayer` and one `RoomManager`; takes an array of transports and one auth middleware:

```ts
const rivalis = new Rivalis<TActorData>({
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new MyAuth(),
    rateLimiter: undefined,  // omit → default token bucket; null → opt out
    logging: undefined,      // omit → built-in console reporter
    maxTopicLength: 256,     // default
    maxPayloadBytes: 65536   // default 64 KiB — core-level inbound payload ceiling
})

rivalis.connections   // joined actors
rivalis.sockets       // open sockets (includes pre-handshake)
rivalis.rooms         // RoomManager
rivalis.logging       // LoggerFactory — set rivalis.logging.level = 'debug'

await rivalis.shutdown({ timeoutMs: 5000 })
```

### Room

`Room<TActorData>` is the user extension point. Subclass it and override the lifecycle:

```ts
class GameRoom extends Room<{ name: string }> {
    override maxActors = 4              // reject 5th joiner with `room_full`
    override joinable = true            // flip to false to refuse new joins (`room_not_joinable`)
    protected override presence = true  // auto __presence:join / __presence:leave broadcasts
    protected override unknownTopicPolicy = 'drop'  // 'kick' (default) | 'drop'

    protected override onCreate() {
        this.bind('move', this.onMove)
        this.bindAny(this.onAnyTopic)   // wildcard fallback (optional)
    }

    protected override onJoin(actor: Actor<{ name: string }>) {
        // actor.send() works synchronously from here — no setImmediate needed.
        actor.send('state', JSON.stringify(this.snapshot()))
    }

    protected override onLeave(actor: Actor<{ name: string }>) { /* cleanup */ }
    protected override onDestroy() { /* dispose external resources */ }

    /**
     * Override to scrub server-only fields out of `actor.data` before
     * presence broadcasts hit other clients.
     */
    protected override presencePayload(actor: Actor<{ name: string }>) {
        return { id: actor.id, name: actor.data?.name }
    }

    private onMove(actor: Actor<{ name: string }>, payload: Uint8Array) {
        // Validate, then broadcast the new state.
        this.broadcast('state', JSON.stringify(this.applyMove(payload)))
    }

    private onAnyTopic(actor: Actor<{ name: string }>, payload: Uint8Array, topic: string) {
        // Receives every frame on a topic that wasn't bound explicitly.
    }

    private snapshot() { return { /* ... */ } }
    private applyMove(payload: Uint8Array) { return { /* ... */ } }
}
```

**Public API:**

| Method | Purpose |
|---|---|
| `bind(topic, listener)` | Register inbound topic handler. Throws on `__`-prefix, `'*'`, or collision. |
| `unbind(topic)` | Returns `true` if a binding was removed. |
| `bindAny(listener)` / `unbindAny()` | Wildcard fallback for any unbound topic. Only one wildcard at a time. |
| `send(actor, topic, payload)` | Unicast. `payload`: `Uint8Array \| string`. |
| `broadcast(topic, payload)` | Fan-out to every actor in the room. |
| `each(fn)` | Iterate the room's actors. |
| `kick(actor, payload?)` | Disconnect an actor with a close-frame reason (≤123 bytes). |
| `destroy()` | Tells the manager to destroy this room. |

The `__` topic prefix is reserved for framework events (`__presence:join`, `__presence:leave`). `bind` / `unbind` reject it.

### Actor

A per-connection handle inside a room. Created by the framework when an actor joins; passed to your lifecycle hooks and topic listeners.

```ts
actor.id          // 16-char CSPRNG-backed id
actor.data        // TActorData | null — whatever your authenticate() returned
actor.joined      // Date
actor.send(topic, payload)
actor.kick(reason?)        // payload: Uint8Array | string
actor.save<T>(key, value)  // per-actor scratch storage
actor.get<T>(key)
```

### AuthMiddleware

Implement one method:

```ts
class JWTAuth extends AuthMiddleware<{ userId: string; tier: 'free' | 'pro' }> {
    override async authenticate(ticket: string) {
        try {
            const claims = await verifyJwt(ticket)  // returns null on bad sig
            if (!claims) return null
            return {
                data: { userId: claims.sub, tier: claims.tier },
                roomId: claims.room
            }
        } catch {
            return null
        }
    }
}
```

Return `null` to reject (closes with `INVALID_TICKET`). Return `{ data, roomId }` to accept — `data` is stamped on `actor.data`, `roomId` routes the actor.

> **Timing-oracle hazard.** Any secret comparison inside `authenticate` (HMACs, signatures, session tokens) must use `crypto.timingSafeEqual` or an equivalent constant-time comparator. `===` and `Buffer.compare` short-circuit on first mismatch and leak the prefix length over enough samples.

For migration from the legacy three-method shape (`validateTicket` / `extractPayload` / `getRoomId`), extend `LegacyAuthMiddleware` instead of `AuthMiddleware` — it ships a default `authenticate` that calls the three. `LegacyAuthMiddleware` is `@deprecated` and will be removed in the next major.

### RoomManager

```ts
rivalis.rooms.define('chat', ChatRoom)        // register a class
rivalis.rooms.create('chat', 'lobby-1')        // instantiate; pass null/omit to auto-generate id
rivalis.rooms.get('lobby-1')                   // Room | null
rivalis.rooms.destroy('lobby-1')               // kicks remaining actors, runs onDestroy

rivalis.rooms.on('create', (id) => { /* ... */ })
rivalis.rooms.on('destroy', (id) => { /* ... */ })
```

Rooms are **not** auto-created on connect. Your application must `create()` rooms before any actor whose ticket maps to that room id can join — otherwise `authenticate` returns a valid `roomId` but `TLayer.grantAccess` rejects with `room id=... does not exist`.

## 🌐 WSTransport options

```ts
new Transports.WSTransport(
    serverOptions,            // ws.ServerOptions (server, port, path, etc.)
    queryTicketParam,         // optional, default 'ticket'
    transportOptions          // WSTransportOptions
)
```

| Option | Default | Description |
|---|---|---|
| `maxPayload` | `64 * 1024` (64 KiB) | Hard cap on a single inbound frame. Caller-passed `serverOptions.maxPayload` honoured if set; this overrides. |
| `heartbeat` | `{ intervalMs: 30000, missThreshold: 2 }` | Ping cadence. `false` to disable. |
| `maxBufferedBytes` | `1024 * 1024` (1 MiB) | Per-socket outbound buffer cap; over the cap, frames are dropped. |
| `onBackpressureDrop` | – | `(actorId, bufferedAmount) => void` — fires on every dropped outbound frame so you can escalate (e.g. kick the slow actor). |
| `allowedOrigins` | – | `ReadonlyArray<string> \| (origin) => boolean` — reject any other `Origin` header before auth runs. Required for CSWSH protection when tickets ride on cookies. |
| `connectionLimiter` | – | A `ConnectionLimiter` subclass — checked before auth on every new socket. Limiter rejection closes with `CloseCode.RATE_LIMITED`. |
| `ticketSource` | `'query'` | `'query'` reads `?ticket=` (default, back-compat). `'protocol'` reads `Sec-WebSocket-Protocol` — preferable in production because subprotocol values don't appear in URL access logs or browser history. |

Tickets are **never** logged in plaintext — only an 8-char SHA-256 fingerprint.

## 🛡️ Rate limiting

The default is opt-out: a fresh `new Rivalis({ ... })` ships a `TokenBucketRateLimiter` at 30 tokens / 30-per-second refill. Tune or disable:

```ts
import { TokenBucketRateLimiter } from '@rivalis/core'

new Rivalis({
    transports: [...],
    authMiddleware: new MyAuth(),

    // Bigger bucket for high-frequency traffic:
    rateLimiter: new TokenBucketRateLimiter({ capacity: 120, refillPerSecond: 60 })

    // …or opt out entirely:
    // rateLimiter: null
})
```

The bucket map is self-bounding so it can't grow without limit under connection
churn (or any path that skips per-actor `release()`): idle buckets are swept once
they age past `idleEvictMs` (default 60 s), and a hard `maxBuckets` LRU cap
(default 100 000) evicts least-recently-used buckets. Both are tunable via
`TokenBucketOptions`; eviction is transparent — an evicted actor's next frame
simply re-creates a full bucket.

Write your own by subclassing `RateLimiter`:

```ts
class FixedWindowLimiter extends RateLimiter {
    private counts = new Map<string, { window: number, count: number }>()
    override check(actorId: string): boolean {
        const window = Math.floor(Date.now() / 1000)
        const entry = this.counts.get(actorId)
        if (!entry || entry.window !== window) {
            this.counts.set(actorId, { window, count: 1 })
            return true
        }
        return ++entry.count <= 60
    }
    override release(actorId: string) { this.counts.delete(actorId) }
}
```

## 🚦 Pre-handshake connection limiting

Cap how many sockets a single IP can open per second. Subclass `ConnectionLimiter`:

```ts
import { ConnectionLimiter } from '@rivalis/core'

class IPLimiter extends ConnectionLimiter {
    private state = new Map<string, { window: number, count: number }>()
    override check(remoteAddress: string): boolean {
        const window = Math.floor(Date.now() / 1000)
        const entry = this.state.get(remoteAddress)
        if (!entry || entry.window !== window) {
            this.state.set(remoteAddress, { window, count: 1 })
            return true
        }
        return ++entry.count <= 10
    }
}

new Transports.WSTransport({ server }, null, {
    connectionLimiter: new IPLimiter()
})
```

> Behind a reverse proxy, `request.socket.remoteAddress` is the proxy. Extract the real client address from `X-Forwarded-For` yourself before passing it to your limiter.

## 🧾 Wire format

Frames are binary: `{ topic: string, payload: bytes }`. The framework never inspects `payload`; encode it however you like — JSON, protobuf, msgpack, raw bytes.

The framework owns these topics (reserved `__` prefix — `bind` / `unbind` reject them):

| Topic | When it fires | Payload |
|---|---|---|
| `__presence:join` | An actor joined a `presence: true` room | `JSON.stringify(presencePayload(actor))` (default `{ id, data }`) |
| `__presence:leave` | An actor left a `presence: true` room | same shape |

## ⚙️ Close codes & kick reasons

`CloseCode` (re-exported from `@rivalis/handshake`):

| Code | Constant | Meaning |
|---|---|---|
| `4001` | `INVALID_TICKET` | Bad / missing ticket; auth rejected |
| `4002` | `INVALID_FRAME` | Non-binary frame received |
| `4003` | `KICKED` | Server-initiated kick (reason in payload) |
| `4004` | `ROOM_REJECTED` | `room_full` or `room_not_joinable` |
| `4005` | `RATE_LIMITED` | Connection limiter rejected (pre-handshake) |

`KickReason` — the strings sent in close-frame payloads:

```ts
import { KickReason } from '@rivalis/core'

KickReason.INVALID_MESSAGE    // 'invalid_message'
KickReason.ROOM_DESTROYED     // 'room_destroyed'
KickReason.ROOM_FULL          // 'room_full'
KickReason.ROOM_NOT_JOINABLE  // 'room_not_joinable'
KickReason.RATE_LIMITED       // 'rate_limited'
KickReason.SERVER_SHUTDOWN    // 'server_shutdown'
```

## 🔌 Graceful shutdown

```ts
process.on('SIGINT', async () => {
    await rivalis.shutdown({ timeoutMs: 5000 })
    process.exit(0)
})
```

`shutdown` destroys every room (kicks remaining actors with `room_destroyed`), then disposes every transport (closes all live sockets with `KICKED + 'server_shutdown'`). The `timeoutMs` is the upper bound for transport disposal.

## 🧪 Custom transports

`WSTransport` is the reference implementation — for anything else (TCP, WebTransport, in-process), subclass `Transport`:

```ts
import { Transport, type TLayer } from '@rivalis/core'

class MyTransport extends Transport {
    override onInitialize(transportLayer: TLayer<any>): void {
        // Wire up your socket source. For each new connection, call:
        //   transportLayer.grantAccess(ticket)        → returns actorId or throws
        //   transportLayer.handleMessage(actorId, frame)  on inbound
        //   transportLayer.handleClose(actorId)            on disconnect
        //   transportLayer.on('message', actorId, fn)      to forward outbound to your socket
        //   transportLayer.on('kick', actorId, fn)         to close your socket with the reason
    }
    override get sockets(): number { /* live socket count */ return 0 }
    override async dispose(): Promise<void> { /* stop accepting + close all */ }
}
```

## License

MIT — see [LICENSE](https://github.com/kalevski/rivalis/blob/main/LICENSE).
