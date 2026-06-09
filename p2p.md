# Rivalis — Transport/Client architecture redesign (P2P as the forcing function)

Bring peer-to-peer multiplayer (WebRTC data channels) to Rivalis **without forcing
developers to learn a second programming model**. The same `Room` / `Actor` /
`bind(topic)` / `broadcast` patterns that power the WebSocket server today must work
over WebRTC, unchanged.

But P2P is not the point of this document. It is the *forcing function*. Adding a second
transport and a second client surfaces every place where the current code special-cases
WebSocket instead of programming against an abstraction. This redesign generalizes those
seams so that **WS, WebRTC, and any future transport/client are all first-class** — and
P2P then falls out as "implement two interfaces," not "fork the framework."

> **Guiding principle:** Game logic stays a `Room` subclass. The transport underneath it
> changes, not the API. Everything below is engineered around that one constraint.

This revision is grounded in a line-by-line re-read of the runtime (`core@6.1.0`,
`handshake@6.0.0`, `browser@6.0.0`, `fleet`). Where the previous draft hand-waved, the
specifics are now nailed down — including three issues the first pass missed (a missing
`Room` actor-lookup API, the pre-listener emit buffer's effect on transport ordering, and
the fact that the serializer-ESM hazard already reaches the kernel, not just future
packages).

---

## 1. Ground-truth audit (what exists, and where it blocks reuse)

The good news the original plan got right: the game-logic + routing layer (`Room`, `Actor`,
`TLayer`, `RoomManager`, `AuthMiddleware`, `Rivalis`, `Config`) imports **only isomorphic
deps**. Verified: every kernel file (`Rivalis.ts`, `TLayer.ts`, `Room.ts`, `Actor.ts`,
`Config.ts`, `AuthMiddleware.ts`, `RoomManager.ts`) imports only from `@toolcase/base`,
`@toolcase/logging`, and `@rivalis/handshake`. The single CSPRNG call (`generateId`,
`TLayer.ts:1`, `RoomManager.ts:1`) resolves to `@toolcase/base`'s `generateId`, which is
`globalThis.crypto.getRandomValues(...)` — **browser-native and Node-18+-native, no
`node:crypto`.** The only node builtins in the entire package are `node:crypto.createHash`
(`WSTransport.ts:2`, for the WS `Sec-WebSocket-Accept` digest) and `ws`
(`WSTransport.ts:3`, `clients/WSClient.ts:2`). The kernel source is *already* isomorphic;
it is held hostage purely by what `main.ts` statically imports.

The `Transport` ↔ `TLayer` seam is genuinely the single integration point. A transport
touches the framework through exactly five calls, all verified in `WSTransport.ts`:

| Step | Call | Direction | Site |
|------|------|-----------|------|
| 1 | `await tl.grantAccess(ticket)` → `actorId` | transport → framework | `WSTransport.ts:211` |
| 2 | `tl.handleMessage(actorId, bytes)` | inbound | `WSTransport.ts:251` |
| 3 | `tl.on('message', actorId, (_, m) => …)` | register outbound | `WSTransport.ts:258` |
| 4 | `tl.on('kick', actorId, (_, m) => …)` | register kick | `WSTransport.ts:269` |
| 5 | `tl.handleClose(actorId)` | disconnect | `WSTransport.ts:205` |

`fleet/` already proves you can stand up a *second* Rivalis app on core as a control plane
(`fleet/src/orchestrator/transport.ts:109` — `attachControlPlane` builds
`new core.Rivalis({ transports:[new WSTransport(...)], authMiddleware, rateLimiter })` and
`rooms.define/create`). That is the exact shape `@rivalis/signal` will reuse.

The bad news — the concrete blockers a second transport/client hits today:

| # | Finding | Evidence | Impact |
|---|---------|----------|--------|
| **F1** | `Transport` base class is **not exported** from `@rivalis/core`. | `core/src/main.ts:40-54` exports `Transports = { WSTransport }`, `Clients = { WSClient }`, and the option types — but never the `Transport` class. `Config` validates `transport instanceof Transport` (`Config.ts:38-42`). | You **cannot author an external transport.** `class RTCTransport extends Transport` is impossible without editing core. Root blocker. |
| **F2** | `@rivalis/core` is **node-only by construction**, though its kernel is not. | `main.ts:12-14` statically `import WSTransport` (→ `ws`, `node:crypto`) and node `WSClient` (→ `ws`); `core/tsup.config.ts` builds a single `src/main.ts` entry at `platform:'node'` with one `"."` export (`package.json:9-15`). | A browser cannot `import '@rivalis/core'` (browser-host, phase 3, is impossible) even though the kernel itself has zero node deps. Two files in one entry hold the isomorphic kernel hostage. |
| **F3** | **Two divergent `WSClient`s** with different contracts. | `browser/src/WSClient.ts` emits `client:connect/disconnect/kicked/reconnecting/reconnect_failed`, has reconnect+jittered backoff (`:355-361`), `getTicket` refresh (`:327-353`), and maps any close code 4000–4999 → `client:kicked {code,reason}` (`:271-280`). `core/src/clients/WSClient.ts` emits `client:connect/disconnect/error`, has **no** reconnect, **no** `kicked`, and an `emit` override that *warns* when no listener is registered (`:170-176`). | "Swap `WSClient` → `RTCClient`" has no contract to swap *against*. The two existing clients already disagree; a third would deepen the mess. |
| **F4** | **Three serializers**, each re-inventing framing discipline. | `handshake/src/serializer.ts` (game frames: `{topic, payload}` over `@toolcase/serializer`), `fleet/src/wire/serializer.ts` (versioned binary, 2-byte `[major,minor]` header, append-only tags, `encodeFrame/decodeFrame`, 417 lines), and the proposed signal wire would be a fourth. | Signaling needs typed, versioned frames; without a shared toolkit it hand-copies fleet's 417-line codec. |
| **F5** | **`@toolcase/serializer`'s ESM entry is broken under Node strict ESM — and the kernel chain already depends on it.** | `node_modules/@toolcase/serializer/lib/main.module.js:2` does `import { Root, Type, … } from "protobufjs/light"` (bare subpath, no `.js`), which Node's strict-ESM resolver rejects. `handshake/src/serializer.ts:1` **top-level-imports** the serializer, and `core/src/TLayer.ts:6` top-level-imports `@rivalis/handshake`. | The hazard is **not** future-only. The core kernel's *own* ESM entry transitively pulls the broken import. It works today only because every consumer is either a **bundler** (Vite resolves `protobufjs/light` → `light.js`) or **CJS** (`require` resolves it). The first plain Node-ESM consumer of `@rivalis/signal`/`@rivalis/node` — or of core itself — breaks. Must be designed in. |
| **F6** | **Auth and rate-limit are single + global** per `Rivalis`. | `ConfigOptions` (`Config.ts:8-14`) — one `authMiddleware`, one `rateLimiter`, one `transports[]`. | Fine for the star (signaling and game host are separate Rivalis apps), but blocks "one host accepts WS *and* RTC peers under different admission rules." Worth an opt-in override. |
| **F7** | `grantAccess(ticket)` is a **string-only seam.** | `TLayer.grantAccess(ticket: string): Promise<string>` (`TLayer.ts:138`); `AuthMiddleware.authenticate(ticket: string)` (`AuthMiddleware.ts:34`). The transport has no typed channel for connection context (peer id, remote addr, transport kind). `WSTransport` does per-IP `ConnectionLimiter` *before* `grantAccess` (`WSTransport.ts:172-185`) because there is nowhere else to put it. | WebRTC's "ticket" arrives out-of-band via signaling and the host knows a `peerId` before the channel opens — there is no typed place to carry it into auth/logging. |
| **F8** *(new)* | **`Room` exposes no actor-lookup-by-id.** | `Room.ts:89` — `actors: Map<string, Actor>` is **private**; the public surface is `each(fn)` (`:213`), `broadcast` (`:209`), `send(actor, …)` (`:190`), `actorCount` (`:101`). There is no `getActor(id)`. | A signaling relay must forward an offer to *one specific* peer by id. Today that's impossible without either iterating `each` on every message or maintaining a parallel map in the `Room` subclass. The previous draft's `this.findActor(msg.to)` was fiction. |

These eight are the actual work. Fix F1–F5 + F8 and P2P is mostly "write the two obvious
classes." Leave them and every new transport reopens core.

---

## 2. Redesign principles

1. **One server-side extension contract (`Transport`) and one client-side extension
   contract (`Client`)** — both exported, both documented, both satisfied by WS and RTC
   identically. The framework programs against the contract; transports/clients are
   plugins.
2. **Core is isomorphic by default.** The kernel (`Rivalis`/`Room`/`Actor`/`TLayer`/…)
   already has no node deps in its *source*; restructure so importing it never drags in
   `ws`/`node:crypto`. Node-only transports/clients move behind platform subpath exports.
3. **The wire is transport-neutral.** `handshake` frames are typed bytes; any transport
   carries them verbatim. Close/kick semantics that WebSocket expresses with numeric close
   codes get a transport-agnostic control-frame convention so they survive over data
   channels too.
4. **P2P reuses, never forks.** `RTCTransport` satisfies the *same* five-step `Transport`
   seam `WSTransport` does. `RTCClient` satisfies the *same* `Client` contract `WSClient`
   does. The signaling server is *another Rivalis app*, exactly as `fleet/` is.
5. **Honor the constraints already discovered.** Lazy-`require` the serializer (F5),
   externalize peers in tsup, dual CJS+ESM — copy the patterns fleet already paid for
   (`fleet/src/util/loadCore.ts`, `fleet/tsup.config.ts`).
6. **Back-compat where cheap, a clean major where it pays.** Breaking import paths is
   acceptable in a `7.0.0` bump *if* it removes a whole class of confusion
   (node-in-browser). The shim is kept only if it can be done without re-polluting the
   browser bundle.

---

## 3. Core generalization (the heart of the redesign)

This section is transport-agnostic. None of it mentions WebRTC; all of it is what makes
WebRTC (and the next transport) cheap.

### 3.1 Export and widen `Transport`; carry connection context (fixes F1, F7)

Export the base class and give `grantAccess` an optional, typed connection context so a
transport can tell the framework *who* is connecting and *how*, without abusing the ticket
string.

```ts
// core/src/Transport.ts  (unchanged contract — exactly today's class, now EXPORTED)
abstract class Transport {
    abstract onInitialize(transportLayer: TLayer<any>): void
    /** Raw open connections that completed handshake (may not have joined a room). */
    abstract get sockets(): number
    dispose(): void | Promise<void> {}
}
```

```ts
// core/src/main.ts — add Transport (and the new Client base, §3.2) to exports
export { Rivalis, Transports, Clients, /* … */ Room, Actor, Transport, Client }
```

```ts
// New: a typed, optional connection context the transport may supply.
export type ConnectionContext = {
    /** Which transport admitted this connection ('ws' | 'webrtc' | custom). */
    kind: string
    /** Transport-native peer/remote id (WS: remoteAddress; RTC: signaling peerId). */
    remoteId?: string
    /** Opaque, transport-specific extras (origin header, ICE candidate type, …). */
    meta?: Record<string, unknown>
}

// TLayer.grantAccess gains an optional 2nd arg, forwarded to authenticate.
async grantAccess(ticket: string, context?: ConnectionContext): Promise<string>
```

