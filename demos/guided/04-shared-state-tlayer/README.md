# Guided level 04 — authoritative shared state with TLayer

Introduces server-authoritative state and a server tick loop — the foundation
of any real-time multiplayer application where the server is the single source
of truth.

Read `src/server.ts` and `src/client.ts` top-to-bottom alongside this README.

---

## Concepts introduced

### 1. Server tick loop

The server advances state on a fixed interval (`TICK_RATE_MS`), independent of
client connections.  The clock starts in `onCreate()` and stops in `onDestroy()`:

```typescript
protected override onCreate(): void {
    this.bind('increment', this.onIncrement)
    this.bind('reset',     this.onReset)

    this.tickTimer = setInterval(() => this.onTick(), TICK_RATE_MS)
}

protected override onDestroy(): void {
    if (this.tickTimer !== null) {
        clearInterval(this.tickTimer)
    }
}
```

`onTick()` increments the server's `tick` counter and broadcasts a snapshot to
every connected actor.  The timer fires even when the room is empty — the server
clock is authoritative, not client-driven.

### 2. TLayer as the delivery bus

`Room.broadcast()` and `Room.send()` are thin wrappers around `TLayer.send()`.
The full delivery path for a tick snapshot looks like this:

```
onTick()
  → Room.broadcast('snapshot', JSON.stringify(snap))
    → TLayer.send(actorId, 'snapshot', bytes)   ← for each joined actor
      → encode(topic, payload)                   ← @rivalis/handshake framing
        → WebSocket.send(frame)                  ← WSTransport
```

The room never holds a socket reference.  It calls `broadcast()` and the
`TLayer` + `Transport` stack handles delivery.  `Config` (passed to `Rivalis`)
is where transports are declared; `TLayer` wires them to the room registry at
boot.

### 3. Authoritative state — inputs, not writes

Clients submit **inputs**, not state patches.  The server applies the input to
its own `SharedState`, then the next tick snapshot propagates the result to
everyone:

```
client sends 'increment' { amount: 5 }
  → server: state.counter += 5, state.lastMutatedBy = name
  → next tick: broadcast('snapshot', { tick, counter, lastMutatedBy })
    → every actor (including the sender) receives the updated counter
```

This keeps the data flow unidirectional and prevents clients from diverging.

### 4. Late-join snapshot

A client connecting after many ticks have passed would see a stale counter
(zero) if it had to wait for the next broadcast.  Instead, `onJoin()` sends the
current snapshot directly to the joining actor before the next tick fires:

```typescript
protected override onJoin(actor: Actor<ActorData>): void {
    // Immediate catch-up — no tick wait required.
    actor.send('snapshot', JSON.stringify(this.buildSnapshot()))
}
```

The client logs the first snapshot it receives with a `← late-join snapshot`
label so the timing is visible.

---

## What the demo does

The server runs a shared counter that starts at zero.  Every second it
broadcasts `{ tick, counter, lastMutatedBy }` to all connected actors.  Actors
in `mutate` mode increment the counter by +5 every 3 seconds and reset it once
at 12 seconds.

```
Server terminal (abridged):

[server] listening on ws://localhost:3103  (Ctrl-C to stop)
[server] room "state-room" ready  tickRate=1000ms
[tick] #0001  counter=0   lastMutatedBy=(none)  actors=0
[tick] #0002  counter=0   lastMutatedBy=(none)  actors=0
[room] JOIN  name="Observer"  tick=2  counter=0  total=1
[tick] #0003  counter=0   lastMutatedBy=(none)  actors=1
[room] JOIN  name="Mutator"   tick=3  counter=0  total=2
[tick] #0004  counter=0   lastMutatedBy=(none)  actors=2
[room] INCREMENT  from="Mutator"  amount=+5  counter=5
[tick] #0005  counter=5   lastMutatedBy=Mutator  actors=2
[room] INCREMENT  from="Mutator"  amount=+5  counter=10
[tick] #0006  counter=10  lastMutatedBy=Mutator  actors=2
...
[room] RESET  from="Mutator"  before=20  after=0
[tick] #0013  counter=0   lastMutatedBy=Mutator  actors=2

Observer terminal:

[Observer] connected  mode=watch
[Observer] waiting for snapshot from server...
[Observer] snapshot  tick=2  counter=0   by=(none)  ← late-join snapshot
[Observer] snapshot  tick=3  counter=0   by=(none)
[Observer] snapshot  tick=4  counter=0   by=(none)
[Observer] snapshot  tick=5  counter=5   by=Mutator
[Observer] snapshot  tick=6  counter=10  by=Mutator
...

Mutator terminal:

[Mutator]  connected  mode=mutate
[Mutator]  waiting for snapshot from server...
[Mutator]  snapshot  tick=3  counter=0  by=(none)  ← late-join snapshot
[Mutator]  → increment  amount=+5
[Mutator]  snapshot  tick=5  counter=5  by=Mutator
[Mutator]  → increment  amount=+5
[Mutator]  snapshot  tick=6  counter=10  by=Mutator
...
[Mutator]  → reset
[Mutator]  snapshot  tick=13  counter=0  by=Mutator
[Mutator]  done — disconnecting
[Mutator]  disconnected
```

---

## How to run

> **Prerequisites:** run `npm install` from the repo root once.

### Step 1 — start the server

```sh
npm run start -w @rivalis/guided-04-shared-state-tlayer
```

Or with live-reload while editing:

```sh
npm run dev -w @rivalis/guided-04-shared-state-tlayer
```

### Step 2 — connect a watch client (separate terminal)

```sh
npm run client:watch -w @rivalis/guided-04-shared-state-tlayer
```

Connects as `Observer` in `watch` mode: logs every incoming snapshot.  Connect
it a few ticks after the server starts to see the late-join snapshot carry the
current counter value.

### Step 3 — connect a mutating client (another terminal)

```sh
npm run client:mutate -w @rivalis/guided-04-shared-state-tlayer
```

Connects as `Mutator` in `mutate` mode: sends `increment +5` every 3 seconds
and a `reset` at 12 seconds, then disconnects.  Watch the `Observer` terminal —
it sees every counter change without sending anything itself.

### Custom name and mode

You can use any name and connect multiple instances simultaneously:

```sh
npx ts-node demos/guided/04-shared-state-tlayer/src/client.ts Alice watch
npx ts-node demos/guided/04-shared-state-tlayer/src/client.ts Bob   mutate
```

---

## What to try next

- Change `TICK_RATE_MS` to `200` and watch the snapshots arrive 5× faster.
- Connect two mutator clients simultaneously and observe that both increment
  inputs apply to the same shared counter.
- Add a `multiply` topic: `{ factor: number }` multiplies the counter rather
  than adding to it.  Notice that the validation / clamping pattern in
  `onIncrement` applies there too.
- Store per-actor scores in the state (a `Map<string, number>`) that accumulate
  with each `increment`.  On leave, broadcast a final leaderboard snapshot.

Continue to **[05-…](../05-…/)** *(coming soon)*.
