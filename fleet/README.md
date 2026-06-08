# `@rivalis/fleet`

> Fleet orchestration for Rivalis: instance discovery, room placement, cluster control.

A **fleet** is a set of game-server instances and the rooms running on them. This package
gives you a central **`Orchestrator`** (which instances exist, what room types they host,
where clients should connect, and remote room create/destroy with acknowledged commands)
and a **`FleetAgent`** that embeds in each `@rivalis/core` instance to report its state and
execute orchestrator-pushed commands.

> **Strict orchestrator-driven request/reply (protocol v3).** The orchestrator drives the whole
> conversation: it **polls** each agent (`fleet/poll`) on its own cadence and the agent **replies**
> (`fleet/state` — a full snapshot or a hash-only liveness reply), and it pushes commands
> (`fleet/cmd`) the agent acks (`fleet/ack`). **Every agent frame must answer an outstanding
> request** (matched by correlation id); an unsolicited, duplicate, or unknown-topic frame gets the
> agent kicked. This shrinks what a compromised agent key can do unsolicited (it cannot spam
> snapshots or flood acks) and replaces the pre-v3 agent-push model.

State is **in-memory and rebuilt from agent poll replies** — no database, restart-safe. The
orchestrator only orchestrates rooms *within* already-running instances; spawning processes/VMs
is the job of k8s / Agones / autoscalers, and matchmaking logic is something you build *on top
of* the fleet API.

```
┌──────────────────────────┐                       ┌──────────────────────────────┐
│ Game server process      │   WS (agent key)      │ Orchestrator                 │
│  Rivalis (@rivalis/core) │ ────────────────────► │  · embedded via Orchestrator │
│  + FleetAgent  ──────────┼ ◄──────────────────── │  · or standalone bin         │
│                          │  commands + acks      │  REST /v1/* (admin key)      │
└──────────────────────────┘                       └──────────────────────────────┘
        × N instances                                  matchmaker / ops / dashboards
```

