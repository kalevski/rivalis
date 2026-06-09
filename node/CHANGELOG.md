# Changelog — @rivalis/node

## [0.1.0] — upcoming

### Decision record

#### Node WebRTC library: node-datachannel default, werift dev/CI fallback (D4 — decided 2026-06-09)

**Decision:** `node-datachannel` is the default Node.js WebRTC implementation
for `@rivalis/node`. `werift` is supported as a no-native-build dev/CI fallback,
selectable via `RIVALIS_WEBRTC_BACKEND=werift`. `@roamhq/wrtc` is not used.

**Rationale:**

| Candidate | Verdict | Reason |
|-----------|---------|--------|
| **node-datachannel** | ✅ Default | Wraps libdatachannel (C++17, MIT). Ships prebuilt binaries for Linux/macOS/Windows via `@mapbox/node-pre-gyp`. Minimal surface: data channels + STUN/TURN client — exactly the WebRTC subset Rivalis needs. Actively maintained; used in production Node WebRTC projects. |
| **werift** | ✅ Dev/CI fallback | Pure TypeScript, zero native build. Ideal for CI environments where installing native toolchains is expensive or blocked, and for contributor onboarding where `npm install` must succeed without a C++ compiler. Enabled by `RIVALIS_WEBRTC_BACKEND=werift`. Full adapter deferred to Phase 4 (p2p.md §12). |
| `@roamhq/wrtc` | ❌ Excluded | Fork of the abandoned `wrtc` package. Requires a full media stack (libwebrtc) that is ~GB of native build artefacts, yet Rivalis only needs data channels. The bloated build footprint is unjustifiable unless full media API parity becomes a hard requirement (it is explicitly out of scope — p2p.md §14). |

**Adapter boundary:**

The library choice is hidden behind the `RTCPeerLike` / `RTCDataChannelLike`
interfaces defined in `src/peer/RTCPeer.ts`. Neither `RTCTransport` nor
`RTCClient` imports `node-datachannel` or `werift` directly — they receive a
`createPeerConnection` factory (the `RTCAdapters.createPeerConnection` slot,
§4.5) and stay completely library-agnostic. Swapping the backend is a one-env-var
change that needs no code modification in transport or client layers.

**Lazy loading:**

Both backends are loaded via `require()` inside a try/catch rather than a
top-level `import`. This mirrors the fleet/handshake lazy-serializer pattern
(p2p.md §3.5, D2) and means:

- `node-datachannel`'s native addon loads only when the first peer connection
  is created, not at module import time.
- `werift` (an `optionalDependency`) silently fails to load only when actually
  requested, producing a clear error message rather than a module-resolution
  crash at startup.

**Package.json surface:**

- `dependencies: { "node-datachannel": "^0.10.0" }` — shipped by default.
- `optionalDependencies: { "werift": "^0.19.0" }` — installed on request;
  `npm install --omit=optional` (the default in many CI pipelines) skips it.

**Phase plan:**

- Phase 1 (p2p.md §12): full `NodeDataChannelPeer` adapter + `RTCTransport` +
  node `RTCClient` wired against `node-datachannel`.
- Phase 4 (p2p.md §12): `WeriftPeer` adapter fully implemented; the stub in
  `src/peer/RTCPeer.ts` is replaced with a working adapter.

**Cross-reference:** `p2p.md §4.5`, `§13.4`, `§15 D4`; `core/CHANGELOG.md` D1
(isomorphic core split); `handshake/CHANGELOG.md` D2 (lazy serializer loader).
