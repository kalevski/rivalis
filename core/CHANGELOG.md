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
