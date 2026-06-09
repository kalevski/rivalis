import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import {
    createHttpApi,
    AuthThrottle,
    AUTH_FAILURE_LIMIT,
    AUTH_FAILURE_WINDOW_MS,
    MAX_SSE_STREAMS
} from '../lib/routers.js'
import {
    Orchestrator,
    validateSnapshot,
    selectSubprotocol,
    WS_SUBPROTOCOL,
    HEADERS_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS
} from '../lib/Orchestrator.js'
import { FleetState } from '../lib/FleetState.js'
import { FleetAgent } from '../lib/FleetAgent.js'
import {
    Topics,
    encodeFrame,
    syncPayloadSchema,
    MAX_ENDPOINT_URL_LENGTH,
    MAX_NAME_LENGTH,
    MAX_ROOM_TYPES,
    MAX_ROOMS,
    MAX_ROOM_ID_LENGTH,
    MAX_ROOM_TYPE_LENGTH,
    MAX_ROOM_CONNECTIONS
} from '../lib/wire.js'

// ws + core via the CJS entry for consistency. ws is a peer dep; the raw client
// lets us control the offered subprotocols, which is exactly what the §13
// fallback test needs to assert.
const require = createRequire(import.meta.url)
const { WebSocket } = require('ws') as typeof import('ws')
const core = require('@rivalis/core') as typeof import('@rivalis/core')
const { Rivalis, Room, AuthMiddleware } = core

/** A concrete game-server Room + an auth that is never invoked (no game clients connect). */
class GameRoom extends (Room as any) {}
class RejectAuth extends (AuthMiddleware as any) {
    async authenticate(): Promise<null> { return null }
}

/** A real in-process Rivalis game server with the given room types defined; no transport. */
function makeGameServer(defs: string[] = ['match']) {
    const rivalis = new Rivalis({ transports: [], authMiddleware: new RejectAuth() as any, rateLimiter: null } as any)
    for (const def of defs) {
        rivalis.rooms.define(def, GameRoom as any)
    }
    return rivalis
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A free ephemeral port (bind, read, release) for a real `listen()` (mirrors agent.test). */
async function freePort(): Promise<number> {
    const server = createNetServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return port
}

/** Recording logger: every level appends a flattened line so tests can assert on content. */
function makeLogger() {
    const lines: Array<{ level: string; msg: string }> = []
    const mk = (level: string) => (...args: unknown[]) => { lines.push({ level, msg: args.map(String).join(' ') }) }
    return {
        error: mk('error'), warning: mk('warning'), info: mk('info'),
        debug: mk('debug'), verbose: mk('verbose'), log: mk('log'), lines
    }
}

const NOOP = { error() {}, warning() {}, info() {}, debug() {}, verbose() {}, log() {} } as any

const room = (id: string, over: any = {}) => ({
    id, type: over.type ?? 'match', connections: over.connections ?? 0, origin: over.origin ?? 'fleet'
})

function syncPayload(over: any = {}): any {
    return {
        seq: over.seq ?? 1,
        hash: over.hash ?? 'h1',
        name: over.name ?? 'eu1',
        processUid: over.processUid ?? 'p1',
        agentVersion: over.agentVersion ?? '1.0.0',
        protocolVersion: over.protocolVersion ?? 1,
        endpointUrl: over.endpointUrl ?? 'wss://eu1.example.com',
        labels: over.labels ?? {},
        capacity: over.capacity ?? { maxConnections: null, maxRooms: null },
        autoCreate: over.autoCreate ?? true,
        roomTypes: over.roomTypes ?? ['match'],
        rooms: over.rooms ?? [],
        status: over.status ?? 'active'
    }
}

// Encode an agent→orch frame as the real agent does (§7, binary wire, task 005).
const bytes = (topic: string, obj: unknown) => encodeFrame(topic, obj)

/** A full fleet/state body (the agent populates every field on a full reply). */
function statePayload(over: any = {}): any {
    return { reqId: over.reqId ?? 'poll_1', full: over.full ?? true, ...syncPayload(over) }
}

function makeAgent(instanceId: string) {
    const sent: Array<{ topic: string; payload: any }> = []
    let closed = false
    return {
        link: { instanceId, send: (topic: string, payload: unknown) => sent.push({ topic, payload }), close: () => { closed = true } },
        sent,
        isClosed: () => closed,
        lastPoll: () => sent.filter((m) => m.topic === Topics.poll).pop()
    }
}

/** Virtual-time, timeouts-only scheduler so poll ticks fire deterministically. */
function makeClock() {
    let now = 0
    let id = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    return {
        now: () => now,
        scheduler: {
            setTimeout: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn }); return t },
            clearTimeout: (h: unknown) => { timers.delete(h as number) }
        },
        advance: (ms: number) => {
            const target = now + ms
            for (;;) {
                let next: { id: number; at: number; fn: () => void } | null = null
                for (const [tid, t] of timers) {
                    if (t.at <= target && (next === null || t.at < next.at)) { next = { id: tid, at: t.at, fn: t.fn } }
                }
                if (next === null) { break }
                now = next.at
                timers.delete(next.id)
                next.fn()
            }
            now = target
        }
    }
}