```ts
// AuthMiddleware.authenticate gains an optional, ignorable 2nd arg.
abstract authenticate(
    ticket: string,
    context?: ConnectionContext
): Promise<AuthResult<TActorData> | null>
```

Both additions are **backward compatible**: existing transports call `grantAccess(ticket)`;
existing `authenticate(ticket)` overrides keep type-checking (TS permits an override that
ignores a trailing optional param). The win: WebRTC passes
`{ kind:'webrtc', remoteId: peerId }`, WS can finally pass
`{ kind:'ws', remoteId: request.socket.remoteAddress, meta:{ origin } }`, and auth can make
transport-aware decisions ("RTC peers must present a signaling-issued token").

`AuthResult` is `{ data: TActorData | null; roomId: string }` today (`AuthMiddleware.ts:7-10`).
Optionally add `actorId?: string` so a transport that already owns a stable identity (a
reconnecting peer) can request it; `TLayer` still validates uniqueness against `roomIds` and
falls back to its existing CSPRNG allocation — `generateId(16)` (64 bits of entropy), retried
up to 8 times on collision (`TLayer.ts:165-175`) — when absent or taken.

### 3.2 Introduce a `Client` base contract (fixes F3)

Today there is no client abstraction — just two classes that drifted (F3). Define the
contract both `WSClient`s already *almost* implement, make both conform, and make every
future client conform too. This is the single biggest reusability win: hooks
(`demo/src/client/useRoom.ts`, which currently types against the concrete `WSClient`),
fleet's `FleetTransportClient` (`FleetAgent.ts:90-99` — already a hand-rolled structural
version of exactly this contract), and app code all program against `Client`, never a
concrete class.

```ts
// core/src/Client.ts  (isomorphic — extends @toolcase/base Broadcast, like both WSClients)
export type ClientEvent =
    | 'client:connect'
    | 'client:disconnect'        // payload: Uint8Array (close reason)
    | 'client:kicked'            // { code, reason } — server/host ended the session
    | 'client:reconnecting'      // payload: Uint8Array (attempt count)
    | 'client:reconnect_failed'
    | 'client:error'             // payload: Error

export type ClientKickedEvent = { code: number; reason: string }

abstract class Client<TTopics extends string = string> extends Broadcast {
    abstract get connected(): boolean
    abstract connect(ticket?: string): void
    abstract disconnect(): void
    abstract send(topic: string, payload?: Uint8Array | string): void
    // typed on/once/off overloads — lift the browser WSClient's overload set verbatim
    // (browser/src/WSClient.ts:204-234): built-in events keyed precisely, user topics as TTopics.
}
```

The unified `ClientEvent` set is the **union** of what the two clients emit today:
browser has `kicked`/`reconnecting`/`reconnect_failed` but not `error`; node has `error`
but none of the others. Conformance means:

- `browser/src/WSClient.ts` `extends Client` — it already emits every event except
  `client:error`; add `client:error` emission on socket error (it currently swallows it
  into reconnect). Mostly declaring conformance.
- `core/src/clients/WSClient.ts` (node) is brought up to the same contract: add
  `client:kicked` (decode the close frame's `4xxx` code + reason exactly as browser does at
  `:271-280`), keep `client:error`, and either add reconnect or **document** that node
  reconnect is layered by the caller (fleet does this via `AgentInternals.createClient` +
  its own backoff). The two clients stop disagreeing. Drop or gate the warn-on-no-listener
  `emit` override (`:170-176`) — it is hostile to a generic event bus where not every event
  has a listener.
- `RTCClient` (browser + node) `extends Client` — and is therefore a drop-in anywhere a
  `Client` is expected.

`useRoom` changes its `useState<WSClient | null>` to `useState<Client | null>`; swapping
transports becomes a constructor change, not a type change. `FleetTransportClient` collapses
into "any `Client`" — `defaultCreateClient` (`FleetAgent.ts:130`) already returns
`Clients.WSClient` cast to its structural interface; once `Client` exists that cast
disappears.

### 3.3 Make core isomorphic; move node code behind subpaths (fixes F2)

Restructure exports so the **default entry is the isomorphic kernel** and node-only
transports/clients live behind explicit subpaths. Because the kernel source is *already*
node-free (§1), this is purely a build/entry split — no kernel code changes.

```jsonc
// core/package.json  → exports map (replaces the single "." entry, package.json:9-15)
{
  "exports": {
    ".":               { "types": "./lib/main.d.ts",     "import": "./lib/module.js",         "require": "./lib/main.js" },
    "./transports/ws": { "types": "./lib/ws.d.ts",       "import": "./lib/ws.module.js",      "require": "./lib/ws.js" },
    "./clients/ws":    { "types": "./lib/wsclient.d.ts",  "import": "./lib/wsclient.module.js","require": "./lib/wsclient.js" }
  }
}
```

- `core/src/main.ts` — kernel only: `Rivalis, Room, Actor, RoomManager, TLayer, Config,
  AuthMiddleware, LegacyAuthMiddleware, RateLimiter, TokenBucketRateLimiter,
  ConnectionLimiter, KickReason, Transport, Client, logging`, plus the `CloseCode` /
  `Message` re-exports from handshake. **Remove the `import './transports/WSTransport'` and
  `import './clients/WSClient'` statements (`main.ts:12-14`).**
- `core/src/transports/ws.ts` (new entry) — exports `WSTransport` + its option types
  (`WSTransportOptions, AllowedOrigins, TicketSource, BackpressureDropFn`).
- `core/src/clients/ws.ts` (new entry) — exports the node `WSClient` + its option types.
- `core/tsup.config.ts` — emit three entry pairs. Keep `platform:'node'` for the `ws`
  entries (they need `ws`/`node:crypto`); build the **kernel entry `platform:'neutral'`** so
  no node builtin is inlined and a browser bundler accepts it. Keep `@toolcase/*`,
  `@rivalis/handshake`, and `ws` in `external`.

**The F5 caveat that makes this non-trivial:** the kernel still top-level-imports
`@rivalis/handshake`, which top-level-imports `@toolcase/serializer`, whose ESM entry is the
broken `protobufjs/light` import. A browser bundler resolves this fine, so the *browser*
goal is met. But a plain Node-ESM `import '@rivalis/core'` would now break (today it works
only because real Node consumers go through CJS). Two options, decide in §13:
**(a)** apply the lazy-`require` serializer discipline (§3.5) down into `handshake` itself so
the kernel's ESM entry is Node-safe, or **(b)** accept that the default ESM kernel entry is
bundler-only and Node servers import via CJS / a node subpath. Recommendation: **(a)** — it
is the same fix fleet already wrote, and it makes the kernel genuinely universal.

**Back-compat shim: none (D1 — decided 2026-06-09).** The lazy-getter approach was ruled out:
any getter reachable from the neutral kernel entry is reachable by browser bundlers, which
would drag `ws` / `node:crypto` back in — the exact pollution the split eliminates. The
`Transports` / `Clients` namespace objects are removed from `main.ts` in `7.0.0`. Callers
migrate to `import { WSTransport } from '@rivalis/core/transports/ws'` (server) and
`import { WSClient } from '@rivalis/core/clients/ws'` (node client). See
`core/CHANGELOG.md` for the full migration guide.

> This single restructure is what makes browser-as-host (phase 3) **fall out for free**
> instead of needing a bespoke `core/runtime.ts`. The runtime split *is* the default entry
> once node code is behind subpaths.

### 3.4 Transport-agnostic close/kick (control frames)

WebSocket expresses kick via a numeric close code + UTF-8 reason. The concrete mechanics,
verified:

- All in-room kicks funnel through `tl.on('kick', actorId, (_, msg) => socket.close(CloseCode.KICKED, Buffer.from(msg)))`
  (`WSTransport.ts:269-271`) — so every kick is close code **4003 (`KICKED`)**, and the
  *reason* (a `KickReason` string) distinguishes them. Pre-join rejections use distinct
  codes: `4001 INVALID_TICKET`, `4004 ROOM_REJECTED`, `4005 RATE_LIMITED`
  (`WSTransport.ts:175`, and on `grantAccess` failure).
- `CloseCode` (4001–4005) lives in `@rivalis/handshake/src/CloseCode.ts`. `KickReason`
  (string values: `invalid_message`, `room_destroyed`, `room_full`, `room_not_joinable`,
  `rate_limited`, `server_shutdown`) lives in `core/src/KickReason.ts`.
- The close *reason* is capped at **123 bytes** (`TLayer.ts:14` `MAX_CLOSE_REASON_BYTES`,
  the WebSocket control-frame limit) and truncated past it.
- The browser client maps any close code in `[4000,5000)` → `client:kicked {code, reason}`
  (`WSClient.ts:271-280`) and refuses to reconnect on `NO_RECONNECT_CODES = {4001, 4003, 4004}`
  (`WSClient.ts:79-83`).

Data channels have **no close code** — `RTCDataChannel.close()` carries nothing. Make the
kick/close reason a first-class, transport-neutral convention so it survives on any
transport:

- Reserve a control topic in `handshake` (e.g. `__rivalis:close`) carrying an encoded
  `{ code, reason }`. `Room`/`TLayer` already reserve the `__` prefix
  (`Room.ts` `RESERVED_TOPIC_PREFIX`, used for `__presence:join`/`__presence:leave`), so this
  is consistent — and `bind` already throws on `__` topics, so user code can't collide.
- `WSTransport` keeps using native close frames (no observable change to WS clients).
- Non-close-code transports (RTC) send the control frame **immediately before** closing the
  channel; the client decodes it to `client:kicked { code, reason }` — the **same event** WS
  clients emit. The `NO_RECONNECT_CODES` gate then works identically across transports.
- Preserve the 123-byte reason ceiling in the convention even though data channels don't
  require it, so a reason string behaves identically regardless of transport.

Result: `KickReason` strings and `CloseCode` numbers become genuinely protocol-level, not
WS-level, and the client's reconnect/kick handling is written once.

### 3.5 Shared typed-codec toolkit (addresses F4, F5)

The project has/needs three protobuf-on-`@toolcase/serializer` codecs. Extract the
**discipline** (not the schemas) into one place so signaling doesn't hand-copy fleet's 417-line
codec:

- A small helper (in `@rivalis/handshake` — home confirmed by D7, decided 2026-06-09)
  wrapping `@toolcase/serializer` with: the 2-byte `[major, minor]` version header
  (`fleet/src/wire/serializer.ts` `WIRE_MAJOR=PROTOCOL_VERSION`, `WIRE_MINOR=0`,
  `HEADER_BYTES=2`), the append-only positional-tag rule (tags are assigned by field order;
  never reorder/remove, only append — `fleet/.../serializer.ts:21-31`), `present()`-based
  decode (own-property vs prototype default — `:228-231`), a `WireVersionError` on major
  mismatch, and — load-bearing — the **lazy serializer loader** that dodges the broken ESM
  (F5):

  ```ts
  // the established fix — fleet/src/wire/serializer.ts:132-142, fleet/src/util/loadCore.ts
  function getSerializer() {
      if (serializer) return serializer
      const metaUrl = import.meta.url                       // real URL in the ESM bundle…
      const req = metaUrl ? createRequire(metaUrl) : require // …empty in the CJS bundle → native require
      const mod = req('@toolcase/serializer')                // resolves the WORKING CJS entry, never the broken ESM one
      const Serializer = mod.Serializer ?? mod.default
      serializer = new Serializer('@rivalis/<name>')
      return serializer
  }
  ```

