# Changelog — @rivalis/handshake

## [upcoming] — unreleased

### Decision record

#### Kernel ESM safety: lazy serializer loader (D2 — decided 2026-06-09)

**Decision:** convert `handshake/src/serializer.ts:1` from a top-level
`import { Serializer } from '@toolcase/serializer'` to the lazy
`createRequire(import.meta.url) ?? require` loader.

**Rationale:**

`@toolcase/serializer`'s ESM entry (`lib/main.module.js`) does
`import { Root, Type, … } from "protobufjs/light"` with a bare subpath and no
`.js` extension, which Node's strict-ESM resolver rejects. `handshake` is the
package that stands between `@toolcase/serializer` and `@rivalis/core`'s kernel:
`handshake/src/serializer.ts` top-level-imports the serializer, and
`core/src/TLayer.ts` top-level-imports `@rivalis/handshake`. The broken import
therefore transits the kernel's own ESM entry (F5 in `p2p.md §1`).

The lazy loader pattern is already proven in the codebase:

- `fleet/src/wire/serializer.ts:132-142` — lazy loader for the fleet binary codec
- `fleet/src/util/loadCore.ts` — same pattern, loads `@rivalis/core` via CJS

Both work identically in the CJS and ESM builds: the CJS bundle has a native
`require`; the ESM bundle derives one from `import.meta.url` via
`node:module.createRequire`.

Converting `handshake/src/serializer.ts` applies the same discipline and closes
the F5 hazard at its source. The alternative — accepting that the ESM entry is
bundler-/CJS-only — would leave plain Node-ESM consumers broken indefinitely and
require every downstream package (`@rivalis/signal`, `@rivalis/node`, future
isomorphic packages) to carry the same workaround individually.

**Option chosen: (a) — convert to lazy loader.**

**Rejected alternative (b):** accept bundler-/CJS-only ESM entry. Ruled out
because it leaves a latent break (F5) reachable from the core kernel's own ESM
entry, forces every downstream package to independently rediscover the workaround,
and diverges from the principled universal-entry goal of §3.3 / §2 ("Core is
isomorphic by default").

**Effect on `handshake`:** no observable behavior change for any existing consumer
(CJS or bundler). The serializer is still initialized lazily on first call; the
singleton is retained between calls as before. The `encode`/`decode` exports are
unchanged. The only difference is that the module no longer top-level-imports the
broken ESM entry.

**Implementation site:** `handshake/src/serializer.ts:1` — gated on D2 (now
unlocked). See `p2p.md §15 Phase 0` for the conversion task (`§3.3a`).

**Cross-reference:** `core/CHANGELOG.md` D1 (isomorphic kernel entry split,
decided 2026-06-09); `p2p.md §3.3a`, `§9`, `§13.2`.

---

## [6.0.0] — current

Existing `@rivalis/handshake` release.