interface HarnessConfig {
    adminKeys?: string[]
    sseQueryAuth?: boolean
    ssePingMs?: number
    maxSseStreams?: number
    trustProxy?: boolean
}

/** HTTP harness over a real `node:http` server + a real FleetState, like httpapi.test. */
async function harness(config: HarnessConfig = {}, hooks: any = {}, logger: any = NOOP) {
    const state = new FleetState()
    const fleet = {
        get stats() { return state.stats },
        get instances() { return state.instances },
        get rooms() { return state.rooms },
        getInstance: (id: string) => state.getInstance(id),
        getRoom: (id: string) => state.getRoom(id),
        findRooms: (filter: any) => state.findRooms(filter ?? {}),
        createRoom: hooks.createRoom ?? (async () => ({ id: 'r', type: 'match', connections: 0, instanceId: 'i1', endpointUrl: 'wss://x', local: false })),
        destroyRoom: hooks.destroyRoom ?? (async () => {}),
        drainInstance: hooks.drainInstance ?? (async () => {}),
        undrainInstance: hooks.undrainInstance ?? (async () => {})
    }
    const api = createHttpApi({
        config: {
            api: true,
            adminKeys: config.adminKeys ?? ['admin-key'],
            cors: false,
            sseQueryAuth: config.sseQueryAuth ?? false,
            trustProxy: config.trustProxy ?? false
        },
        fleet: fleet as any,
        isReady: () => true,
        subscribe: () => () => {},
        getLogger: () => logger,
        ssePingMs: config.ssePingMs,
        maxSseStreams: config.maxSseStreams
    })
    await api.listen({ port: 0, host: '127.0.0.1' })
    const port = (api.fastify.server.address() as any).port as number
    return {
        state,
        base: `http://127.0.0.1:${port}`,
        close: async () => { await api.close() }
    }
}

// ===========================================================================
// Audience separation + uniform 401 (§13)
// ===========================================================================

test('audience separation: a non-admin (agent) key on /v1 is a uniform 401, identical across all causes', async () => {
    const h = await harness({ adminKeys: ['the-admin-key'] })
    try {
        const bodies: any[] = []
        // missing, wrong, and an "agent" key (a key valid for the OTHER audience).
        for (const headers of [undefined, { authorization: 'Bearer totally-wrong' }, { authorization: 'Bearer the-agent-key' }]) {
            const r = await fetch(`${h.base}/v1/stats`, headers ? { headers } : {})
            assert.equal(r.status, 401)
            bodies.push(await r.json())
        }
        assert.equal(bodies[0].cause, 'UNAUTHORIZED')
        assert.equal(bodies[0].status, 'rejected')
        // Nothing distinguishes missing / unknown / wrong-audience — one uniform body.
        assert.deepEqual(bodies[0], bodies[1])
        assert.deepEqual(bodies[1], bodies[2])
    } finally {
        await h.close()
    }
})

// ===========================================================================
// Per-IP failed-auth throttle → 429 AUTH_THROTTLED (§13)
// ===========================================================================

test('per-IP failed-auth throttle trips at the configured budget → AUTH_THROTTLED', async () => {
    const h = await harness({ adminKeys: ['the-admin-key'] })
    try {
        // The first AUTH_FAILURE_LIMIT failures are plain 401s.
        for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
            const r = await fetch(`${h.base}/v1/stats`, { headers: { authorization: 'Bearer wrong' } })
            assert.equal(r.status, 401, `failure ${i} → 401`)
            assert.equal((await r.json()).cause, 'UNAUTHORIZED')
        }
        // The next attempt trips the throttle.
        const tripped = await fetch(`${h.base}/v1/stats`, { headers: { authorization: 'Bearer wrong' } })
        assert.equal(tripped.status, 429)
        assert.equal((await tripped.json()).cause, 'AUTH_THROTTLED')

        // While blocked, even a VALID key is throttled — the bucket gates per IP.
        const stillBlocked = await fetch(`${h.base}/v1/stats`, { headers: { authorization: 'Bearer the-admin-key' } })
        assert.equal(stillBlocked.status, 429)
        assert.equal((await stillBlocked.json()).cause, 'AUTH_THROTTLED')
    } finally {
        await h.close()
    }
})

// ===========================================================================
// trustProxy (task 007, §13): the throttle + audit log key on req.ip, which is
// the forwarded client IP when trustProxy is on and the direct socket address
// (header ignored) when it is off.
// ===========================================================================

