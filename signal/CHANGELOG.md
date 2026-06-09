# Changelog — @rivalis/signal

## [0.1.0] — upcoming

### Decision record

#### TURN relay strategy: coturn sidecar confirmed (D6 — decided 2026-06-09)

**Decision:** production TURN relay is provided by **coturn as a sidecar** process.
A pure-JS STUN responder is available as a **dev-only** convenience, enabled by
the `RIVALIS_STUN_DEV=true` environment variable. A production TURN relay in JS
is **never shipped** — not now, not in a later phase.

**Rationale:**

| Factor | coturn sidecar | JS TURN reimplementation |
|--------|---------------|--------------------------|
| **Protocol fit** | STUN/TURN are UDP (RFC 5389 / RFC 8656). coturn manages raw OS sockets, allocation tables, and permission/channel lifecycle in C — exactly what a UDP relay needs. | Node.js runs on the same event loop as game logic. A UDP-heavy relay would compete for CPU and is outside Node's idiomatic strengths. |
| **Credential scheme** | `IceConfig` mints ephemeral HMAC-SHA1 creds (`username = <unixExpiry>:<peerId>`, `credential = base64(HMAC_SHA1(secret, username))`). coturn's `static-auth-secret` REST mode validates them natively — zero extra integration work. | A JS TURN server would need to replicate the same HMAC validation on top of a from-scratch UDP relay — high complexity for no gain over using the established implementation. |
| **Reliability / battle-test** | coturn is the reference TURN implementation, used in production by Jitsi, Pion, many WebRTC platforms. Its reliability and STUN/TURN/TURNS conformance are well-established. | A JS reimplementation would need independent conformance testing against RFC 8656, including the full TURN allocation, permission, channel, and refresh lifecycle. |
| **Maintenance burden** | Config is a single `turnserver.conf` with `static-auth-secret`. Upgrades are OS package management. | A JS relay would become a long-term maintenance surface the team owns exclusively. |
| **Security** | The TURN shared secret stays on the server; clients receive only ephemeral creds with a short TTL. coturn enforces expiry independently. | No change to the credential model, but a JS relay adds a new attack surface the team must audit and patch. |

**Pure-JS STUN for development:**

STUN (binding requests only, no relay) is far simpler than TURN and feasible in
JS for local development where NAT traversal is not needed. Enabling it via
`RIVALIS_STUN_DEV=true` lets contributors run the full signaling stack without
installing coturn — the JS responder handles `binding:request` only and returns
the observed address. It must never be exposed on a production port:

```sh
# dev only — no TURN, no production use
RIVALIS_STUN_DEV=true node signal/dist/main.js
```

The flag is off by default; `SignalServer` start-up logs a clear warning when it
is enabled. The full implementation of this responder is deferred to Phase 4
(`p2p.md §12`). Until then, the flag is accepted but raises a `not implemented`
error to prevent accidental reliance on an unfinished path.

**Deployment summary (production):**

1. Run coturn alongside the signal server (same host or dedicated, reachable on
   UDP 3478 / TCP 3478 / TLS 5349).
2. Set `use-auth-secret` + `static-auth-secret=<shared-secret>` in
   `turnserver.conf`. The secret must match `ICE_TURN_SECRET` in the signal
   server's environment.
3. `IceConfig.issueFor(peerId)` mints creds; coturn validates them via
   `static-auth-secret` REST; creds expire at `unixExpiry`. The secret never
   leaves the server.
4. For forced-relay testing (CI NAT scenario) set `iceTransportPolicy:'relay'`
   in the client; see task `077-node-low-nat-turn-relay-test.md`.

**What this decision locks for downstream tasks:**

- **IceConfig** (`task 055`): credential format is `username = <unixExpiry>:<peerId>`,
  `credential = base64(HMAC_SHA1(ICE_TURN_SECRET, username))`. This is the
  coturn `static-auth-secret` REST scheme — no other format is valid.
- **coturn provisioning** (`task 057`): deployment docs, `turnserver.conf`
  template, and secret-rotation guidance all follow the `static-auth-secret`
  scheme confirmed here.
- **IceConfig tests** (`task 067`): the HMAC unit test asserts the exact
  `username/credential` format coturn expects.
- **NAT/TURN relay test** (`task 077`): the CI-optional test forces relay via
  a real coturn container, validating the full credential round-trip.

**Out of scope (explicit, by this decision):**

- A production JS TURN relay — ruled out permanently (see `p2p.md §14`).
- A production JS STUN responder — dev-only (Phase 4).
- Media relay (TURN for video/audio) — data-channel only; `p2p.md §14`.

**Cross-reference:** `p2p.md §4.3`, `§8`, `§13.6`, `§14`, `§15 D6`;
`signal/CHANGELOG.md` D6 (this entry); task `055-signal-high-ice-config-turn-creds.md`;
task `057-signal-medium-coturn-provisioning.md`; task `067-signal-low-ice-config-tests.md`;
task `077-node-low-nat-turn-relay-test.md`.
