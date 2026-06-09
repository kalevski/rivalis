import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'

import { FleetAgent } from '../lib/FleetAgent.js'
import { encodeFrame, decodeFrame, PROTOCOL_VERSION, Topics } from '../lib/wire.js'

const require = createRequire(import.meta.url)
const { WSClient } = require('@rivalis/core/clients/ws') as typeof import('@rivalis/core/clients/ws')
const pkg = require('../package.json') as { version: string }

// ---------------------------------------------------------------------------
// Test doubles. The agent only touches a small, documented surface: a transport
// client (core's WSClient shape — injected), an injectable scheduler so timers
// fire deterministically, and a faithful fake RoomManager/Rivalis.
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A port that is guaranteed closed: bind to an ephemeral port, then release it. */
async function closedPortUrl(): Promise<string> {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return `ws://127.0.0.1:${port}`
}

function makeLogger() {
    const calls: Record<string, unknown[][]> = { error: [], warning: [], info: [], debug: [], verbose: [], log: [] }
    const mk = (k: string) => (...args: unknown[]) => { calls[k].push(args) }
    return { error: mk('error'), warning: mk('warning'), info: mk('info'), debug: mk('debug'), verbose: mk('verbose'), log: mk('log'), calls }
}

type Handler = (...args: any[]) => void

class FakeClient {
    connected = false
    connectCalls = 0
    lastTicket: string | undefined
    sent: Array<{ topic: string; payload: any }> = []
    private listeners = new Map<string, Set<Handler>>()

    on(event: string, fn: Handler) {
        let set = this.listeners.get(event)
        if (set === undefined) { set = new Set(); this.listeners.set(event, set) }
        set.add(fn)
        return this
    }
    off(event: string, fn: Handler) { this.listeners.get(event)?.delete(fn); return this }
    removeAllListeners(event?: string) { if (event) { this.listeners.delete(event) } else { this.listeners.clear() } return this }
    connect(ticket?: string) { this.connectCalls++; this.lastTicket = ticket }
    disconnect() { this.connected = false; this.fire('client:disconnect', Buffer.from('terminated')) }
    // Binary wire (§7, task 005): the agent now sends versioned protobuf frames;
    // decode them back to the typed payload so assertions read structured data.
    send(topic: string, payload: Uint8Array) { this.sent.push({ topic, payload: decodeFrame(topic, payload) }) }

    fire(event: string, ...args: unknown[]) { for (const fn of [...(this.listeners.get(event) ?? [])]) { fn(...args) } }
    /** Simulate the transport socket opening. */
    open() { this.connected = true; this.fire('client:connect') }
    /** Simulate fleet/hello from the orchestrator (binary frame on the wire). */
    hello(payload: Record<string, unknown>) { this.fire('fleet/hello', encodeFrame('fleet/hello', payload)) }
    /** Simulate a raw (un-versioned) frame on a topic — e.g. a legacy JSON peer. */
    deliverRaw(topic: string, bytes: Uint8Array) { this.fire(topic, bytes) }
    /** Simulate any topic frame from the orchestrator (binary-encoded). */
    deliver(topic: string, payload: Record<string, unknown> = {}) { this.fire(topic, encodeFrame(topic, payload)) }
    byTopic(topic: string) { return this.sent.filter((m) => m.topic === topic) }
    last(topic: string) { return this.byTopic(topic).pop() }
    /** Total live transport listeners across all events (task 008 — detach assertion). */
    totalListeners() { let n = 0; for (const set of this.listeners.values()) { n += set.size } return n }
}

