import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHttpApi, MAX_BODY_BYTES, SSE_PING_MS } from '../lib/routers.js'
import { FleetState, FleetError } from '../lib/FleetState.js'

// ---------------------------------------------------------------------------
// The routers are a pure function of their HttpApiDeps seams (§15), so these tests
// boot the Fastify app on an ephemeral port — no core, no WebSocket. Read methods
// are backed by a real FleetState (so ETag/304 and id resolution are exercised for
// real); control methods are programmable stubs (so every §10 error-code is
// drivable). `fetch` makes the requests.
//
// Envelope (task 006): responses are `@toolcase/base` `HTTP.RESTResponse` /
// `HTTP.RESTError` — `{ status: 'OK', data? }` on success, `{ status: 'rejected',
// cause: <FleetErrorCode> }` on failure (the stable §10 code travels in `cause`).
// ---------------------------------------------------------------------------

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

interface Hooks {
    createRoom?: (req: any) => Promise<any>
    destroyRoom?: (id: string) => Promise<void>
    drainInstance?: (id: string) => Promise<void>
    undrainInstance?: (id: string) => Promise<void>
}

interface HarnessConfig {
    api?: boolean
    adminKeys?: string[]
    cors?: false | { origins: string[] }
    sseQueryAuth?: boolean
    trustProxy?: boolean
    ready?: boolean
    ssePingMs?: number
}

async function harness(config: HarnessConfig = {}, hooks: Hooks = {}) {
    const state = new FleetState()
    const listeners = new Set<(e: any) => void>()
    const fleet = {
        get stats() { return state.stats },
        get instances() { return state.instances },
        get rooms() { return state.rooms },
        getInstance: (id: string) => state.getInstance(id),
        getRoom: (id: string) => state.getRoom(id),
        findRooms: (filter: any) => state.findRooms(filter ?? {}),
        createRoom: hooks.createRoom ?? (async () => { throw new Error('createRoom not stubbed') }),
        destroyRoom: hooks.destroyRoom ?? (async () => {}),
        drainInstance: hooks.drainInstance ?? (async () => {}),
        undrainInstance: hooks.undrainInstance ?? (async () => {})
    }
    let ready = config.ready ?? true
    const api = createHttpApi({
        config: {
            api: config.api ?? true,
            adminKeys: config.adminKeys ?? ['admin-key'],
            cors: config.cors ?? false,
            sseQueryAuth: config.sseQueryAuth ?? false,
            trustProxy: config.trustProxy ?? false
        },
        fleet: fleet as any,
        isReady: () => ready,
        subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
        getLogger: () => NOOP,
        ssePingMs: config.ssePingMs
    })
    await api.listen({ port: 0, host: '127.0.0.1' })
    const port = (api.fastify.server.address() as any).port as number
    return {
        state,
        fleet,
        base: `http://127.0.0.1:${port}`,
        fire: (type: string, data: unknown) => { for (const l of listeners) l({ type, data }) },
        setReady: (v: boolean) => { ready = v },
        close: async () => { await api.close() }
    }
}

const ADMIN = { authorization: 'Bearer admin-key' }

// ---------------------------------------------------------------------------
// Health probes (§10) — unauthenticated; /readyz reflects transport readiness.
// ---------------------------------------------------------------------------

test('/healthz and /readyz are unauthenticated; /readyz is false until ready', async () => {
    const h = await harness({ ready: false })
    try {
        let r = await fetch(`${h.base}/healthz`)
        assert.equal(r.status, 200)
        assert.deepEqual(await r.json(), { status: 'OK' })

        r = await fetch(`${h.base}/readyz`)
        assert.equal(r.status, 503)
        assert.equal((await r.json()).cause, 'NOT_READY')

        h.setReady(true)
        r = await fetch(`${h.base}/readyz`)
        assert.equal(r.status, 200)
    } finally {
        await h.close()
    }
})

