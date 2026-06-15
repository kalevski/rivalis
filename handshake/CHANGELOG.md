# Changelog — @rivalis/handshake

## [upcoming] — unreleased

### Decision record

#### Shared typed-codec toolkit home (D7 — decided 2026-06-09)

**Decision:** the shared typed-codec discipline folds into **`@rivalis/handshake`**.
No new `@rivalis/wire` package is created.

**What this adds to `handshake`:**

A small codec helper wrapping `@toolcase/serializer` with:

- A 2-byte `[major, minor]` version header (same layout as `fleet/src/wire/serializer.ts`
  `WIRE_MAJOR`/`WIRE_MINOR`/`HEADER_BYTES`).
- Append-only positional-tag discipline: field order determines the tag; never reorder
  or remove fields, only append.
- `present()`-based decode (own-property vs prototype default) for forward-compat reads.
- `WireVersionError` thrown on a major-version mismatch.
- The baked-in lazy `createRequire(import.meta.url) ?? require` loader that keeps the
  module Node-ESM-safe (same pattern as D2 below).

This toolkit is the shared foundation for *control/negotiation* wires — `@rivalis/signal`'s
`wire/` and any future typed binary protocol. Consumer schema files become ~80 lines of
field definitions over the helper, not a 417-line fork of fleet's codec.

`handshake`'s game-frame codec (`{topic, payload}`, no version header) is **unchanged** —
it is the hot path and its frame shape is fixed. The toolkit is additive.

**Rationale:**

1. **`handshake` already owns the wire layer.** It holds the game-frame codec, `CloseCode`,
   and (after D2) the control-frame convention. The typed-codec discipline is another wire
   concern — colocation is the principled choice.

2. **No new package needed.** Every package that needs the toolkit (`@rivalis/signal`,
   `@rivalis/node`) already depends on `@rivalis/handshake` transitively. A separate
   `@rivalis/wire` would add an extra dependency hop for no consumer benefit.

3. **The lazy-loader (D2) is already landing here.** The toolkit's lazy-`require` pattern
   (`createRequire(import.meta.url) ?? require`) is the same fix. Writing it once inside
   `handshake` (D2 + D7 together) avoids each downstream package re-implementing it
   independently — the stated anti-pattern from D2's rationale.

4. **Scope of `@rivalis/wire` is empty.** The only hypothetical reason to split is "external
   consumers want the codec without the frame layer." No such consumer exists today; `signal`
   and `node` are first-party. The §14 out-of-scope note explicitly defers any codec-only
   public API. Splitting prematurely adds maintenance surface with no payoff.

5. **Consistency with the target package table (§5).** `p2p.md §5` already assigns the
   toolkit to `@rivalis/handshake`. Confirming that assignment keeps the spec and
   implementation in sync.

**Rejected alternative:** new `@rivalis/wire` package. Ruled out because no current consumer
needs the toolkit without also needing `handshake`; the extra package would require its own
build config, publish pipeline, and peer-dependency declarations for zero consumer benefit at
this stage. Can be revisited if a genuine external-only consumer materialises.

**Implementation site:** `handshake/src/codec/` (new directory) — a `createCodec(name,
schema)` factory returning `{ encode, decode }` backed by the versioned helper. See
`p2p.md §3.5` and `§15 Phase 0 F4` for the full build and test tasks.

**Cross-reference:** `handshake/CHANGELOG.md` D2 (lazy serializer loader, decided
2026-06-09); `core/CHANGELOG.md` D1 (isomorphic kernel split, decided 2026-06-09);
`p2p.md §3.5`, `§5`, `§9`, `§13.7`.

---

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
