# Guided level 03 — auth, rate limiting, and kicks

Introduces four gatekeeping primitives in isolation so each rejection path is
clearly visible in the logs.  The room logic is intentionally minimal (a single
`ping`/`pong` exchange); the focus is on the policies, not on chat.

Read `src/server.ts` and `src/good-client.ts` / `src/bad-client.ts`
top-to-bottom alongside this README.

---

## Policies configured on the server

| Policy | API | Effect |
|--------|-----|--------|
| Auth | `AuthMiddleware.authenticate` | Ticket must match `<name>:rivalis` — wrong secret → socket closed with `INVALID_TICKET` |
| Rate limiting | `TokenBucketRateLimiter { capacity:4, refillPerSecond:1 }` | Each actor may send a burst of 4 frames; the 5th exhausts the bucket and the actor is kicked with `rate_limited` |
| Connection cap | `ConnectionLimiter` (`SlidingWindowLimiter`) | At most 3 raw sockets per IP per 10 s; the 4th is closed at the transport layer **before auth runs** |
| Room cap | `room.maxActors = 2` | At most 2 actors may be joined simultaneously; a 3rd is rejected with `room_full` |
| Explicit kick | `actor.kick(KickReason.RATE_LIMITED)` | Every joined actor is automatically kicked after 8 s |

### Ticket format

```
<name>:<secret>
```

Valid: `Alice:rivalis`  
Invalid: `Alice:wrongpass`

---

## How to run

> **Prerequisites:** run `npm install` from the repo root once.

### Step 1 — start the server

```sh
npm run start -w @rivalis/guided-03-auth-and-limits
```

Or with live-reload while editing:

```sh
npm run dev -w @rivalis/guided-03-auth-and-limits
```

---

### Step 2 — run the good client

```sh
npm run client:good -w @rivalis/guided-03-auth-and-limits
```

Connects with `Alice:rivalis`, sends 3 pings at 1 per second (well inside the
rate limit), and waits for the server to kick it at 8 s.

**Server terminal:**

```
[conn-limiter] allowed  127.0.0.1 — 1/3 in window
[auth] accepted  name="Alice"
[room] JOIN  name="Alice" id=Alice  total=1
[room] PING  name="Alice" text="ping-1"
[room] PING  name="Alice" text="ping-2"
[room] PING  name="Alice" text="ping-3"
[room] KICK  name="Alice" id=Alice  reason=rate_limited (demo auto-kick)
[room] LEAVE name="Alice" id=Alice  remaining=0
```

**Client terminal:**

```
[Alice] connected
[Alice] server says: "Connected. Server will kick you in 8 s as a demo of actor.kick()."
[Alice] → ping  "ping-1"
[Alice] ← pong "ping-1"
[Alice] → ping  "ping-2"
[Alice] ← pong "ping-2"
[Alice] → ping  "ping-3"
[Alice] ← pong "ping-3"
[Alice] disconnected (server kicked or connection closed)
```

---

### Step 3 — run the bad clients

Each scenario can be run independently while the server is running.  Restart
the server between overcap runs to reset the sliding window.

#### Scenario A — wrong credential (`AuthMiddleware`)

```sh
npm run client:bad-auth -w @rivalis/guided-03-auth-and-limits
```

Ticket `BadActor:wrongpass` is rejected by `TicketAuth.authenticate` before the
actor enters any room.

**Server:**
```
[conn-limiter] allowed  127.0.0.1 — 1/3 in window
[auth] rejected — wrong secret for name="BadActor"
```

**Client:**
```
[BadActor] connecting with invalid ticket "BadActor:wrongpass"
[BadActor] disconnected — server rejected the ticket (as expected)
```

**API exercised:** `AuthMiddleware.authenticate` returns `null` →
`CloseCode.INVALID_TICKET`

---

#### Scenario B — message flood (`TokenBucketRateLimiter`)

```sh
npm run client:flood -w @rivalis/guided-03-auth-and-limits
```

Connects with a valid ticket, then fires 20 `ping` frames without delay.
The bucket (`capacity=4`) drains after 4 frames; the 5th triggers a kick.

**Server:**
```
[conn-limiter] allowed  127.0.0.1 — 1/3 in window
[auth] accepted  name="Flooder"
[room] JOIN  name="Flooder" id=Flooder  total=1
[room] PING  name="Flooder" text="flood-1"
[room] PING  name="Flooder" text="flood-2"
[room] PING  name="Flooder" text="flood-3"
[room] PING  name="Flooder" text="flood-4"
                                         ← frames 5-20 dropped; actor kicked
[room] LEAVE name="Flooder" id=Flooder  remaining=0
```

**Client:**
```
[Flooder] connected — flooding 20 pings with no delay ...
[Flooder] all 20 pings sent — expect a rate-limited kick
[Flooder] ← pong "flood-1"
...
[Flooder] disconnected — kicked by rate limiter (as expected)
```

