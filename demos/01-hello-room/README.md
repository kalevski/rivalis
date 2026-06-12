# Guided level 01 — hello-room

The smallest complete Rivalis program: one server, one room, one client, one
message exchanged.  Read through `src/index.ts` top-to-bottom while this README
explains what each section is doing and which Rivalis concept it maps to.

---

## What this demo does

```
[server] room "lobby" created
[server] listening on ws://localhost:3100
[server] actor joined   id=<uuid>
[client] connected
[client] sending   "Hello, Rivalis!" on topic "greeting"
[server] received  "Hello, Rivalis!" from id=<uuid>
[server] echoed    "Hello, Rivalis!" back to id=<uuid>
[client] received  "Hello, Rivalis!" ← exchange complete
[client] disconnected — shutting down
[server] actor left     id=<uuid>
```

---

## Concepts introduced

### `Rivalis` — the server root

`new Rivalis({ transports, authMiddleware })` is the starting point of every
server.  It owns the transport layer, the room registry (`rivalis.rooms`), and
the logging factory.

### `Transport` — wire protocol adapter

A `Transport` translates between a socket protocol (WebSocket, WebRTC data
channel, …) and Rivalis's internal framing.  This demo uses `WSTransport` from
`@rivalis/node`, which wraps the `ws` library and attaches to a plain
`http.Server`.

### `AuthMiddleware` — per-connection gating

Every inbound socket is passed to `authenticate(ticket)` before it enters any
room.  Return `null` to reject; return `{ data, roomId }` to accept.  The
`data` field is stamped onto the `Actor` and can hold any per-user state (name,
role, session token, …).  Here we accept any non-empty ticket and route
everyone to the single `"lobby"` room.

### `Room` — the logical space

Subclass `Room` to define the behaviour of a space actors can join.
Key methods:

| Method | When it runs |
|--------|-------------|
| `onCreate()` | Once, when the room is instantiated. Register topic listeners here with `bind()`. |
| `onJoin(actor)` | Each time a new actor enters. |
| `onLeave(actor)` | Each time an actor disconnects or is kicked. |
| `onDestroy()` | When the room is torn down via `rooms.destroy()` or `rivalis.shutdown()`. |

### `bind(topic, handler)` — topic routing

`bind()` maps an inbound topic string to a method.  When the framework receives
a frame on that topic it calls `handler(actor, payload, topic)`.  `payload` is
always a `Uint8Array`; decode it however your protocol requires.

### `actor.send(topic, payload)` — targeted delivery

`actor.send()` delivers a frame to exactly one actor.  Use `broadcast()` to
fan a frame out to every actor in the room.

### `Client` — the client-side counterpart

`WSClient` from `@rivalis/node` connects over WebSocket, handles the ticket
handshake, and emits topic events for incoming frames.  Its API mirrors the
server: `client.send(topic, payload)` sends a frame; `client.on(topic, cb)`
listens for one.  Built-in lifecycle events: `client:connect`,
`client:disconnect`, `client:kicked`, `client:error`.

---

## How to run

From the repo root (after `npm install`):

```sh
# one-shot run
npm run start -w @rivalis/guided-01-hello-room

# live-reload while editing (requires nodemon at the workspace level)
npm run dev -w @rivalis/guided-01-hello-room
```

The program boots the server, connects a client, exchanges one message, and
exits automatically — no Ctrl-C needed.

---

## What to try next

- Change the `TOPIC` constant and notice how both the server's `bind()` call
  and the client's `client.on()` call must match.
- Add a second `bind()` with a different topic — only messages on that exact
  string will reach it.
- Set `presence: true` on `HelloRoom` and watch `__presence:join` /
  `__presence:leave` frames appear automatically.

Continue to **[02-topics-and-broadcast](../02-topics-and-broadcast/)** to learn
how to publish to named topics and fan messages out to all connected actors.
