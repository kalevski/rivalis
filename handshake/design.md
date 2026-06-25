# `@rivalis/handshake` — internal redesign

Clean-room reorganization of the package internals. **The public API (everything
re-exported from `src/main.ts`) and the on-wire byte formats stay exactly as they
are today.** Only the internal module layout changes. No consumer
(`@rivalis/core`, `@rivalis/browser`, `@rivalis/node`, `@rivalis/signal`,
`@rivalis/fleet`) needs an import change.

---

## 1. Constraints (what must not change)

1. **Exported symbols** — the surface listed in §3. Same names, same kinds
   (value vs type), same shapes. This is the stated contract.
2. **Wire bytes** — `encode`/`decode`, `createCodec`, and `encodeCloseFrame`/
   `decodeCloseFrame` produce/consume identical bytes. The package is shipped to
   both ends of a connection (server + client), which can run at skewed versions,
   so the append-only tag rule and the version-header layout are hard interop
   constraints, not implementation details. A behavior-only refactor must keep
   them byte-identical.

Everything else (file layout, internal class boundaries, where a constant lives)
is free to move.

---

## 2. Why reorganize

The package currently mixes four distinct concerns across files whose boundaries
don't follow them:

| File | Concern(s) | Problem |
|------|-----------|---------|
| `src/serializer.ts` | low-level binary **engine** (`Serializer`, `Writer`, `Reader`, varint, zig-zag) **+** the realtime **message codec** (`encode`/`decode`/`Message`) | two unrelated concerns, two reasons to change, in one file |
| `src/codec/index.ts` | versioned **codec toolkit** (`createCodec`, `WireVersionError`, `present`, `FieldType`, `Schema`, …) | a directory holding a single `index.ts`; the name "codec" collides with the "message codec" above |
| `src/closeFrame.ts` | **close frame** machinery | builds a raw `Serializer` by hand — a third, ad-hoc way to construct a codec, inconsistent with `createCodec` |
| `src/CloseCode.ts` | **close codes** constant | fine, but isolated from the rest of the close concern |
| `src/main.ts` | public barrel | fine |

Concrete smells:
- The hot-path message codec is appended to the bottom of the engine file — they
  version and evolve independently but can't be reasoned about separately.
- `FieldType` (public) restates the engine's scalar type-name strings; the two
  can drift because there's no single source.
- `FieldDef` is defined in `serializer.ts` and re-exported from `codec/` — the
  schema vocabulary has no clear home.
- Two construction paths coexist (`createCodec` vs hand-rolled `Serializer` in
  `closeFrame.ts`) with no documented reason.

---

## 3. Public API inventory (the contract)

Full export list of `src/main.ts`. **All of these are preserved.** "Consumed"
marks symbols actually imported elsewhere in the monorepo today; the rest are part
of the contract but currently unused by consumers.

| Symbol | Kind | Group | Consumed by |
|--------|------|-------|-------------|
| `encode` | value | realtime codec | core, browser, node, signal (+tests) |
| `decode` | value | realtime codec | core (TLayer), browser, node, signal |
| `Message` | type | realtime codec | core, browser (re-exported) |
| `createCodec` | value | versioned codec | browser/node NegotiationCore, RTCTransport, signal |
| `WireVersionError` | value | versioned codec | signal (re-exported) |
| `present` | value | versioned codec | browser/node NegotiationCore, signal |
| `FieldType` | value | versioned codec | browser/node NegotiationCore, RTCTransport, signal |
| `Schema` | type | versioned codec | signal |
| `FieldDef` | type | versioned codec | — |
| `CodecOptions` | type | versioned codec | — |
| `Codec` | type | versioned codec | — |
| `CloseCode` | value | close | core, browser, node (WSTransport, clients) |
| `CloseCodeType` | type | close | — |
| `CLOSE_CONTROL_TOPIC` | value | close | browser/node clients + RTCTransport |
| `MAX_CLOSE_REASON_BYTES` | value | close | core (TLayer, kick-reason test) |
| `encodeCloseFrame` | value | close | browser/node RTCTransport, RTCClient |
| `decodeCloseFrame` | value | close | browser/node clients, RTCClient |
| `CloseFrame` | type | close | — |

Four groups fall out naturally: **realtime codec**, **versioned codec**,
**close**, all sitting on a shared **wire engine** (which exports nothing public
except the `FieldDef` type and `FieldType` vocab).

---

## 4. Proposed layout

