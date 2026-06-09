# Changelog — @rivalis/core

## [7.0.0] — 2026-06-09

### Breaking changes

#### Isomorphic kernel entry + Node subpath exports (D1 — decided 2026-06-09)

**Decision:** clean `7.0.0` major — **no lazy-`require` shim**.

The default entry (`"."`) now exports the **isomorphic kernel only**.
Node-only transports and clients move behind explicit subpath exports.
The legacy `Transports = { WSTransport }` / `Clients = { WSClient }` namespace
objects are **removed** from the main entry.

**Rationale:** a lazy-getter shim that keeps `Transports.WSTransport` reachable
from the neutral kernel entry must itself be reachable from that entry.
Because bundlers follow `import` reachability, the getter would drag `ws` and
`node:crypto` back into browser bundles — the precise problem the entry split
solves. The marginal convenience of keeping the old import path does not justify
re-polluting the isomorphic bundle. A clean major with a one-line migration is
the right trade-off.

**Migration** — update affected import sites (see p2p.md §5 for the full list):

```diff
- import { Transports } from '@rivalis/core'
- const transport = new Transports.WSTransport({ server })
+ import { WSTransport } from '@rivalis/core/transports/ws'
+ const transport = new WSTransport({ server })
```

```diff
- import { Clients } from '@rivalis/core'
- const client = new Clients.WSClient(url)
+ import { WSClient } from '@rivalis/core/clients/ws'
+ const client = new WSClient(url)
```

All kernel types (`Rivalis`, `Room`, `Actor`, `AuthMiddleware`, `RateLimiter`,
`ConnectionLimiter`, `KickReason`, `TLayer`, `Config`, …) continue to be
imported from `'@rivalis/core'` unchanged.

#### `Client` abstract base class location (D3 — decided 2026-06-09)

**Decision:** `Client` is defined in **`@rivalis/core`** (`core/src/Client.ts`),
exported from the isomorphic kernel entry.

**Rationale:**

Both client implementations (`browser/src/WSClient.ts` and
`core/src/clients/WSClient.ts`) already depend on `@rivalis/core` directly or
transitively. Placing `Client` in `@rivalis/core` means:

- Every conforming client (`WSClient` ×2, `RTCClient` ×2) has exactly one
  import home: `import { Client } from '@rivalis/core'`.
- The `Transport` base (F1, also in `@rivalis/core`) and `Client` sit
  side-by-side — the symmetric server-side/client-side extension contracts
  live in the same package.
- `@rivalis/handshake`'s role stays focused on the wire layer (frame codec,
  `CloseCode`, control-frame convention, codec toolkit) — not abstractions.