test('health probes are served even when the REST API is disabled', async () => {
    const h = await harness({ api: false })
    try {
        assert.equal((await fetch(`${h.base}/healthz`)).status, 200)
        assert.equal((await fetch(`${h.base}/readyz`)).status, 200)
        // /v1 is gone when api:false.
        const r = await fetch(`${h.base}/v1/stats`, { headers: ADMIN })
        assert.equal(r.status, 404)
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Auth — Bearer admin key on every /v1 route; uniform 401 (§10/§13).
// ---------------------------------------------------------------------------

test('/v1 routes require the admin bearer key; missing or wrong → 401 UNAUTHORIZED', async () => {
    const h = await harness()
    try {
        let r = await fetch(`${h.base}/v1/stats`)
        assert.equal(r.status, 401)
        const body = await r.json() as any
        assert.equal(body.status, 'rejected')
        assert.equal(body.cause, 'UNAUTHORIZED')

        r = await fetch(`${h.base}/v1/stats`, { headers: { authorization: 'Bearer wrong' } })
        assert.equal(r.status, 401)
        assert.equal((await r.json()).cause, 'UNAUTHORIZED')

        r = await fetch(`${h.base}/v1/stats`, { headers: ADMIN })
        assert.equal(r.status, 200)
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Read routes respond with the OK envelope; 404s carry the right code (§10).
// ---------------------------------------------------------------------------

test('read routes return the RESTResponse envelope and the §10 404 codes', async () => {
    const h = await harness()
    h.state.applySnapshot('i1', syncPayload({ rooms: [room('r1', { connections: 3 }), room('r2')] }), 1000)
    try {
        const get = async (p: string) => {
            const r = await fetch(`${h.base}${p}`, { headers: ADMIN })
            return { status: r.status, body: await r.json() as any }
        }

        let res = await get('/v1/stats')
        assert.equal(res.status, 200)
        assert.equal(res.body.status, 'OK')
        assert.equal(res.body.data.instances, 1)
        assert.equal(res.body.data.rooms, 2)
        assert.equal(res.body.data.connections, 3)
        assert.ok(typeof res.body.data.stateHash === 'string')

        res = await get('/v1/instances')
        assert.equal(res.status, 200)
        assert.equal(res.body.data.length, 1)
        assert.equal(res.body.data[0].id, 'i1')

        res = await get('/v1/instances/i1')
        assert.equal(res.status, 200)
        assert.equal(res.body.data.id, 'i1')

        res = await get('/v1/instances/nope')
        assert.equal(res.status, 404)
        assert.equal(res.body.cause, 'INSTANCE_NOT_FOUND')

        res = await get('/v1/instances/i1/rooms')
        assert.equal(res.status, 200)
        assert.equal(res.body.data.length, 2)

        res = await get('/v1/instances/nope/rooms')
        assert.equal(res.status, 404)
        assert.equal(res.body.cause, 'INSTANCE_NOT_FOUND')

        res = await get('/v1/rooms')
        assert.equal(res.status, 200)
        assert.equal(res.body.data.length, 2)

        res = await get('/v1/rooms/r1')
        assert.equal(res.status, 200)
        assert.equal(res.body.data.id, 'r1')
        assert.equal(res.body.data.connections, 3)

        res = await get('/v1/rooms/nope')
        assert.equal(res.status, 404)
        assert.equal(res.body.cause, 'ROOM_NOT_FOUND')
    } finally {
        await h.close()
    }
})

test('GET /v1/rooms honors type / instanceId / repeatable label filters (findRooms parity)', async () => {
    const h = await harness()
    h.state.applySnapshot('i1', syncPayload({
        labels: { region: 'eu', tier: 'premium' },
        roomTypes: ['match', 'lobby'],
        rooms: [room('m1', { type: 'match' }), room('l1', { type: 'lobby' })]
    }), 1000)
    h.state.applySnapshot('i2', syncPayload({
        processUid: 'p2', labels: { region: 'us' }, rooms: [room('m2', { type: 'match' })]
    }), 1000)
    try {
        const get = async (p: string) => (await (await fetch(`${h.base}${p}`, { headers: ADMIN })).json() as any).data

        assert.equal((await get('/v1/rooms?type=match')).length, 2)
        assert.equal((await get('/v1/rooms?type=lobby')).length, 1)
        assert.equal((await get('/v1/rooms?instanceId=i1')).length, 2)
        // Repeatable label, all must match.
        assert.equal((await get('/v1/rooms?label=region:eu')).length, 2)
        assert.equal((await get('/v1/rooms?label=region:eu&label=tier:premium')).length, 2)
        assert.equal((await get('/v1/rooms?label=region:eu&label=tier:none')).length, 0)
        assert.equal((await get('/v1/rooms?label=region:us')).length, 1)
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Control routes: create (201), destroy, drain/undrain delegate to the fleet API.
// ---------------------------------------------------------------------------

test('POST /v1/rooms returns 201 RoomInfo; DELETE and drain/undrain delegate', async () => {
    const created: any[] = []
    const destroyed: string[] = []
    const drained: string[] = []
    const undrained: string[] = []
    const h = await harness({}, {
        createRoom: async (req) => {
            created.push(req)
            return { id: req.roomId ?? 'r_gen', type: req.type, connections: 0, instanceId: 'i1', endpointUrl: 'wss://eu1', local: false }
        },
        destroyRoom: async (id) => { destroyed.push(id) },
        drainInstance: async (id) => { drained.push(id) },
        undrainInstance: async (id) => { undrained.push(id) }
    })
    try {
        let r = await fetch(`${h.base}/v1/rooms`, {
            method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'match', roomId: 'match-1', placement: { strategy: 'least-loaded' } })
        })
        assert.equal(r.status, 201)
        const body = await r.json() as any
        assert.equal(body.status, 'OK')
        assert.equal(body.data.id, 'match-1')
        assert.deepEqual(created[0], { type: 'match', roomId: 'match-1', placement: { strategy: 'least-loaded' } })

        r = await fetch(`${h.base}/v1/rooms/match-1`, { method: 'DELETE', headers: ADMIN })
        assert.equal(r.status, 200)
        assert.deepEqual(destroyed, ['match-1'])

        r = await fetch(`${h.base}/v1/instances/i1/drain`, { method: 'POST', headers: ADMIN })
        assert.equal(r.status, 200)
        r = await fetch(`${h.base}/v1/instances/i1/undrain`, { method: 'POST', headers: ADMIN })
        assert.equal(r.status, 200)
        assert.deepEqual(drained, ['i1'])
        assert.deepEqual(undrained, ['i1'])
    } finally {
        await h.close()
    }
})

test('POST /v1/rooms with a missing/invalid type → 400 VALIDATION before any placement', async () => {
    let called = false
    const h = await harness({}, { createRoom: async () => { called = true; return {} } })
    try {
        const r = await fetch(`${h.base}/v1/rooms`, {
            method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: 'x' })
        })
        assert.equal(r.status, 400)
        assert.equal((await r.json()).cause, 'VALIDATION')
        assert.equal(called, false, 'createRoom is never reached on a validation failure')

        const bad = await fetch(`${h.base}/v1/rooms`, {
            method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: '{not json'
        })
        assert.equal(bad.status, 400)
        assert.equal((await bad.json()).cause, 'VALIDATION')
    } finally {
        await h.close()
    }
})

test('POST /v1/rooms with an explicit roomId outside the §11 charset → 400 VALIDATION before createRoom', async () => {
    // The derived JSON Schema carries ROOM_ID_PATTERN, so a hostile id is rejected
    // declaratively at the route — createRoom is never reached.
    let called = false
    const h = await harness({}, { createRoom: async () => { called = true; return {} } })
    try {
        for (const roomId of ['has space', 'has/slash', 'has~tilde', 'a'.repeat(65)]) {
            const r = await fetch(`${h.base}/v1/rooms`, {
                method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'match', roomId })
            })
            assert.equal(r.status, 400, `roomId ${JSON.stringify(roomId)} → 400`)
            assert.equal((await r.json()).cause, 'VALIDATION')
        }
        assert.equal(called, false, 'a charset violation never reaches createRoom')
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Acceptance: every §10 error code maps to its HTTP status verbatim.
// ---------------------------------------------------------------------------

test('control errors map to the §10 HTTP statuses verbatim', async () => {
    const cases: Array<[string, number]> = [
        ['NO_CANDIDATE', 409],
        ['ROOM_EXISTS', 409],
        ['INSTANCE_DRAINING', 409],
        ['INSTANCE_NOT_FOUND', 404],
        ['INSTANCE_BUSY', 429],
        ['COMMAND_FAILED', 502],
        ['INSTANCE_DISCONNECTED', 502],
        ['COMMAND_TIMEOUT', 504],
        ['VALIDATION', 400]
    ]
    for (const [code, status] of cases) {
        const h = await harness({}, { createRoom: async () => { throw new FleetError(code as any, `boom ${code}`) } })
        try {
            const r = await fetch(`${h.base}/v1/rooms`, {
                method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'match' })
            })
            assert.equal(r.status, status, `${code} → HTTP ${status}`)
            const body = await r.json() as any
            assert.equal(body.status, 'rejected')
            assert.equal(body.cause, code)
        } finally {
            await h.close()
        }
    }
})

// ---------------------------------------------------------------------------
// Acceptance: the documented safe-retry contract — a retry with an explicit
// roomId after a 504 is idempotent (success, or 409 ROOM_EXISTS).
// ---------------------------------------------------------------------------

test('POST /v1/rooms retry with an explicit roomId after a 504 is idempotent', async () => {
    let attempt = 0
    const h = await harness({}, {
        createRoom: async (req) => {
            attempt++
            if (attempt === 1) {
                throw new FleetError('COMMAND_TIMEOUT', 'no ack')          // first attempt times out
            }
            throw new FleetError('ROOM_EXISTS', 'already created by the late ack') // retry: id now exists
        }
    })
    try {
        const post = () => fetch(`${h.base}/v1/rooms`, {
            method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'match', roomId: 'match-42' })
        })
        const first = await post()
        assert.equal(first.status, 504)
        assert.equal((await first.json()).cause, 'COMMAND_TIMEOUT')

        const retry = await post()
        assert.equal(retry.status, 409, 'retry surfaces ROOM_EXISTS — treat as success per the §10 contract')
        assert.equal((await retry.json()).cause, 'ROOM_EXISTS')
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Acceptance: conditional requests — weak ETag + If-None-Match → 304; a
// heartbeat (touch) alone never invalidates the ETag (§6/§10).
// ---------------------------------------------------------------------------

test('GET stats/instances/rooms expose a weak ETag and answer 304 to If-None-Match', async () => {
    const h = await harness()
    h.state.applySnapshot('i1', syncPayload({ rooms: [room('r1')] }), 1000)
    try {
        for (const path of ['/v1/stats', '/v1/instances', '/v1/rooms']) {
            const first = await fetch(`${h.base}${path}`, { headers: ADMIN })
            assert.equal(first.status, 200)
            const etag = first.headers.get('etag')
            assert.ok(etag && etag.startsWith('W/"'), `${path} returns a weak ETag`)
            await first.body?.cancel()

            const second = await fetch(`${h.base}${path}`, { headers: { ...ADMIN, 'if-none-match': etag as string } })
            assert.equal(second.status, 304, `${path} → 304 on a matching If-None-Match`)
            await second.body?.cancel()
        }
    } finally {
        await h.close()
    }
})

test('a heartbeat (touch) does not change the ETag; a semantic change does', async () => {
    const h = await harness()
    h.state.applySnapshot('i1', syncPayload({ seq: 1, hash: 'h1', rooms: [room('r1')] }), 1000)
    try {
        const etag = (await fetch(`${h.base}/v1/instances`, { headers: ADMIN })).headers.get('etag') as string

        // A ping-style touch only bumps lastSyncAt — excluded from the semantic hash.
        h.state.touch('i1', 99999)
        let r = await fetch(`${h.base}/v1/instances`, { headers: { ...ADMIN, 'if-none-match': etag } })
        assert.equal(r.status, 304, 'a heartbeat alone never invalidates the ETag')
        await r.body?.cancel()

        // A real state change (new room) flips the hash → full 200.
        h.state.applySnapshot('i1', syncPayload({ seq: 2, hash: 'h2', rooms: [room('r1'), room('r2')] }), 1000)
        r = await fetch(`${h.base}/v1/instances`, { headers: { ...ADMIN, 'if-none-match': etag } })
        assert.equal(r.status, 200, 'a semantic change invalidates the ETag')
        assert.notEqual(r.headers.get('etag'), etag)
        await r.body?.cancel()
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Acceptance: a body over 64 KiB → 413 PAYLOAD_TOO_LARGE without parsing.
// ---------------------------------------------------------------------------

test('a request body over 64 KiB → 413 PAYLOAD_TOO_LARGE before any JSON.parse', async () => {
    let called = false
    const h = await harness({}, { createRoom: async () => { called = true; return {} } })
    try {
        const r = await fetch(`${h.base}/v1/rooms`, {
            method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: 'a'.repeat(MAX_BODY_BYTES + 1)
        })
        assert.equal(r.status, 413)
        assert.equal((await r.json()).cause, 'PAYLOAD_TOO_LARGE')
        assert.equal(called, false, 'the oversized body never reached createRoom / JSON.parse')
    } finally {
        await h.close()
    }
})

// ---------------------------------------------------------------------------
// Acceptance: SSE delivers events + 15 s ping frames; ?key= gated by sseQueryAuth.
// ---------------------------------------------------------------------------

function collect(resp: Response) {
    const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    const ref = { buf: '' }
    ;(async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) { break }
                ref.buf += dec.decode(value, { stream: true })
            }
        } catch { /* aborted */ }
    })()
    return ref
}

async function waitFor(ref: { buf: string }, pred: (s: string) => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!pred(ref.buf)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`timeout waiting for SSE content; got: ${JSON.stringify(ref.buf)}`)
        }
        await new Promise((r) => setTimeout(r, 10))
    }
}

test('SSE streams fleet events and emits a keep-alive ping; default cadence is 15 s', async () => {
    assert.equal(SSE_PING_MS, 15000, 'documented default ping cadence (§10)')
    const h = await harness({ ssePingMs: 40 })
    const ac = new AbortController()
    try {
        const resp = await fetch(`${h.base}/v1/events`, { headers: ADMIN, signal: ac.signal })
        assert.equal(resp.status, 200)
        assert.match(resp.headers.get('content-type') ?? '', /text\/event-stream/)
        const ref = collect(resp)

        h.fire('instance:join', { id: 'i1', name: 'eu1' })
        await waitFor(ref, (s) => s.includes('event: instance:join') && s.includes('"id":"i1"'))

        h.fire('room:create', { id: 'r1', type: 'match' })
        await waitFor(ref, (s) => s.includes('event: room:create') && s.includes('"id":"r1"'))

        // Keep-alive comment frame (injected cadence = 40 ms).
        await waitFor(ref, (s) => s.includes(': ping'))
    } finally {
        ac.abort()
        await h.close()
    }
})

test('SSE ?key= auth is rejected unless sseQueryAuth is enabled', async () => {
    // Off (default): query key rejected with the uniform 401.
    const off = await harness({ sseQueryAuth: false })
    try {
        const r = await fetch(`${off.base}/v1/events?key=admin-key`)
        assert.equal(r.status, 401)
        assert.equal((await r.json()).cause, 'UNAUTHORIZED')
    } finally {
        await off.close()
    }

    // On: a correct query key opens the stream; a wrong one is still 401.
    const on = await harness({ sseQueryAuth: true, ssePingMs: 1000 })
    const ac = new AbortController()
    try {
        const wrong = await fetch(`${on.base}/v1/events?key=nope`)
        assert.equal(wrong.status, 401)

        const ok = await fetch(`${on.base}/v1/events?key=admin-key`, { signal: ac.signal })
        assert.equal(ok.status, 200)
        assert.match(ok.headers.get('content-type') ?? '', /text\/event-stream/)
    } finally {
        ac.abort()
        await on.close()
    }
})

// ---------------------------------------------------------------------------
// CORS (§10) — off by default; an allowed origin is echoed onto /v1 + preflight.
// (@fastify/cors handles a real preflight, which always carries
// Access-Control-Request-Method — supplied here as a browser would.)
// ---------------------------------------------------------------------------

test('CORS is off by default and echoes an allowed origin when configured', async () => {
    const off = await harness()
    try {
        const r = await fetch(`${off.base}/v1/stats`, { headers: { ...ADMIN, origin: 'https://dash.example.com' } })
        assert.equal(r.headers.get('access-control-allow-origin'), null, 'no CORS header by default')
        await r.body?.cancel()
    } finally {
        await off.close()
    }

    const on = await harness({ cors: { origins: ['https://dash.example.com'] } })
    try {
        const r = await fetch(`${on.base}/v1/stats`, { headers: { ...ADMIN, origin: 'https://dash.example.com' } })
        assert.equal(r.headers.get('access-control-allow-origin'), 'https://dash.example.com')
        await r.body?.cancel()

        // Preflight.
        const pre = await fetch(`${on.base}/v1/rooms`, {
            method: 'OPTIONS',
            headers: { origin: 'https://dash.example.com', 'access-control-request-method': 'POST' }
        })
        assert.equal(pre.status, 204)
        assert.equal(pre.headers.get('access-control-allow-origin'), 'https://dash.example.com')
        assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/)

        // A non-allowed origin gets no echo.
        const denied = await fetch(`${on.base}/v1/stats`, { headers: { ...ADMIN, origin: 'https://evil.example.com' } })
        assert.equal(denied.headers.get('access-control-allow-origin'), null)
        await denied.body?.cancel()
    } finally {
        await on.close()
    }
})