function makeScheduler() {
    let nextId = 1
    const timeouts = new Map<number, () => void>()
    const intervals = new Map<number, () => void>()
    const scheduler = {
        setTimeout: (fn: () => void) => { const id = nextId++; timeouts.set(id, fn); return id },
        clearTimeout: (h: unknown) => { timeouts.delete(h as number) },
        setInterval: (fn: () => void) => { const id = nextId++; intervals.set(id, fn); return id },
        clearInterval: (h: unknown) => { intervals.delete(h as number) }
    }
    return {
        scheduler,
        pendingTimeouts: () => timeouts.size,
        pendingIntervals: () => intervals.size,
        /** Fire every currently-pending timeout once (insertion order), clearing each. */
        runTimeouts: () => { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn() } },
        /** Fire the most-recently-created interval N times. */
        runLastInterval: (times = 1) => {
            const ids = [...intervals.keys()]
            const fn = intervals.get(ids[ids.length - 1])!
            for (let i = 0; i < times; i++) { fn() }
        }
    }
}

function makeFakeRivalis(defs: string[] = ['match']) {
    const rooms = new Map<string, { id: string; type: string; actorCount: number }>()
    const definitions = new Set(defs)
    const listeners = new Map<string, Set<Handler>>()
    const logger = makeLogger()
    let gen = 0
    const emit = (event: string, ...args: unknown[]) => { for (const fn of [...(listeners.get(event) ?? [])]) { fn(...args) } }
    const manager = {
        definitions: () => [...definitions],
        keys: () => rooms.keys(),
        get: (id: string) => rooms.get(id) ?? null,
        get count() { return rooms.size },
        create(type: string, id: string | null) {
            const rid = id ?? `gen_${++gen}`
            if (!definitions.has(type)) { throw new Error(`room create error: type=(${type}) is not defined`) }
            if (rooms.has(rid)) { throw new Error(`room create error: room id=(${rid}) is taken`) }
            const room = { id: rid, type, actorCount: 0 }
            rooms.set(rid, room)
            emit('create', rid, type)
            return room
        },
        destroy(id: string) {
            if (!rooms.has(id)) { throw new Error(`room destroy error: roomId=(${id}) does not exist`) }
            rooms.delete(id)
            emit('destroy', id)
        },
        on(event: string, fn: Handler) {
            let set = listeners.get(event)
            if (set === undefined) { set = new Set(); listeners.set(event, set) }
            set.add(fn)
            return manager
        },
        off(event: string, fn: Handler) { listeners.get(event)?.delete(fn); return manager }
    }
    let shutdownCalls = 0
    const rivalis = { rooms: manager, logging: { getLogger: () => logger }, shutdown: async () => { shutdownCalls++ } }
    return {
        rivalis, manager, logger, rooms,
        addRoom: (id: string, type = 'match', count = 0) => { rooms.set(id, { id, type, actorCount: count }) },
        setCount: (id: string, count: number) => { rooms.get(id)!.actorCount = count },
        shutdownCalls: () => shutdownCalls,
        /** Live count of subscribers on the rooms 'destroy' broadcast — the agent's provenance handler (task 008). */
        destroyListeners: () => listeners.get('destroy')?.size ?? 0
    }
}