test('with trustProxy: true, the throttle and audit log key on the forwarded client IP', async () => {
    const logger = makeLogger()
    const adminKey = 'the-admin-key-0123456789'
    const h = await harness({ adminKeys: [adminKey], trustProxy: true }, { destroyRoom: async () => {} }, logger)
    try {
        // Burn the failed-auth budget for one forwarded client (9.9.9.9), then trip it.
        for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
            const r = await fetch(`${h.base}/v1/stats`, { headers: { 'x-forwarded-for': '9.9.9.9', authorization: 'Bearer wrong' } })
            assert.equal(r.status, 401, `9.9.9.9 failure ${i} → 401`)
        }
        const tripped = await fetch(`${h.base}/v1/stats`, { headers: { 'x-forwarded-for': '9.9.9.9', authorization: 'Bearer wrong' } })
        assert.equal(tripped.status, 429, '9.9.9.9 is now throttled')
        assert.equal((await tripped.json()).cause, 'AUTH_THROTTLED')

        // A DIFFERENT forwarded client is its own bucket — NOT collapsed with 9.9.9.9.
        const other = await fetch(`${h.base}/v1/stats`, { headers: { 'x-forwarded-for': '8.8.8.8', authorization: 'Bearer wrong' } })
        assert.equal(other.status, 401, 'a different forwarded IP is not throttled by 9.9.9.9 — per-client buckets')

        // The audit log attributes a mutating request to the forwarded client IP.
        const del = await fetch(`${h.base}/v1/rooms/room-1`, { method: 'DELETE', headers: { 'x-forwarded-for': '7.7.7.7', authorization: `Bearer ${adminKey}` } })
        assert.equal(del.status, 200)
        await delay(50)
        const audit = logger.lines.find((l) => l.msg.startsWith('audit') && l.msg.includes('DELETE'))
        assert.ok(audit, 'an audit line was emitted')
        assert.ok(audit!.msg.includes('ip=7.7.7.7'), `audit line keys on the forwarded client IP: ${audit!.msg}`)
    } finally {
        await h.close()
    }
})

test('with the default trustProxy: false, X-Forwarded-For is ignored — clients share the socket-IP bucket', async () => {
    const h = await harness({ adminKeys: ['the-admin-key'] }) // trustProxy defaults to false
    try {
        // Burn the budget while spoofing a forwarded IP — the header must be ignored,
        // so these all charge the single direct socket-address bucket (127.0.0.1).
        for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
            const r = await fetch(`${h.base}/v1/stats`, { headers: { 'x-forwarded-for': '1.1.1.1', authorization: 'Bearer wrong' } })
            assert.equal(r.status, 401, `failure ${i} → 401`)
        }
        // A request claiming a DIFFERENT forwarded IP is still throttled — the header
        // was not consulted, so it hit the same bucket. (Regression for the proxy DoS.)
        const spoofed = await fetch(`${h.base}/v1/stats`, { headers: { 'x-forwarded-for': '2.2.2.2', authorization: 'Bearer wrong' } })
        assert.equal(spoofed.status, 429, 'a forged X-Forwarded-For does not dodge the throttle when trustProxy is off')
        assert.equal((await spoofed.json()).cause, 'AUTH_THROTTLED')
    } finally {
        await h.close()
    }
})

// ===========================================================================
// AuthThrottle bucket-map bound (task 007, §13): the map does not grow
// monotonically — fully-refilled stale buckets are pruned and a hard cap evicts
// the oldest-touched bucket. Unit-tested against a fake clock for determinism.
// ===========================================================================

test('AuthThrottle prunes fully-refilled stale buckets so memory is not monotonic', () => {
    let now = 0
    const throttle = new AuthThrottle(AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS, () => now)

    // 500 distinct source IPs each record one failed auth → one bucket apiece.
    for (let i = 0; i < 500; i++) {
        throttle.recordFailure(`10.${(i >> 8) & 255}.${i & 255}.1`)
    }
    assert.equal(throttle.size, 500, 'one bucket per distinct source IP')

    // Advance well past the window: every bucket has fully refilled and carries no
    // information. The next refill (any IP) runs the once-per-window sweep.
    now += AUTH_FAILURE_WINDOW_MS * 2
    throttle.recordFailure('203.0.113.1')

    assert.equal(throttle.size, 1, 'fully-refilled stale buckets are pruned; only the freshly-touched one remains')
})

test('AuthThrottle caps total buckets (oldest-touched evicted) so memory is O(cap)', () => {
    let now = 0
    const cap = 3
    const throttle = new AuthThrottle(AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS, () => now, cap)

    // Many fresh IPs in quick succession (within one window, so the time-based sweep
    // cannot reclaim them) — the hard cap must still bound the map.
    for (let i = 0; i < 50; i++) {
        now += 1
        throttle.recordFailure(`198.51.100.${i}`)
    }
    assert.ok(throttle.size <= cap, `bucket count is bounded by the cap (${cap}), got ${throttle.size}`)
})