- `handshake`'s game-frame codec (`{topic, payload}`, no version header — it's the hot path
  and the frame shape is fixed) is the one place that may need the lazy loader retrofitted to
  it (see §3.3 option (a)): today it top-level-imports the serializer
  (`handshake/src/serializer.ts:1`), which is exactly what exposes the kernel's ESM entry to
  F5. Converting that single import to the lazy loader closes the hazard at its source.
- The toolkit is for *control/negotiation* wires (fleet, signal) where typed payloads and
  version evolution matter.

Concretely, `@rivalis/signal`'s `wire/` becomes ~80 lines of schema definitions over the
shared helper, not a fork of fleet's 417-line file, and F5's lazy loader is solved once.

### 3.6 Multi-transport into one room; optional per-transport admission (addresses F6)

`Rivalis` already takes `transports: Transport[]` and a single room space, and its
constructor calls `transport.onInitialize(this.transportLayer)` for each
(`Rivalis.ts:33-34`). Two cheap wins:

- **✅ Document and test "one `Room`, many transports" (task 042, 2026-06-09).**

  #### Wiring

  Every transport in the array receives the **exact same `TLayer` reference** from
  `Rivalis.constructor`. Once each transport calls `tl.grantAccess(ticket, context)`, the
  actor is registered in that shared `TLayer` and joins whichever room `AuthResult.roomId`
  names. From that point, the actor is completely opaque to the room — `actorCount`,
  `each()`, `broadcast()`, `send()`, `kick()` all operate on the merged actor set regardless
  of which transport admitted them.

  ```ts
  // Both transports feed one room space via one TLayer.
  const rivalis = new Rivalis<ActorData>({
      transports: [
          new WSTransport({ port }),     // WS clients connect here
          new RTCTransport({ signalUrl }) // RTC peers connect here (Phase 1)
      ],
      authMiddleware: new ArenaAuthMiddleware()
  })
  rivalis.rooms.define('ttt', TttRoom) // TttRoom is transport-agnostic
  rivalis.rooms.create('ttt', 'game-1')
  ```

  #### Constraints

  1. **Shared admission.** All transports use the same `authMiddleware` and `rateLimiter`
     configured in `ConfigOptions`. Per-transport overrides are deferred to Phase 4
     (§13 D9, task 043/086).
  2. **Globally unique actor ids.** `TLayer.grantAccess` allocates a CSPRNG `actorId`
     (`generateId(16)`, 64 bits of entropy, 8 retries on collision) that is unique across
     the entire Rivalis instance, not just within a transport.
  3. **Transport-opaque rooms.** `Room.onJoin/onLeave/onMessage` receive an `Actor` with no
     indication of which transport admitted it. Transport-kind information is available via
     `ConnectionContext` (§3.1) if an auth middleware inspects it, but does not surface in
     the room API.
  4. **Pre-listener buffer applies to all transports.** Each transport must register
     `tl.on('message', actorId, …)` and `tl.on('kick', actorId, …)` promptly after
     `grantAccess` returns. `TLayer` buffers up to 256 outbound frames per actor key while
     no listener is registered (`pendingEmits`, `TLayer.ts:58-66`) and flushes them on the
     first `on`/`once` — so a slow transport risks overflowing that buffer on a chatty
     `onJoin`.

  Tested in `core/test/multi-transport-one-room.test.mts`.

- **Optional per-transport auth/rate-limit override.** Allow a transport to carry its own
  `authMiddleware?` / `rateLimiter?`; `TLayer` uses the transport's if present, else the
  global `Config` default. Keeps the simple case one-line, unlocks "WS peers authenticate by
  cookie, RTC peers by signaling token." Strictly additive to `ConfigOptions`
  (`Config.ts:8-14`). Recommend **defer** (§13) — separate Rivalis apps already cover the
  star topology.

### 3.7 Add `Room.getActor(id)` (fixes F8) — required by signaling

`Room` has no way to address one actor by id; `actors` is private (`Room.ts:89`) and the
public surface is `each`/`broadcast`/`send(actor,…)`/`actorCount`. A signaling relay must
forward an SDP offer to *one* peer, so add a minimal, protected lookup:

```ts
// core/src/Room.ts — additive, no behavior change to existing rooms
protected getActor(actorId: string): Actor<TActorData> | null {
    return this.actors.get(actorId) ?? null
}
```

This is the smallest correct fix and unblocks `SignalRoom.relay` (§4.3). It also tidies any
room that today reaches for `each` purely to find one actor. Purely additive.

---

## 4. P2P architecture (built on the generalized core)

With §3 in place, this is the easy half.

### 4.1 Topology: host-authoritative star (unchanged, and correct)

```
            ┌─────────────┐   signaling (WS, no game traffic after setup)
            │  @rivalis/  │◄────────────┬──────────────┬──────────────┐
            │   signal    │             │              │              │
            │ (a Rivalis  │   ICE config / TURN creds   │              │
            │   app)      │             │              │              │
            └─────────────┘             ▼              ▼              ▼
                                  ┌──────────┐   ┌──────────┐   ┌──────────┐
                                  │  HOST    │   │  peer A  │   │  peer B  │
                                  │ Rivalis +│◄═►│ RTCClient│   │ RTCClient│
                                  │RTCTransport══════════════════════════╝
                                  └──────────┘    WebRTC DataChannels (game traffic)
```

The star is the *only* topology that preserves the `Room` model: a `Room` holds
authoritative state and `broadcast`s to actors — inherently one-authority-many-clients.
Full mesh / lockstep / CRDT is a different programming model and stays out of scope (§14).

- **Host** = authority. A `Rivalis` with an `RTCTransport`, running ordinary `Room`
  subclasses. Node process (phase 1) or an elected browser peer (phase 3, now cheap thanks
  to §3.3).
- **Peers** = `RTCClient` (browser via `@rivalis/browser`, node via `@rivalis/node`), each a
  `Client` (§3.2) speaking `handshake` frames over one `RTCDataChannel`.
- **Signaling** = `@rivalis/signal`, a Rivalis app brokering SDP/ICE and minting TURN creds.
  **Zero game traffic after the channel opens** — the P2P win.

### 4.2 `RTCTransport` (host) — satisfies the same five-step `Transport` seam

Maps 1:1 onto the five-step seam from §1. The only substitution is `RTCDataChannel` for
`ws.WebSocket`. Implemented in `node/src/RTCTransport.ts` (task 061).

**Ticket protocol:** WebSocket expresses the auth ticket in the URL or `Sec-WebSocket-Protocol`
header; `RTCDataChannel` has no equivalent handshake header. The peer sends its game-room auth
ticket as UTF-8 bytes in the **first binary message** on the data channel. `RTCTransport` reads
that first message, calls `grantAccess`, then switches to normal game-frame forwarding.
This keeps the signaling wire and the game wire independent — the signal server sees only
SDP/ICE; the game ticket never touches the signal layer.

```ts
// node/src/RTCTransport.ts (actual implementation — abridged)
class RTCTransport extends Transport {
    // actorId → open data channel (post-grant)
    private readonly channels = new Map<string, RTCDataChannelLike>()
    // peerId → actorId — routes PC state-change events to handleClose
    private readonly peerToActor = new Map<string, string>()
    // prevents double-close when both DC.onClose and PC state-change fire
    private readonly closedActors = new Set<string>()

    override onInitialize(layer: TLayer<any>): void {
        this.layer = layer
        this.signalClient.on('signal:welcome', (payload) => {
            const { myId, iceServers } = decodeWelcome(payload)
            this.negotiator.initialize(myId, iceServers, {  // HostNegotiator (§4.5)
                onChannel:         (channel, peerId) => this.onChannelOpen(channel, peerId),
                onPeerStateChange: (peerId, state)   => this.onPeerStateChange(peerId, state),
            })
        })
        this.signalClient.connect(this.hostTicket)        // (1) become host in SignalRoom
    }

    private onChannelOpen(channel: RTCDataChannelLike, peerId: string): void {
        let actorId: string | null = null
        channel.onClose(() => { if (actorId) this.triggerClose(actorId, peerId) })
        channel.onMessage((buf) => {
            if (actorId !== null) {
                this.layer!.handleMessage(actorId, buf)   // (3) normal game frames
                return
            }
            // First message is the peer's game-room auth ticket (UTF-8)
            const peerTicket = new TextDecoder().decode(buf)
            const ctx = { kind: 'webrtc', remoteId: peerId }
            void (async () => {
                const aid = await this.layer!.grantAccess(peerTicket, ctx)  // (2) §3.1 context
                actorId = aid
                this.channels.set(aid, channel)
                this.peerToActor.set(peerId, aid)
                // (4) register outbound listeners immediately — flushes pendingEmits
                this.layer!.on('message', aid, (_, m) => channel.sendBinary(m))
                this.layer!.on('kick',    aid, (_, m) => { this.sendCloseFrame(channel, m); channel.close() }) // §3.4
            })()
        })
    }

    private onPeerStateChange(peerId: string, state: string): void {
        if (state === 'disconnected' || state === 'closed' || state === 'failed') {
            this.negotiator.closePeer(peerId)
            const aid = this.peerToActor.get(peerId)
            if (aid) this.triggerClose(aid, peerId)    // (5)
        }
    }
}
```

**Ordering note (verified):** `grantAccess` triggers `Room.onJoin`, where the game often
calls `actor.send(...)` immediately. Outbound frames emitted before the transport registers
`on('message', actorId, …)` are not lost — `TLayer` buffers them per-actor (`pendingEmits`,
keyed `message:<actorId>`, capped at `MAX_PENDING_EMITS_PER_KEY = 256`, `TLayer.ts:58-66`)
and flushes on listener registration (`flushPending`, `:127-132`). So the order in
`onChannelOpen` above is safe, but `RTCTransport` registers the `message`/`kick`
listeners immediately after `grantAccess` (in the same microtask) so the buffer drains
right away rather than risking the 256-frame overflow on a chatty `onJoin`.

**Double-close guard:** both `DC.onClose` and PC state-change (`disconnected/failed/closed`)
can fire for the same peer. `RTCTransport` uses a `closedActors: Set<string>` guard and a
`peerToActor: Map<string, string>` map so `TLayer.handleClose` is called exactly once per
actor regardless of which event fires first.

A host is then literally the WS bootstrap with one line changed
(compare `demo/src/server/index.ts:29-34`):

```ts
const rivalis = new Rivalis<ActorData>({
    transports: [ new RTCTransport({ signalUrl, ticket }) ],   // ← only this differs
    authMiddleware: new ArenaAuthMiddleware()
})
rivalis.rooms.define('ttt', TttRoom)   // ← unchanged game logic
rivalis.rooms.create('ttt', 'ttt')
```