const BASE_OPTS = { url: 'ws://orch:7350', key: 'agent-key', endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' }

/** Boot an agent over a fake client + scheduler, already past `fleet/hello`. */
function bootConnected(extraOpts: Record<string, unknown> = {}, fake = makeFakeRivalis()) {
    const sched = makeScheduler()
    const client = new FakeClient()
    const agent = new FleetAgent(fake.rivalis as any, { ...BASE_OPTS, ...extraOpts } as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any
    })
    void agent.connect()
    client.open()
    client.hello({ instanceId: 'i1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 5000 })
    return { agent, client, sched, fake }
}

// ---------------------------------------------------------------------------
// Acceptance: connect() against an unreachable orchestrator keeps the promise
// pending, retries with backoff, and does NOT crash the host process
// (regression for the task 002 WSClient hardening, §15).
// ---------------------------------------------------------------------------

test('connect() to an unreachable orchestrator stays pending, retries with backoff, never crashes', async () => {
    const fake = makeFakeRivalis()
    const url = await closedPortUrl()
    let attempts = 0
    const agent = new FleetAgent(fake.rivalis as any, { ...BASE_OPTS, url } as any, {
        backoff: { baseMs: 15, capMs: 30 },
        createClient: (u) => {
            const c = new WSClient(u, { ticketSource: 'protocol' })
            const original = c.connect.bind(c)
            ;(c as any).connect = (ticket?: string) => { attempts++; original(ticket) }
            return c as any
        }
    })

    let settled = false
    agent.connect().then(() => { settled = true }, () => { settled = true })

    await delay(220)
    assert.equal(settled, false, 'connect() must stay pending while the orchestrator is unreachable')
    assert.ok(attempts >= 2, `expected the agent to retry (got ${attempts} attempts)`)
    assert.equal(agent.status, 'connecting')

    await agent.disconnect()
})

// ---------------------------------------------------------------------------
// Acceptance: connectTimeoutMs rejection leaves no timers/retry loops running.
// ---------------------------------------------------------------------------

test('connectTimeoutMs rejects, transitions to closed, and stops the retry loop', async () => {
    const fake = makeFakeRivalis()
    const url = await closedPortUrl()
    let attempts = 0
    const agent = new FleetAgent(fake.rivalis as any, { ...BASE_OPTS, url, connectTimeoutMs: 60 } as any, {
        backoff: { baseMs: 10, capMs: 20 },
        createClient: (u) => {
            const c = new WSClient(u, { ticketSource: 'protocol' })
            const original = c.connect.bind(c)
            ;(c as any).connect = (ticket?: string) => { attempts++; original(ticket) }
            return c as any
        }
    })

    await assert.rejects(agent.connect(), /connect timeout/i)
    const attemptsAtReject = attempts
    assert.equal(agent.status, 'closed')

    await delay(120)
    assert.equal(attempts, attemptsAtReject, 'no further connect attempts after the timeout fired — no leaked retry loop')
})

// ---------------------------------------------------------------------------
// Acceptance: room create/destroy no longer pushes (task 011); changes surface
// only at the next orchestrator poll. The agent runs no heartbeat timer.
// ---------------------------------------------------------------------------

test('room creates do not push; the change surfaces only at the next poll (task 011)', () => {
    const { client, sched, fake } = bootConnected()
    const baseline = client.sent.length

    for (let i = 0; i < 50; i++) { fake.manager.create('match', `r${i}`) }
    assert.equal(sched.pendingTimeouts(), 0, 'no debounced-sync timer — room events do not push')
    assert.equal(client.sent.length, baseline, 'no frame is sent on room creates')

    // The orchestrator polls → the agent answers with a full state reflecting all 50.
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    const state = client.last(Topics.state)!
    assert.equal(state.payload.full, true)
    assert.equal(state.payload.rooms.length, 50, 'the poll reply reflects all 50 rooms')
})

// ---------------------------------------------------------------------------
// Acceptance: poll replies dedup by the orchestrator-supplied knownHash —
// unchanged state → hash-only, changed (or forced) → full snapshot (task 011).
// ---------------------------------------------------------------------------

test('poll replies dedup by knownHash: unchanged → hash-only, changed/forced → full', () => {
    const fake = makeFakeRivalis()
    fake.addRoom('r1', 'match', 1)
    const { client } = bootConnected({}, fake)

    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    const s1 = client.last(Topics.state)!
    assert.equal(s1.payload.full, true, 'knownHash null → a full reply')
    const hash = s1.payload.hash

    client.deliver(Topics.poll, { reqId: 'p2', knownHash: hash, status: 'active' })
    assert.equal(client.last(Topics.state)!.payload.full, false, 'unchanged state → hash-only reply')

    fake.setCount('r1', 5)
    client.deliver(Topics.poll, { reqId: 'p3', knownHash: hash, status: 'active' })
    assert.equal(client.last(Topics.state)!.payload.full, true, 'connection-count drift → full reply')
})

// ---------------------------------------------------------------------------
// Acceptance (task 009): a full fleet/state from a real FleetAgent carries the
// version resolved from fleet/package.json, not a hand-maintained literal — the
// CLI's --version and the snapshot agentVersion share one resolution helper (§6).
// ---------------------------------------------------------------------------

test('a full fleet/state reports agentVersion resolved from package.json, not a literal', () => {
    const { client } = bootConnected()

    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    const state = client.last(Topics.state)!
    assert.equal(state.payload.full, true)
    assert.equal(state.payload.agentVersion, pkg.version, 'agentVersion equals require("../package.json").version')
})

// ---------------------------------------------------------------------------
// Acceptance: fleet/cmd create/destroy acked correctly incl. alreadyGone and
// autoCreate:false rejection.
// ---------------------------------------------------------------------------

test('fleet/cmd create executes the room and acks ok with the room, stamping fleet provenance', () => {
    const { agent, client, fake } = bootConnected()
    void agent

    client.deliver('fleet/cmd', { cmdId: 'c1', op: 'create', roomType: 'match', roomId: 'match-42' })

    const ack = client.last('fleet/ack')!
    assert.equal(ack.payload.cmdId, 'c1')
    assert.equal(ack.payload.ok, true)
    assert.deepEqual(ack.payload.room, { id: 'match-42', type: 'match' })
    assert.ok(fake.rooms.has('match-42'), 'the room is actually created on the instance')

    // Provenance: a poll reply reports the fleet-created room as origin:'fleet'.
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    const state = client.last(Topics.state)!
    const room = state.payload.rooms.find((r: any) => r.id === 'match-42')
    assert.equal(room.origin, 'fleet')
})

test('fleet/cmd destroy of an existing room acks ok; of a missing room acks ok+alreadyGone', () => {
    const { client, fake } = bootConnected()
    fake.addRoom('keep', 'match', 0)

    client.deliver('fleet/cmd', { cmdId: 'd1', op: 'destroy', roomId: 'keep' })
    const ack1 = client.last('fleet/ack')!
    assert.equal(ack1.payload.ok, true)
    assert.notEqual(ack1.payload.alreadyGone, true, 'a real destroy is not alreadyGone')
    assert.equal(fake.rooms.has('keep'), false, 'the room is gone')

    client.deliver('fleet/cmd', { cmdId: 'd2', op: 'destroy', roomId: 'ghost' })
    const ack2 = client.last('fleet/ack')!
    assert.equal(ack2.payload.cmdId, 'd2')
    assert.equal(ack2.payload.ok, true)
    assert.equal(ack2.payload.alreadyGone, true, 'idempotent destroy of an already-gone room')
})

test('fleet/cmd create is rejected when autoCreate is false', () => {
    const { client, fake } = bootConnected({ autoCreate: false })

    client.deliver('fleet/cmd', { cmdId: 'c2', op: 'create', roomType: 'match', roomId: 'nope' })
    const ack = client.last('fleet/ack')!
    assert.equal(ack.payload.ok, false)
    assert.match(String(ack.payload.error), /autoCreate/i)
    assert.equal(fake.rooms.has('nope'), false, 'no room is created when autoCreate is disabled')
})

test('fleet/cmd create is rejected when maxRooms capacity is exhausted', () => {
    const fake = makeFakeRivalis()
    fake.addRoom('r1', 'match', 0)
    const { client } = bootConnected({ capacity: { maxRooms: 1 } }, fake)

    client.deliver('fleet/cmd', { cmdId: 'c3', op: 'create', roomType: 'match', roomId: 'overflow' })
    const ack = client.last('fleet/ack')!
    assert.equal(ack.payload.ok, false)
    assert.match(String(ack.payload.error), /capacity/i)
    assert.equal(fake.rooms.has('overflow'), false)
})

// ---------------------------------------------------------------------------
// Acceptance: drain() flips the agent-owned status immediately and resolves only
// when a poll echoes the target status (the orchestrator's recorded value) —
// the acknowledged confirmation, no unsolicited frame (task 011).
// ---------------------------------------------------------------------------

test('drain() resolves only when a poll echoes draining; state replies carry draining meanwhile', async () => {
    const { agent, client } = bootConnected()

    let resolved = false
    const draining = agent.drain().then(() => { resolved = true })
    assert.equal(agent.status, 'draining', 'agent owns status — flips immediately')
    // No frame is pushed by drain() itself (no unsolicited frame, task 011).
    assert.equal(client.byTopic(Topics.state).length, 0)

    // A poll still echoing 'active' must NOT resolve drain(); the agent answers full
    // (status is part of its hash) and the reply carries draining.
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    await delay(5)
    assert.equal(resolved, false, 'drain() does not resolve until the orchestrator echoes draining')
    assert.equal(client.last(Topics.state)!.payload.status, 'draining', 'the state reply carries draining')

    // A poll echoing draining (the orchestrator recorded it) resolves drain().
    client.deliver(Topics.poll, { reqId: 'p2', knownHash: null, status: 'draining' })
    await draining
    assert.equal(resolved, true)
})

test('undrain() flips status back to active and resolves on the active poll echo', async () => {
    const { agent, client } = bootConnected()

    const draining = agent.drain()
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'draining' })
    await draining
    assert.equal(agent.status, 'draining')

    const active = agent.undrain()
    assert.equal(agent.status, 'connected', 'undrain flips local status immediately')
    client.deliver(Topics.poll, { reqId: 'p2', knownHash: null, status: 'active' })
    await active
    assert.equal(agent.status, 'connected')

    // Subsequent state replies carry active.
    client.deliver(Topics.poll, { reqId: 'p3', knownHash: null, status: 'active' })
    assert.equal(client.last(Topics.state)!.payload.status, 'active')
})