// ===========================================================================
// Concurrent SSE stream cap → 429 SSE_LIMIT (§13)
// ===========================================================================

test('the concurrent SSE stream cap defaults to 100 and the over-limit stream → SSE_LIMIT', async () => {
    assert.equal(MAX_SSE_STREAMS, 100, 'documented default cap (§13)')
    // Inject a small cap to exercise the 101st-style trip cheaply.
    const h = await harness({ maxSseStreams: 2, ssePingMs: 1000 })
    const acs: AbortController[] = []
    try {
        for (let i = 0; i < 2; i++) {
            const ac = new AbortController()
            acs.push(ac)
            const r = await fetch(`${h.base}/v1/events`, { headers: { authorization: 'Bearer admin-key' }, signal: ac.signal })
            assert.equal(r.status, 200, `stream ${i} opens`)
        }
        // The stream beyond the cap is refused with SSE_LIMIT.
        const over = await fetch(`${h.base}/v1/events`, { headers: { authorization: 'Bearer admin-key' } })
        assert.equal(over.status, 429)
        assert.equal((await over.json()).cause, 'SSE_LIMIT')
    } finally {
        for (const ac of acs) { ac.abort() }
        await h.close()
    }
})

// ===========================================================================
// Audit logging by fingerprint, never key material (§13)
// ===========================================================================

test('mutating routes are audit-logged by key fingerprint, never the key material', async () => {
    const logger = makeLogger()
    const adminKey = 'super-secret-admin-key-0123456789'
    const h = await harness({ adminKeys: [adminKey] }, { destroyRoom: async () => {} }, logger)
    try {
        const r = await fetch(`${h.base}/v1/rooms/room-1`, { method: 'DELETE', headers: { authorization: `Bearer ${adminKey}` } })
        assert.equal(r.status, 200)
        await delay(50) // the audit line is logged after dispatch resolves

        const audit = logger.lines.find((l) => l.msg.startsWith('audit') && l.msg.includes('DELETE'))
        assert.ok(audit, 'an audit line was emitted for the mutating route')
        const expectedFp = 'key#' + createHash('sha256').update(adminKey).digest('hex').slice(0, 8)
        assert.ok(audit!.msg.includes(expectedFp), 'audit line carries the key fingerprint')
        assert.ok(audit!.msg.includes('outcome=200'), 'audit line records the outcome')

        // No log line anywhere ever contains the raw key (§13 keys-never-logged).
        for (const line of logger.lines) {
            assert.ok(!line.msg.includes(adminKey), `log line leaks the key: ${line.msg}`)
        }
    } finally {
        await h.close()
    }
})

// ===========================================================================
// Snapshot field validation — authenticated ≠ trusted (§13)
// ===========================================================================

test('validateSnapshot enforces the §13 field caps (scheme, sizes, counts)', () => {
    assert.equal(validateSnapshot(syncPayload()), null, 'a clean snapshot passes')
    // Every allowed endpointUrl scheme passes; everything else is rejected.
    for (const url of ['ws://a', 'wss://a', 'http://a', 'https://a']) {
        assert.equal(validateSnapshot(syncPayload({ endpointUrl: url })), null, `${url} allowed`)
    }
    assert.ok(validateSnapshot(syncPayload({ endpointUrl: 'javascript:alert(1)' })), 'javascript: rejected')
    assert.ok(validateSnapshot(syncPayload({ endpointUrl: 'file:///etc/passwd' })), 'file: rejected')
    assert.ok(validateSnapshot(syncPayload({ endpointUrl: 'wss://' + 'a'.repeat(513) })), 'over 512 chars rejected')
    assert.ok(validateSnapshot(syncPayload({ name: 'n'.repeat(65) })), 'name over 64 rejected')

    const tooManyLabels: Record<string, string> = {}
    for (let i = 0; i < 33; i++) { tooManyLabels['k' + i] = 'v' }
    assert.ok(validateSnapshot(syncPayload({ labels: tooManyLabels })), 'over 32 labels rejected')
    assert.ok(validateSnapshot(syncPayload({ labels: { ['k'.repeat(65)]: 'v' } })), 'label key over 64 rejected')
    assert.ok(validateSnapshot(syncPayload({ labels: { k: 'v'.repeat(65) } })), 'label value over 64 rejected')

    const tooManyTypes = Array.from({ length: 257 }, (_, i) => 't' + i)
    assert.ok(validateSnapshot(syncPayload({ roomTypes: tooManyTypes })), 'over 256 roomTypes rejected')
    // A single over-long roomTypes entry is rejected (per-entry length, not just count).
    assert.ok(validateSnapshot(syncPayload({ roomTypes: ['t'.repeat(MAX_ROOM_TYPE_LENGTH + 1)] })), 'over-long roomTypes entry rejected')
})