**peerId ↔ actorId.** Two id spaces meet: the signaling `peerId` (routes SDP/ICE) and the
`actorId` (CSPRNG, `generateId(16)`, `TLayer.ts:166`). `RTCTransport` owns the map; the
`Room`-facing world speaks only `actorId`, exactly as `WSTransport` keeps the `ws.WebSocket`
private. §3.1's `ConnectionContext.remoteId` carries the `peerId` into auth/logging without
leaking it into the room.

### 4.3 `@rivalis/signal` — signaling server (a Rivalis app)

Honest decomposition of "STUN/TURN on core": STUN/TURN are UDP (RFC 5389/8656); core is
WS/TCP. So the package is **signaling + ICE/credential issuance**, with **coturn** as the
relay it provisions — not a JS reimplementation of a UDP relay.

1. **Signaling** = a `Room` subclass. Typed message relay between actors — which `Room`
   already does. The bulk of the package, ~80 lines.
2. **ICE config + TURN credential minting** = `IceConfig` (HMAC ephemeral creds, coturn
   `static-auth-secret`/REST scheme). Cheap, security-sensitive, we own it.
3. **STUN responder + TURN relay** = integrate coturn as a sidecar. (Optional dev-only
   pure-JS STUN responder behind a flag; never a production TURN relay in JS.)

```ts
// signal/src/SignalRoom.ts  (sketch — a normal Room subclass; uses Room.getActor from §3.7)
import { Actor, Room } from '@rivalis/core'
import { encode, decode } from './wire'   // §3.5 shared-toolkit codec

class SignalRoom extends Room<PeerData> {
    protected override presence = true              // reuse join/leave fanout
    protected override unknownTopicPolicy = 'drop'  // tolerate client/server skew
    private hostId: string | null = null

    protected override onCreate(): void {
        this.bind('signal:offer',  this.relay)      // SDP offer  → { to }
        this.bind('signal:answer', this.relay)      // SDP answer → { to }
        this.bind('signal:ice',    this.relay)      // ICE candidate → { to }
    }
    protected override onJoin(actor: Actor<PeerData>): void {
        if (this.hostId === null) this.hostId = actor.id            // first peer hosts
        actor.send('signal:welcome', encode({
            youId: actor.id, hostId: this.hostId,
            iceServers: this.iceConfig.issueFor(actor.id)           // incl. TURN creds
        }))
    }
    protected override onLeave(actor: Actor<PeerData>): void {
        if (actor.id === this.hostId) { this.hostId = null; this.broadcast('signal:host_gone', '') }
    }
    private relay(actor: Actor<PeerData>, payload: Uint8Array, topic: string): void {
        const msg = decode(payload)                 // { to, ... }
        this.getActor(msg.to)?.send(topic, payload) // §3.7 lookup; forward verbatim (from = actor.id)
    }
}
```

> The `relay` body uses `this.getActor(msg.to)` (§3.7). Without that addition, the only
> alternative is iterating `this.each(...)` per message to find one peer — O(n) per signal,
> and the previous draft's `findActor` simply does not exist. Adding `getActor` is the clean
> unblock.

Everything around it — auth, rate limiting, origin allow-listing, heartbeats, ticket
handling — comes **free** from core (`WSTransport` + `TokenBucketRateLimiter` +
`AuthMiddleware`). `SignalServer` is `new Rivalis({ transports:[new WSTransport(...)],
authMiddleware:new SignalAuthMiddleware() })` + `rooms.define('signal', SignalRoom)` —
the exact shape `fleet`'s `attachControlPlane` uses (`fleet/src/orchestrator/transport.ts:109-163`),
including the `ticketSource:'protocol'` option and a `TokenBucketRateLimiter`.

**ICE/TURN credential issuance** (`signal/src/IceConfig.ts`): `issueFor(peerId): string`
returns a JSON-encoded `RTCIceServer[]`. The return type is `string` rather than a typed
array because the `signal:welcome` wire frame carries `iceServers` as a STRING field (the
client `JSON.parse`s it after wire-decoding). For TURN it mints ephemeral creds —
`username = <unixExpiry>:<peerId>`,
`credential = base64(HMAC_SHA1(turnSharedSecret, username))` via `node:crypto.createHmac`;
coturn validates the HMAC and expires creds at `unixExpiry`. Never ship the shared secret.

### 4.4 `RTCClient` (browser + node) — satisfies the `Client` contract

`RTCClient extends Client` (§3.2), so it is API-identical to `WSClient` by construction —
the drop-in for client authors:

```ts
class RTCClient<TTopics extends string = string> extends Client<TTopics> {
    constructor(signalUrl: string, options?: RTCClientOptions)
    get connected(): boolean
    connect(ticket?: string): void
    disconnect(): void
    send(topic: string, payload?: Uint8Array | string): void
    // on/once/off — the Client event taxonomy, identical to WSClient
}
```

**Internals:**
- **Signaling leg = a `Client`**, not a reinvention: reuse `WSClient` to talk to
  `@rivalis/signal`. The browser `WSClient`'s reconnect/backoff is already solid —
  jittered exponential `baseDelayMs * 2^attempt + jitter` capped at `maxDelayMs`
  (defaults 500 ms / 10 s, `WSClient.ts:355-361`), with `getTicket` token refresh on
  reconnect (`:327-353`).
- **Connect flow:** `connect(ticket)` → WS-connect to signal → on `signal:welcome`,
  `new RTCPeerConnection({ iceServers })` → `createDataChannel('rivalis', { ordered:true })`
  → offer → relay through signal → apply answer → trickle ICE → on `datachannel.open` emit
  `client:connect`.
- **`send`** = `channel.send(encode(topic, toU8(payload)))` — the same `handshake.encode`
  the WS path uses (`WSClient.ts:194`); guard on `channel.readyState !== 'open'` exactly as
  WS guards on `readyState !== OPEN` (`WSClient.ts:184`).
- **`onmessage`** = `decode(bytes)` → `emit(topic, payload)` — identical to
  `WSClient.onMessage` (`WSClient.ts:266-269`).
- **Kick** = §3.4 control frame → `client:kicked { code, reason }`. Same event, same
  `NO_RECONNECT_CODES` gate.
- **Reconnect** = re-run the negotiation, gated by the same code logic; the signaling leg's
  `WSClient` handles its own backoff.

Browser `RTCClient` uses native `RTCPeerConnection`/`RTCDataChannel` — **no extra
dependency**; `@rivalis/browser` stays `@toolcase/*` + `@rivalis/handshake` + (now)
`@rivalis/core`'s isomorphic kernel for `Client`/types.

### 4.5 Shared negotiation core + adapters (mirrors fleet's injection precedent)

Browser `RTCClient`, node `RTCClient`, and `RTCTransport` share ~all the offer/answer/ICE
state machine; they differ only in (a) the WebRTC primitive and (b) the WS primitive.
Factor the state machine into one isomorphic module driven by injected adapters — this is
**exactly** the pattern fleet already uses (`FleetTransportClient` interface +
`defaultCreateClient` injection + `AgentInternals.createClient` seam,
`FleetAgent.ts:90-99,114-122,130-136,235`).

```ts
// isomorphic negotiation, environment supplied by adapters
interface RTCAdapters {
    createPeerConnection(config: RTCConfiguration): RTCPeerLike
    createSignalingClient(url: string): Client      // §3.2 — browser WSClient or node WSClient
}
// browser passes { native RTCPeerConnection, browser WSClient }
// node    passes { node-datachannel adapter,   node    WSClient }
```

Keep this **internal** (a private module shared across `@rivalis/browser` and
`@rivalis/node`); do *not* publish a `@rivalis/p2p` package unless an external consumer needs
the state machine directly (defer — justified by the fleet precedent of keeping the injected
seam private).

**Node WebRTC lib:** `node-datachannel` (libdatachannel — data channels + STUN/TURN client,
prebuilt binaries, small, active) as the default, behind the `RTCPeerLike` adapter so the
choice never touches `RTCClient`/`RTCTransport`. `werift` (pure TS, no native build) viable
as a dev/CI fallback behind a flag. Avoid `@roamhq/wrtc` unless full API parity is required.

---

## 5. Target package layout & migration

The principled end state is a **platform-symmetric** split:

| Package | Environment | Contents |
|---------|-------------|----------|
| `@rivalis/handshake` | isomorphic | game-frame codec, `CloseCode`, control-frame convention (§3.4), shared typed-codec toolkit (§3.5); serializer import converted to the lazy loader (§3.3a) |
| `@rivalis/core` | **isomorphic kernel** | `Rivalis`, `Room` (now with `getActor`), `Actor`, `RoomManager`, `TLayer`, `Config`, `AuthMiddleware`, `RateLimiter*`, `ConnectionLimiter`, `KickReason`, **`Transport`**, **`Client`** |
| `@rivalis/core/transports/ws`, `/clients/ws` | node subpaths | `WSTransport`, node `WSClient` (physically still in core, behind node export conditions) |
| `@rivalis/node` | node | `RTCTransport` (host), node `RTCClient`, `SignalClient`, `RTCPeer` adapter; deps: `node-datachannel`, `ws` |
| `@rivalis/browser` | browser | `WSClient`, `RTCClient`, browser `RTCTransport` (phase-3 host), shared negotiation core w/ native adapters |
| `@rivalis/signal` | node | `SignalServer`, `SignalRoom`, `SignalAuthMiddleware`, `IceConfig`, `wire/`; built on core + `WSTransport` |
| `@rivalis/fleet` | node | unchanged (already a core app; benefits from `Client`/`Transport` exports — its `FleetTransportClient` cast disappears) |

Root `package.json` `workspaces` gains `"signal"`, `"node"` (currently `handshake, core,
browser, fleet, demo, landing-page`).

**Why node WS stays physically in core (behind subpaths) rather than moving to
`@rivalis/node`:** moving it is the *cleanest* mental model but a louder break and a bigger
demo/fleet churn. The subpath split (§3.3) gets ~90% of the benefit (isomorphic default
entry) with a one-line import migration. Revisit a full move to `@rivalis/node` in a later
major if the boundary proves confusing.

**Migration cost is bounded and mechanical:**
- `demo/src/server/index.ts`, `fleet/src/orchestrator/transport.ts` change
  `Transports.WSTransport` → `import { WSTransport } from '@rivalis/core/transports/ws'`
  (D1 locked: no lazy shim — direct subpath import only).
- `demo/src/client/useRoom.ts` types its state against `Client` instead of `WSClient`
  (`useState<Client | null>`) — no behavior change.
- `fleet`'s `FleetTransportClient` interface + the cast in `defaultCreateClient` collapse to
  `Client`.
- Everything in `Room`/`Actor`/game logic: **zero changes** (the whole point).

---

## 6. End-to-end sequence (peer joins a host)

