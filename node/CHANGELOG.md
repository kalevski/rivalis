# Changelog — @rivalis/node

## [0.1.0] — upcoming

### Security hardening

#### Offer-time admission control for host RTC peer connections (task 040 — 2026-06-12)

**Problem:** `HostNegotiator` (`node/src/peer/NegotiationCore.ts`) allocated a native
`RTCPeerConnection` on every inbound `signal:offer`, keyed by the attacker-supplied
`from` id, with no bound on `pcs.size` and no negotiation timeout. The `peerLimiter`
(gate 2, `RTCTransport`) only runs after a data channel opens, so it never gated PC
creation. A flood of offers with distinct `from` ids could allocate unbounded native
PCs that never reach `onChannelOpen`, and a later offer could silently clobber an
in-progress peer's PC entry via `pcs.set`.

**Fix:** admission control applied at offer time, *before* any native PC is allocated
(see `p2p.md §8`, gate 0):

- **Concurrency cap** — `maxConcurrentNegotiations` (default 1024) bounds `pcs.size`;
  offers beyond the cap are dropped without allocating a PC.
- **Duplicate-`from` rejection** — an offer whose `from` already has a live PC is
  dropped; the in-progress PC is never overwritten.
- **Negotiation timeout** — `negotiationTimeoutMs` (default 15 s, `<= 0` disables)
  arms a per-PC timer that closes and removes any PC that has not reached `connected`
  in time, then notifies the host via `onPeerStateChange(peerId, 'failed')`. The timer
  is cleared on connect, `closePeer`, and `dispose`.

Both limits are exposed on `RTCTransportOptions` (`maxConcurrentNegotiations`,
`negotiationTimeoutMs`) and on the `HostNegotiator` constructor via the new
`HostNegotiationGuardOptions`. Defaults exported as
`DEFAULT_MAX_CONCURRENT_NEGOTIATIONS` / `DEFAULT_NEGOTIATION_TIMEOUT_MS`.

Tests: `node/test/negotiation-core.test.mts` (concurrency cap, freed-slot re-admission,
duplicate-`from` rejection + ICE routing, timeout cleanup, connect/closePeer/dispose
timer clearing).

**Cross-reference:** `p2p.md §8` (three-gate throttle table); task
`040-node-rtc-gate-peer-connection-creation.md`.

---

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

**Phase plan / implementation status:**

- Phase 1 (p2p.md §12): full `NodeDataChannelPeer` adapter + `RTCTransport` +
  node `RTCClient` wired against `node-datachannel`. ✅ Done.
- Phase 4 (p2p.md §12): `WeriftPeer` adapter fully implemented (task 088,
  2026-06-09). The Phase 1 stub in `src/peer/RTCPeer.ts` is replaced with a
  working `WeriftPeer` + `WeriftDataChannel` implementation. See implementation
  notes below.

**WeriftPeer implementation notes (task 088, 2026-06-09):**

werift's `RTCPeerConnection` API is entirely async — `createOffer()`,
`createAnswer()`, `setLocalDescription()`, `setRemoteDescription()`, and
`addIceCandidate()` all return Promises. The `RTCPeerLike` interface is
synchronous (NegotiationCore calls these methods and immediately proceeds).
The adapter bridges this gap with an **internal promise queue** (`_enqueue`):
each call schedules its async work onto a sequential chain, so back-to-back
calls like

```typescript
pc.setRemoteDescription(offer)   // enqueued — runs first
pc.setLocalDescription('answer') // enqueued — runs after setRemoteDescription resolves
```

are always correctly serialised without requiring any change in NegotiationCore.

`onicecandidate` is wired in the `WeriftPeer` constructor (so candidates
generated during `setLocalDescription` are captured regardless of when
`onLocalCandidate` is registered). The `onconnectionstatechange` handler reads
`pc.connectionState` and forwards it to the `onStateChange` callback. Incoming
data channels are delivered via `ondatachannel`.

`WeriftDataChannel` wraps werift's `RTCDataChannel`, mapping `onmessage` events
(data: `Buffer | string | ArrayBuffer`) → `Uint8Array` for the `onMessage`
callback, and forwarding `sendBinary(Uint8Array)` directly (werift accepts
`Uint8Array` in `dc.send()`).

Both `WeriftPeer` and `WeriftDataChannel` are exported from `@rivalis/node`
main entry so they can be used in tests and custom adapter wiring.

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