test('validateSnapshot bounds the rooms[] array (count, id/type length, connections ceiling)', () => {
    // A large-but-sane snapshot still passes: 10k rooms with 64-char ids.
    const saneId = 'r'.repeat(MAX_ROOM_TYPE_LENGTH) // 64-char id
    const saneRooms = Array.from({ length: 10_000 }, (_, i) => room(saneId + '-' + i))
    assert.equal(validateSnapshot(syncPayload({ rooms: saneRooms })), null, '10k rooms with sane ids pass')

    // Over MAX_ROOMS entries → rejected.
    const tooManyRooms = Array.from({ length: MAX_ROOMS + 1 }, (_, i) => room('r' + i))
    assert.ok(validateSnapshot(syncPayload({ rooms: tooManyRooms })), 'over MAX_ROOMS rooms rejected')

    // An over-long room id (a single id can be megabytes; encodeRoomId expands it ~3×).
    assert.ok(validateSnapshot(syncPayload({ rooms: [room('x'.repeat(MAX_ROOM_ID_LENGTH + 1))] })), 'over-long room id rejected')

    // An over-long room type.
    assert.ok(validateSnapshot(syncPayload({ rooms: [room('r1', { type: 't'.repeat(MAX_ROOM_TYPE_LENGTH + 1) })] })), 'over-long room type rejected')

    // An absurd connections value (hostile ~4.29e9 inflates FleetStats + skews placement).
    assert.ok(validateSnapshot(syncPayload({ rooms: [room('r1', { connections: MAX_ROOM_CONNECTIONS + 1 })] })), 'over-ceiling connections rejected')
    assert.equal(validateSnapshot(syncPayload({ rooms: [room('r1', { connections: MAX_ROOM_CONNECTIONS })] })), null, 'connections at the ceiling passes')
})

test('a rooms[] rejection reason never echoes the agent-supplied id/type (§13)', () => {
    const idReason = validateSnapshot(syncPayload({ rooms: [room('SECRET-ROOM-ID'.repeat(40))] }))
    assert.ok(idReason, 'rejected')
    assert.ok(!(idReason as string).includes('SECRET-ROOM-ID'), 'room id content not echoed')

    const typeReason = validateSnapshot(syncPayload({ rooms: [room('r1', { type: 'SECRET-TYPE'.repeat(20) })] }))
    assert.ok(typeReason, 'rejected')
    assert.ok(!(typeReason as string).includes('SECRET-TYPE'), 'room type content not echoed')
})

test('the snapshot caps are sourced from the FieldSchema (single source of truth)', () => {
    // The schema next to SyncPayload expresses the §13 caps; the named constants it
    // references are exported so raising a cap cannot drift from the enforcing rule.
    assert.equal(syncPayloadSchema.endpointUrl?.max, MAX_ENDPOINT_URL_LENGTH)
    assert.equal(syncPayloadSchema.name?.max, MAX_NAME_LENGTH)
    assert.equal(syncPayloadSchema.roomTypes?.max, MAX_ROOM_TYPES)
    assert.equal(syncPayloadSchema.roomTypes?.items?.max, MAX_ROOM_TYPE_LENGTH)
    assert.equal(syncPayloadSchema.rooms?.max, MAX_ROOMS)
    assert.equal(MAX_ENDPOINT_URL_LENGTH, 512)
    assert.equal(MAX_NAME_LENGTH, 64)
    assert.equal(MAX_ROOM_TYPES, 256)
    assert.equal(MAX_ROOMS, 50_000)
    assert.equal(MAX_ROOM_ID_LENGTH, 256)
    assert.equal(MAX_ROOM_TYPE_LENGTH, 64)
    assert.equal(MAX_ROOM_CONNECTIONS, 1_000_000)
})

test('a snapshot rejection reason never echoes agent-supplied values (§13)', () => {
    // A hostile scheme must not be reflected back into the reason / log line.
    const schemeReason = validateSnapshot(syncPayload({ endpointUrl: 'javascript:alert(1)' }))
    assert.ok(schemeReason, 'rejected')
    assert.ok(!/javascript|alert/i.test(schemeReason as string), 'scheme/value not echoed')

    // An oversized name is rejected without quoting any of its characters.
    const nameReason = validateSnapshot(syncPayload({ name: 'SECRET'.repeat(20) }))
    assert.ok(nameReason, 'rejected')
    assert.ok(!(nameReason as string).includes('SECRET'), 'name content not echoed')

    // A non-string label value is rejected without quoting the value.
    const labelReason = validateSnapshot(syncPayload({ labels: { k: 'v'.repeat(65) } }))
    assert.ok(labelReason, 'rejected')
    assert.ok(!(labelReason as string).includes('v'.repeat(65)), 'label value not echoed')
})

