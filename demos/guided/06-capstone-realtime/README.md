# Guided level 06 — Capstone: multiplayer lobby + match server

The final rung of the tutorial ladder. A single real-time application that
combines every capability introduced in levels 01–05: auth, rate limiting,
connection limiting, dynamic room creation, authoritative state with a tick
loop, broadcast and direct messaging, presence, and server-initiated kicks.

## What this demo builds

A two-phase arena game:

1. **Lobby** — players connect and declare readiness. When at least two are
   queued, the server creates a match room and notifies each player where to
   reconnect.

2. **Match** — up to four players share a room with a server-authoritative
   score state. A tick loop broadcasts snapshots every second. Players earn
   points by sending `score` inputs. After 25 seconds the server broadcasts
   the final result and destroys the room.

```
CLIENT A                 SERVER                  CLIENT B
──────────────────────────────────────────────────────────
connect "Alice:arena|lobby"  ──►  lobby JOIN
                                  ◄──  welcome
send "ready"             ──►  readySet.add(Alice)
                                  ◄──  status {queued}

connect "Bob:arena|lobby"  ──►  lobby JOIN
                                  ◄──  welcome
send "ready"             ──►  readySet.add(Bob)
                                  3 s matchmaking tick fires
                          rooms.create("match", "match-1")
                                  ◄──  match:assigned {matchId:"match-1"}  (Alice)
                                  ◄──  match:assigned {matchId:"match-1"}  (Bob)

connect "Alice:arena|match-1" ──►  match-1 JOIN
                                  ◄──  match:snapshot (tick=0, status=open)
connect "Bob:arena|match-1" ──►  match-1 JOIN
                                  ◄──  match:snapshot (tick=0, status=open)
                                  ...tick every 1 s...
                                  5 s: room locked (joinable=false)
                                  ◄──  match:event {type:"locked"}  (both)
send "score"             ──►  state.scores[Alice] += N
                                  ◄──  score:ack + next snapshot (both)
                                  ...
                                  25 s: match ends
                                  ◄──  match:over {winner, scores}  (both)
                          rooms.destroy("match-1")  →  actors kicked (ROOM_DESTROYED)
```

## Feature map — how this capstone maps to earlier levels

| Feature | API used here | Introduced in |
|---------|--------------|---------------|
| Stand up a server and a Room | `Rivalis`, `Room`, `onCreate` | Level 01 |
| Receive actors and send welcome | `onJoin`, `actor.send` | Level 01 |
| Auto-broadcast join/leave | `presence = true` | Level 01 |
| Named topic handlers | `bind`, `onChat`, `onScore` | Level 01–02 |
| Broadcast to all actors | `Room.broadcast` | Level 02 |
| Direct message to one actor | `actor.send` | Level 02 |
| Ticket-gated authentication | `AuthMiddleware`, `timingSafeCompare` | Level 03 |
| Token-bucket rate limiting | `TokenBucketRateLimiter` | Level 03 |
| Per-IP connection limiting | `ConnectionLimiter` | Level 03 |
| Cap actors per room | `maxActors = 4` | Level 03 |
| Prevent late joiners | `joinable = false` | Level 03 |
| Server-initiated kick | `actor.kick(reason)` | Level 03 |
| Server tick loop | `setInterval` in `onCreate` | Level 04 |
| Authoritative shared state | `state.scores` mutated server-side | Level 04 |
| Late-join snapshot | `actor.send(snapshot)` in `onJoin` | Level 04 |
| TLayer state broadcast | `Room.broadcast('match:snapshot', …)` | Level 04 |
| Register a room type | `rooms.define` | Level 05 |
| Create a room on demand | `rooms.create` | Level 05 |
| Look up a live room | `rooms.get` | Level 05 |
| Destroy a room | `rooms.destroy` | Level 05 |
| Room lifecycle events | `rooms.on('create'…)` / `rooms.on('destroy'…)` | Level 05 |
| Auto-dispose when empty | `onLeave` → `rooms.destroy` when count=0 | Level 05 |

## Ticket format

```
<name>:<secret>|<destination>
```

| Part | Value |
|------|-------|
| `name` | Alphanumeric display name, max 20 chars |
| `secret` | Must equal `arena` |
| `destination` | `lobby` or `match-N` (the match must already exist) |

Examples:

```
Alice:arena|lobby
Bob:arena|match-1
```

## How to run

### 1 — Install dependencies (repo root, one-time)

```bash
npm install
```

### 2 — Start the server

```bash
npm run start -w @rivalis/guided-06-capstone-realtime
# or in watch mode (restarts on file changes)
npm run dev   -w @rivalis/guided-06-capstone-realtime
```

The server starts with a single lobby room. No match rooms exist yet.

### 3 — Connect clients

Open separate terminals for each client. You need at least two to trigger
matchmaking:

```bash
# Terminal A
npm run client -w @rivalis/guided-06-capstone-realtime -- Alice

# Terminal B
npm run client -w @rivalis/guided-06-capstone-realtime -- Bob

# Terminal C (optional — joins the same match if within MATCH_MAX_ACTORS=4)
npm run client -w @rivalis/guided-06-capstone-realtime -- Carol
```

Each client:
1. Connects to the lobby and receives a welcome message.
2. Automatically sends `ready` after 2 seconds.
3. Receives `match:assigned` once the lobby pairs two or more ready players.
4. Disconnects from the lobby and reconnects to the assigned match room.
5. Receives the late-join snapshot and starts scoring.
6. Exits cleanly when the match ends (after ~25 s).

### 4 — Type-check only (no emit)

```bash
npm run build -w @rivalis/guided-06-capstone-realtime
```

## Server-side timing

| Event | When |
|-------|------|
| Lobby matchmaking tick | Every 3 s |
| Match room lock (`joinable = false`) | 5 s after match creation |
| Match room end (all actors kicked) | 25 s after match creation |
| Lobby idle kick | 45 s after a player joins without getting a match |

## Observable log lines

Watch the server terminal to follow the full lifecycle:

```
[server]  listening on ws://localhost:3105
[manager] CREATED  id="lobby"  type="lobby"  total=1  active=[lobby]
[lobby]   created  tick=3000ms  idleKick=45s
[auth]    accepted  name="Alice"  → lobby
[lobby]   JOIN  name="Alice"  total=1
[auth]    accepted  name="Bob"  → lobby
[lobby]   JOIN  name="Bob"  total=2
[lobby]   READY  name="Alice"  readyCount=1
[lobby]   READY  name="Bob"    readyCount=2
[lobby]   MATCH ASSIGNED  name="Alice"  matchId="match-1"
[lobby]   MATCH ASSIGNED  name="Bob"    matchId="match-1"
[manager] CREATED  id="match-1"  type="match"  total=2  active=[lobby, match-1]
[match:match-1] created  maxActors=4  locks in 5s  ends in 25s
[auth]    accepted  name="Alice"  → match-1
[match:match-1] JOIN  name="Alice"  total=1
[auth]    accepted  name="Bob"    → match-1
[match:match-1] JOIN  name="Bob"    total=2
[match:match-1] TICK  #001  actors=2  status=open
[match:match-1] LOCKED  actors=2
[match:match-1] SCORE  name="Alice"  +3  total=3
[match:match-1] TICK  #006  actors=2  status=locked  leader="Alice"
...
[match:match-1] MATCH OVER  winner="Alice"  tick=25
[manager] DESTROYED  id="match-1"  total=1  active=[lobby]
[match:match-1] destroyed
```
