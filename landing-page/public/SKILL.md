---
name: rivalis
description: Build real-time apps and multiplayer game servers with Rivalis - @rivalis/core (Node.js server with rooms, actors, auth middleware, WebSocket transport) and @rivalis/browser (typed browser WebSocket client with reconnect). Use when the user asks to add a Rivalis server/room, wire up a Rivalis browser client, design auth/ticket flow, configure rate limiting / heartbeats / origin allow-lists, debug close codes (4001-4005), or imports `@rivalis/core` / `@rivalis/browser` / `@rivalis/handshake`.
---

# Rivalis

Rivalis is a Node.js framework for real-time / multiplayer apps over WebSocket. Server (`@rivalis/core`) owns the simulation; clients (`@rivalis/browser`) send intent and render server-broadcast state. Wire format is binary `{ topic: string, payload: bytes }` — the framework never inspects `payload`.

## When to use

Trigger on any of:
- File imports `@rivalis/core`, `@rivalis/browser`, or `@rivalis/handshake`.
- User says "Rivalis", "WSClient", "Room", "AuthMiddleware", "TLayer", "actor.send", "broadcast", or asks about the wire protocol / close codes 4001-4005.
- User wants to add: a real-time room (chat, lobby, matchmaking, presence), an authoritative game tick loop, a browser realtime client with reconnect, or a custom transport / rate limiter / connection limiter.

Skip when the user is using `socket.io`, raw `ws`, `colyseus`, or any other realtime stack — those have different APIs and primitives.

## Architecture in one paragraph

`Client socket → Transport → TLayer → RoomManager → Room → Actor handlers`. Subclass `Room` (override `onCreate` / `onJoin` / `onLeave` / `onDestroy`, `bind` topics to handlers, `broadcast` / `send` / `kick` to fan out). Subclass `AuthMiddleware` (one method: `authenticate(ticket)` returns `{ data, roomId } | null`). Construct one `Rivalis` with an array of transports, an auth middleware, and optional rate limiter. **Rooms are not auto-created on connect** — call `rivalis.rooms.define(name, Class)` then `rivalis.rooms.create(name, id)` before any actor whose ticket maps to `id` connects, otherwise auth succeeds and `TLayer.grantAccess` rejects with `room id=... does not exist`.

## Project scaffolding (monorepo layout)

Rivalis apps are split across **at least two** runtimes — Node server and browser client. Use **npm workspaces** so the wire-format types live in one place and both sides stay in sync. Pick a layout based on what you're building:

| Building | Workspaces | Notes |
|---|---|---|
| Chat / lobby / dashboard / collab tool | `{project}/server` + `{project}/app` | DOM-heavy UI. React / Vue / Svelte. |
| Real-time game (canvas, WebGL, Phaser) | `{project}/server` + `{project}/game` | Render loop owns the frame. UI overlay optional. |
| Hybrid (game + lobby UI) | `{project}/server` + `{project}/app` + `{project}/game` | Lobby in `app`, match in `game`. Both import `@rivalis/browser`. |

Always add a third workspace `{project}/protocol` for **shared wire types and constants** — topic names, command/event shapes, `encode` / `decode` helpers, room id unions. Both `server` and `app` / `game` import it. Without it, you end up retyping `LobbyChatEvent` on each side and they drift.

### Directory layout

```
{project}/
├── package.json                  # root, private, workspaces array
├── tsconfig.base.json            # shared compiler options
├── protocol/
│   ├── package.json              # name: @{project}/protocol
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # re-exports
│       ├── topics.ts             # 'lobby:state' | 'chat' | ...
│       └── messages.ts           # ChatCommand, ChatEvent, ...
├── server/
│   ├── package.json              # name: @{project}/server
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # http + Rivalis bootstrap
│       ├── AuthMiddleware.ts
│       └── rooms/
│           └── LobbyRoom.ts
└── app/                          # or game/
    ├── package.json              # name: @{project}/app
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        └── useRoom.ts
```

### Root `package.json`

```json
{
    "name": "@{project}/root",
    "private": true,
    "workspaces": ["protocol", "server", "app"],
    "scripts": {
        "dev": "concurrently -n server,app -c blue,green npm:dev:server npm:dev:app",
        "dev:server": "npm run dev -w @{project}/server",
        "dev:app": "npm run dev -w @{project}/app",
        "build": "npm run build --workspaces --if-present"
    },
    "devDependencies": {
        "concurrently": "^9.1.2",
        "typescript": "^5.8.3"
    }
}
```

For a game project, swap `app` → `game` in `workspaces` and the script names.

### `tsconfig.base.json`

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true
    }
}
```

Each workspace `tsconfig.json` extends this. Server overrides `module: 'CommonJS'` under `ts-node` so `nodemon -e ts --exec "ts-node src/index.ts"` works without ESM ceremony.

### `protocol` workspace

The single source of truth for what flies over the wire. Keep it dependency-free TypeScript so both runtimes consume it.

```ts
// protocol/src/topics.ts
export type ServerTopic =
    | 'lobby:state'
    | 'chat'
    | '__presence:join'
    | '__presence:leave'

export type ClientTopic = 'chat'

// protocol/src/messages.ts
export type ChatCommand = { text: string }
export type ChatEvent = { from: string, name: string, text: string, t: number }

// protocol/src/index.ts
export * from './topics'
export * from './messages'