test('a hostile/oversized snapshot is rejected and the read model keeps the last good state', () => {
    const logger = makeLogger()
    const clock = makeClock()
    const orch = new Orchestrator({ port: 0, agentKey: 'agent-key', api: false }, { logger, scheduler: clock.scheduler, now: clock.now })
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link)

    // Reply to the current outstanding poll with a full fleet/state (task 011).
    const reply = (over: any) => {
        const poll = agent.lastPoll()!.payload
        orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ ...over, reqId: poll.reqId, full: true })))
    }

    // A good baseline snapshot lands in the read model.
    reply({ seq: 1, hash: 'h1', rooms: [room('r1')] })
    assert.equal(orch.fleet.getInstance('i1').endpointUrl, 'wss://eu1.example.com')
    assert.equal(orch.fleet.getInstance('i1').rooms.length, 1)

    // A javascript: endpointUrl (would XSS a dashboard) is rejected — last good state holds.
    clock.advance(5000)
    reply({ seq: 2, hash: 'h2', endpointUrl: 'javascript:alert(1)', rooms: [room('r1'), room('r2')] })
    assert.equal(orch.fleet.getInstance('i1').endpointUrl, 'wss://eu1.example.com', 'bad endpointUrl not applied')
    assert.equal(orch.fleet.getInstance('i1').rooms.length, 1, 'bad snapshot did not add rooms')

    // Oversized name is likewise rejected.
    clock.advance(5000)
    reply({ seq: 3, hash: 'h3', name: 'n'.repeat(65) })
    assert.equal(orch.fleet.getInstance('i1').name, 'eu1', 'oversized name not applied')

    // An over-long room id (rooms[] bound, task 006) is rejected — last good state holds.
    clock.advance(5000)
    reply({ seq: 4, hash: 'h4', rooms: [room('x'.repeat(MAX_ROOM_ID_LENGTH + 1))] })
    assert.equal(orch.fleet.getInstance('i1').rooms.length, 1, 'over-long room id did not replace rooms')

    // More than MAX_ROOMS entries is rejected without bloating the read model.
    clock.advance(5000)
    reply({ seq: 5, hash: 'h5', rooms: Array.from({ length: MAX_ROOMS + 1 }, (_, i) => room('r' + i)) })
    assert.equal(orch.fleet.getInstance('i1').rooms.length, 1, 'over-MAX_ROOMS snapshot did not add rooms')

    // An absurd connections value (skews least-loaded placement) is rejected.
    clock.advance(5000)
    reply({ seq: 6, hash: 'h6', rooms: [room('r1', { connections: MAX_ROOM_CONNECTIONS + 1 })] })
    assert.equal(orch.fleet.getInstance('i1').rooms[0].connections, 0, 'over-ceiling connections not applied')

    // A subsequent good snapshot is applied normally — rejection is not sticky.
    clock.advance(5000)
    reply({ seq: 7, hash: 'h7', rooms: [room('r1'), room('r2')] })
    assert.equal(orch.fleet.getInstance('i1').rooms.length, 2, 'a later good snapshot recovers')

    // A rejected snapshot is dropped but the poll reply was still valid (no kick).
    assert.equal(agent.isClosed(), false, 'a validation rejection drops the snapshot, it does not kick the agent')
    assert.ok(logger.lines.some((l) => l.level === 'warning' && l.msg.includes('rejected snapshot')), 'rejection is logged')
})

// ===========================================================================
// Request/reply enforcement (task 011): every agent frame must be a reply to an
// outstanding orchestrator request. A spontaneous fleet/state, an ack for an
// unknown cmdId, a duplicate reply, and an unknown topic each kick + evict the
// agent — and the kick log never echoes payload contents (§7, §13).
// ===========================================================================

test('a spontaneous fleet/state (no matching poll) kicks + evicts the agent; the log carries no payload', () => {
    const logger = makeLogger()
    const orch = new Orchestrator({ port: 0, agentKey: 'agent-key', api: false }, { logger })
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link) // a poll is outstanding, but with a different reqId

    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({
        reqId: 'forged-reqid', full: true, seq: 1, hash: 'h', name: 'SECRET-PAYLOAD-MARKER'
    })))
    assert.equal(agent.isClosed(), true, 'a spontaneous fleet/state is kicked')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the offender is evicted')
    for (const line of logger.lines) {
        assert.ok(!line.msg.includes('SECRET-PAYLOAD-MARKER'), `kick log leaks payload: ${line.msg}`)
        assert.ok(!line.msg.includes('forged-reqid'), `kick log leaks the correlation id: ${line.msg}`)
    }
})