// ---------------------------------------------------------------------------
// Acceptance: the graceful-shutdown sequence (drain → awaitEmpty → disconnect →
// rivalis.shutdown). drain() resolves on the poll echo (task 011).
// ---------------------------------------------------------------------------

test('enableGracefulShutdown drains (poll echo) → awaitEmpty → disconnect → rivalis.shutdown', async () => {
    const fake = makeFakeRivalis() // no rooms → awaitEmpty resolves immediately
    const sched = makeScheduler()
    const client = new FakeClient()
    let signalHandler: (() => void) | null = null
    const agent = new FleetAgent(fake.rivalis as any, BASE_OPTS as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any,
        installSignalHandlers: (h) => { signalHandler = h; return () => {} }
    })
    void agent.connect()
    client.open()
    client.hello({ instanceId: 'i1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 5000 })

    agent.enableGracefulShutdown({ emptyTimeoutMs: 1000 })
    assert.ok(signalHandler, 'a signal handler was installed via the seam')

    // SIGTERM → drain → awaitEmpty → disconnect → rivalis.shutdown.
    signalHandler!()
    assert.equal(agent.status, 'draining', 'the sequence drains first (agent owns status, flips immediately)')

    // drain() resolves only on a poll echoing draining (the acknowledged confirmation).
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'draining' })
    await delay(20)

    assert.equal(fake.shutdownCalls(), 1, 'rivalis.shutdown ran at the end of the sequence')
    assert.equal(agent.status, 'closed', 'the agent ends closed')
})