```
src/
  main.ts            # public barrel — re-exports only. PUBLIC API, byte-identical to today.

  wire/              # Layer 0 — pure binary engine. No frame knowledge. Leaks only FieldDef + scalar vocab.
    varint.ts        #   Writer + Reader: LEB128 varint, length-prefixed bytes, zig-zag.
    types.ts         #   FieldDef, the scalar type-name union, and the FieldType constant (single source).
    serializer.ts    #   Serializer class: schema-driven encode/decode, append-only positional tags.

  message.ts         # Layer 1a — realtime hot-path codec: encode / decode / Message. Fixed schema, no header.
  codec.ts           # Layer 1b — versioned codec toolkit: createCodec / WireVersionError / present / Schema / CodecOptions / Codec (re-exports FieldType, FieldDef).

  closeCodes.ts      # Layer 2 — CloseCode constant + CloseCodeType.
  closeFrame.ts      # Layer 2 — CloseFrame, encode/decodeCloseFrame, CLOSE_CONTROL_TOPIC, MAX_CLOSE_REASON_BYTES, UTF-8 truncation.
```

One folder — `wire/` — because the engine is genuinely multi-file. Everything else
is a flat, single-purpose module. No single-file directories (kills the current
`codec/index.ts` smell).

### Dependency rule (strictly downward)

```
main.ts
  ├── message.ts ─────────┐
  ├── codec.ts ───────────┤
  ├── closeCodes.ts       ├──→ wire/   (serializer → varint, types)
  └── closeFrame.ts ──────┘
                           closeFrame.ts → closeCodes.ts (for code typing only)
```

- `wire/*` imports nothing outside `wire/` (pure; node-or-browser agnostic — uses
  only `TextEncoder`/`TextDecoder`/`Uint8Array`).
- `message.ts`, `codec.ts`, `closeFrame.ts` each import from `wire/` only.
- No sideways dependencies between `message` / `codec` (they're parallel codec
  families over the same engine).
- `main.ts` contains re-exports only — zero logic.

---

## 5. Module responsibilities

### `wire/varint.ts`
The byte plumbing, extracted from today's `serializer.ts`. `Writer` (growable
buffer, `varint()`, `lenBytes()`, `done()`) and `Reader` (`varint()`, `take()`,
`more`). LEB128 unsigned varints; zig-zag is applied by the serializer, not here.
Splitting this out leaves `serializer.ts` to be purely about the schema/tag logic.
*(This is the one optional split — `Writer`/`Reader` are ~70 lines and only the
serializer uses them. Keeping them inside `serializer.ts` is acceptable if a
folder feels heavy; the rest of the design is unaffected.)*

### `wire/types.ts`
The schema vocabulary, single source of truth:
- `FieldDef` (`{ key, type, rule, default? }`) — moved here from `serializer.ts`.
- the scalar type-name string union (`'string' | 'uint32' | 'int32' | 'bool' | 'bytes'`).
- `FieldType` constant object — was duplicated in `codec/index.ts`; now defined
  once here against the union, re-exported through `codec.ts` (its documented home)
  and `main.ts`. Engine and public constant can no longer drift.

### `wire/serializer.ts`
The `Serializer` class only: `define()`, `encode()`, `decode()`, the positional
tag rule, scalar/nested read+write, `defaultFor()`. Imports `Writer`/`Reader` from
`varint.ts` and `FieldDef` from `types.ts`. Not part of the public API (internal
substrate for the three codecs above it).

### `message.ts`
Today's bottom-of-`serializer.ts` block, lifted out. Owns the fixed
`{ topic, payload }` realtime frame, the lazy singleton serializer, and exports
`encode`, `decode`, `Message`. No version header (hot path).