const enc = new TextEncoder()
const dec = new TextDecoder()
export const encode = <T>(v: T): Uint8Array => enc.encode(JSON.stringify(v))
export const decode = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T
```

```json
// protocol/package.json
{
    "name": "@{project}/protocol",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "main": "src/index.ts",
    "types": "src/index.ts"
}
```

Pointing `main` / `types` at `src/index.ts` lets Vite and ts-node consume the source directly — no build step for an internal package.

### `server` workspace

```json
// server/package.json
{
    "name": "@{project}/server",
    "private": true,
    "scripts": {
        "dev": "nodemon -w src -e ts --exec \"ts-node src/index.ts\"",
        "build": "tsc -p tsconfig.json"
    },
    "dependencies": {
        "@rivalis/core": "*",
        "@{project}/protocol": "*"
    },
    "devDependencies": {
        "nodemon": "^3.1.9",
        "ts-node": "^10.9.2",
        "@types/node": "^22.0.0"
    }
}
```

```ts
// server/src/index.ts
import http from 'http'
import { Rivalis, Transports } from '@rivalis/core'
import Auth from './AuthMiddleware'
import LobbyRoom from './rooms/LobbyRoom'

const server = http.createServer()
const rivalis = new Rivalis({
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new Auth()
})
rivalis.rooms.define('lobby', LobbyRoom)
rivalis.rooms.create('lobby', 'global')
server.listen(2334)

process.on('SIGINT', async () => { await rivalis.shutdown(); process.exit(0) })
```

### `app` workspace (DOM / React)

```json
// app/package.json
{
    "name": "@{project}/app",
    "private": true,
    "type": "module",
    "scripts": {
        "dev": "vite",
        "build": "vite build",
        "preview": "vite preview"
    },
    "dependencies": {
        "@rivalis/browser": "*",
        "@{project}/protocol": "*",
        "react": "^19.0.0",
        "react-dom": "^19.0.0"
    },
    "devDependencies": {
        "@vitejs/plugin-react": "^4.7.0",
        "vite": "^6.0.0"
    }
}
```

```ts
// app/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: { '/ws': { target: 'ws://localhost:2334', ws: true } }
    }
})
```

### `game` workspace (canvas / Phaser)

Same shape as `app`, replace deps:

```json
{
    "name": "@{project}/game",
    "private": true,
    "type": "module",
    "scripts": { "dev": "vite", "build": "vite build" },
    "dependencies": {
        "@rivalis/browser": "*",
        "@{project}/protocol": "*",
        "phaser": "^4.0.0"
    },
    "devDependencies": { "vite": "^6.0.0" }
}
```

Game loop owns the render frame; `WSClient` listens on tick / state topics and updates a scene-local model. Send input flags **on key state changes only** — not every frame — to stay under the default 30 fps token bucket. See *Recipe 4 — Fixed-rate tick simulation*.

### Bootstrapping a new project — the recipe

1. `mkdir {project} && cd {project} && npm init -y` — turn it into the root package.
2. Set `"private": true`, add `"workspaces": ["protocol", "server", "app"]` (or `"game"`).
3. `mkdir protocol server app && cd protocol && npm init -y`, repeat for each. Edit each name to `@{project}/<workspace>`, set `"private": true`.
4. From the root: `npm install @rivalis/core -w @{project}/server` and `npm install @rivalis/browser -w @{project}/app`.
5. Wire `@{project}/protocol` as a dep on both: `npm install @{project}/protocol -w @{project}/server` and same for `app`. npm resolves the workspace symlink — no publishing needed.
6. Drop in the `tsconfig.base.json` above; each workspace `tsconfig.json` does `"extends": "../tsconfig.base.json"`.
7. From the root: `npm run dev` — concurrently runs server (`:2334`) and Vite (`:5173`).

### Pitfalls specific to this layout

- **Don't import server code from `app` / `game`.** Workspace symlinks make it tempting; doing so pulls Node-only deps into the bundle. The protocol package is the only shared surface.
- **Don't publish `protocol` to npm.** Mark `"private": true`. It's an internal contract, not a public API.
- **Match `roomId` strings between protocol constants and `rivalis.rooms.create`.** A typo only surfaces at connect time as `room id=... does not exist` from `TLayer.grantAccess`.
- **One `WSClient` per connection, not per component.** Build a `useRoom` hook (see *React `useRoom` pattern*) that owns the lifecycle and hand the client down.
- **In dev, point `WSClient` at the server port (`2334`), not the Vite port (`5173`).** Or proxy `/ws` through Vite as shown above; pick one and stick with it.

## Minimal server (always start here)

```ts
import http from 'http'
import {
    Rivalis, Transports, Room, AuthMiddleware,
    type AuthResult, type Actor
} from '@rivalis/core'

type ActorData = { name: string }