test('an ack for an unknown cmdId kicks + evicts the agent; the log carries no payload', () => {
    const logger = makeLogger()
    const orch = new Orchestrator({ port: 0, agentKey: 'agent-key', api: false }, { logger })
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link)

    orch.handleAgentMessage('i1', Topics.ack, bytes(Topics.ack, { cmdId: 'SECRET-CMD-MARKER', ok: true }))
    assert.equal(agent.isClosed(), true, 'an unknown-cmdId ack is kicked')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the offender is evicted')
    for (const line of logger.lines) {
        assert.ok(!line.msg.includes('SECRET-CMD-MARKER'), `kick log leaks the ack payload: ${line.msg}`)
    }
})

test('a duplicate fleet/state reply (reqId already consumed) kicks + evicts the agent', () => {
    const logger = makeLogger()
    const orch = new Orchestrator({ port: 0, agentKey: 'agent-key', api: false }, { logger })
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link)
    const reqId = agent.lastPoll()!.payload.reqId

    // First reply consumes the outstanding poll — accepted.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId, full: true, seq: 1, hash: 'h1', rooms: [room('r1')] })))
    assert.equal(agent.isClosed(), false, 'the first matching reply is accepted')
    // The duplicate matches no outstanding poll — kicked.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId, full: true, seq: 2, hash: 'h2' })))
    assert.equal(agent.isClosed(), true, 'a duplicate reply is kicked')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the offender is evicted')
})

test('an unexpected topic on the control plane kicks + evicts the agent', () => {
    const orch = new Orchestrator({ port: 0, agentKey: 'agent-key', api: false })
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link)
    // A topic the room never binds reaches the orchestrator's defensive default.
    // (Real agents are kicked earlier by FleetRoom's unknownTopicPolicy = 'kick'.)
    orch.handleAgentMessage('i1', 'fleet/bogus', new Uint8Array([3, 0]))
    assert.equal(agent.isClosed(), true, 'an unexpected topic is kicked')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the offender is evicted')
})

// ===========================================================================
// Production refuse-to-start (§13)
// ===========================================================================

test('production refuses to start with a key shorter than 16 characters', () => {
    assert.throws(
        () => new Orchestrator({ port: 0, agentKey: 'short', api: false }, { env: 'production' }),
        /shorter than 16/
    )
})

test('production refuses to start when agentKey and adminKey lists intersect', () => {
    const shared = 'a-strong-shared-key-0123456789' // ≥ 16 chars, so strength is not the trigger
    assert.throws(
        () => new Orchestrator({ port: 0, agentKey: shared, adminKey: shared, api: true }, { env: 'production' }),
        /intersect/
    )
})

test('outside production, weak or intersecting keys warn instead of refusing to start', () => {
    const logger = makeLogger()
    assert.doesNotThrow(() =>
        new Orchestrator({ port: 0, agentKey: 'dev', adminKey: 'dev', api: true }, { env: 'development', logger }))
    assert.ok(logger.lines.some((l) => l.level === 'warning' && l.msg.includes('intersect')), 'intersection warned in dev')
})

// ===========================================================================
// Slowloris caps (§13): the shared node:http server carries explicit
// headersTimeout / requestTimeout — a hand-rolled router is not exempt, and the
// Fastify same-port recipe sets them on the server the serverFactory creates.
// ===========================================================================

test('the shared http server sets explicit headersTimeout/requestTimeout (slowloris caps)', () => {
    // The serverFactory runs at construction, so the timeouts are set before listen().
    const orch = new Orchestrator({ port: 0, agentKey: 'agent-key', adminKey: 'admin-key', api: true })
    const server = (orch as unknown as { httpServer: { headersTimeout: number; requestTimeout: number } | null }).httpServer
    assert.ok(server !== null, 'the shared http server is created by the Fastify serverFactory')
    assert.equal(server!.headersTimeout, HEADERS_TIMEOUT_MS, 'headersTimeout is set explicitly (§13)')
    assert.equal(server!.requestTimeout, REQUEST_TIMEOUT_MS, 'requestTimeout is set explicitly (§13)')
})

// ===========================================================================
// WS handshake: 101 echoes the sentinel, not the ticket; admin key rejected (§13)
// ===========================================================================

test('selectSubprotocol prefers the sentinel and never returns the ticket when the sentinel is offered', () => {
    // Agent key offered first (the ticket WSTransport extracts), sentinel second.
    assert.equal(selectSubprotocol(new Set(['the-agent-key', WS_SUBPROTOCOL])), WS_SUBPROTOCOL)
    assert.equal(selectSubprotocol(new Set([WS_SUBPROTOCOL])), WS_SUBPROTOCOL)
    // A legacy single-key client (no sentinel) still negotiates so the handshake holds.
    assert.equal(selectSubprotocol(new Set(['only-the-key'])), 'only-the-key')
    assert.equal(selectSubprotocol(new Set()), false)
})

