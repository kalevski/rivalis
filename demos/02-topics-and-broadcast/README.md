# Guided level 02 — topics and broadcast

Adds three actors to a single room and demonstrates the four capabilities that
multi-client applications are built on: named topic subscription, broadcasting
to all actors, sending a direct message to a single actor, and reacting to
actors joining and leaving.

Read `src/server.ts` and `src/client.ts` top-to-bottom alongside this README.

---

## What this demo does

```
Terminal 1 (server)
[server] room "lobby" ready
[server] listening on ws://localhost:3101  (Ctrl-C to stop)
[server] JOIN   Alice  (id=Alice)  total=1
[server] ROSTER → Alice  peers=[(none)]
[server] JOIN   Bob    (id=Bob)    total=2
[server] ROSTER → Bob   peers=[Alice]
[server] CHAT   <Alice>: Hello from Alice!
[server] DM     <Bob> → <Alice>: Hey Alice, private message from Bob!
[server] JOIN   Carol  (id=Carol)  total=3
[server] ROSTER → Carol  peers=[Alice, Bob]
[server] CHAT   <Bob>: Hello from Bob!
[server] DM     <Carol> → <Alice>: Hey Alice, private message from Carol!
[server] CHAT   <Carol>: Hello from Carol!
[server] LEAVE  Alice  (id=Alice)  remaining=2
[server] LEAVE  Bob    (id=Bob)    remaining=1
[server] LEAVE  Carol  (id=Carol)  remaining=0

Terminal 2 (Alice)
[Alice] connected to ws://localhost:3101
[Alice] sent CHAT   "Hello from Alice!"
[Alice] ROSTER  you=Alice  peers=[(none)]
[Alice] CHAT    <Alice>: Hello from Alice!
[Alice] NOTICE  ** Bob joined   (id=Bob)
[Alice] DM      [from Bob] Hey Alice, private message from Bob!
[Alice] NOTICE  ** Carol joined (id=Carol)
[Alice] DM      [from Carol] Hey Alice, private message from Carol!
[Alice] CHAT    <Bob>: Hello from Bob!
[Alice] CHAT    <Carol>: Hello from Carol!

Terminal 3 (Bob)
[Bob] connected to ws://localhost:3101
[Bob] sent CHAT   "Hello from Bob!"
[Bob] ROSTER  you=Bob  peers=[Alice]
[Bob] sent DM     → Alice: "Hey Alice, private message from Bob!"
[Bob] CHAT    <Alice>: Hello from Alice!
[Bob] NOTICE  ** Bob joined   (id=Bob)   ← own join notice
[Bob] NOTICE  ** Carol joined (id=Carol)
[Bob] CHAT    <Bob>: Hello from Bob!
[Bob] CHAT    <Carol>: Hello from Carol!

Terminal 4 (Carol)
[Carol] connected to ws://localhost:3101
[Carol] sent CHAT   "Hello from Carol!"
[Carol] ROSTER  you=Carol  peers=[Alice, Bob]
[Carol] sent DM     → Alice: "Hey Alice, private message from Carol!"
[Carol] CHAT    <Alice>: Hello from Alice!
[Carol] CHAT    <Bob>: Hello from Bob!
[Carol] NOTICE  ** Carol joined  (id=Carol)  ← own join notice
[Carol] CHAT    <Carol>: Hello from Carol!
```

---

## Concepts introduced

### Named topic subscription — `bind(topic, handler)`

The room registers two inbound topics in `onCreate()`:

```typescript
this.bind('chat', this.onChat)  // any actor → broadcast to all
this.bind('dm',   this.onDm)   // any actor → single targeted actor
```

Frames arriving on an unregistered topic kick the sender by default
(`unknownTopicPolicy = 'kick'`), so the topic list is an explicit contract
between server and clients.

### Broadcast — `this.broadcast(topic, payload)`

`broadcast()` iterates every actor currently in the room and calls `send()`
for each one.  It is used in two places:

| Where | What it sends | Who receives it |
|-------|---------------|-----------------|
| `onJoin` | `notice { type: 'join', … }` | All actors, including the one that just joined |
| `onLeave` | `notice { type: 'leave', … }` | Actors still in the room (leaver already removed) |
| `onChat` handler | `chat { from, text }` | All actors, including the sender |

### Direct (targeted) delivery — `actor.send(topic, payload)`

`actor.send()` reaches exactly one actor.  Used here for:

- The **roster** frame sent to the joining actor only, listing who is already
  in the room.
- The **dm** frame forwarded to a single named peer — `getActor(id)` (a
  protected `Room` method) looks up the target; if it is not currently in the
  room the frame is silently dropped.

### Join / leave lifecycle — `onJoin` / `onLeave`

| Hook | Actor in room map | Typical use |
|------|------------------|-------------|
| `onJoin(actor)` | Yes — just added | Send welcome data; announce to others |
| `onLeave(actor)` | No — already removed | Announce to remaining actors; clean up per-actor state |

Because the leaver is gone from the map before `onLeave` runs, a `broadcast()`
inside `onLeave` naturally skips them.

### `ActorData` type parameter

`Room<ActorData>` gives typed access to `actor.data` inside every handler and
lifecycle hook.  The auth middleware stamps `{ name: string }` onto each actor
by returning it as the `data` field of `AuthResult`.

---

## How to run

> **Prerequisites:** run `npm install` from the repo root once.

### Step 1 — start the server

```sh
npm run start -w @rivalis/guided-02-topics-and-broadcast
```

Or with live-reload while editing:

```sh
npm run dev -w @rivalis/guided-02-topics-and-broadcast
```

### Step 2 — connect three clients (separate terminals)

```sh
npm run client -w @rivalis/guided-02-topics-and-broadcast -- Alice
npm run client -w @rivalis/guided-02-topics-and-broadcast -- Bob
npm run client -w @rivalis/guided-02-topics-and-broadcast -- Carol
```

Each client stays connected for 15 seconds and then disconnects on its own.
Open the terminals side-by-side so you can see the same events arriving from
three different perspectives simultaneously.

### Step 3 — observe

| What to watch for | Where it appears |
|-------------------|-----------------|
| Join notices for every new actor | All client terminals |
| Own join notice (self-notification) | The joining client's terminal |
| Chat messages from every sender | All client terminals |
| Roster (private, only for the joining actor) | The joining client's terminal |
| DM from a later-joining client to Alice | Alice's terminal |
| Leave notices as clients time out | Remaining client terminals |

---

## What to try next

- Add a second `bind()` for a `shout` topic that prefixes the text with
  `[SHOUT]` before broadcasting — notice how only frames on that exact topic
  reach the handler.
- Set `protected override presence = true` on `BroadcastRoom` and watch
  `__presence:join` / `__presence:leave` frames appear automatically alongside
  the manual `notice` frames.
- Override `presencePayload(actor)` to control what fields the automatic
  presence frames expose.

Continue to **[03-auth-and-limits](../03-auth-and-limits/)** to require
authentication and enforce per-room connection limits.
