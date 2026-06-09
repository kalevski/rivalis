# Changelog — @rivalis/node

## [0.1.0] — upcoming

### Decision record

#### v1 host location: Node-host-first; browser-as-host deferred to Phase 3 (D5 — decided 2026-06-09)

**Decision:** the v1 authoritative host is a **Node.js process**. `RTCTransport`
(the host-side WebRTC transport) lives in `@rivalis/node` and is the Phase 1
deliverable. Browser-as-host is deferred to Phase 3.

**Rationale:**

| Factor | Node host (v1) | Browser host (Phase 3) |
|--------|---------------|----------------------|
| **Trust model** | Equivalent to the existing WS server: a controlled, trusted process. Auth, rate-limiting, and game logic all behave identically. | Only as trustworthy as the browser tab running it. Suitable for casual/co-op; risky for competitive or authoritative games (§8 trust note). |
| **Implementation cost** | `RTCTransport extends Transport` with five-step seam (§4.2). `@rivalis/node` dependency on `node-datachannel`. Game `Room` subclasses are **unchanged**. | Requires browser `RTCTransport` (§4.5 native adapters) + host-election logic in `SignalRoom` + optional `Room.serialize()/hydrate()` for host handoff (§12 Phase 3). |
| **Core dependency** | No new core work beyond Phase 0. D1's isomorphic split and D3's `Client` base are already locked for other reasons. | Phase 3 browser-host **falls out for free** once D1's isomorphic core is in place (§3.3 note), but the feature itself is higher complexity and lower urgency. |
| **Phase sequencing** | Phase 1 is gated on Phase 0 core generalization only. Shortest path to a working P2P demo. | Gated on Phase 2 (browser peers) completing first. Attempting it earlier would sequence phases in reverse. |

**Sequencing implication:**

This decision locks the phase roadmap order:
- Phase 1: Node host (`RTCTransport` in `@rivalis/node`) ↔ Node peers.
- Phase 2: Browser peers (`RTCClient` in `@rivalis/browser`) ↔ Node host.
- Phase 3: Browser-as-host (browser `RTCTransport`, host election).

None of this forecloses browser-host. The §3.3 isomorphic core split (D1) is
designed precisely so that a browser host needs no bespoke runtime build —
it will be cheap to add in Phase 3. The sequencing simply reflects
implementation dependencies and trust trade-offs, not a limit on the architecture.

**Cross-reference:** `p2p.md §13.5`, `§12` (phased roadmap), `§8` (browser-host
trust note), `§4.1` (host-authoritative star topology); `core/CHANGELOG.md` D1
(isomorphic kernel entry split); `node/CHANGELOG.md` D4 (Node WebRTC library).

---

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

---

#### Package names confirmed: @rivalis/signal + @rivalis/node (D10 — decided 2026-06-09)

**Decision:** `@rivalis/node` confirmed as the name of this package.
`@rivalis/signal` confirmed as the name of the signaling-server package.

Full rationale and workspace registration details in `signal/CHANGELOG.md` D10.

**Cross-reference:** `p2p.md §5`, `§13.10`, `§15 D10`;
`signal/CHANGELOG.md` D10 (primary decision record);
task `010-node-low-decide-package-names.md`.