```
peer (RTCClient)            @rivalis/signal (SignalRoom)         host (RTCTransport)
   |   WS connect + ticket ───────►|                                    |
   |◄── signal:welcome {hostId,    |                                    |
   |     iceServers w/ TURN creds} |                                    |
   |   create PC + DataChannel     |                                    |
   |   signal:offer {to:host} ────►|── getActor(host).send ────────────►|
   |◄────────── relay ─────────────|◄── signal:answer {to:peer} ────────|
   |   signal:ice ⇄ (trickle, relayed both ways through SignalRoom)     |
   |═══════════ DTLS handshake + DataChannel OPEN (direct or via TURN) ═══════════|
   |                               |   grantAccess(ticket,{kind:'webrtc',remoteId:peerId})|
   |                               |        Room.onJoin(actor) → actor.send (buffered+flushed)|
   |◄═══ game frames (handshake encode/decode) over DataChannel ═══════►|
   |   (peer closes / PC fails)    |   handleClose(actorId) → onLeave    |
```

After the channel opens, the signaling server sees **zero** game traffic.

---

## 7. Reliability, backpressure, liveness, frame size (generalized, not WS-specific)

- **Reliability/ordering.** Default `{ ordered:true }` ≈ WebSocket semantics (safe drop-in;
  correct for `ttt`/`counter`/`lobby`). Unreliable/unordered (`{ ordered:false,
  maxRetransmits:0 }`) for high-rate state (`arena`, `ARENA_TICK_HZ=30`,
  `demo/src/protocol.ts:69`) where the newest snapshot supersedes lost ones. Expose
  per-channel reliability as an `RTCClient`/`RTCTransport` option. Optionally a `Transport`
  capability descriptor (`{ ordered, reliable, maxFrameBytes }`) a `Room` can query — keep
  phase-1 to a single reliable channel for parity.
- **Frame size (new, must not be skipped).** `WSTransport`'s default max payload is
  **64 KiB** (`DEFAULT_MAX_PAYLOAD = 64 * 1024`, `WSTransport.ts:52`). WebRTC data channels
  cap a single SCTP message far lower in practice — ~16 KiB is the safe cross-impl ceiling,
  with larger sizes only by negotiation. A `Room` that today `broadcast`s a >16 KiB snapshot
  over WS will silently fail over RTC. The negotiation layer (§4.5) must either chunk/reassemble
  large frames or expose `maxFrameBytes` so a `Room` can split (the arena snapshot is the
  realistic offender). Surface this as a `Transport` capability and **log** when a frame is
  dropped/chunked — never truncate silently.
- **Backpressure** is a shared concern, not WS's alone. `WSTransport` drops when
  `socket.bufferedAmount > maxBufferedBytes` (default **1 MiB**, `WSTransport.ts:70`) and
  invokes an `onBackpressureDrop(actorId, bufferedAmount)` hook (`:262-266`).
  `RTCDataChannel.bufferedAmount` + `bufferedAmountLowThreshold` is the exact analog. Factor
  the drop-or-escalate decision into a tiny shared helper both transports call, so the policy
  (and the hook signature) is identical.
- **Liveness** is per-transport. WS uses a ping/pong heartbeat (default 30 s interval,
  2-miss threshold → `socket.terminate()`, `WSTransport.ts:134-141,runHeartbeat`). RTC relies
  on `pc.onconnectionstatechange` (ICE/DTLS consent freshness) → `handleClose` on
  `disconnected`/`failed`/`closed`. Document the parallel; no shared timer needed.

---

## 8. Security

- **Auth:** reuse `AuthMiddleware` unchanged. The peer's ticket reaches the host via
  signaling and is validated in `RTCTransport` through `grantAccess` — identical trust
  model to `WSTransport`. §3.1's `ConnectionContext` lets auth additionally see the
  transport kind and signaling `peerId`. The signaling WS is itself `AuthMiddleware`-gated.
  `AuthMiddleware.authenticate` should use constant-time compares (`crypto.timingSafeEqual`)
  for ticket secrets — already flagged in `AuthMiddleware.ts:23`.
- **TURN creds:** ephemeral HMAC creds (§4.3), short TTL, minted server-side. The TURN
  shared secret never leaves the server.
- **DTLS:** WebRTC data channels are DTLS-encrypted by default — game traffic is encrypted
  peer↔host end-to-end with no extra work.
- **Origin allow-listing / connection rate limiting / heartbeats:** inherited on the
  signaling leg from `WSTransport` (`allowedOrigins` as array or predicate,
  `WSTransport.ts:116-121`; `ConnectionLimiter` per-IP pre-handshake, `:172-185`; heartbeat).
- **Pre-admission limiting on RTC — two-hop throttle:** RTC connections pass through two
  admission gates before `grantAccess` runs:

  | Hop | Where | Key | Mechanism |
  |-----|-------|-----|-----------|
  | **1 — signaling leg** | `WSTransport` (signal server) | remote IP | `ConnectionLimiter` per-IP, `WSTransport.ts:172-185` |
  | **2 — game-host leg** | `RTCTransport` (`node/src/RTCTransport.ts`) | signaling `peerId` | optional `peerLimiter?: ConnectionLimiter` checked before `grantAccess` |

  The signaling WS already applies `WSTransport`'s `ConnectionLimiter` (per-IP), so the
  first hop is covered automatically. The second hop is opt-in: pass a `ConnectionLimiter`
  instance as `peerLimiter` in `RTCTransportOptions`. When a check returns `false`, the
  channel is closed with `CloseCode.RATE_LIMITED` / `KickReason.RATE_LIMITED` before
  `AuthMiddleware` is ever invoked — identical semantics to `WSTransport`'s per-IP gate.
  Omitting `peerLimiter` is safe for deployments where the signaling gate is sufficient,
  but the option exists to prevent the game host from being hammered independently of the
  signal server.
- **Rate-limiting game traffic:** `TLayer` runs the limiter inside `handleMessage`
  (`TLayer.ts:211-218`, kicks with `KickReason.RATE_LIMITED` on `check()===false`,
  `TokenBucketRateLimiter` default capacity 30 / refill 30/s) — so it applies to WebRTC peers
  automatically, no transport work.
- **Browser-host trust note:** a browser host is only as trustworthy as the client running
  it. Document that browser-host (phase 3) suits casual/co-op; competitive/authoritative
  games should use a Node host (phase 1).

---

## 9. Build & packaging (with the constraints already discovered)

- **Serializer ESM (F5):** any typed wire — `@rivalis/signal` `wire/`, node packages
  touching the serializer, **and `@rivalis/handshake` itself** — must load
  `@toolcase/serializer` via the lazy `createRequire(import.meta.url) ?? require` loader,
  never a top-level `import` (`fleet/src/wire/serializer.ts:132-142`,
  `fleet/src/util/loadCore.ts`). The shared toolkit (§3.5) bakes this in. Converting
  `handshake/src/serializer.ts:1` is what makes the **core kernel's ESM entry Node-safe**
  (§3.3a) rather than bundler-only.
- **tsup:** copy fleet's dual CJS+ESM config (`fleet/tsup.config.ts`): two configs, `cjs` →
  `lib/main.js` + `esm` → `lib/module.js`, `dts` only on the CJS pass, `clean:true` on the
  first / `clean:false` on the second, and externalize all peer/runtime deps
  (`@rivalis/core`, `@toolcase/*`, `node-datachannel`, `ws`, `@rivalis/handshake`).
- **core kernel entry** builds `platform:'neutral'` (browser-safe); the `transports/ws` /
  `clients/ws` entries build `platform:'node'`.