class ChatRoom extends Room<ActorData> {
    protected override presence = true   // auto __presence:join / __presence:leave
    protected override onCreate() { this.bind('chat', this.onChat) }
    protected override onJoin(actor: Actor<ActorData>) {
        actor.send('welcome', JSON.stringify({ youAre: actor.data?.name ?? '' }))
    }
    private onChat(actor: Actor<ActorData>, payload: Uint8Array) {
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
server.listen(8080)

process.on('SIGINT', async () => { await rivalis.shutdown(); process.exit(0) })
```

## Minimal browser client

```ts
import { WSClient } from '@rivalis/browser'

const ws = new WSClient<'chat' | 'welcome'>('ws://localhost:8080', { reconnect: true })
const enc = new TextEncoder()
const dec = new TextDecoder()

ws.on('client:connect', () => console.log('connected'))
ws.on('client:kicked', ({ code, reason }) => console.log('kicked:', code, reason))
ws.on('chat', (p) => console.log('chat:', dec.decode(p)))

ws.connect('alice')
ws.send('chat', enc.encode('hello'))
```

## Rules and pitfalls — apply unconditionally

- **Reserved `__` topic prefix.** `bind` / `unbind` throw on `__`-prefixed topics. Framework owns `__presence:join` / `__presence:leave`. Pick app topic names that don't start with `__`.
- **Topic uniqueness.** `bind` throws if the topic is already bound (silent overwrite was a footgun). Use `unbind(topic)` first if you need to swap handlers.
- **One wildcard.** `bindAny` errors if a wildcard listener already exists; call `unbindAny` first.
- **Payloads are opaque bytes.** `Uint8Array` in / out. Encode with `TextEncoder` + `JSON.stringify` (or protobuf / msgpack). The wire layer never inspects payload.
- **`actor.send` from inside `onJoin` works** — TLayer's per-actor buffer handles the timing. No `setImmediate` needed.
- **Don't auto-create rooms.** Always `rivalis.rooms.define(name, Class)` + `rivalis.rooms.create(name, id)` at startup. Auth's `roomId` must match a created room id.
- **`authenticate` must use constant-time comparison for any secret check** (`crypto.timingSafeEqual`). `===` and `Buffer.compare` short-circuit and leak prefix length over enough samples.
- **Tickets are never logged in plaintext** — only an 8-char SHA-256 fingerprint. Don't add log lines that include the raw ticket.
- **Production: put the ticket in `Sec-WebSocket-Protocol`, not the URL.** Set `ticketSource: 'protocol'` on **both** `WSTransportOptions` and `WSClientOptions`. Subprotocol values stay out of access logs and browser history. The ticket must conform to subprotocol token grammar (no spaces, commas, or padding `=`; standard base64url JWTs satisfy this).
- **Reconnect skips terminal codes.** The browser client treats `INVALID_TICKET` (4001), `KICKED` (4003), and `ROOM_REJECTED` (4004) as terminal and won't reconnect. Surface a "reconnect" button via `client:reconnect_failed`.
- **Short-lived JWTs need `getTicket`.** Reconnects use the original ticket unless you pass `getTicket: async () => fetch('/api/realtime-token').then(r => r.text())`. If `getTicket` throws, the reconnect loop terminates.
- **Behind a reverse proxy, `request.socket.remoteAddress` is the proxy.** Extract real client IP from `X-Forwarded-For` yourself before passing to `ConnectionLimiter.check`.
- **Default rate limiter is opt-out** (TokenBucket: 30 capacity / 30 refill-per-sec). Pass `rateLimiter: null` only with intent. Defaults are designed so a fresh `new Rivalis({...})` is not a trivial DoS target.
- **Default frame cap 64 KiB, topic cap 256 chars.** Tunable via `WSTransportOptions.maxPayload` and `ConfigOptions.maxTopicLength`.
- **Heartbeats default on** (30 s ping, 2-miss kill). Pass `heartbeat: false` only when you have a reason.
- **`onCreate` runs in the constructor before `logger.info('created')`.** Throwing here breaks room creation. Defer external I/O to lifecycle hooks called later.
- **`onLeave` removes the actor from the map *before* the user-supplied hook runs.** `each` / `broadcast` from inside `onLeave` naturally exclude the leaver. `onJoin` adds the actor *before* it runs, so `each` includes the joiner.
- **A throw out of a topic listener is logged but does not kick the actor** — the framework can't tell whether the throw was from malformed input or your bug. Validate inputs explicitly and call `actor.kick(KickReason.INVALID_MESSAGE)` when appropriate.

## Testing changes

For UI work the user can see, start a dev server and exercise the feature in a browser. The bundled `npm run demo` boots Express on `:2334` + Vite on `:5173` with four reference rooms (`lobby`, `counter`, `ttt`, `arena`) — useful for sanity-checking that a server change still renders correctly.

---

# Server recipes (`@rivalis/core`)

Patterns for the four kinds of room you actually build. Copy the closest match and adapt.

## Room lifecycle and overrides

```ts
class GameRoom extends Room<{ name: string }> {
    override maxActors = 4              // 5th joiner rejected with `room_full`
    override joinable = true            // flip false to refuse joins (`room_not_joinable`)
    protected override presence = true  // auto __presence:join / __presence:leave
    protected override unknownTopicPolicy = 'drop'   // 'kick' (default) | 'drop'

    protected override onCreate() {
        this.bind('move', this.onMove)
        this.bindAny(this.onAnyTopic)   // optional wildcard fallback
    }

    protected override onJoin(actor: Actor<{ name: string }>) {
        // actor.send() works synchronously from here
        actor.send('state', JSON.stringify(this.snapshot()))
    }

    protected override onLeave(actor: Actor<{ name: string }>) { /* cleanup */ }
    protected override onDestroy() { /* dispose external resources */ }

    /** Override to scrub server-only fields out of actor.data before presence broadcasts hit other clients. */
    protected override presencePayload(actor: Actor<{ name: string }>) {
        return { id: actor.id, name: actor.data?.name }
    }

    private onMove(actor: Actor<{ name: string }>, payload: Uint8Array) {
        this.broadcast('state', JSON.stringify(this.applyMove(payload)))
    }

    private onAnyTopic(actor: Actor<{ name: string }>, payload: Uint8Array, topic: string) {
        // Receives every frame on a topic that wasn't bound explicitly.
    }
}
```

Public API surface on `Room`:

| Method | Purpose |
|---|---|
| `bind(topic, listener)` | Register inbound topic handler. Throws on `__`-prefix, `'*'`, or topic already bound. |
| `unbind(topic)` | Returns `true` if a binding was removed. |
| `bindAny(listener)` / `unbindAny()` | Wildcard fallback. Only one wildcard at a time. |
| `send(actor, topic, payload)` | Unicast. `payload`: `Uint8Array \| string`. |
| `broadcast(topic, payload)` | Fan-out to every actor in the room. |
| `each(fn)` | Iterate actors. |
| `kick(actor, payload?)` | Disconnect with close-frame reason (≤123 bytes). |
| `destroy()` | Tells the manager to destroy this room. |
| `actorCount` | Live actors in room. |

`Actor<T>` surface:

```ts
actor.id          // 16-char CSPRNG-backed id
actor.data        // T | null — whatever authenticate() returned
actor.joined      // Date
actor.send(topic, payload)
actor.kick(reason?)        // payload: Uint8Array | string
actor.save<T>(key, value)  // per-actor scratch storage
actor.get<T>(key)
```

## Recipe 1 — Presence + chat (the lobby pattern)

```ts
import { Actor, Room } from '@rivalis/core'

const HISTORY_LIMIT = 50

class LobbyRoom extends Room<ActorData> {
    protected override presence = true
    private history: ChatEvent[] = []

    protected override onCreate() {
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor<ActorData>) {
        actor.send('lobby:state', encode({ youId: actor.id, history: this.history }))
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array) {
        const command = decode<ChatCommand>(payload)
        const text = command.text?.trim().slice(0, 200)
        if (!text) return
        const event: ChatEvent = {
            from: actor.id,
            name: actor.data!.name,
            text,
            t: Date.now()
        }
        this.history.push(event)
        if (this.history.length > HISTORY_LIMIT) this.history.shift()
        this.broadcast('chat', encode(event))
    }
}
```

Notes:
- `presence = true` triggers `__presence:join` / `__presence:leave` automatically. Payload is `JSON.stringify(presencePayload(actor))`. Override `presencePayload` to filter sensitive fields.
- The joiner is included in the actor map *before* `onJoin` runs, so `each` / `broadcast` calls inside `onJoin` see them.
- The leaver is removed *before* `onLeave` runs, so they're naturally excluded from `each` / `broadcast`.

## Recipe 2 — Server-authoritative shared state (counter pattern)

```ts
class CounterRoom extends Room<ActorData> {
    private value: number = 0

    protected override onCreate() {
        this.bind('change', this.onChange)
    }

    protected override onJoin(actor: Actor<ActorData>) {
        actor.send('counter:state', encode({ value: this.value, by: null }))
    }

    private onChange(actor: Actor<ActorData>, payload: Uint8Array) {
        const command = decode<CounterCommand>(payload)
        const delta = Math.trunc(command.delta)
        if (delta !== 1 && delta !== -1) return   // validate; bad input → silent drop
        this.value += delta
        this.broadcast('counter:state', encode({ value: this.value, by: actor.data!.name }))
    }
}
```

Validate inputs explicitly. A throw out of a topic listener is logged but does not kick — the framework can't tell user bug from malicious input.

## Recipe 3 — Turn-based with capacity (`maxActors` + `joinable`)

```ts
class TttRoom extends Room<ActorData> {
    override maxActors = 2

    private status: 'waiting' | 'playing' | 'finished' = 'waiting'
    private players: Player[] = []

    protected override onCreate() {
        this.bind('place', this.onPlace)
        this.bind('reset', this.onReset)
    }

    protected override onJoin(actor: Actor<ActorData>) {
        const symbol: 'X' | 'O' = this.players.length === 0 ? 'X' : 'O'
        this.players.push({ id: actor.id, symbol, name: actor.data!.name })
        if (this.players.length === 2) this.startGame()
        this.broadcastState()
    }

    protected override onLeave(actor: Actor<ActorData>) {
        // Any leave aborts the game so the room can accept new players.
        this.players = this.players.filter((p) => p.id !== actor.id)
        this.status = 'waiting'
        this.joinable = true
        this.broadcastState()
    }

    private startGame() {
        this.status = 'playing'
        this.joinable = false   // refuse spectators while a game is running
    }

    private onPlace(actor: Actor<ActorData>, payload: Uint8Array) {
        if (this.status !== 'playing') return
        // ...validate move; if game ends, set this.joinable = true
    }

    private broadcastState() {
        // Per-actor view: each player gets a state stamped with their own id/symbol.
        this.each((actor) => {
            actor.send('ttt:state', encode(this.snapshotFor(actor.id)))
        })
    }
}
```

Capacity rejection happens at `TLayer.grantAccess` *after* auth but before `onJoin`. The 5th joiner sees `client:kicked` with code `4004 ROOM_REJECTED` and reason `room_full` (or `room_not_joinable` if `joinable` is false).

## Recipe 4 — Fixed-rate tick simulation (real-time arena pattern)

Server owns the simulation; clients send **input flags only on key state changes**, not on every frame. That keeps the inbound rate well under the default 30 fps token bucket without opting out.

```ts
const TICK_HZ = 30
const TICK_MS = Math.round(1000 / TICK_HZ)
const SPEED = 220

class ArenaRoom extends Room<ActorData> {
    private positions = new Map<string, { x: number; y: number }>()
    private inputs = new Map<string, ArenaInput>()
    private tickHandle: NodeJS.Timeout | null = null
    private lastTickAt: number = 0

    protected override onCreate() {
        this.bind('input', this.onInput)
        this.lastTickAt = Date.now()
        this.tickHandle = setInterval(() => this.tick(), TICK_MS)
        this.tickHandle.unref?.()   // don't keep the process alive on shutdown
    }

    protected override onDestroy() {
        if (this.tickHandle !== null) clearInterval(this.tickHandle)
        this.tickHandle = null
        this.positions.clear()
        this.inputs.clear()
    }

    protected override onJoin(actor: Actor<ActorData>) {
        this.positions.set(actor.id, spawnPoint())
        this.inputs.set(actor.id, { up: false, down: false, left: false, right: false })
        this.broadcastSnapshot()  // joiner sees others without waiting for next tick
    }

    protected override onLeave(actor: Actor<ActorData>) {
        this.positions.delete(actor.id)
        this.inputs.delete(actor.id)
    }

    private onInput(actor: Actor<ActorData>, payload: Uint8Array) {
        try {
            const raw = decode<Partial<ArenaInput>>(payload)
            this.inputs.set(actor.id, {
                up: raw.up === true, down: raw.down === true,
                left: raw.left === true, right: raw.right === true
            })
        } catch { /* bad JSON — ignore one stutter, client resends on next key */ }
    }

    private tick() {
        const now = Date.now()
        const dt = Math.max(0, (now - this.lastTickAt) / 1000)
        this.lastTickAt = now
        if (dt <= 0) return
        for (const [id, pos] of this.positions) {
            const i = this.inputs.get(id)!
            const dx = (i.right ? 1 : 0) - (i.left ? 1 : 0)
            const dy = (i.down ? 1 : 0) - (i.up ? 1 : 0)
            if (dx === 0 && dy === 0) continue
            const len = Math.hypot(dx, dy) || 1
            pos.x = clamp(pos.x + (dx / len) * SPEED * dt, MIN_X, MAX_X)
            pos.y = clamp(pos.y + (dy / len) * SPEED * dt, MIN_Y, MAX_Y)
        }
        this.broadcastSnapshot()
    }
}
```

## RoomManager

```ts
rivalis.rooms.define('chat', ChatRoom)         // register a class
rivalis.rooms.create('chat', 'lobby-1')         // instantiate; pass null/omit to auto-generate id
rivalis.rooms.get('lobby-1')                    // Room | null
rivalis.rooms.destroy('lobby-1')                // kicks remaining actors with `room_destroyed`, runs onDestroy

rivalis.rooms.on('create', (id) => { /* ... */ })
rivalis.rooms.on('destroy', (id) => { /* ... */ })
```

## Graceful shutdown

```ts
process.on('SIGINT', async () => {
    await rivalis.shutdown({ timeoutMs: 5000 })
    process.exit(0)
})
```

`shutdown` destroys every room (kicks remaining actors with `room_destroyed`), then disposes every transport (closes all live sockets with `KICKED + 'server_shutdown'`). `timeoutMs` is the upper bound for transport disposal.

## Logging

```ts
rivalis.logging.level = 'debug'   // 'debug' | 'info' | 'warn' | 'error'
```

`rivalis.logging` is a `LoggerFactory`; rooms get a child logger named `room=<id>`.

---

# Client recipes (`@rivalis/browser`)

The browser client is intentionally tiny: `connect`, `disconnect`, `send`, `on` / `once` / `off`. It uses native `WebSocket` — no `ws`, no polyfill.

## Constructor

```ts
new WSClient<TTopics extends string = string>(baseURL: string, options?: WSClientOptions)

type WSClientOptions = {
    reconnect?: boolean | WSClientReconnectOptions
    ticketSource?: 'query' | 'protocol'      // default 'query'
    getTicket?: () => string | Promise<string>
}

type WSClientReconnectOptions = {
    maxAttempts?: number      // default Infinity
    baseDelayMs?: number      // default 500
    maxDelayMs?: number       // default 10_000
}
```

## Methods

| Method | Description |
|---|---|
| `connect(ticket?)` | Open a new connection. The ticket is what the server's `AuthMiddleware.authenticate` receives. |
| `disconnect()` | Close gracefully. Cancels pending reconnects, nulls the stored ticket. |
| `send(topic, payload?)` | Send a frame. `payload`: `Uint8Array \| string` (strings UTF-8 encoded for you). Drops with a warning if not in `OPEN` state. |
| `on(event, listener, context?)` | Subscribe. |
| `once(event, listener, context?)` | One-shot subscribe. |
| `off(event, listener, context?)` | Unsubscribe. |

## Built-in events

| Event | Payload | When |
|---|---|---|
| `client:connect` | – | WebSocket handshake completed (auth may still kick the connection right after). |
| `client:disconnect` | `Uint8Array` (close-frame reason, UTF-8) | Socket closed for any reason. |
| `client:kicked` | `{ code: number, reason: string }` | Server closed with a 4xxx app-level code. Fires *before* `client:disconnect`. |
| `client:reconnecting` | `Uint8Array` (attempt number as UTF-8 string) | Reconnect attempt scheduled; backoff already running. |
| `client:reconnect_failed` | – | `maxAttempts` exhausted, or `getTicket` threw. Terminal — no further attempts. |
| `<your topic>` | `Uint8Array` | Inbound frame on a server-broadcast topic. |

Default flow without reconnect: `client:connect` → ... → `client:disconnect` (with `client:kicked` in between if the server actively closed with 4xxx).

## Typed topics generic

```ts
type AppTopics = 'lobby:state' | 'chat' | 'game:tick'

const ws = new WSClient<AppTopics>('ws://localhost:8080')

ws.on('chat', (payload) => { ... })           // ✓
ws.on('typo:state', (payload) => { ... })     // type error
ws.on('client:kicked', ({ code, reason }) => { ... })  // built-in events still typed
```

## Reconnection

```ts
const ws = new WSClient(url, { reconnect: true })   // exp backoff with jitter, no attempt limit

const ws2 = new WSClient(url, {
    reconnect: { maxAttempts: 8, baseDelayMs: 250, maxDelayMs: 5000 }
})

ws2.on('client:reconnecting', (n) => console.log('attempt', new TextDecoder().decode(n)))
ws2.on('client:reconnect_failed', () => {
    // Surface a "Reconnect" button. The loop is terminal — no more attempts.
})
```

**Reconnect skips terminal close codes.** `INVALID_TICKET` (4001), `KICKED` (4003), `ROOM_REJECTED` (4004) are treated as terminal. Retrying is just noise — the server doesn't want you back.

## Refreshing short-lived tickets across reconnects

```ts
const ws = new WSClient(url, {
    reconnect: true,
    getTicket: async () => {
        const res = await fetch('/api/realtime-token', { credentials: 'include' })
        if (!res.ok) throw new Error('token endpoint failed')
        return await res.text()
    }
})

ws.connect(initialTicket)   // first call still uses its argument verbatim
```

If `getTicket` throws or rejects, the loop terminates with `client:reconnect_failed` (you can't reconnect without a ticket).

## Ticket via subprotocol (production default)

Keep credentials out of URL access logs and browser history. Set `ticketSource: 'protocol'` on **both** the server and the client:

```ts
const ws = new WSClient('wss://api.example.com/ws', {
    ticketSource: 'protocol',
    reconnect: true
})
ws.connect(jwt)   // sent via Sec-WebSocket-Protocol, NOT ?ticket=
```

The ticket must conform to subprotocol token grammar — no spaces, no commas, no padding `=`. Standard base64url JWTs satisfy this. Empty tickets in protocol mode throw before opening the socket.

## JSON encode / decode helper

The framework treats `payload` as opaque bytes. Most apps wrap one helper:

```ts
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

ws.send('chat', encode({ text: 'hello' }))
ws.on('chat', (p) => console.log(decode<{ text: string }>(p)))
```

Swap in `@bufbuild/protobuf` / `msgpackr` for higher throughput — wire layer doesn't care.

## React `useRoom` pattern

When connecting from React, build one hook per room that owns the lifecycle (connect on mount, disconnect on unmount, reconnect on identity change). Components attach their own topic listeners through the returned `WSClient`.

```ts
import { useEffect, useState } from 'react'
import { WSClient } from '@rivalis/browser'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'rejected'
const decoder = new TextDecoder()
const PERSISTENT_REJECTIONS = new Set(['room_full', 'room_not_joinable'])

export function useRoom(roomId: string, identity: { name: string; color: string }) {
    const [client, setClient] = useState<WSClient | null>(null)
    const [state, setState] = useState<ConnectionState>('connecting')
    const [reason, setReason] = useState<string>('')

    useEffect(() => {
        const ws = new WSClient(`ws://${location.hostname}:2334`)
        let mounted = true

        ws.on('client:connect', () => {
            if (!mounted) return
            setState('connected'); setReason('')
        }, null)

        ws.on('client:disconnect', (payload) => {
            if (!mounted) return
            const r = decoder.decode(payload as Uint8Array)
            setReason(r)
            setState(PERSISTENT_REJECTIONS.has(r) ? 'rejected' : 'disconnected')
        }, null)

        ws.connect(`${roomId}|${identity.name}|${identity.color}`)
        setClient(ws); setState('connecting')

        return () => {
            mounted = false
            ws.disconnect()
            setClient(null)
        }
    }, [roomId, identity.name, identity.color])

    return { client, state, reason }
}
```

In a child component:

```tsx
const { client, state } = useRoom('lobby', identity)

useEffect(() => {
    if (!client) return
    client.on('chat', (p) => { ... }, null)
    client.on('__presence:join', (p) => { ... }, null)
    client.on('__presence:leave', (p) => { ... }, null)
}, [client])
```

The third `null` argument to `on` is the `context` — passing `null` keeps it free of accidental `this` rebinding inside hooks.

## Close codes (re-exported, no extra install)

```ts
import { CloseCode } from '@rivalis/browser'

CloseCode.INVALID_TICKET   // 4001 — bad / missing ticket
CloseCode.INVALID_FRAME    // 4002 — non-binary frame
CloseCode.KICKED           // 4003 — server-initiated kick
CloseCode.ROOM_REJECTED    // 4004 — room_full / room_not_joinable
CloseCode.RATE_LIMITED     // 4005 — pre-handshake connection limiter
```

`client:kicked` fires for any 4xxx code with parsed `{ code, reason }` — you don't have to peek into the close payload yourself.

---

# Protocol, codes, and custom transports

## Wire format

A single binary frame: `{ topic: string, payload: bytes }`. The framework never inspects `payload` — encode it however you like (JSON, protobuf, msgpack, raw bytes).

The `@rivalis/handshake` package owns the format primitives. It's bundled into both `@rivalis/core` and `@rivalis/browser` builds — **consumers never install it**.

## Reserved topics (framework-owned)

The `__` prefix is reserved. `bind` / `unbind` throw if you pass a `__`-prefixed topic.

| Topic | When it fires | Payload |
|---|---|---|
| `__presence:join` | An actor joined a `presence: true` room | `JSON.stringify(presencePayload(actor))` (default `{ id, data }`) |
| `__presence:leave` | An actor left a `presence: true` room | same shape |

Override `presencePayload(actor)` on your `Room` subclass to scrub server-only fields out of `actor.data` before broadcast.

## Close codes

`CloseCode` is re-exported from `@rivalis/handshake` (bundled into `@rivalis/core` and `@rivalis/browser`).

| Code | Constant | Meaning |
|---|---|---|
| `4001` | `INVALID_TICKET` | Bad / missing ticket; auth rejected |
| `4002` | `INVALID_FRAME` | Non-binary frame received |
| `4003` | `KICKED` | Server-initiated kick (reason in payload) |
| `4004` | `ROOM_REJECTED` | `room_full` or `room_not_joinable` |
| `4005` | `RATE_LIMITED` | Connection limiter rejected (pre-handshake) |

The browser client treats `INVALID_TICKET`, `KICKED`, and `ROOM_REJECTED` as **terminal** for reconnect purposes — those mean the server doesn't want you back, so retrying is just noise.

## KickReason — strings sent in close-frame payloads

```ts
import { KickReason } from '@rivalis/core'

KickReason.INVALID_MESSAGE    // 'invalid_message'
KickReason.ROOM_DESTROYED     // 'room_destroyed'
KickReason.ROOM_FULL          // 'room_full'
KickReason.ROOM_NOT_JOINABLE  // 'room_not_joinable'
KickReason.RATE_LIMITED       // 'rate_limited'
KickReason.SERVER_SHUTDOWN    // 'server_shutdown'
```

`client:kicked` on the browser side fires for any 4xxx code with parsed `{ code, reason }` so you don't have to peek into the close payload yourself.

## Custom transports

`WSTransport` is the reference implementation — for anything else (TCP, WebTransport, in-process), subclass `Transport`:

```ts
import { Transport, type TLayer } from '@rivalis/core'

class MyTransport extends Transport {
    override onInitialize(transportLayer: TLayer<any>): void {
        // For each new connection, call:
        //   transportLayer.grantAccess(ticket)            → returns actorId or throws
        //   transportLayer.handleMessage(actorId, frame)  on inbound
        //   transportLayer.handleClose(actorId)           on disconnect
        //   transportLayer.on('message', actorId, fn)     to forward outbound to your socket
        //   transportLayer.on('kick', actorId, fn)        to close your socket with the reason
    }
    override get sockets(): number { return 0 /* live socket count */ }
    override async dispose(): Promise<void> { /* stop accepting + close all */ }
}
```

Adding a new transport means subclassing `Transport` and wiring four entry points: inbound-grant-access, inbound-message, inbound-close, and listening for outbound-message / outbound-kick events from `TLayer`.

## Pipeline overview

```
Client socket → Transport → TLayer → RoomManager → Room → Actor handlers
```

- **Transport** translates between its native protocol (currently WebSocket) and the framework boundary.
- **TLayer** owns the per-actor emitter and routes inbound frames into rooms; it enforces `maxTopicLength`, runs the `RateLimiter`, and manages the per-actor message buffer that makes `actor.send()` from inside `onJoin` work without ceremony.
- **RoomManager** is the registry of room *classes* (`define`) and *instances* (`create`).
- **Room** is the user extension point.
- **Actor** is a per-connection handle inside a room; carries `data` from `AuthMiddleware.authenticate` and exposes `send` / `kick` / `save` / `get`.

## Rivalis constructor reference

```ts
const rivalis = new Rivalis<TActorData>({
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new MyAuth(),
    rateLimiter: undefined,  // omit → default token bucket; null → opt out
    logging: undefined,      // omit → built-in console reporter
    maxTopicLength: 256      // default
})

rivalis.connections   // joined actors
rivalis.sockets       // open sockets (includes pre-handshake)
rivalis.rooms         // RoomManager
rivalis.logging       // LoggerFactory — set rivalis.logging.level = 'debug'

await rivalis.shutdown({ timeoutMs: 5000 })
```

---

# Auth & security

The defaults are designed so a fresh `new Rivalis({ ... })` is not a trivial DoS target. Each layer below is documented and tunable.

## AuthMiddleware — the only required piece

Implement one method. Return `null` to reject (closes with `INVALID_TICKET` 4001). Return `{ data, roomId }` to accept — `data` is stamped on `actor.data`, `roomId` routes the actor.

```ts
import { AuthMiddleware, type AuthResult } from '@rivalis/core'

class JWTAuth extends AuthMiddleware<{ userId: string; tier: 'free' | 'pro' }> {
    override async authenticate(ticket: string): Promise<AuthResult<{ userId: string; tier: 'free' | 'pro' }> | null> {
        try {
            const claims = await verifyJwt(ticket)
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

### Composite tickets (demo pattern)

When the ticket carries multiple fields (room id + display name + color), parse and validate each one. Reject anything malformed.

```ts
class ArenaAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const parts = ticket.split('|')
        if (parts.length !== 3) return null
        const [roomId, name, color] = parts
        if (!ROOM_SET.has(roomId ?? '')) return null
        if (!name || name.length > 20) return null
        if (!/^#[0-9a-fA-F]{6}$/.test(color ?? '')) return null
        return { data: { name: name as string, color: color as string }, roomId: roomId as RoomId }
    }
}
```

### Rooms must exist before auth maps to them

`authenticate` returning a `roomId` does NOT auto-create the room. `TLayer.grantAccess` rejects with `room id=... does not exist` if the manager has no instance. Define + create rooms at startup:

```ts
rivalis.rooms.define('chat', ChatRoom)
rivalis.rooms.create('chat', 'global')
```

### Timing-oracle hazard

Any secret comparison inside `authenticate` (HMACs, signatures, session tokens) **must** use `crypto.timingSafeEqual` or an equivalent constant-time comparator. `===` and `Buffer.compare` short-circuit on first mismatch and leak the prefix length over enough samples.

```ts
import { timingSafeEqual } from 'node:crypto'

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ab.length !== bb.length) return false
    return timingSafeEqual(ab, bb)
}
```

### Migrating from legacy three-method shape

The old shape was `validateTicket` / `extractPayload` / `getRoomId`. Extend `LegacyAuthMiddleware` instead of `AuthMiddleware` — it ships a default `authenticate` that calls the three. `LegacyAuthMiddleware` is `@deprecated` and removed in the next major.

## Ticket via subprotocol (recommended for production)

Subprotocol values don't appear in URL access logs or browser history. Set on **both** sides:

```ts
// server
new Transports.WSTransport({ server }, null, { ticketSource: 'protocol' })

// client
new WSClient(url, { ticketSource: 'protocol' })
```

Default is `'query'` (`?ticket=...`) for back-compat. Subprotocol token grammar disallows spaces, commas, and padding `=`; standard base64url JWTs satisfy this. Empty tickets in protocol mode throw a clear error before opening the socket.

## Origin allow-list (CSWSH protection)

If your tickets ride on cookies, you must reject cross-origin handshakes before auth runs:

```ts
new Transports.WSTransport({ server }, null, {
    allowedOrigins: ['https://app.example.com', 'https://staging.example.com']
})

// or as a function
new Transports.WSTransport({ server }, null, {
    allowedOrigins: (origin) => origin.endsWith('.example.com')
})
```

## Per-IP connection limiter (pre-handshake)

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

Limiter rejection closes with `CloseCode.RATE_LIMITED` (4005).

> Behind a reverse proxy, `request.socket.remoteAddress` is the proxy. Extract the real client address from `X-Forwarded-For` yourself before passing it to your limiter.

## Per-actor rate limit (post-auth)

Default is opt-out: `TokenBucketRateLimiter` at 30 capacity / 30 refill-per-sec. Tune or replace:

```ts
import { TokenBucketRateLimiter } from '@rivalis/core'

new Rivalis({
    transports: [...],
    authMiddleware: new MyAuth(),
    rateLimiter: new TokenBucketRateLimiter({ capacity: 120, refillPerSecond: 60 })
    // or rateLimiter: null   // opt out entirely
})
```

Custom limiter — subclass `RateLimiter`:

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

`release(actorId)` is called when the actor disconnects — clean up state.

## WSTransport options reference

```ts
new Transports.WSTransport(
    serverOptions,            // ws.ServerOptions (server, port, path, etc.)
    queryTicketParam,         // optional, default 'ticket'
    transportOptions          // WSTransportOptions
)
```

| Option | Default | Description |
|---|---|---|
| `maxPayload` | `64 * 1024` (64 KiB) | Hard cap on a single inbound frame. |
| `heartbeat` | `{ intervalMs: 30000, missThreshold: 2 }` | Ping cadence. `false` to disable. |
| `maxBufferedBytes` | `1024 * 1024` (1 MiB) | Per-socket outbound buffer cap; over the cap, frames are dropped. |
| `onBackpressureDrop` | – | `(actorId, bufferedAmount) => void` — fires on every dropped outbound frame so you can escalate (e.g. kick). |
| `allowedOrigins` | – | `ReadonlyArray<string> \| (origin) => boolean` — reject any other `Origin` before auth runs. |
| `connectionLimiter` | – | A `ConnectionLimiter` subclass — checked before auth on every new socket. |
| `ticketSource` | `'query'` | `'query'` reads `?ticket=`. `'protocol'` reads `Sec-WebSocket-Protocol`. |

## Backpressure handling

If a client is slow to drain, `maxBufferedBytes` triggers per-frame drops. Wire `onBackpressureDrop` to escalate:

```ts
new Transports.WSTransport({ server }, null, {
    onBackpressureDrop: (actorId, bufferedAmount) => {
        // Optional: kick the actor after N drops.
        const room = findRoomFor(actorId)
        room?.kickById(actorId, 'slow-consumer')
    }
})
```

## Ticket logging

Tickets are **never** logged in plaintext — only an 8-char SHA-256 fingerprint. Don't add log lines that include the raw ticket; if you need to correlate, log the fingerprint yourself the same way.

## Defaults summary

- Frame size cap: **64 KiB**
- Topic length cap: **256 chars**
- Per-actor rate limit: **30 frames/sec** (opt-out via `rateLimiter: null`)
- Heartbeat: **30 s ping, 2-miss threshold** (opt-out via `heartbeat: false`)
- Origin allow-list: **opt-in** (`allowedOrigins`)
- Per-IP connection limit: **opt-in** (`connectionLimiter`)
- Ticket logging: only an 8-char SHA-256 fingerprint
