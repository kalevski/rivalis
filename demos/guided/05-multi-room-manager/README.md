# Guided level 05 — RoomManager: create / route / list / dispose

Builds on levels 01–04. The per-room logic is an intentionally trivial echo
room; the lesson is the **room lifecycle** that `RoomManager` exposes.

## Concepts covered

| API | What it does |
|-----|-------------|
| `rooms.define(key, RoomClass)` | Register a room *type* (class) without creating any instance |
| `rooms.create(type, id)` | Spin up a room on demand, keyed by caller-chosen id |
| `rooms.get(id)` | Look up a live room — returns `null` when it does not exist |
| `rooms.destroy(id)` | Dispose a room; remaining actors are kicked, `onDestroy` runs |
| `rooms.count` | Number of rooms currently alive |
| `rooms.keys()` | Iterator over live room ids |
| `rooms.on('create', …)` | Event fired after a room is inserted — `(roomId, roomType)` |
| `rooms.on('destroy', …)` | Event fired after a room is removed — `(roomId)` |

## Create / route / dispose flow

```
client connects with ticket "Alice|lobby"
        │
        ▼
RoomAuth.authenticate()
  rooms.get('lobby') === null  →  rooms.create('echo', 'lobby')
  return { data: { name: 'Alice' }, roomId: 'lobby' }
        │
        ▼
[manager] CREATED  id="lobby"  type="echo"  total=1  active=[lobby]
        │
        ▼
EchoRoom.onJoin(Alice)  →  actor.send('welcome', '…')
[room:lobby] JOIN  name="Alice"  occupants=1

--- Alice types a message ---

EchoRoom.onEcho  →  actor.send('echo', '[lobby] Alice: hello')

--- Alice disconnects ---

EchoRoom.onLeave(Alice)
  actorCount === 0  →  rooms.destroy('lobby')
[room:lobby] LEAVE  name="Alice"  remaining=0
[room:lobby] destroyed
[manager] DESTROYED  id="lobby"  total=0  active=[]
```

When a second client joins the same room name before Alice leaves, `rooms.get`
returns the existing instance and no new room is created. Both clients share
one `EchoRoom` and receive each other's `__presence:join` / `__presence:leave`
events automatically (the room sets `presence = true`).

## How to run

### 1 — Start the server

```bash
# from the repo root
npm run start -w @rivalis/guided-05-multi-room-manager
# or in watch mode
npm run dev -w @rivalis/guided-05-multi-room-manager
```

The server starts with **zero rooms**. Watch the terminal for `[manager]`
lines as rooms are created and destroyed.

### 2 — Connect clients

Open several terminals and run each command independently:

```bash
# Terminal A — Alice joins "lobby"
npm run client -w @rivalis/guided-05-multi-room-manager -- Alice lobby

# Terminal B — Bob joins a *different* room "arena"
npm run client -w @rivalis/guided-05-multi-room-manager -- Bob arena

# Terminal C — Carol joins "lobby" (same room as Alice)
npm run client -w @rivalis/guided-05-multi-room-manager -- Carol lobby
```

Or pass name / room directly when calling `ts-node`:

```bash
ts-node src/client.ts Alice lobby
ts-node src/client.ts Bob   arena
```

### 3 — Observe the lifecycle

1. **First join to a room** → `[manager] CREATED` log line.
2. **Multiple clients in the same room** → they see each other's presence
   events and share the same echo channel; clients in other rooms see nothing.
3. **Last client leaves a room** → `EchoRoom.onLeave` calls `rooms.destroy()`,
   which triggers `[manager] DESTROYED`. The room id is freed and will be
   re-created fresh the next time a client requests it.

### 4 — Verify type-check

```bash
npm run build -w @rivalis/guided-05-multi-room-manager
```