### `codec.ts`
Today's `codec/index.ts`, flattened out of the folder. `createCodec` (2-byte
`[major, minor]` header + body), `WireVersionError`, `present`, the `Schema` /
`CodecOptions` / `Codec` types. Re-exports `FieldType` and `FieldDef` from
`wire/types.ts` so consumers' existing `import { FieldType, FieldDef } from
'@rivalis/handshake'` keep resolving.

### `closeCodes.ts`
The `CloseCode` frozen constant (4001–4005) and `CloseCodeType`. Zero dependencies
— core/browser/node import just `CloseCode` without dragging in any frame
machinery.

### `closeFrame.ts`
`CloseFrame` type, `CLOSE_CONTROL_TOPIC`, `MAX_CLOSE_REASON_BYTES`, the
boundary-safe `truncateUtf8`, and `encodeCloseFrame` / `decodeCloseFrame`. Keeps
building a raw `Serializer` directly (see decision §7.1) — **no version header**,
preserving the current bytes.

---

## 6. Symbol → module map (surface preservation proof)

`main.ts` re-exports every symbol from its new home; the barrel's output is
identical to today's.

| Export | New source module |
|--------|-------------------|
| `encode`, `decode`, `Message` | `message.ts` |
| `createCodec`, `WireVersionError`, `present`, `Schema`, `CodecOptions`, `Codec` | `codec.ts` |
| `FieldType`, `FieldDef` | `wire/types.ts` (re-exported via `codec.ts` → `main.ts`) |
| `CloseCode`, `CloseCodeType` | `closeCodes.ts` |
| `CLOSE_CONTROL_TOPIC`, `MAX_CLOSE_REASON_BYTES`, `encodeCloseFrame`, `decodeCloseFrame`, `CloseFrame` | `closeFrame.ts` |

`main.ts` sketch:

```ts
export { encode, decode } from './message'
export type { Message } from './message'

export { createCodec, WireVersionError, present, FieldType } from './codec'
export type { FieldDef, Schema, CodecOptions, Codec } from './codec'

export { default as CloseCode } from './closeCodes'
export type { CloseCode as CloseCodeType } from './closeCodes'

export {
    CLOSE_CONTROL_TOPIC,
    MAX_CLOSE_REASON_BYTES,
    encodeCloseFrame,
    decodeCloseFrame,
} from './closeFrame'
export type { CloseFrame } from './closeFrame'
```

> Internal change invisible to consumers: `CloseCode` was the default export of a
> file named `CloseCode.ts`; it is now the default export of `closeCodes.ts`. The
> barrel still surfaces `CloseCode` (value) and `CloseCodeType` (type) identically.

---

## 7. Key decisions

### 7.1 Close frame stays on the raw serializer (no version header)
`createCodec` prepends a 2-byte `[major, minor]` header; the close frame today has
none. Routing `closeFrame.ts` through `createCodec` for "consistency" would add 2
bytes → a wire-format change → breaks decode against any peer on the current
major. Close frames also ride a fixed reserved topic (`__rivalis:close`) whose
version is already pinned by the handshake, so a per-frame header buys nothing.
**Decision:** keep `closeFrame.ts` on a hand-built `Serializer` (one lazy
singleton, append-only tags `1=code, 2=reason`), and document *why* it doesn't use
`createCodec`. The inconsistency is intentional and now explained, not accidental.

### 7.2 `FieldType` / `FieldDef` single source in `wire/types.ts`
The public `FieldType` constant is the engine's scalar vocabulary. Defining it once
in `wire/types.ts` and re-exporting removes the current duplication between
`serializer.ts` (the strings) and `codec/index.ts` (the constant).

### 7.3 `wire/` is the only folder
The current `codec/` directory holds a lone `index.ts`. Flattening it to `codec.ts`
and reserving folders for genuinely multi-file units (`wire/`) makes the layer map
legible at a glance.

### 7.4 Message codec separated from the engine
`encode`/`decode`/`Message` graduate to their own `message.ts`. The hot-path frame
and the schema engine now version independently and read independently.

---

## 8. Migration

Purely mechanical, internal-only:

1. Create `wire/varint.ts`, `wire/types.ts`, `wire/serializer.ts` by splitting
   today's `serializer.ts` engine portion.
2. Move the message-codec tail of `serializer.ts` to `message.ts`.
3. Move `codec/index.ts` → `codec.ts`; point its `FieldType`/`FieldDef` at
   `wire/types.ts`; delete the `codec/` folder.
4. Rename `CloseCode.ts` → `closeCodes.ts`; keep `closeFrame.ts`, repoint its
   `Serializer` import to `wire/serializer.ts`.
5. Update `src/main.ts` re-export paths (symbol list unchanged).
6. `package.json` `source`/entry stays `src/main.ts`; `tsup.config.ts` unchanged
   (single entry, bundles everything).

**Verification:**
- `npm run build` (tsup) — must emit the same `lib/main.d.ts` surface.
- Existing `test/codec.test.mts` and `test/closeFrame.test.mts` pass unchanged
  (they exercise only public API and bytes).
- The package smoke import (`node -e "import '@rivalis/handshake'"`) still resolves.
- No consumer package edits; their `@rivalis/handshake` imports are untouched.

Optional follow-up: add unit tests for `wire/serializer.ts` and `wire/varint.ts`
in isolation (varint round-trips, append-only skip of unknown tags, zig-zag
boundaries) — newly possible now that the engine is its own module.
