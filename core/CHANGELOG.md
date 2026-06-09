# Changelog — @rivalis/core

## [7.0.0] — upcoming

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

## [6.1.0] — current

Existing `@rivalis/core` release. Node-only; single `"."` export entry bundles
`WSTransport` and node `WSClient` alongside the isomorphic kernel.