// ---------------------------------------------------------------------------
// Reconnection: a fresh hello resets the per-connection seq; the orchestrator's
// first poll (knownHash:null) yields a full snapshot; processUid stays constant (§7).
// ---------------------------------------------------------------------------

test('reconnect: a fresh hello resets seq; the next poll yields a full snapshot; processUid constant', () => {
    const { agent, client, sched } = bootConnected()
    const firstUid = agent.processUid

    // Drop the link (unintentional) → the agent schedules a reconnect.
    client.connected = false
    client.fire('client:disconnect', Buffer.from('reset'))
    assert.equal(agent.status, 'connecting')
    assert.ok(sched.pendingTimeouts() >= 1, 'a reconnect is scheduled')

    // Reconnect: new transport open + a NEW instanceId in hello.
    sched.runTimeouts()
    client.open()
    client.hello({ instanceId: 'i2', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 5000 })
    assert.equal(agent.processUid, firstUid, 'processUid is stable across reconnects')

    // The agent pushes nothing on hello (task 011); the orchestrator's first poll
    // (knownHash:null on the new connection) draws a full snapshot.
    const baseline = client.sent.length
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    const afterReconnect = client.sent.slice(baseline).filter((m) => m.topic === Topics.state)
    assert.equal(afterReconnect.length, 1)
    assert.equal(afterReconnect[0].payload.full, true, 'a full snapshot on the first poll after reconnect')
})