> ⚠️ **Designed for private networks.** TLS termination is **out of scope** — see
> [Security](#️-security) before exposing this anywhere.

## 📦 Install

```sh
npm install @rivalis/fleet
```

`@rivalis/fleet` adopts the `@toolcase/*` node-service blueprint, so it carries a small set of
externalized runtime dependencies (the original zero-dependency goal was relaxed in spec §5):

```jsonc
"dependencies": {
  "@toolcase/node": "^4.0.0",        // typed env() loader, EndpointError, FieldSchema, Router/RouteHandler
  "@toolcase/serializer": "3.x",     // runtime-defined protobuf for the binary agent ↔ orch WS frames
  "@fastify/cors": "^11.2.0",        // CORS for the /v1 REST surface + SSE
  "fastify": "^5.8.5",               // HTTP server shared with the agent WS transport
  "commander": "^12.1.0",            // rivalis-fleet binary flag parser (§12)
  "redis": "^5.12.1"                 // NOT used by the fleet — see note below
},
"peerDependencies": {
  "@rivalis/core": ">=6.1.0 <7",     // the agent half needs the 6.1.0 core additions (Room.type, RoomManager.definitions())
  "@toolcase/base": "3.x",
  "@toolcase/logging": "3.x",
  "ws": "8.x"
}
```

**Why `redis` is here even though the fleet never opens a Redis connection.** `@toolcase/node@4`
is a monolithic backend bundle that eager-`require`s `redis` at module top (it ships the KV/leaderboard
helpers the fleet doesn't use). `redis` is an *optional* peer of `@toolcase/node`, but the eager require
means `require('@rivalis/fleet')` would throw `MODULE_NOT_FOUND: redis` without it. So it is kept **only
to satisfy `@toolcase/node@4`'s eager require** — do not remove it while that eager-load persists (a
smoke test guards this). The fix is upstream: once `@toolcase/node` lazy-loads `redis`, this line drops.

The core lower bound is **`>=6.1.0`, not `6.x`**: the agent depends on small core additions that
land in 6.1.0. Installed against 6.0.0, `npm install` fails loudly; if it somehow runs, the
agent's constructor feature-detects the missing APIs and throws an actionable error at startup
rather than emitting `undefined` room types at runtime.

## 🧩 Three consumption modes

1. **Library — agent side.** A `FleetAgent` a Rivalis app instantiates to attach itself to an
   orchestrator: it reports the instance's rooms/connections and runs room create/destroy commands.
2. **Library — orchestrator side.** An `Orchestrator` embeddable in any Node process (custom
   matchmaker, monolith, tests). Full fleet state + control API, plus an optional REST API.
3. **Binary.** `rivalis-fleet` runs a standalone orchestrator configured by env vars / CLI flags —
   zero code needed to operate a cluster.

## 🛰️ Agent side (in each game server)

```ts
import { Rivalis } from '@rivalis/core'
import { FleetAgent } from '@rivalis/fleet'

const rivalis = new Rivalis({ /* ... */ })
rivalis.rooms.define('match', MatchRoom)
rivalis.rooms.define('lobby', LobbyRoom)

const agent = new FleetAgent(rivalis, {
    url: 'ws://orchestrator.internal:7350',     // orchestrator WS endpoint
    key: process.env.FLEET_AGENT_KEY!,           // agent key (sent via WS subprotocol, never a URL query)
    endpointUrl: 'wss://eu1.game.example.com',   // what game clients should be handed
    name: 'eu1',
    labels: { region: 'eu' },
    capacity: { maxConnections: 2000, maxRooms: 100 },
    // optional:
    autoCreate: true            // allow orchestrator-initiated rooms.create (default true)
    // NOTE: no heartbeatMs option — the orchestrator owns the poll cadence (sent in fleet/hello)
})

await agent.connect()       // resolves on the first successful fleet/hello.
                            // Default: retries forever (exponential backoff) — the promise
                            // stays pending while the orchestrator is unreachable. This is
                            // documented steady-state behavior, not a hang. Pass
                            // connectTimeoutMs to reject after a deadline instead.

agent.status                // 'connecting' | 'connected' | 'draining' | 'closed'

await agent.drain()         // stop receiving placements; flips the agent-owned status and
                            // resolves when a poll echoes 'draining' (the orchestrator recorded it)
await agent.awaitEmpty({ timeoutMs: 60_000 })   // resolves when all local rooms are empty
await agent.disconnect()    // detach cleanly

// or wire SIGTERM/SIGINT to: drain → awaitEmpty → disconnect → rivalis.shutdown()
agent.enableGracefulShutdown({ emptyTimeoutMs: 60_000 })
```

The agent **never throws into the host process from network failures** — it logs via
`rivalis.logging.getLogger('fleet')` and retries with backoff. It tracks **room provenance**:
rooms it created in response to an orchestrator command are reported `origin: 'fleet'`,
everything else `origin: 'local'` — and this is the only source of the `RoomInfo.local` flag,
which survives orchestrator restarts because it lives in the process that owns the rooms.

## 🎛️ Orchestrator side (embedded)

```ts
import { Orchestrator } from '@rivalis/fleet'

const orchestrator = new Orchestrator({
    host: '0.0.0.0',                             // bind address (default 0.0.0.0)
    port: 7350,
    agentKey: process.env.FLEET_AGENT_KEY!,      // string | string[] — agents connect with any listed key
    adminKey: process.env.FLEET_ADMIN_KEY!,      // string | string[] — required when api: true
    api: true,                                   // serve REST /v1 (default true)
    heartbeatMs: 5000,
    commandTimeoutMs: 10000,
    cors: false,                                 // false (default) | { origins: string[] }
    sseQueryAuth: false                          // allow ?key= auth on /v1/events for EventSource
})

await orchestrator.listen()

// ---- read model ----
orchestrator.fleet.stats                          // FleetStats
orchestrator.fleet.instances                      // InstanceInfo[]
orchestrator.fleet.rooms                          // RoomInfo[]
orchestrator.fleet.getInstance(id)                // InstanceInfo | null
orchestrator.fleet.getRoom(roomId)                // RoomInfo | null
orchestrator.fleet.findRooms({ type: 'match', labels: { region: 'eu' } })

// ---- control (all return Promises resolved on agent ack) ----
const room = await orchestrator.fleet.createRoom({
    type: 'match',
    roomId: 'match-42',                           // optional — generated if omitted (charset: ^[A-Za-z0-9_-]{1,64}$)
    placement: {                                  // optional — defaults to least-loaded
        // instanceId: 'i_abc',                   // pin to a connection-scoped instance id (see caveat), OR:
        // processUid: 'p_9f3…',                  // pin by stable process id, OR:
        strategy: 'least-loaded',                 // 'least-loaded' | 'most-loaded' | 'random'
        labels: { region: 'eu' },                 // only instances matching all labels
        force: false                              // pinning to a draining instance requires force: true
    }
})  // → RoomInfo (includes endpointUrl for handing to clients)

await orchestrator.fleet.destroyRoom('match-42')          // roomId is fleet-unique
await orchestrator.fleet.drainInstance('i_abc')
await orchestrator.fleet.undrainInstance('i_abc')

// ---- events ----
orchestrator.on('instance:join',  (instance) => {})
orchestrator.on('instance:leave', (instance) => {})
orchestrator.on('instance:stale', (instance) => {})
orchestrator.on('room:create',    (room) => {})
orchestrator.on('room:destroy',   (room) => {})
orchestrator.on('sync',           (stats) => {})   // any state change

await orchestrator.shutdown()
```

### Pinning caveat (`placement.instanceId`)

Instance ids are **connection-scoped** — any reconnect invalidates them, and a matchmaker that
cached one gets `404 INSTANCE_NOT_FOUND`. The contract is *look up, then pin immediately; treat
a 404 as "re-lookup, retry once"*. For a **stable handle across reconnects, pin by `processUid`**
instead — it identifies the process, not the connection. Specifying both is a `400 VALIDATION`.

## 🖥️ Binary — `rivalis-fleet`

The flag surface is parsed by [`commander`](https://github.com/tj/commander.js) (the help
screen and validation are generated, not hand-maintained):

```
$ rivalis-fleet --help

Usage: rivalis-fleet [options]

Options:
  -H, --host <addr>       bind address (env FLEET_HOST, default 0.0.0.0)
  -p, --port <n>          HTTP/WS port (env FLEET_PORT, default 7350)
  --agent-key <key>       agent auth key, repeatable (env FLEET_AGENT_KEY, required*)
  --admin-key <key>       REST admin key, repeatable (env FLEET_ADMIN_KEY, required* when --api)
  --no-api                disable REST API
  --cors <origin>         CORS allow-origin, repeatable (env FLEET_CORS_ORIGINS, default off)
  --sse-query-auth        allow ?key= on /v1/events (env FLEET_SSE_QUERY_AUTH, default off)
  --heartbeat <ms>        agent heartbeat interval (env FLEET_HEARTBEAT_MS, default 5000)
  --command-timeout <ms>  command ack timeout (env FLEET_COMMAND_TIMEOUT_MS, default 10000)
  --log-level <level>     trace|debug|info|warn|error (env FLEET_LOG_LEVEL, default info)
  -v, --version           output the version number
  -h, --help              display help for command

* If omitted, a random key (32 bytes from crypto.randomBytes, base64url-encoded) is
  generated and printed once at startup (dev convenience; refused when NODE_ENV=production).
  Supplied keys are checked against the §13 strength rule at startup. Env vars accept
  comma-separated lists for key rotation.
```

```
$ FLEET_AGENT_KEY=s3cret FLEET_ADMIN_KEY=adm1n rivalis-fleet -p 7350
[INFO] fleet ▸ orchestrator listening host=(0.0.0.0) port=(7350) api=(/v1) heartbeat=(5000ms)
```

- **Dev-key behavior:** if no `--agent-key` / `--admin-key` (or env var) is supplied, a random
  32-byte key is generated and printed once at startup so you can get going with zero config.
- **Production refusals:** when `NODE_ENV=production`, the binary **refuses to auto-generate** a
  missing key. The orchestrator also refuses to start with a key shorter than 16 characters, or
  when the agent-key and admin-key lists **intersect** (one key serving both audiences re-opens
  the legacy single-token hole). Keys 16–31 chars long start with a "weak" warning.
- Comma-separated env values are accepted for **key rotation** (add new → roll callers → remove old).

## 🌐 REST API (`/v1`)

Served when `api: true` — built on **Fastify** + `@toolcase/node`'s `RouteHandler`/`Router`, sharing
the same `node:http` server as the agent WebSocket transport (one port for both). Auth is
`Authorization: Bearer <adminKey>` on everything except `/healthz` and `/readyz`. Request bodies are
capped at **64 KiB** before any parse (`413 PAYLOAD_TOO_LARGE`).

**Response envelope** — `@toolcase/base` `HTTP.RESTResponse` / `HTTP.RESTError`:

- **Success:** `{ "status": "OK", "data": … }` (a list response may also carry `"count"`).
- **Failure:** `{ "status": "rejected", "cause": "<CODE>" }` — `cause` is the stable, machine-readable
  error code (the `FleetErrorCode`s in the table below).

> **Breaking change (was `@rivalis/registry` / pre-006):** the legacy envelope
> `{ message: 'OK' | 'FAIL', data?, code?, cause? }` is replaced. Map old → new:
> `message: 'OK'` → `status: 'OK'`, `message: 'FAIL'` → `status: 'rejected'`, and the machine-readable
> `code` now travels in **`cause`**. The HTTP status codes and the `FleetErrorCode` strings are
> unchanged — only the JSON shape and the field carrying the code moved.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/healthz` | liveness, no auth |
| GET | `/readyz` | readiness (HTTP listening **and** WS transport attached), no auth |
| GET | `/v1/stats` | `FleetStats` |
| GET | `/v1/instances` | all instances |
| GET | `/v1/instances/:id` | one instance (404 if absent) |
| GET | `/v1/instances/:id/rooms` | rooms on one instance |
| POST | `/v1/instances/:id/drain` | mark draining |
| POST | `/v1/instances/:id/undrain` | restore to active |
| GET | `/v1/rooms?type=&instanceId=&label=k:v` | rooms cluster-wide; `label` repeatable, all must match |
| GET | `/v1/rooms/:roomId` | one room (404 if absent) |
| POST | `/v1/rooms` | **create with placement** — body `{ type, roomId?, placement? }` → `201` `RoomInfo` |
| DELETE | `/v1/rooms/:roomId` | destroy (orchestrator resolves the owning instance) |
| GET | `/v1/events` | **Server-Sent Events** stream of fleet events for dashboards |

**Conditional requests:** `GET /v1/stats`, `/v1/instances`, and `/v1/rooms` return
`ETag: W/"<stateHash>"` and honor `If-None-Match` → `304`. The hash covers semantic state only
(instances, rooms, counts, statuses, capacities) — heartbeat bookkeeping (`lastSyncAt`) is
excluded, so a quiet fleet actually produces `304`s. The ETag is weak because two bodies with
equal hashes may still differ in `lastSyncAt`. Change-polling is therefore plain HTTP semantics.

**SSE (`/v1/events`):** a `: ping` comment frame is emitted every 15 s so idle proxies don't kill
the stream. No event replay — `Last-Event-ID` is not supported; a reconnecting consumer re-`GET`s
`/v1/stats` + `/v1/instances` to resync, then resumes the stream. For browser `EventSource`
(which cannot set headers), `?key=<adminKey>` is accepted **only when `sseQueryAuth: true`** —
see the [security caveat](#️-security).

### ✅ Safe retries on `POST /v1/rooms` — the day-one matchmaker contract

A `504 COMMAND_TIMEOUT` does **not** mean the room wasn't created — the agent may ack late and the
next snapshot will surface it. Make retries idempotent by **always passing a client-supplied
`roomId`**:

1. `POST /v1/rooms` with `{ type, roomId }`.
2. On `504` (or a network error), **retry the same request**.
3. The retry either **succeeds**, or returns **`409 ROOM_EXISTS`** — treat that as success and
   `GET /v1/rooms/:roomId` to fetch the `RoomInfo`.

The same `roomId` is reserved while a create is in flight, so two concurrent creates of one id can
never both land — exactly one wins, the rest get `409 ROOM_EXISTS`. Adopt this pattern from day
one; it is the documented contract, not a workaround.

### Error codes

Each code below is returned in the failure envelope's **`cause`** field (`{ status: 'rejected', cause }`).

| HTTP | `cause` | When |
|------|--------|------|
| 400 | `VALIDATION` | malformed body/params / `roomId` outside `^[A-Za-z0-9_-]{1,64}$` / both `instanceId` and `processUid` pins |
| 401 | `UNAUTHORIZED` | missing, unknown, or wrong-audience key — one uniform response for all three |
| 404 | `INSTANCE_NOT_FOUND`, `ROOM_NOT_FOUND` | unknown id |
| 409 | `NO_CANDIDATE` | no instance passes the placement filter |
| 409 | `ROOM_EXISTS` | explicit `roomId` already exists **or is reserved by an in-flight create** |
| 409 | `INSTANCE_DRAINING` | pinned placement to a draining instance without `force` |
| 413 | `PAYLOAD_TOO_LARGE` | request body over 64 KiB |
| 429 | `INSTANCE_BUSY` | per-instance in-flight command cap (32) reached |
| 429 | `AUTH_THROTTLED` | per-IP failed-auth limit exceeded |
| 429 | `SSE_LIMIT` | concurrent SSE stream cap (default 100) reached |
| 502 | `COMMAND_FAILED` | agent acked `ok: false` |
| 502 | `INSTANCE_DISCONNECTED` | agent dropped with the command in flight (immediate, no timeout wait) |
| 504 | `COMMAND_TIMEOUT` | no ack within `commandTimeoutMs` |

### Migrating from `@rivalis/registry`

| Legacy (`@rivalis/registry`) | New |
|---|---|
| `GET /api/stats` | `GET /v1/stats` |
| `GET /api/instances[...]` | `GET /v1/instances[...]` |
| `POST /api/instances/:id/rooms` | `POST /v1/rooms` with `placement.instanceId` |
| `DELETE /api/instances/:id/rooms/:roomId` | `DELETE /v1/rooms/:roomId` |
| raw token in `Authorization` | `Bearer` scheme, separate agent/admin keys |

`roomId` is now **fleet-unique** (legacy allowed the same id on different instances and returned an
array); `GET`/`DELETE /v1/rooms/:roomId` are unambiguous, and `DELETE` no longer needs the instance id.

## 🛡️ Security

> ⚠️ **Designed for private networks. TLS termination is OUT OF SCOPE.** Front the orchestrator
> with a reverse proxy or service mesh that terminates TLS. Bind to an internal interface with
> `host` / `--host` (e.g. `127.0.0.1` or a private NIC) where possible. The private-network
> assumption covers **transport**, not authentication — keys are still enforced.

- **Two keys, two audiences.** `agentKey` authenticates instances (each can only affect its own
  state); `adminKey` authenticates the REST API (full control). **Audience separation is enforced:**
  presenting an agent key to `/v1/*` is a plain `401`, never a downgraded read-only view. If the
  configured agent/admin key lists intersect, the orchestrator warns — and **refuses to start when
  `NODE_ENV=production`**.
- **Key strength enforced at startup** (production): keys shorter than 16 chars are refused,
  shorter than 32 are warned. The auto-generated dev key is 32 bytes from `crypto.randomBytes`.
- **Key rotation without downtime.** Both options accept `string | string[]` (env vars accept a
  comma-separated list). Procedure: **add the new key → roll agents/callers to it → remove the old
  key.** No simultaneous fleet-wide restart.
- **No secrets in URLs.** The agent key travels in the `Sec-WebSocket-Protocol` header
  (`ticketSource: 'protocol'`), never as a `?ticket=` query parameter. The `101` handshake echoes a
  fixed sentinel subprotocol (`rivalis-fleet.v1`), never the key.
- **`sseQueryAuth` caveat (off by default).** The lone exception to the no-secrets-in-URLs rule is
  the SSE `?key=` fallback for browser `EventSource`, which cannot set headers. It is an explicit
  operator opt-in (`sseQueryAuth: true` / `--sse-query-auth`). ⚠️ **Query strings land in
  proxy/access logs — prefer the `Authorization: Bearer` header form.** A short-lived derived-token
  endpoint is on the roadmap.
- **Agent data is authenticated, not trusted.** Snapshots are bounds-checked before they touch the
  read model (`endpointUrl` must be a `ws:`/`wss:`/`http:`/`https:` URL ≤ 512 chars; `name` ≤ 64;
  ≤ 32 labels; `roomTypes` ≤ 256). A failing snapshot is rejected with a logged warning and the
  read model keeps its last good state.
- **Uniform, throttled auth failures.** Every failure (missing / unknown / wrong-audience; REST, WS,
  or SSE) returns the identical `401 { status: 'rejected', cause: 'UNAUTHORIZED' }`. Failures are
  rate-limited per source IP (`429 AUTH_THROTTLED`) and logged with IP and route — **never the
  presented credential**. The failed-auth bucket map is bounded (fully-refilled buckets are pruned,
  with a hard cap), so it cannot grow without limit under spoofed-IP churn.
- **`trustProxy` (off by default).** The per-IP throttle and audit log key on `req.ip`. ⚠️ **Without
  `trustProxy`, that is the direct socket address — so behind a reverse proxy every client collapses
  into the one proxy IP: the throttle is per-proxy, not per-client (10 failed auths from anyone can
  `429` every dashboard/matchmaker), and audit lines all show the proxy.** When you front the
  orchestrator with a *trusted* TLS-terminating proxy/mesh, set `trustProxy: true` (`--trust-proxy` /
  `FLEET_TRUST_PROXY`) so Fastify resolves the real client IP from `X-Forwarded-For`. Leave it off for
  direct exposure — a spoofable header from an untrusted network must not be believed.
- **Keys never logged.** Logs identify *which* configured key authenticated by an 8-hex-char
  truncated-SHA-256 fingerprint (`key#a1b2c3d4`), so rotation stays observable without printing key
  material. The three mutating routes (`POST /v1/rooms`, `DELETE /v1/rooms/:id`, drain/undrain) are
  audit-logged: route, key fingerprint, source IP, outcome.

- **The orchestrator controls the conversation (protocol v3).** Every agent frame must be a reply to
  an outstanding request (a `fleet/poll` reqId, or a `fleet/cmd` cmdId). An unsolicited, duplicate, or
  unknown-topic frame is kicked — so a compromised agent key **cannot spam snapshots, flood acks, or
  push state on its own schedule**. Defenses are now protocol structure, not just rate limiting.

### Residual risk (stated honestly)

The agent key is **shared across instances**, so a compromised game node can still register phantom
instances, advertise fake capacity to skew placement, or accept-and-blackhole placements *when the
orchestrator asks it to*. It can no longer flood the orchestrator with unsolicited frames (those are
kicked, see above). On the private networks this is designed for, the remaining surface is an accepted
risk — documented rather than hidden. The snapshot field caps above limit its blast radius, and
**per-instance registration tokens** are on the roadmap for deployments that need the stronger story.

## 🧯 Failure modes & guarantees

| Scenario | Behavior |
|----------|----------|
| Orchestrator restarts | Agents reconnect with backoff; full state rebuilt within ~1 poll interval (the orchestrator polls each reconnected agent with `knownHash: null`). Room provenance survives (agents report `origin`); duplicate ids are tie-broken deterministically (earliest joiner keeps the canonical id). |
| Agent socket drops | Instance evicted instantly; its rooms vanish from the read model (they keep running on the node — this is discovery only). Rejoin restores them; `processUid` correlates the leave/join pair. |
| Agent drops with commands in flight | All pending commands rejected immediately with `502 INSTANCE_DISCONNECTED` — no waiting out `commandTimeoutMs`. |
| Agent wedged (connected, silent) | Missed poll replies accrue: marked `stale` at **2 missed polls** (excluded from placement), evicted at **3 missed polls** (≈ 2×/3× the poll interval). In-flight commands are rejected `INSTANCE_DISCONNECTED` on evict. |
| Agent sends an unsolicited / duplicate / unknown-topic frame | **Kicked and evicted** — every agent frame must answer an outstanding request (matched by correlation id); the kick log names the cause + instance, never the payload. It reconnects fresh. |
| Local room create/destroy | Surfaces in the read model at the **next poll** (bounded by the poll interval) — local changes no longer push. Orchestrator-initiated creates are read-your-write via the cmd ack. |
| Command lost / agent slow | Ack timeout → `504`; the next poll reconciles actual state. Retry safely with an explicit `roomId`. (A late ack arriving after the timeout matches no pending command → the agent is kicked and reconnects.) |
| Destroy races the room's natural end | Agent acks `ok: true, alreadyGone: true` — idempotent, no spurious `502`. |
| Snapshot approaches the 4 MiB transport frame limit | Agent logs a warning at 50% and an error at 90% — degradation is observable before the hard failure. |
| Two agents, same `name` | Allowed (names are labels, ids are identity) — logged with a warning since it usually signals a config copy-paste. |
| Hostile/buggy agent sends malformed/oversized snapshot fields | Snapshot rejected with a logged warning; read model keeps its last good state. |

**Consistency stance:** the read model is **eventually consistent with agent truth, bounded by one
poll interval**. Command acks give read-your-write on the happy path. This matches what matchmaking
needs; nothing here pretends to be a database.

## 🗺️ Roadmap

Post-v1, explicitly out of scope today: create-time room `options` passed through to `onCreate`;
per-room metadata passthrough for richer matchmaking queries; optional Prometheus `/metrics`;
short-lived derived tokens for SSE/dashboard auth (replacing the `?key=` caveat); per-instance
registration tokens (closing the shared-agent-key residual risk); chunked `fleet/state` for fleets
near the 4 MiB frame ceiling; `url: string | string[]` on `FleetAgent` for failover-by-DNS; and
orchestrator HA (v2) if a single node ever becomes the bottleneck.

## License

MIT
