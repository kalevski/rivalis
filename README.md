[![logo](https://user-images.githubusercontent.com/10467454/113154097-f834d280-9237-11eb-95a9-bd62cdde4677.png)](https://rivalis.dev)
<h3 align="center">Simple, secure and fast real-time application development on top of NodeJS</h3>

----

[![forthebadge](https://forthebadge.com/images/badges/built-with-love.svg)](https://rivalis.dev)
[![forthebadge](https://forthebadge.com/images/badges/fo-real.svg)](https://rivalis.dev)
[![forthebadge](https://forthebadge.com/images/badges/uses-js.svg)](https://rivalis.dev)
[![forthebadge](https://forthebadge.com/images/badges/open-source.svg)](https://rivalis.dev)

[![GitHub](https://img.shields.io/github/license/kalevski/rivalis?style=for-the-badge)](https://github.com/kalevski/rivalis/blob/main/LICENSE)

----

Rivalis is a free, open-source framework for building real-time applications and multiplayer game servers on Node.js. It gives you **rooms**, **actors**, and a **typed wire protocol** out of the box, with WebSocket transport, presence, rate limiting, heartbeats, graceful shutdown, and a browser client that handles reconnection.

## 👍 Good for

- **Real-time applications** — chat, presence, notifications, live dashboards, collaborative editing
- **Multiplayer games** — turn-based strategy, arena games, lobby/matchmaking systems
- **Server-authoritative state** — anywhere you need a single source of truth that broadcasts to many clients

## ⭐ What you get

- **Server** ([`@rivalis/core`](./core)) — Node framework: rooms, actors, auth middleware, WebSocket transport, per-actor rate limiting, per-IP connection limiting, configurable frame and topic size caps, graceful shutdown.
- **Client** ([`@rivalis/browser`](./browser)) — Browser WebSocket client: typed event listeners, exponential-backoff reconnect, ticket-refresh hook for short-lived JWTs, structured `client:kicked` events.
- **Shared protocol** — Single binary wire format (`{ topic, payload: bytes }`) with documented WebSocket close codes. The `@rivalis/handshake` package is bundled into both `core` and `browser` builds — consumers never install it.

## 🚀 Getting started

Build a server in 30 lines:

```ts
import http from 'http'
import {
    Rivalis, Transports, Room, AuthMiddleware,
    type AuthResult, type Actor
} from '@rivalis/core'

type ActorData = { name: string }

class ChatRoom extends Room<ActorData> {
    protected override presence = true   // broadcast __presence:join / leave automatically
    protected override onCreate() {
        this.bind('chat', this.onChat)
    }
    private onChat(actor: Actor<ActorData>, payload: Uint8Array) {
        this.broadcast('chat', payload)  // fan-out to everyone in the room
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
server.listen(8080)

process.on('SIGINT', async () => { await rivalis.shutdown(); process.exit(0) })
```

…and connect a browser client:

```ts
import { WSClient } from '@rivalis/browser'

const ws = new WSClient('ws://localhost:8080', { reconnect: true })
const encoder = new TextEncoder()
const decoder = new TextDecoder()

ws.on('client:connect', () => console.log('connected'))
ws.on('client:kicked', ({ code, reason }) => console.log('kicked:', code, reason))
ws.on('chat', (payload) => console.log('chat:', decoder.decode(payload)))

ws.connect('alice')                              // ticket = "alice"
ws.send('chat', encoder.encode('hello world'))   // payloads are opaque bytes
```

Read on for full options:

- **[@rivalis/core](./core/README.md)** — building servers, rooms, auth, transport tuning
- **[@rivalis/browser](./browser/README.md)** — the browser client API

## 📦 Packages

| Package | Description | Published |
|---|---|---|
| [`@rivalis/core`](./core) | Node.js server framework | ✅ |
| [`@rivalis/browser`](./browser) | Browser WebSocket client | ✅ |
| `@rivalis/handshake` | Wire-format primitives shared by `core` + `browser` | private (bundled) |
| `@rivalis/demo` | End-to-end example: Express + Vite + React | private |

## 🚀 Run the demo

The demo ships a tiny app with three rooms — chat lobby, shared counter, two-player tic-tac-toe — to exercise every feature end-to-end.

```bash
git clone git@github.com:kalevski/rivalis.git
cd rivalis
npm install
npm run build
npm run demo
```

Then open <http://localhost:5173> (Vite client) which talks to the WebSocket server on `:2334`.

## 🧠 How it works

Server pipeline:

```
Client socket ─► Transport ─► TLayer ─► RoomManager ─► Room ─► Actor handlers
```

- **Transport** translates between its native protocol (currently WebSocket) and the framework boundary. Adding a new transport means subclassing `Transport` and wiring four entry points.
- **TLayer** owns the per-actor emitter and routes inbound frames into rooms; it also enforces `maxTopicLength`, runs the `RateLimiter`, and manages the per-actor message buffer that makes `actor.send()` from inside `onJoin` work without ceremony.
- **RoomManager** is the registry of room *classes* (`define`) and *instances* (`create`).
- **Room** is the user extension point: bind topics to handlers, broadcast, kick, and override the `onCreate` / `onJoin` / `onLeave` / `onDestroy` lifecycle.
- **Actor** is a per-connection handle inside a room; it carries the data your `AuthMiddleware.authenticate` returned and exposes `send`/`kick`.

Wire format is a single binary frame: `{ topic: string, payload: bytes }`. The framework never inspects `payload` — encode it however you like (JSON, protobuf, msgpack, raw bytes).

## 🛡️ Security defaults

The defaults are designed so that a fresh `new Rivalis({ ... })` is not a trivial DoS target. Each is documented and tunable:

- **Inbound frame size** capped at 64 KiB per frame (`WSTransportOptions.maxPayload`).
- **Topic length** capped at 256 characters (`ConfigOptions.maxTopicLength`).
- **Per-actor rate limit** — token bucket, default 30 frames/sec (`TokenBucketRateLimiter`). Pass `rateLimiter: null` to opt out.
- **Heartbeat** — 30 s ping interval, 2-miss termination threshold (configurable, disable with `heartbeat: false`).
- **Origin allow-list** for CSWSH protection (opt-in via `allowedOrigins`).
- **Per-IP connection rate limit** (opt-in via `connectionLimiter`).
- **Ticket logging** — only an 8-char SHA-256 fingerprint, never the raw ticket.

## License

MIT — see [LICENSE](./LICENSE).