**API exercised:** `TokenBucketRateLimiter.check` returns `false` →
`KickReason.RATE_LIMITED`

---

#### Scenario C — over-cap (`ConnectionLimiter` + `maxActors`)

```sh
npm run client:overcap -w @rivalis/guided-03-auth-and-limits
```

Opens 4 connections from the same IP in rapid succession, hitting both caps:

1. The sliding-window `ConnectionLimiter` allows the first 3 sockets within
   the 10-second window; the **4th is rejected** before auth runs.
2. Of the 3 admitted sockets, Cap1 and Cap2 join the room; Cap3 passes auth
   but is rejected with `room_full` because `maxActors=2`.

**Server:**
```
[conn-limiter] allowed  127.0.0.1 — 1/3 in window
[conn-limiter] allowed  127.0.0.1 — 2/3 in window
[conn-limiter] allowed  127.0.0.1 — 3/3 in window
[conn-limiter] rejected 127.0.0.1 — 3 connections in last 10s (max 3)
[auth] accepted  name="Cap1"
[auth] accepted  name="Cap2"
[auth] accepted  name="Cap3"
[room] JOIN  name="Cap1" id=Cap1  total=1
[room] JOIN  name="Cap2" id=Cap2  total=2
                                   ← Cap3 rejected: room_full
```

**Client:**
```
[Cap1] connected — inside the room
[Cap1] server says: "Connected. Server will kick you in 8 s ..."
[Cap2] connected — inside the room
[Cap2] server says: "Connected. Server will kick you in 8 s ..."
[Cap3] disconnected        ← auth passed but room was full
[Cap4] disconnected        ← never reached auth; conn-limiter blocked it
```

**API exercised:**
- `ConnectionLimiter.check` returns `false` → `CloseCode.RATE_LIMITED`
- `room.maxActors` reached → `KickReason.ROOM_FULL`

---

## Concepts introduced

### `AuthMiddleware` — per-connection ticket validation

```typescript
class TicketAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const sep = ticket.indexOf(':')
        if (sep <= 0) return null                                   // reject
        if (!timingSafeCompare(ticket.slice(sep + 1), SECRET)) return null
        return { data: { name }, roomId: ROOM_ID }                  // accept
    }
}
```

`authenticate` fires once per inbound socket, before any room is entered.
Return `null` to reject (`CloseCode.INVALID_TICKET`); return `{ data, roomId }`
to accept and route the actor.

Use `timingSafeCompare` instead of `===` — plain equality short-circuits at the
first mismatching byte and leaks the prefix length to timing-oracle attacks.

### `TokenBucketRateLimiter` — per-actor inbound throttle

```typescript
new TokenBucketRateLimiter({ capacity: 4, refillPerSecond: 1 })
// passed to:
new Rivalis({ ..., rateLimiter })
```

Each actor gets an independent bucket.  `check(actorId)` returns `false` when
the bucket is empty; the framework kicks the actor with `KickReason.RATE_LIMITED`
and drops the frame.

### `ConnectionLimiter` — pre-auth socket rate cap

```typescript
class SlidingWindowLimiter extends ConnectionLimiter {
    override check(remoteAddress: string): boolean { ... }
}
// passed to WSTransport as a transport option:
new WSTransport({ server }, null, { connectionLimiter })
```

`check` runs on every raw TCP socket *before* auth.  Return `false` to close
the socket with `CloseCode.RATE_LIMITED`.  The argument is the remote address.

There is no `release` callback — the limiter manages its own state (here a
`Map<IP, timestamp[]>`) and expires old entries on its own schedule.

### `actor.kick(reason)` — server-initiated disconnect

```typescript
actor.kick(KickReason.RATE_LIMITED)
```

Disconnects a specific actor at any time.  The string becomes the WebSocket
close-frame reason so the client can identify the cause.  `KickReason` exports
the well-known reason strings (`rate_limited`, `room_full`, `room_destroyed`,
`server_shutdown`, …).

### `room.maxActors` — room-level head count cap

```typescript
class GateRoom extends Room<ActorData> {
    override maxActors = 2
}
```

When the cap is reached, `TLayer.grantAccess` rejects new joins with
`KickReason.ROOM_FULL` — the actor authenticated but cannot enter the room.

---

## What to try next

- Change `TICKET_SECRET` and restart — all clients fail auth.
- Set `capacity: 1` on the rate limiter and run the flood scenario — the second
  frame already exhausts the bucket.
- Set `CONN_LIMIT_MAX = 1` and run a single `bad-auth` followed by a
  `good-client` — the good client hits the connection cap because the failed
  connection still counted in the window.
- Add a `'kick'` topic to `GateRoom` so an operator client can kick a named
  actor on demand instead of using the timer.

Continue to **[04-…](../04-…/)** *(coming soon)*.