test('a real FleetAgent (default transport) negotiates the sentinel; the 101 never carries the agent key', async () => {
    // The load-bearing assertion (task 001): exercise the ACTUAL agent client path —
    // a FleetAgent with the default `createClient` — not a hand-built ws client. The
    // real agent offers `[agentKey, WS_SUBPROTOCOL]` (ticket first, sentinel appended
    // by core's WSClient `subprotocols` option), so the orchestrator selects the
    // sentinel and the agent key never round-trips into the 101 response headers (§13).
    const agentKey = 'agent-key-strong-0123456789'
    const adminKey = 'admin-key-strong-0123456789'
    const port = await freePort()
    const orch = new Orchestrator({ host: '127.0.0.1', port, agentKey, adminKey, api: true })
    await orch.listen()
    const server = makeGameServer(['match'])
    const agent = new FleetAgent(
        server as any,
        { url: `ws://127.0.0.1:${port}`, key: agentKey, endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' } as any,
        { backoff: { baseMs: 30, capMs: 150 } } as any
    )
    // §8: never throw into the host — sink the re-emitted transport 'error' events.
    ;(agent as unknown as { on(e: string, fn: () => void): void }).on('error', () => {})
    try {
        await agent.connect()
        // The default WSClient's underlying ws socket: its negotiated `.protocol` IS
        // the value the server put in the 101 `Sec-WebSocket-Protocol` header.
        const ws = (agent as unknown as { client: { ws: { protocol: string } } }).client.ws
        assert.equal(ws.protocol, WS_SUBPROTOCOL, 'real agent negotiates the sentinel (§13)')
        assert.notEqual(ws.protocol, agentKey, 'the 101 never echoes the agent key')
    } finally {
        await agent.disconnect()
        await orch.shutdown()
    }
})

test('fallback echo of a non-sentinel subprotocol logs a §13 warning, never the credential value', async () => {
    // A legacy client that offers ONLY the ticket (no sentinel) forces the fallback:
    // RFC 6455 lets the server pick only an offered subprotocol, so to complete the
    // handshake it must echo the key. That is the §13 leak — assert it is logged
    // (naming the sentinel + §13) and that the credential value is never in the line.
    const agentKey = 'agent-key-strong-0123456789'
    const logger = makeLogger()
    const port = await freePort()
    const orch = new Orchestrator({ host: '127.0.0.1', port, agentKey, api: false }, { logger })
    await orch.listen()
    try {
        const legacy = new WebSocket(`ws://127.0.0.1:${port}`, agentKey)
        await new Promise<void>((resolve, reject) => {
            legacy.on('open', () => resolve())
            legacy.on('error', reject)
            setTimeout(() => reject(new Error('legacy client never opened')), 3000)
        })
        assert.equal(legacy.protocol, agentKey, 'fallback echoes the ticket for a sentinel-less client (legacy compat)')
        legacy.close()
        const warn = logger.lines.find(
            (l) => l.level === 'warning' && l.msg.includes('§13') && l.msg.includes(WS_SUBPROTOCOL)
        )
        assert.ok(warn !== undefined, 'a §13 fallback warning is logged when the ticket is echoed')
        assert.ok(!warn!.msg.includes(agentKey), 'the warning never logs the credential value')
    } finally {
        await orch.shutdown()
    }
})

test('an admin key presented as a WS ticket is rejected (audience separation)', async () => {
    const agentKey = 'agent-key-strong-0123456789'
    const adminKey = 'admin-key-strong-0123456789'
    const port = await freePort()
    const orch = new Orchestrator({ host: '127.0.0.1', port, agentKey, adminKey, api: true })
    await orch.listen()
    try {
        // Admin key presented as a WS ticket → closed with INVALID_TICKET (4001),
        // never joins. Hand-built here because only a raw client can present the
        // admin key as the ticket (a real FleetAgent always carries the agent key).
        const badClient = new WebSocket(`ws://127.0.0.1:${port}`, [adminKey, WS_SUBPROTOCOL])
        let badJoined = false
        badClient.on('message', () => { badJoined = true })
        const closeCode = await new Promise<number>((resolve, reject) => {
            badClient.on('close', (code) => resolve(code))
            badClient.on('error', () => { /* surfaced as close */ })
            setTimeout(() => reject(new Error('admin-key WS client never closed')), 3000)
        })
        assert.equal(closeCode, 4001, 'admin key as a WS ticket → INVALID_TICKET close')
        assert.equal(badJoined, false, 'a rejected connection never joins / receives frames')
    } finally {
        await orch.shutdown()
    }
})