// ---------------------------------------------------------------------------
// Protocol-major mismatch in hello is fatal: reject, close, no retry (§7).
// ---------------------------------------------------------------------------

test('a protocol-major mismatch in fleet/hello rejects connect and closes the agent', async () => {
    const sched = makeScheduler()
    const client = new FakeClient()
    const fake = makeFakeRivalis()
    const agent = new FleetAgent(fake.rivalis as any, BASE_OPTS as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any
    })

    const connecting = agent.connect()
    client.open()
    client.hello({ instanceId: 'i1', protocolVersion: 99, heartbeatMs: 5000 })

    await assert.rejects(connecting, /protocol major mismatch/i)
    assert.equal(agent.status, 'closed')
})

// ---------------------------------------------------------------------------
// Version mismatch via the wire header: an OLD JSON orchestrator (v1) talking to
// this v2 binary agent fails loudly at fleet/hello — the lockstep-upgrade
// requirement (§7, task 005). A legacy JSON frame's first byte (`{` = 123) can
// never be a valid protocol major, so the 2-byte header check catches it.
// ---------------------------------------------------------------------------

test('a legacy JSON fleet/hello (v1 peer) fails connect loudly with a version-mismatch error', async () => {
    const sched = makeScheduler()
    const client = new FakeClient()
    const fake = makeFakeRivalis()
    const agent = new FleetAgent(fake.rivalis as any, BASE_OPTS as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any
    })

    const connecting = agent.connect()
    client.open()
    // A v1 orchestrator would send JSON, not a versioned binary frame.
    client.deliverRaw('fleet/hello', Buffer.from(JSON.stringify({ instanceId: 'i1', protocolVersion: 1, heartbeatMs: 5000 })))

    await assert.rejects(connecting, /version mismatch/i)
    assert.equal(agent.status, 'closed')
})

// ---------------------------------------------------------------------------
// Host-safety: a malformed/truncated binary frame is logged and dropped, never
// thrown into the host process (§8, task 005 criterion 4).
// ---------------------------------------------------------------------------

test('a malformed binary fleet/cmd is logged and dropped — no throw, no ack', () => {
    const { client, fake } = bootConnected()
    const before = client.byTopic('fleet/ack').length

    // A frame with this build's valid header [major, minor] but a garbage body:
    // the protobuf decode fails; the agent logs and drops it.
    const truncated = Uint8Array.from([PROTOCOL_VERSION, 0, 0xff, 0xff, 0xff, 0xff])
    assert.doesNotThrow(() => client.deliverRaw('fleet/cmd', truncated))

    assert.equal(client.byTopic('fleet/ack').length, before, 'a malformed cmd produces no ack')
    assert.ok(fake.logger.calls.warning.some((a) => /decode/i.test(String(a[0]))), 'the drop is logged')
})

// ---------------------------------------------------------------------------
// Host-safety: the key is sent via subprotocol, never appended to the URL (§13).
// ---------------------------------------------------------------------------