- App code that programs against `Client` (`demo/src/client/useRoom.ts`,
  fleet's `FleetTransportClient` collapse) imports from a single, stable,
  isomorphic module.

**Rejected alternative:** place `Client` in `@rivalis/handshake`. Ruled out
because `handshake`'s purpose is the wire/frame layer, not the client
abstraction; consumers that want the contract without the codec would gain an
unwanted transitive dependency; and D2's lazy-serializer conversion makes
`handshake` carry more machinery — adding the class hierarchy there would
conflate two distinct concerns.

**Implementation site:** `core/src/Client.ts` — new file; exported from
`core/src/main.ts`. See `p2p.md §3.2` for the full conformance tasks.

**Cross-reference:** `core/CHANGELOG.md` D1 (isomorphic kernel entry split,
decided 2026-06-09); `handshake/CHANGELOG.md` D2 (lazy serializer loader,
decided 2026-06-09); `p2p.md §3.2`, `§5`, `§13.3`.

#### `Room.getActor` visibility (D8 — decided 2026-06-09)

**Decision:** `protected`.

**Rationale:**

`getActor(id)` is a subclass primitive, not a public API. The canonical caller is
a `Room` subclass like `SignalRoom` that must route a message to one specific peer
by id (§4.3). Making it `protected` signals precisely this intent and prevents
external code from bypassing the `each`/`broadcast`/`send` surface, which is the
deliberate public contract.

`public` was considered and rejected: the only concrete use case is intra-room
routing inside a subclass (signaling relay). Exposing it publicly would invite
callers to obtain `Actor` references and call `actor.kick` or other actor methods
directly, circumventing room-level accounting and making the room's actor map an
implementation detail in name only. There is no known use case today that requires
external lookup of a joined actor that is not already satisfied by `each`.

App code that needs to find one actor among many should either maintain a
subclass-level index (a `Map<string, Actor>` in `onCreate`/`onJoin`/`onLeave`)
or iterate via `each`. `getActor` is a targeted primitive for routing, not a
general query API.

**Implementation site:** `core/src/Room.ts` (after the `actorCount` getter, before
`onCreate`). No behavioral change to existing rooms — purely additive.

**Cross-reference:** `p2p.md §3.7`, `§4.3`, `§13.8`; task list D8 (Phase −1).

#### Per-transport auth/rate-limit override (D9 — decided 2026-06-09)

**Decision:** **defer** to Phase 4.

Per-transport `authMiddleware?` / `rateLimiter?` overrides on `Transport` subclasses
are **not** shipped in Phase 0. `ConfigOptions` (`Config.ts:8-14`) is unchanged.

**Rationale:**

The feature is strictly additive — it does not alter the existing single-auth /
single-rateLimiter contract. The driving use case ("WS peers authenticate by
cookie, RTC peers by signaling token") is already fully solvable today by running
two separate `Rivalis` apps, which is exactly the pattern `fleet/` established.
Because separate apps already cover the star topology, the urgency is low and the
scope of Phase 0 should not widen for a convenience feature. Implementing it later
as an opt-in addition to `ConfigOptions` carries zero risk of breaking the API;
deferring now keeps Phase 0 focused on the blockers (`Transport` export, isomorphic
kernel split, `Client` contract) that pay for themselves regardless of P2P.

**Deferred work tracked in:** Phase 4, task `086-core-low-per-transport-admission-impl.md`
and `043-core-low-per-transport-admission-override.md`.

**Phase 0 impact:** none. `Config.ts:8-14` is untouched; no tracking stub or
placeholder is added. When Phase 4 lands, `Transport` gains optional
`authMiddleware?: AuthMiddleware<any>` and `rateLimiter?: RateLimiter | null`;
`TLayer` prefers the transport's when present, falls back to the global `Config`
default. The change will be backward-compatible and additive.

**Cross-reference:** `p2p.md §3.6`, `§12 Phase 4`, `§13.9`; task list D9 (Phase −1).

---

**New exports in `7.0.0`:**

| Export | Description |
|--------|-------------|
| `Transport` | Abstract base class — now exported (was unreachable; blocked external transports — F1) |
| `Client` | Abstract base class for all client implementations (F3) |
| `ConnectionContext` | Typed per-connection context forwarded from transport to `grantAccess` (§3.1) |

**Export map** (`core/package.json`):

```jsonc
{
  "exports": {
    ".":               { "types": "./lib/main.d.ts",      "import": "./lib/module.js",          "require": "./lib/main.js" },
    "./transports/ws": { "types": "./lib/ws.d.ts",        "import": "./lib/ws.module.js",       "require": "./lib/ws.js" },
    "./clients/ws":    { "types": "./lib/wsclient.d.ts",  "import": "./lib/wsclient.module.js", "require": "./lib/wsclient.js" }
  }
}
```

The kernel entry builds `platform:'neutral'`; the `transports/ws` and
`clients/ws` entries build `platform:'node'`.

Downstream packages that declare a peer on `@rivalis/core` should update their
range to `>=7 <8`.

---

## [6.1.0] — previous

Existing `@rivalis/core` release. Node-only; single `"."` export entry bundles
`WSTransport` and node `WSClient` alongside the isomorphic kernel.