- **`@rivalis/signal` & `@rivalis/node`:** `peerDependencies` on `@rivalis/core`
  (`>=7 <8` post-split; or `>=6.1 <7` if the split somehow ships non-breaking — unlikely),
  `@toolcase/base|logging`, `ws`. `@rivalis/node` `dependencies`: `node-datachannel`.
  (Mirror fleet's `peerDependencies` block, `fleet/package.json:35-40`.)
- **`@rivalis/browser`:** no new runtime deps (native WebRTC); adds `@rivalis/core` (kernel)
  for `Client`/types + new source + exports.
- **`@rivalis/handshake`:** wire format reused as-is; gains the control-frame convention
  (§3.4), the lazy serializer loader (§3.3a/§3.5), and optionally the typed-codec toolkit.

---

## 10. Testing

- **Contract conformance (new):** a shared test suite asserting every `Client`
  (`WSClient` browser, `WSClient` node, `RTCClient` ×2) exposes the same `connected`/
  `connect`/`disconnect`/`send` surface and emits the same `ClientEvent` set with the same
  connect/disconnect/kick semantics. Proves "drop-in." This test will *fail today* against
  the two existing `WSClient`s — that failure is the F3 spec.
- **Wire/serializer:** signaling payloads round-trip (mirror handshake tests); the shared
  toolkit's version-header + append-only behavior + `WireVersionError` on major mismatch are
  unit-tested once. Add a Node strict-ESM smoke test (`node --input-type=module -e "import
  '@rivalis/handshake'"`) that would catch an F5 regression.
- **`SignalRoom`:** relay routing (offer from A reaches only B via `getActor`), host
  assignment, host-gone fanout, presence — in-process with core, no real WebRTC (like
  fleet's tests).
- **`IceConfig`:** HMAC cred format matches coturn's expected `username/credential`; expiry
  honored.
- **`RTCTransport` ↔ `RTCClient` loopback:** two peers in one process over `node-datachannel`
  (no NAT) running an **unchanged `TttRoom`**, asserting state broadcasts arrive — including
  the `onJoin`-send-before-listener case (proves the `pendingEmits` flush, §4.2). The key
  test proving "same game logic over WebRTC."
- **Multi-transport (new):** one `Rivalis` with `[WSTransport, RTCTransport]`; a WS client
  and an RTC peer join the same room and see each other (proves §3.6).
- **Frame size (new):** a `broadcast` larger than the RTC message ceiling either chunks
  correctly or is reported via the capability descriptor — never silently dropped (§7).
- **Browser:** Playwright/headless-Chromium two-tab test against a Node host; play a move,
  assert both boards update.
- **NAT/TURN:** CI-optional coturn container forcing relay (`iceTransportPolicy:'relay'`).

---

## 11. Migration & developer experience

**Server game logic: zero changes.** A `Room` written today runs over WebRTC by changing
only the host bootstrap transport (and the post-split import path):

```diff
- import { Transports } from '@rivalis/core'
- transports: [ new Transports.WSTransport({ server }) ],
+ import { RTCTransport } from '@rivalis/node'
+ transports: [ new RTCTransport({ signalUrl, ticket, room: 'ttt' }) ],
```

**Client: one-line swap** (now backed by a real shared contract, §3.2):

```diff
- import { WSClient } from '@rivalis/browser'
- const client = new WSClient(`ws://host:2334`)
+ import { RTCClient } from '@rivalis/browser'
+ const client = new RTCClient(`ws://signal-host:9000`)   // points at signaling, not game server
  client.connect(ticket)
  client.on('ttt:state', payload => render(decode(payload)))   // unchanged
  client.send('place', encode({ index }))                      // unchanged
```

Add `demo/src/p2p/` (a P2P variant: the unchanged `TttRoom`, a Node host with
`RTCTransport`, the existing React client pointed at `RTCClient`) to prove parity,
paralleling `demo/src/fleet/`.

---

## 12. Phased roadmap

| Phase | Scope | Outcome |
|-------|-------|---------|
| **0 — Core generalization** | Export `Transport`; add `Client` base + conform both `WSClient`s; `Room.getActor` (§3.7); isomorphic core entry + node subpaths (§3.3) incl. lazy serializer in handshake (§3.3a); control-frame convention (§3.4); shared codec toolkit + lazy-require (§3.5); `ConnectionContext` on `grantAccess`/`authenticate` (§3.1). | **No P2P yet**, but core is genuinely extensible + isomorphic; existing WS path unchanged; conformance + Node-ESM smoke tests green. *This phase pays for itself even if P2P never ships.* |
| **1 — Node↔Node P2P** | `@rivalis/signal` (`SignalRoom` + `IceConfig`, STUN + coturn creds); `@rivalis/node` (`RTCTransport` + node `RTCClient` over `node-datachannel`). | **Node host ↔ Node peer, unchanged Rooms** (loopback test passes). |
| **2 — Browser peers** | `@rivalis/browser` `RTCClient`; coturn integration docs; `demo/p2p/`; frame-size chunking. | **Browser peers ↔ Node host**, real NAT traversal. |
| **3 — Browser-as-host** | Browser `RTCTransport` (reuses §4.5 negotiation core w/ native adapters); host election (`SignalRoom` already tracks `hostId`/`host_gone`); optional `Room` `serialize()/hydrate()` for state handoff. Browser-host is **free of a bespoke runtime build** thanks to §3.3. | **Serverless P2P**, same `Room` logic in the browser. |
| **4 (opt)** | Unreliable/dual channel for realtime; transport capability descriptor; per-transport auth/rate-limit (§3.6); pure-JS STUN dev fallback; `werift` dev mode. | realtime-grade + zero-native dev path. |

Phase 0 is the redesign; phases 1–3 are the P2P payoff. Each later phase widens topology
without touching the game-logic API.

---

## 13. Decisions needed before coding

1. **Core split breaking-ness (§3.3):** ✅ **Decided 2026-06-09 — `7.0.0` major.**
   Ship as a clean major with `@rivalis/core/transports/ws` subpath imports. The lazy-`require`
   shim is dropped: a getter reachable from the neutral kernel entry would carry `ws` /
   `node:crypto` back into browser bundles, defeating the purpose of the split. Migration is a
   one-line import change per affected site (see `core/CHANGELOG.md` for the full migration guide).
2. **Kernel ESM safety (§3.3a):** ✅ **Decided 2026-06-09 — convert to lazy loader.**
   Apply the `createRequire(import.meta.url) ?? require` discipline in
   `handshake/src/serializer.ts` so `import '@rivalis/core'` works under plain Node ESM.
   **Rationale:** same fix fleet already wrote (`fleet/src/wire/serializer.ts:132-142`);
   closes F5 at its source; option (b) (bundler-/CJS-only) rejected because it leaves the
   latent break reachable from the kernel's own ESM entry and forces every downstream package
   to independently rediscover the workaround. See `handshake/CHANGELOG.md` for the full
   decision record.
3. **`Client` base location:** ✅ **Decided 2026-06-09 — `@rivalis/core` kernel.**
   `Client` is defined in `core/src/Client.ts` and exported from the isomorphic kernel entry
   (`import { Client } from '@rivalis/core'`). Both `WSClient` implementations and all future
   clients (`RTCClient` ×2) import the contract from this single location.
   `@rivalis/handshake` remains focused on the wire/frame layer.
   Full rationale in `core/CHANGELOG.md` D3.
4. **Node WebRTC lib:** ✅ **Decided 2026-06-09 — `node-datachannel` default, `werift` dev/CI fallback.**
   `node-datachannel` (libdatachannel, prebuilt native binary) is the production default.
   `werift` (pure TypeScript, no native build) is the dev/CI fallback, selected via
   `RIVALIS_WEBRTC_BACKEND=werift`. `@roamhq/wrtc` excluded: requires a full libwebrtc
   media stack (~GB) for a data-channel-only use case (§14 out-of-scope). Both are hidden
   behind the `RTCPeerLike`/`RTCDataChannelLike` adapter interfaces (`node/src/peer/RTCPeer.ts`)
   so `RTCTransport`/`RTCClient` are library-agnostic. Full rationale in `node/CHANGELOG.md` D4.
5. **Host location for v1:** ✅ **Decided 2026-06-09 — Node-host-first; browser-as-host deferred to Phase 3.**
   A Node process is the v1 authoritative host. `RTCTransport` lives in `@rivalis/node` (Phase 1).
   Browser-as-host is a supported future topology (Phase 3) made cheap by the §3.3 isomorphic
   core split, but is not part of the v1 scope. Rationale: a Node host is a trusted, controlled
   process — its authority model is equivalent to the existing WS server, so game logic requires
   zero changes; browser-host trust caveats (§8) are real and belong in a later, deliberately
   scoped phase. See `node/CHANGELOG.md` D5 for the full decision record.
6. **TURN relay:** ✅ **Decided 2026-06-09 — coturn sidecar confirmed.**
   Production TURN relay is coturn as a sidecar (never reimplemented in JS). A pure-JS STUN
   responder is available dev-only behind `RIVALIS_STUN_DEV=true` (Phase 4). IceConfig mints
   HMAC-SHA1 ephemeral creds (`username = <unixExpiry>:<peerId>`, `credential =
   base64(HMAC_SHA1(secret, username))`) — coturn's `static-auth-secret` REST scheme validates
   them natively. The shared secret never leaves the server. Full rationale in
   `signal/CHANGELOG.md` D6.
7. **Shared codec toolkit home (§3.5):** ✅ **Decided 2026-06-09 — fold into `@rivalis/handshake` confirmed.**
   The typed-codec discipline (2-byte `[major,minor]` version header, append-only positional
   tags, `present()`-based decode, `WireVersionError` on major mismatch, baked-in lazy loader)
   lives in `@rivalis/handshake`. No new `@rivalis/wire` package is created. Full rationale in
   `handshake/CHANGELOG.md` D7.
8. **`Room.getActor` visibility (§3.7):** ✅ **Decided 2026-06-09 — `protected` confirmed.**
   `getActor` is a subclass primitive for intra-room routing (signaling relay routes to one
   specific peer by id). `public` was rejected: it would invite external callers to obtain
   `Actor` references and bypass the `each`/`broadcast`/`send` surface; no external use case
   exists that `each` or a subclass-maintained index cannot already satisfy. Full rationale in
   `core/CHANGELOG.md` D8.
9. **Per-transport auth/rate-limit override (§3.6):** ✅ **Decided 2026-06-09 — defer.**
   Separate Rivalis apps already cover the star topology; the feature is additive and
   low urgency. `ConfigOptions` (`Config.ts:8-14`) is unchanged in Phase 0. Phase 4
   tracking in `043-core-low-per-transport-admission-override.md`;
   implementation in `086-core-low-per-transport-admission-impl.md`.
   Full rationale in `core/CHANGELOG.md` D9.
10. **Package names:** `@rivalis/signal` + `@rivalis/node` (proposed). Confirm.

---

## 14. Out of scope (explicit)

- **Full mesh / authoritative-less netcode** (lockstep, rollback, CRDT) — a different
  programming model; the `Room` pattern is host-authoritative by design (§4.1).
- **Reimplementing a production TURN relay in JS** — use coturn (§4.3).
- **Voice/video media tracks** — data-channel only. A natural future extension since
  `RTCPeerConnection` already supports media.
- **Changing the `handshake` game-frame format** — reused unchanged; only *additive*
  (control-frame convention, codec toolkit, lazy-serializer loader).

---

## 15. Implementation task list

Full task breakdown covering everything in §1–§14. Grouped by the §12 phases. Each task
cites the section/finding it implements. Order within a phase is dependency-sorted.

### Phase −1 — Decisions to lock before coding (§13)

These gate Phase 0; resolve all ten, record the chosen values in the changelog/ADR.

- [x] **D1** Core split breaking-ness: `7.0.0` major confirmed — `@rivalis/core/transports/ws` import, no lazy shim. (§3.3, §13.1) — decided 2026-06-09; rationale in `core/CHANGELOG.md`.
- [x] **D2** Kernel ESM safety: convert to lazy loader confirmed — `createRequire(import.meta.url) ?? require` in `handshake/src/serializer.ts`. (§3.3a, §13.2) — decided 2026-06-09; rationale in `handshake/CHANGELOG.md`.
- [x] **D3** `Client` base location: `@rivalis/core` kernel confirmed — `core/src/Client.ts`, exported from `'@rivalis/core'`. (§3.2, §13.3) — decided 2026-06-09; rationale in `core/CHANGELOG.md`.
- [x] **D4** Node WebRTC lib: `node-datachannel` default, `werift` dev/CI fallback (`RIVALIS_WEBRTC_BACKEND=werift`). (§4.5, §13.4) — decided 2026-06-09; rationale in `node/CHANGELOG.md`.
- [x] **D5** v1 host location: Node-host-first confirmed — browser-as-host deferred to Phase 3. (§13.5) — decided 2026-06-09; rationale in `node/CHANGELOG.md`.
- [x] **D6** TURN relay: coturn sidecar confirmed; pure-JS STUN dev-only behind `RIVALIS_STUN_DEV=true`; no JS production TURN. (§4.3, §13.6) — decided 2026-06-09; rationale in `signal/CHANGELOG.md`.
- [x] **D7** Shared codec toolkit home: fold into `@rivalis/handshake` confirmed — typed-codec discipline (2-byte header, append-only tags, lazy-require, `WireVersionError`) lives in `handshake`; no new `@rivalis/wire` package. (§3.5, §13.7) — decided 2026-06-09; rationale in `handshake/CHANGELOG.md`.
- [x] **D8** `Room.getActor` visibility: `protected` confirmed — subclass-routing primitive; no public use case. (§3.7, §13.8) — decided 2026-06-09; rationale in `core/CHANGELOG.md`.
- [x] **D9** Per-transport auth/rate-limit override: **defer confirmed** — additive, low urgency; separate Rivalis apps cover the star. Phase 4 tracking in task 043 / impl in task 086. (§3.6, §13.9) — decided 2026-06-09; rationale in `core/CHANGELOG.md`.
- [x] **D10** Package names: `@rivalis/signal` + `@rivalis/node` confirmed — workspace registered in root `package.json`; `signal/package.json` created. (§13.10) — decided 2026-06-09; rationale in `signal/CHANGELOG.md` D10.

### Phase 0 — Core generalization (no P2P yet; pays for itself regardless)

**F1 / §3.1 — Export and widen `Transport`; carry connection context**
- [x] Move/define `Transport` abstract class in `core/src/Transport.ts` (unchanged contract: `onInitialize`, `get sockets`, `dispose`). (§3.1)
- [x] Export `Transport` from `core/src/main.ts`. (F1)
- [x] Add `ConnectionContext` type (`kind`, `remoteId?`, `meta?`) and export it. (§3.1)
- [x] Add optional 2nd arg `context?: ConnectionContext` to `TLayer.grantAccess`. (§3.1) — `core/src/TLayer.ts:132` `async grantAccess(ticket: string, context?: ConnectionContext)` forwards context verbatim to `authMiddleware.authenticate`; task 063, 2026-06-09.
- [x] Add optional 2nd arg `context?: ConnectionContext` to `AuthMiddleware.authenticate` (backward-compatible). (§3.1) — `core/src/AuthMiddleware.ts:38` `abstract authenticate(ticket: string, context?: ConnectionContext)`; `LegacyAuthMiddleware` accepts and ignores context (no behavior change to existing overrides); task 063, 2026-06-09.
- [x] Add optional `actorId?: string` to `AuthResult`; `TLayer` validates uniqueness, falls back to CSPRNG `generateId(16)` (8 retries) when absent/taken. (§3.1)
- [x] Update `WSTransport` to pass `{ kind:'ws', remoteId: request.socket.remoteAddress, meta:{ origin } }`. (§3.1)

**F3 / §3.2 — `Client` base contract**
- [ ] Define `Client` abstract class in `core/src/Client.ts` extending `@toolcase/base` `Broadcast`; `connected`/`connect`/`disconnect`/`send` + typed `on/once/off` overloads lifted from browser WSClient `:204-234`. (§3.2)
- [ ] Define `ClientEvent` union + `ClientKickedEvent` type. (§3.2)
- [ ] Export `Client` from `core/src/main.ts`. (F1)
- [ ] Browser `WSClient extends Client`; add `client:error` emission on socket error (stop swallowing into reconnect). (§3.2)
- [ ] Node `core/src/clients/WSClient.ts extends Client`: add `client:kicked` (decode 4xxx + reason like browser `:271-280`), keep `client:error`; document caller-layered reconnect. (§3.2)
- [x] Remove/gate node WSClient warn-on-no-listener `emit` override (`:170-176`). (§3.2)
- [x] `demo/src/client/useRoom.ts` → `useState<Client | null>`. (§3.2, §5)
- [x] Collapse fleet `FleetTransportClient` interface + `defaultCreateClient` cast → `Client`. (§3.2, §5)

**F2 / §3.3 — Isomorphic core; node code behind subpaths**
- [x] Remove `import './transports/WSTransport'` + `import './clients/WSClient'` from `core/src/main.ts:12-14`. (§3.3)
- [x] Trim `main.ts` to kernel-only exports + `CloseCode`/`Message` re-exports. (§3.3)
- [ ] New entry `core/src/transports/ws.ts` exporting `WSTransport` + option types (`WSTransportOptions, AllowedOrigins, TicketSource, BackpressureDropFn`). (§3.3)
- [x] New entry `core/src/clients/ws.ts` exporting node `WSClient` + option types. (§3.3)
- [x] Rewrite `core/package.json` `exports` map: `.` (kernel) + `./transports/ws` + `./clients/ws`, each dual types/import/require. (§3.3)
- [x] `core/tsup.config.ts`: 3 entry pairs; kernel `platform:'neutral'`, ws entries `platform:'node'`; keep `@toolcase/*`, `@rivalis/handshake`, `ws` external. (§3.3, §9)
- [x] Back-compat shim decision per D1: **no shim** — remove `Transports`/`Clients` namespace objects from `main.ts`; document `7.0.0` migration in `core/CHANGELOG.md`. (§3.3, §13.1)

**F5 / §3.3a / §3.5 — Kernel ESM safety (lazy serializer)**
- [x] Convert `handshake/src/serializer.ts:1` top-level serializer import → lazy `createRequire(import.meta.url) ?? require` loader. (§3.3a, §3.5, §9) — gated on D2 (locked 2026-06-09; convert confirmed — see `handshake/CHANGELOG.md`)
- [x] Add Node strict-ESM smoke test: `node --input-type=module -e "import '@rivalis/handshake'"` (and `'@rivalis/core'`). (§10)

**F4 / §3.5 — Shared typed-codec toolkit**
- [ ] Build codec helper in `@rivalis/handshake` (D7 — decided 2026-06-09) wrapping `@toolcase/serializer`: 2-byte `[major,minor]` header, append-only positional tags, `present()`-based decode, `WireVersionError` on major mismatch, baked-in lazy loader. (§3.5)
- [x] Unit-test version-header + append-only + `WireVersionError`. (§10) — `handshake/test/codec.test.mts`: version-header, cross-minor round-trip (forward/backward), append-only schema evolution (v1↔v2 frames), `WireVersionError` on major mismatch, `present()` semantics.

**§3.4 — Transport-agnostic close/kick control frames**
- [x] Reserve control topic `__rivalis:close` in `handshake` carrying encoded `{ code, reason }`; honor existing `__` reserved-prefix guard. (§3.4) — `CLOSE_CONTROL_TOPIC`, `encodeCloseFrame`, `decodeCloseFrame` in `handshake/src/closeFrame.ts`; exported from `handshake/src/main.ts`; tests in `handshake/test/closeFrame.test.mts`.
- [x] Preserve 123-byte reason ceiling (`MAX_CLOSE_REASON_BYTES`) in the convention. (§3.4) — enforced in `encodeCloseFrame` via UTF-8 boundary-safe truncation; `MAX_CLOSE_REASON_BYTES = 123` exported.
- [x] `WSTransport` unchanged (keeps native close frames). (§3.4) — verified 2026-06-09; test in `core/test/wstransport-native-close-parity.test.mts`.
- [x] Client-side decode of `__rivalis:close` → `client:kicked { code, reason }`; reuse `NO_RECONNECT_CODES = {4001,4003,4004}` gate. (§3.4) — `browser/src/WSClient.ts` `onMessage` intercepts `CLOSE_CONTROL_TOPIC`, decodes via `decodeCloseFrame`, emits `client:kicked`, and uses `pendingCloseCode` as `effectiveCode` in the `shouldReconnect` gate; native 4xxx path deduplicates via the same field. Tests in `browser/test/close-frame.test.mts`.

**F8 / §3.7 — `Room.getActor(id)`**
- [x] Add `protected getActor(actorId): Actor | null` to `core/src/Room.ts`. (§3.7) — visibility locked `protected` per D8 (decided 2026-06-09).

**§3.6 — Multi-transport (cheap docs/test wins)**
- [x] Document + test "one `Room`, many transports" wiring. (§3.6) — task 042, 2026-06-09; wiring + constraints in §3.6; tests in `core/test/multi-transport-one-room.test.mts`.
- [x] Per-transport `authMiddleware?`/`rateLimiter?` override — **defer** per D9 (track only). (§3.6) — deferred design documented in `core/CHANGELOG.md` D9; Phase 4 implementation in task `086-core-low-per-transport-admission-impl.md`; task `043-core-low-per-transport-admission-override.md` closed 2026-06-09.

**Phase 0 exit gate**
- [x] Contract-conformance test suite across browser WSClient + node WSClient (initially red = F3 spec). (§10) — `core/test/client-conformance.test.mts`; S3 (`connected` during CONNECTING) is the red spec: node WSClient passes (readyState-based), browser WSClient fails (`this.ws !== null`). Suite turns fully green once browser WSClient's `connected` getter is made readyState-based (§3.2).
- [x] Existing WS path green; Node-ESM smoke green; demo + fleet build against new imports. (§12 phase 0) — task 045, 2026-06-09. Migration: `demo/src/server/index.ts` now imports `WSTransport` from `@rivalis/core/transports/ws`; `fleet/src/orchestrator/transport.ts` uses direct subpath import (no lazy shim, per D1); `fleet/src/agent/FleetAgent.ts` imports `WSClient` from `@rivalis/core/clients/ws`; fleet tsup externals include the two new subpaths. All references to the removed `Transports`/`Clients` namespace objects updated in fleet tests. ESM smoke test and WS subpath test cover the phase 0 exit criteria.

### Phase 1 — Node↔Node P2P

**Repo/build setup**
- [x] Add `"signal"`, `"node"` to root `package.json` workspaces. (§5)
- [x] `@rivalis/signal` + `@rivalis/node` `package.json`: dual CJS+ESM tsup (mirror fleet); `peerDependencies` `@rivalis/core >=7 <8`, `@toolcase/base|logging`, `ws`; `@rivalis/node` `dependencies: node-datachannel`. (§9)

**`@rivalis/signal`**
- [x] `signal/src/wire/` — ~80 lines of schema defs over shared toolkit (§3.5). (§4.3)
- [x] `SignalRoom extends Room<PeerData>`: `presence=true`, `unknownTopicPolicy='drop'`, bind `signal:offer/answer/ice` → `relay`. (§4.3)
- [x] `relay` uses `getActor(msg.to)?.send(topic, payload)` (forward verbatim). (§4.3, §3.7)
- [x] `onJoin`: first peer → `hostId`; `signal:welcome { youId, hostId, iceServers: iceConfig.issueFor(actor.id) }`. (§4.3) — `IceConfig` reads `ICE_TURN_URLS`/`ICE_TURN_SECRET`/`ICE_STUN_URLS`/`ICE_TTL` from env; empty array when TURN not configured.
- [x] `onLeave`: host leaves → clear `hostId`, broadcast `signal:host_gone`. (§4.3)
- [x] `SignalAuthMiddleware`. (§4.3, §8) — `signal/src/SignalAuthMiddleware.ts`; ticket format `<roomId>:<secret>`; constant-time SHA-256 + timingSafeEqual; rotation-safe multi-secret list; tests in `signal/test/signal-auth-middleware.test.mts`.
- [x] `IceConfig.issueFor(peerId)`: build `RTCIceServer[]`; TURN ephemeral creds `username=<unixExpiry>:<peerId>`, `credential=base64(HMAC_SHA1(secret, username))` via `node:crypto.createHmac`; never ship secret. (§4.3, §8) — `signal/src/IceConfig.ts`; exported from `signal/src/main.ts`.
- [x] `SignalServer` bootstrap: `new Rivalis({ transports:[new WSTransport(...)], authMiddleware })` + `rooms.define('signal', SignalRoom)`; `ticketSource:'protocol'` + `TokenBucketRateLimiter` (mirror fleet `attachControlPlane`). (§4.3) — `signal/src/SignalServer.ts`; `SIGNAL_ROOM_TYPE='signal'`, `SIGNAL_ROOM_ID='signal'`; `rooms` exposed for multi-session use; exported from `signal/src/main.ts`.
- [x] coturn provisioning: shared-secret/REST config; deployment docs. (§4.3, §13.6) — `signal/coturn/turnserver.conf` template (use-auth-secret + static-auth-secret/REST scheme matching IceConfig HMAC); `signal/README.md` with port table, TLS guidance, zero-downtime secret rotation; task 057, 2026-06-09.

**`@rivalis/node`**
- [x] `RTCPeer` adapter — `RTCPeerLike`/`RTCDataChannelLike` over `node-datachannel`. (§4.5) — `node/src/peer/RTCPeer.ts`; `NodeDCDataChannel` and `NodeDataChannelPeer` exported; optional `ndc?` injection param on `NodeDataChannelPeer` for test-time mocking without native binaries; `WeriftPeer` stub satisfies the same shape (Phase 4 placeholder); tests in `node/test/rtc-peer-adapter.test.mts`; task 058, 2026-06-09.
- [x] Shared isomorphic negotiation core (offer/answer/ICE state machine) driven by injected `RTCAdapters` (`createPeerConnection`, `createSignalingClient`); keep **internal**, no `@rivalis/p2p` package. (§4.5) — `node/src/peer/NegotiationCore.ts`; `PeerNegotiator` (initiating/peer side) + `HostNegotiator` (answering/host side); exported from `node/src/main.ts`; tests in `node/test/negotiation-core.test.mts`; task 059, 2026-06-09. **Divergence from plan:** added `from` field (tag 3, APPEND-ONLY) to Offer, Answer, and IceCandidate wire frames so the receiving host can identify the sender without server-side injection — necessary for correct per-peer PC routing when multiple peers negotiate concurrently. The `@rivalis/signal` relay passes payloads verbatim; old decoders without tag 3 silently skip it. Schema updated in both `node/src/peer/NegotiationCore.ts` (local codec) and `signal/src/wire/index.ts` (canonical schema).
- [x] `SignalClient` (a `Client` to `@rivalis/signal`; reuse node WSClient). (§4.2) — `node/src/SignalClient.ts`; `SignalClient extends Client<SignalTopic>` wraps node WSClient with `ticketSource:'protocol'`; forwards `client:connect/disconnect/kicked/error` lifecycle events and all `signal:*` topics; reconnect is caller-layered (RTCTransport/RTCClient observe `client:disconnect` and re-call `connect()`) — same pattern as node WSClient in fleet, NOT built-in backoff (node WSClient intentionally omits reconnect); exported from `node/src/main.ts`; tests in `node/test/signal-client.test.mts`; task 060, 2026-06-09.
- [x] `RTCTransport extends Transport`: 5-step seam — `onInitialize` connects signal + listens offers/ice; `onChannelOpen` → `grantAccess(peerTicket, {kind:'webrtc',remoteId:peerId})`, register inbound/outbound **before** onJoin sends, kick via §3.4 control frame, `handleClose` on pc `disconnected/closed/failed`. (§4.2) — `node/src/RTCTransport.ts`; `channel.onClose` registered before first message to handle pre-grant close race; `ticketConsumed` + `earlyClose` flags guard the async grantAccess path; `layer.on('message'/'kick', aid, …)` registered immediately in the same microtask after grant so `pendingEmits` drains before any further activity; tests in `node/test/rtc-transport.test.mts`; tasks 061+063, 2026-06-09.
- [x] `sockets` getter = open DC count; `dispose` closes channels+pcs+signal client. (§4.2)
- [x] peerId↔actorId map owned by transport (Room speaks only actorId). (§4.2) — `peerToActor: Map<peerId,actorId>` routes PC state-change events to `handleClose`; `channels: Map<actorId,channel>` is the outbound send surface; `closedActors: Set<actorId>` is the double-close guard; TLayer only ever sees `actorId`; `ConnectionContext {kind:'webrtc', remoteId:peerId}` carries peerId into `grantAccess` → `authenticate` without exposing it to the room; tests in `node/test/rtc-transport.test.mts` (`'grantAccess receives ConnectionContext'`, `'PC state "disconnected/failed/closed" → handleClose'`, `'double-close guard'`); task 063, 2026-06-09.
- [x] Node `RTCClient extends Client`: signaling leg = WSClient; connect flow (welcome → PC → createDataChannel ordered → offer/answer/trickle → open ⇒ `client:connect`); `send` guards `readyState!=='open'`; `onmessage` decode→emit; kick via §3.4. (§4.4) — `node/src/RTCClient.ts`; `RTCClient<TTopics> extends Client<TTopics>`; `PeerNegotiator` (from NegotiationCore) used as the signaling leg (fresh instance per negotiation attempt — avoids listener duplication since `PeerNegotiator.connect()` registers persistent `on()` handlers); `connect(ticket)` ticket is forwarded both to the signal server and as the first binary DC message (§4.2 game-host auth); `send()` encodes via `handshake.encode` + `channel.sendBinary`; `onMessage` decodes via `handshake.decode`, intercepts `CLOSE_CONTROL_TOPIC` → `client:kicked { code, reason }` (§3.4), routes all other topics as normal; double-close guard (`disconnecting` flag) prevents `triggerDisconnect` from firing twice when both DC.onClose and PC state-change arrive; signal `client:disconnect` before DC opens triggers early reconnect (avoids waiting for ICE timeout). **Divergence from §4.4 plan:** the plan states "the signaling leg's `WSClient` handles its own backoff" — this describes the browser case where browser `WSClient` has built-in reconnect. The node `WSClient` intentionally omits built-in reconnect (caller-layered, like fleet). Therefore, node `RTCClient` owns its own optional jittered-exponential backoff loop (`reconnect` option, disabled by default) rather than relying on the signal leg — same `NO_RECONNECT_CODES` gate and `getTicket` refresh; re-runs full negotiation (new `PeerNegotiator`) per attempt. Exported from `node/src/main.ts`; tests in `node/test/rtc-client.test.mts`; task 064, 2026-06-09.
- [ ] Per-`peerId` pre-admission throttle before `grantAccess` in `RTCTransport` (RTC isn't covered by WS `ConnectionLimiter`). (§8)

**Phase 1 tests / exit**
- [x] `SignalRoom` unit: relay A→only B via `getActor`, host assignment, host-gone fanout, presence (in-process, no real WebRTC). (§10) — `signal/test/signal-room.test.mts`: host assignment, welcome youId/hostId/iceServers, TURN creds via env vars, offer/answer/ice relay to target-only (verbatim payload), host-gone fanout, non-host leave no-host_gone, presence:join/leave broadcasts, unknownTopicPolicy=drop (actor stays connected).
- [x] `IceConfig` unit: HMAC `username/credential` matches coturn; expiry honored. (§10) — `signal/test/ice-config.test.mts`: no-TURN empty array, STUN-only no-creds, username format, HMAC matches coturn, multi-url array, combined STUN+TURN, 24 h default TTL, fromEnv wiring.
- [x] **Loopback**: two peers one process over `node-datachannel`, unchanged `TttRoom`, assert broadcasts arrive — including onJoin-send-before-listener (`pendingEmits` flush). (§10, §4.2) — `node/test/rtc-loopback.test.mts`; InProcessSignalBus relays signal:offer/answer/ice in-process via `createCodec` `to`-field routing; real `NodeDataChannelPeer` connections; suite skipped gracefully when node-datachannel native binary is absent; task 068, 2026-06-09.

### Phase 2 — Browser peers

- [x] `@rivalis/browser` `RTCClient extends Client` using native `RTCPeerConnection`/`RTCDataChannel` (no new runtime dep); reuse shared negotiation core w/ native adapters. (§4.4, §4.5) — `browser/src/peer/RTCPeer.ts` (native adapters implementing RTCPeerLike/RTCDataChannelLike; async op queue serialises createOffer/setLocalDescription/addIceCandidate); `browser/src/peer/NegotiationCore.ts` (isomorphic copy of node/src/peer/NegotiationCore.ts with local RTCPeer types; includes HostNegotiator for Phase-3 browser-as-host); `browser/src/RTCClient.ts` (same structure as node RTCClient — own reconnect loop, new PeerNegotiator per attempt, §3.4 control-frame kick, double-close guard; signaling leg is browser WSClient(ticketSource='protocol')); exported from `browser/src/main.ts`; task 069, 2026-06-09. **Divergence from §4.4 plan:** plan says "signaling leg's WSClient handles its own backoff" (browser WSClient has built-in reconnect). Implemented with WSClient(reconnect:false) + RTCClient-owned backoff loop instead, for the same reason as the node version: reusing a PeerNegotiator across reconnects duplicates its persistent signal-client event listeners. The full-negotiation-retry approach (new PeerNegotiator per attempt) is cleaner and keeps the node/browser implementations structurally identical.
- [ ] `@rivalis/browser` adds `@rivalis/core` kernel dep for `Client`/types + new exports. (§9)
- [ ] Frame-size handling: chunk/reassemble large frames or expose `maxFrameBytes` capability so a `Room` can split (arena snapshot offender); **log** drop/chunk, never silent truncate. RTC ceiling ~16 KiB vs WS 64 KiB. (§7)
- [ ] Backpressure shared helper: factor drop-or-escalate (`bufferedAmount` + threshold) used by both transports; identical `onBackpressureDrop` hook signature. (§7)
- [ ] Reliability option: per-channel `{ ordered }` on `RTCClient`/`RTCTransport`; phase-2 single reliable channel for parity. (§7)
- [ ] coturn integration docs. (§4.3, §13.6)
- [ ] `demo/src/p2p/`: unchanged `TttRoom` + Node host w/ `RTCTransport` + existing React client on `RTCClient` (parallels `demo/src/fleet/`). (§11)
- [ ] Playwright/headless-Chromium two-tab test vs Node host (play move, both boards update). (§10)
- [ ] NAT/TURN CI-optional: coturn container forcing `iceTransportPolicy:'relay'`. (§10)
- [ ] Frame-size test: oversized `broadcast` chunks or is reported via capability — never silently dropped. (§10)
- [ ] Multi-transport test: one `Rivalis` `[WSTransport, RTCTransport]`; WS client + RTC peer in same room see each other. (§10, §3.6)
- [ ] Browser-host trust note in docs (casual/co-op vs Node host for competitive). (§8)

### Phase 3 — Browser-as-host (serverless P2P)

- [ ] Browser `RTCTransport` reusing §4.5 negotiation core w/ native adapters (free of bespoke runtime build thanks to §3.3). (§12 phase 3)
- [ ] Host election leveraging `SignalRoom` `hostId`/`host_gone`. (§4.3, §12)
- [ ] Optional `Room.serialize()/hydrate()` for host-handoff state transfer. (§12 phase 3)

### Phase 4 — Optional (realtime-grade + zero-native dev)

- [ ] Unreliable/unordered + dual-channel for high-rate state (`arena`, `{ ordered:false, maxRetransmits:0 }`). (§7, §12)
- [ ] `Transport` capability descriptor `{ ordered, reliable, maxFrameBytes }` a `Room` can query. (§7, §12)
- [ ] Per-transport auth/rate-limit override (the deferred D9). (§3.6, §12)
- [ ] Pure-JS STUN dev-only responder behind a flag. (§4.3, §12)
- [ ] `werift` dev/CI fallback behind a flag (no native build). (§4.5, §12)

### Cross-cutting (verify continuously)

- [ ] `AuthMiddleware.authenticate` constant-time ticket compare (`crypto.timingSafeEqual`) — already flagged `AuthMiddleware.ts:23`. (§8)
- [ ] Confirm DTLS-by-default encryption documented (no extra work). (§8)
- [ ] Liveness parity doc: WS heartbeat vs RTC `onconnectionstatechange`→`handleClose`. (§7)
- [ ] Game-traffic rate-limiting auto-applies to RTC via `TLayer.handleMessage` — verify, no transport work. (§8)
- [ ] Game logic (`Room`/`Actor`): **zero changes** — assert across all phases. (§5, §11)