test('the agent key is passed as the WS subprotocol ticket, not a query string', () => {
    const sched = makeScheduler()
    const client = new FakeClient()
    const fake = makeFakeRivalis()
    const agent = new FleetAgent(fake.rivalis as any, BASE_OPTS as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any
    })
    void agent.connect()
    assert.equal(client.lastTicket, 'agent-key', 'the key is handed to the transport as the ticket (subprotocol via ticketSource:protocol)')
})

// ---------------------------------------------------------------------------
// Listener-cleanup (task 008): the room-provenance and transport listeners
// follow the connection lifecycle — detached on the terminal paths so a
// discarded/replaced agent stops reacting to room events (no reference leak).
// ---------------------------------------------------------------------------

test('disconnect() detaches the rooms provenance handler and transport listeners', async () => {
    const { agent, client, fake } = bootConnected()
    assert.equal(fake.destroyListeners(), 1, 'the provenance handler is subscribed while connected')
    assert.ok(client.totalListeners() > 0, 'transport listeners are wired while connected')

    await agent.disconnect()

    assert.equal(fake.destroyListeners(), 0, 'destroying a room no longer invokes the agent provenance handler')
    assert.equal(client.totalListeners(), 0, 'transport listeners are detached on disconnect')
})

test('failConnect (connectTimeout) detaches the rooms provenance handler', async () => {
    const sched = makeScheduler()
    const client = new FakeClient()
    const fake = makeFakeRivalis()
    const agent = new FleetAgent(fake.rivalis as any, { ...BASE_OPTS, connectTimeoutMs: 50 } as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any
    })
    const connecting = agent.connect()
    assert.equal(fake.destroyListeners(), 1)

    // Fire the connect-deadline timeout → failConnect → terminal close.
    sched.runTimeouts()
    await assert.rejects(connecting, /connect timeout/i)

    assert.equal(agent.status, 'closed')
    assert.equal(fake.destroyListeners(), 0, 'the provenance handler is detached on a fatal connect failure')
    assert.equal(client.totalListeners(), 0, 'transport listeners are detached on failConnect')
})

test('connect() after disconnect() re-subscribes and restores provenance tracking', async () => {
    const { agent, client, fake } = bootConnected()
    await agent.disconnect()
    assert.equal(fake.destroyListeners(), 0, 'detached after disconnect')

    // Reuse the agent: reconnect over the same transport (connect() resets `closed`).
    void agent.connect()
    client.open()
    client.hello({ instanceId: 'i2', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 5000 })
    assert.equal(fake.destroyListeners(), 1, 're-subscribed on reconnect')

    // Full provenance pipeline works again: a fleet-created room reports origin:'fleet'.
    client.deliver('fleet/cmd', { cmdId: 'c1', op: 'create', roomType: 'match', roomId: 'm1' })
    assert.equal(client.last('fleet/ack')!.payload.ok, true)
    client.deliver(Topics.poll, { reqId: 'p1', knownHash: null, status: 'active' })
    const room = client.last(Topics.state)!.payload.rooms.find((r: any) => r.id === 'm1')
    assert.equal(room.origin, 'fleet', 'provenance tracking works again after reconnect')

    await agent.disconnect()
})

test('double enableGracefulShutdown leaves exactly one active handler pair', () => {
    const sched = makeScheduler()
    const client = new FakeClient()
    const fake = makeFakeRivalis()
    let installs = 0
    let uninstalls = 0
    const agent = new FleetAgent(fake.rivalis as any, BASE_OPTS as any, {
        scheduler: sched.scheduler,
        createClient: () => client as any,
        installSignalHandlers: () => { installs++; return () => { uninstalls++ } }
    })

    agent.enableGracefulShutdown()
    agent.enableGracefulShutdown()

    assert.equal(installs, 2, 'each call installs a handler pair')
    assert.equal(uninstalls, 1, 'the first pair is uninstalled before the second installs — exactly one active pair')
    void agent
})
