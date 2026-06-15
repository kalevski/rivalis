import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { createRequire } from 'node:module'

import { Orchestrator } from '../lib/Orchestrator.js'
import { FleetAgent } from '../lib/FleetAgent.js'
import { Topics, decodeFrame } from '../lib/wire.js'

// ---------------------------------------------------------------------------
// End-to-end integration & failure suite (task 013, §15).
//
// Unlike the per-task unit suites (which drive AgentLink / scheduler seams), this
// file boots the FULL wire path: a real `Orchestrator.listen()` (node:http + WS
// transport + dogfooded FleetRoom) and real in-process `Rivalis` game servers with
// real `FleetAgent`s talking over actual WebSockets. It pins the §14 guarantees
// end-to-end — discovery, placement, drain round-trip, eviction, restart
// provenance, and reconnection — that no seam-level test can cover.
//
// core + ws are loaded via require (CJS entry) for consistency; the ESM hazard
// (F5 — broken protobufjs/light in @toolcase/serializer ESM) was fixed in core 7.0.0
// via the lazy-serializer loader in handshake, but the require path remains fast and
// avoids async top-level await in a test file.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)
const core = require('@rivalis/core') as typeof import('@rivalis/core')
const { Rivalis, Room, AuthMiddleware } = core
const { WSClient: CoreWSClient } = require('@rivalis/node') as typeof import('@rivalis/node')

const AGENT_KEY = 'fleet-agent-key-integration'
const ADMIN_KEY = 'fleet-admin-key-integration'
// Short heartbeat keeps the suite fast: snapshots/pings flow every 60 ms, so a
// status flip or eviction surfaces in well under a second of polling (§15 "no real
// 15 s eviction waits"). Eviction here is exercised via socket-close (instant); the
// liveness-timer 2×/3× path is already pinned by the orchestrator unit test.
const HEARTBEAT_MS = 60

// ---------------------------------------------------------------------------
// Test doubles for the agent-side game server: a concrete Room and an auth
// middleware that is never invoked (no game clients connect — the FleetAgent is the
// only socket, and it connects to the ORCHESTRATOR, not to this server).
// ---------------------------------------------------------------------------

class GameRoom extends (Room as any) {}
class RejectAuth extends (AuthMiddleware as any) {
    async authenticate(): Promise<null> { return null }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A free ephemeral port (bind, read, release) for a real `listen()`. */
async function freePort(): Promise<number> {
    const server = createNetServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return port
}

/** Poll `predicate` until it returns a truthy value, or throw after `timeout`. */
async function waitFor<T>(predicate: () => T, label = 'condition', timeout = 5000, interval = 15): Promise<T> {
    const start = Date.now()
    for (;;) {
        const value = predicate()
        if (value) { return value }
        if (Date.now() - start > timeout) { throw new Error(`waitFor timed out: ${label}`) }
        await delay(interval)
    }
}

/** A real in-process Rivalis game server with the given room types defined; no transport. */
function makeGameServer(defs: string[] = ['match']) {
    const rivalis = new Rivalis({ transports: [], authMiddleware: new RejectAuth() as any, rateLimiter: null })
    for (const def of defs) {
        rivalis.rooms.define(def, GameRoom as any)
    }
    return rivalis
}

interface AgentOpts {
    endpointUrl: string
    name: string
    labels?: Record<string, string>
    capacity?: { maxConnections?: number | null; maxRooms?: number | null }
}

/** Construct a FleetAgent over the real hardened WSClient (default transport). */
function newAgent(rivalis: unknown, url: string, opts: AgentOpts, internals: Record<string, unknown> = {}): FleetAgent {
    const agent = new FleetAgent(
        rivalis as any,
        { url, key: AGENT_KEY, ...opts } as any,
        { backoff: { baseMs: 30, capMs: 150 }, ...internals } as any
    )
    // The §8 contract is "never throw into the host"; the agent re-emits transport
    // failures as 'error' broadcasts. Attach a sink so a reconnect storm (e.g. while
    // the orchestrator is restarting) is silent rather than noisy.
    ;(agent as unknown as { on(e: string, fn: () => void): void }).on('error', () => {})
    return agent
}

const auth = { headers: { authorization: `Bearer ${ADMIN_KEY}` } }

/** REST helper: returns `{ status, json }`. */
async function rest(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { authorization: `Bearer ${ADMIN_KEY}` }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
    }
    const res = await fetch(`${base}${path}`, init)
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
}

function baseUrlOf(port: number): { ws: string; http: string } {
    return { ws: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` }
}

function orchestratorOptions(port: number): Record<string, unknown> {
    return {
        host: '127.0.0.1', port,
        agentKey: AGENT_KEY, adminKey: ADMIN_KEY,
        api: true, heartbeatMs: HEARTBEAT_MS
    }
}

// ===========================================================================
// Criterion 1 — discovery: instances and pre-existing rooms appear over real WS.
// ===========================================================================

test('discovery: two agents and their pre-existing rooms surface in the read model and over REST', async () => {
    const port = await freePort()
    const { ws, http } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any)
    await orch.listen()

    const serverA = makeGameServer(['match', 'lobby'])
    const serverB = makeGameServer(['match'])
    // A room that exists BEFORE the agent attaches must still be discovered (§8: the
    // first snapshot enumerates rooms.keys() + room.type, the §4 core additions).
    serverA.rooms.create('match', 'pre-existing-a')

    const agentA = newAgent(serverA, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1', labels: { region: 'eu' } })
    const agentB = newAgent(serverB, ws, { endpointUrl: 'wss://us1.game.example.com', name: 'us1', labels: { region: 'us' } })
    try {
        await agentA.connect()
        await agentB.connect()
        await waitFor(() => orch.fleet.instances.length === 2, 'both instances discovered')

        const names = orch.fleet.instances.map((i) => i.name).sort()
        assert.deepEqual(names, ['eu1', 'us1'], 'both instance names discovered')

        // The pre-existing room is reported, with its type and local provenance.
        const pre = await waitFor(() => orch.fleet.getRoom('pre-existing-a'), 'pre-existing room discovered')
        assert.equal(pre.type, 'match')
        assert.equal(pre.local, true, 'a directly-created room is origin:local')
        assert.equal(pre.endpointUrl, 'wss://eu1.game.example.com', 'room carries the owning instance endpointUrl')

        // roomTypes union is reported per instance.
        const eu = orch.fleet.instances.find((i) => i.name === 'eu1')!
        assert.deepEqual([...eu.roomTypes].sort(), ['lobby', 'match'])

        // The same view is served over real REST with the admin bearer key.
        const stats = await rest(http, 'GET', '/v1/stats')
        assert.equal(stats.status, 200)
        assert.equal(stats.json.data.instances, 2)
        assert.ok(stats.json.data.roomTypes.includes('match'))
    } finally {
        await agentA.disconnect()
        await agentB.disconnect()
        await serverA.shutdown()
        await serverB.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// Criterion 1 — placement: POST /v1/rooms lands per algorithm and returns endpointUrl.
// ===========================================================================

test('placement: POST /v1/rooms creates a room on the right instance and returns its endpointUrl', async () => {
    const port = await freePort()
    const { ws, http } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any)
    await orch.listen()

    const serverA = makeGameServer(['match'])
    const serverB = makeGameServer(['match'])
    const agentA = newAgent(serverA, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1', labels: { region: 'eu' } })
    const agentB = newAgent(serverB, ws, { endpointUrl: 'wss://us1.game.example.com', name: 'us1', labels: { region: 'us' } })
    try {
        await agentA.connect()
        await agentB.connect()
        await waitFor(() => orch.fleet.instances.length === 2, 'both instances present')

        // Label-pinned placement is deterministic: only the eu instance is a candidate.
        const created = await rest(http, 'POST', '/v1/rooms', { type: 'match', roomId: 'match-eu', placement: { labels: { region: 'eu' } } })
        assert.equal(created.status, 201, 'placement returns 201')
        const room = created.json.data
        assert.equal(room.id, 'match-eu')
        assert.equal(room.type, 'match')
        assert.equal(room.endpointUrl, 'wss://eu1.game.example.com', 'RoomInfo carries the chosen instance endpointUrl for handing to clients')
        assert.equal(room.local, false, 'a fleet-placed room is origin:fleet')

        // The command actually created the room on the eu game server (not us).
        assert.ok(serverA.rooms.get('match-eu') !== null, 'room created on the eu instance')
        assert.equal(serverB.rooms.get('match-eu'), null, 'room not created on the us instance')

        // And it reconciles into the read model on the agent's next snapshot.
        await waitFor(() => orch.fleet.getRoom('match-eu'), 'placed room reconciles into the read model')

        // A default (unpinned) placement still returns a usable endpointUrl from one of the two.
        const any = await rest(http, 'POST', '/v1/rooms', { type: 'match' })
        assert.equal(any.status, 201)
        assert.match(any.json.data.endpointUrl, /^wss:\/\/(eu1|us1)\.game\.example\.com$/)
    } finally {
        await agentA.disconnect()
        await agentB.disconnect()
        await serverA.shutdown()
        await serverB.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// Criterion 1 — drain round-trip (agent-initiated drain via the poll-echo
// confirmation AND the orchestrator-initiated cmd/ack path) + eviction on close.
// ===========================================================================

test('drain round-trip (agent-initiated + REST) and eviction on socket close, over real WS', async () => {
    const port = await freePort()
    const { ws, http } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any)
    await orch.listen()
    const leaves: any[] = []
    orch.on('instance:leave', (i: any) => leaves.push(i))

    const serverA = makeGameServer(['match'])
    const serverB = makeGameServer(['match'])
    const agentA = newAgent(serverA, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' })
    const agentB = newAgent(serverB, ws, { endpointUrl: 'wss://us1.game.example.com', name: 'us1' })
    try {
        await agentA.connect()
        await agentB.connect()
        await waitFor(() => orch.fleet.instances.length === 2, 'both instances present')

        const idA = () => orch.fleet.instances.find((i) => i.processUid === agentA.processUid)?.id ?? null
        const idB = () => orch.fleet.instances.find((i) => i.processUid === agentB.processUid)?.id ?? null

        // Agent-initiated drain (task 011): drain() flips the agent-owned status and
        // resolves only when a poll echoes 'draining'; the next state reply carries it.
        await agentB.drain()
        assert.equal(agentB.status, 'draining', 'agent owns status — flips immediately')
        await waitFor(() => orch.fleet.getInstance(idB()!)?.status === 'draining', 'agent-initiated drain reflected in read model')

        // Orchestrator-initiated drain via REST rides the fleet/cmd {op:drain} -> ack
        // path; the agent flips status and the snapshot carries it.
        const drainRes = await rest(http, 'POST', `/v1/instances/${idA()}/drain`)
        assert.equal(drainRes.status, 200)
        await waitFor(() => orch.fleet.getInstance(idA()!)?.status === 'draining', 'REST drain reflected in read model')

        // Undrain restores active.
        const undrainRes = await rest(http, 'POST', `/v1/instances/${idA()}/undrain`)
        assert.equal(undrainRes.status, 200)
        await waitFor(() => orch.fleet.getInstance(idA()!)?.status === 'active', 'undrain restores active')

        // Eviction on socket close (§14: socket drop -> evicted instantly).
        const evicted = idA()!
        await agentA.disconnect()
        await waitFor(() => orch.fleet.getInstance(evicted) === null, 'instance evicted on socket close')
        assert.ok(leaves.some((i) => i.id === evicted), 'instance:leave fired for the evicted instance')
        assert.equal(orch.fleet.instances.length, 1, 'only the surviving instance remains')
    } finally {
        await agentA.disconnect()
        await agentB.disconnect()
        await serverA.shutdown()
        await serverB.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// Criterion 2 — restart provenance: RoomInfo.local stable across an orchestrator
// restart (agent-reported origin), §11 duplicate-id tie-break honored.
// ===========================================================================

test('restart provenance: local flags and the §11 tie-break are identical before and after an orchestrator restart', async () => {
    const port = await freePort()
    const { ws } = baseUrlOf(port)
    const options = orchestratorOptions(port)
    let orch = new Orchestrator(options as any)
    await orch.listen()

    const serverA = makeGameServer(['match'])
    const serverB = makeGameServer(['match'])
    // A local room on A (origin:local, created directly — not via the fleet).
    serverA.rooms.create('match', 'local-a')

    const agentA = newAgent(serverA, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' })
    const agentB = newAgent(serverB, ws, { endpointUrl: 'wss://us1.game.example.com', name: 'us1' })

    /** Map every room's public id to its `local` flag — the provenance fingerprint. */
    const provenance = () => Object.fromEntries(orch.fleet.rooms.map((r) => [r.id, r.local]))

    try {
        await agentA.connect()
        await agentB.connect()
        await waitFor(() => orch.fleet.instances.length === 2, 'both instances present')

        // A fleet-created room on A (origin:fleet).
        await orch.fleet.createRoom({ type: 'match', roomId: 'fleet-a', placement: { processUid: agentA.processUid } })
        // A fleet-created room id that B will ALSO claim locally — the cross-instance
        // duplicate. Created on A via the fleet first (so the id is free), then created
        // directly on B: the §11 tie-break must keep the fleet room canonical and
        // surface B's local room namespaced as <processUid>~shared.
        await orch.fleet.createRoom({ type: 'match', roomId: 'shared', placement: { processUid: agentA.processUid } })
        serverB.rooms.create('match', 'shared')

        const namespaced = `${agentB.processUid}~shared`
        await waitFor(() => orch.fleet.getRoom(namespaced), 'B\'s colliding local room surfaces namespaced')

        // Sanity on the tie-break before the restart.
        assert.equal(orch.fleet.getRoom('shared')!.local, false, 'fleet room keeps the canonical id')
        assert.equal(orch.fleet.getRoom(namespaced)!.local, true, 'the local duplicate is namespaced by processUid')
        assert.equal(orch.fleet.getRoom('local-a')!.local, true)
        assert.equal(orch.fleet.getRoom('fleet-a')!.local, false)

        const before = provenance()
        const idABefore = orch.fleet.instances.find((i) => i.processUid === agentA.processUid)!.id

        // ---- restart the orchestrator on the same port; agents reconnect ----
        await orch.shutdown()
        orch = new Orchestrator(options as any)
        await orch.listen()

        await waitFor(() => orch.fleet.instances.length === 2, 'both agents reconnect after restart', 8000)
        await waitFor(() => orch.fleet.rooms.length === Object.keys(before).length, 'all rooms restored after restart', 8000)

        const after = provenance()
        assert.deepEqual(after, before, 'RoomInfo.local values (agent-reported origin) are identical across the restart')

        // Criterion 3 corollary: a reconnect yields a NEW instanceId but a stable processUid.
        const idAAfter = orch.fleet.instances.find((i) => i.processUid === agentA.processUid)!.id
        assert.notEqual(idAAfter, idABefore, 'a reconnect assigns a new connection-scoped instanceId')
    } finally {
        await agentA.disconnect()
        await agentB.disconnect()
        await serverA.shutdown()
        await serverB.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// Criterion 3 — reconnection: a dropped socket yields a new instanceId, the same
// processUid, a full snapshot that restores rooms, and a correlatable leave/join
// pair on the SAME orchestrator (for dashboards).
// ===========================================================================

test('reconnection: new instanceId, constant processUid, rooms restored, correlatable leave/join', async () => {
    const port = await freePort()
    const { ws } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any)
    await orch.listen()

    const joins: Array<{ id: string; processUid: string }> = []
    const leaves: string[] = []
    orch.on('instance:join', (i: any) => joins.push({ id: i.id, processUid: i.processUid }))
    orch.on('instance:leave', (i: any) => leaves.push(i.id))

    // A controllable transport: a thin pass-through over the real hardened WSClient
    // whose `drop()` closes the socket WITHOUT calling agent.disconnect(), so the
    // agent treats it as an unexpected drop and reconnects (the dashboard leave/join
    // scenario), all against ONE live orchestrator.
    let realClient: any = null
    const createClient = (url: string) => {
        realClient = new CoreWSClient(url, { ticketSource: 'protocol' })
        return {
            get connected() { return realClient.connected },
            connect: (t?: string) => realClient.connect(t),
            disconnect: () => realClient.disconnect(),
            // Binary wire (§7, task 005): pass the encoded frame straight through.
            send: (topic: string, payload: Uint8Array) => realClient.send(topic, payload),
            on: (e: string, fn: (...a: any[]) => void) => realClient.on(e, fn),
            off: (e: string, fn: (...a: any[]) => void) => realClient.off(e, fn),
            removeAllListeners: (e?: string) => realClient.removeAllListeners(e)
        }
    }

    const server = makeGameServer(['match'])
    const agent = newAgent(server, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' }, { createClient })
    try {
        await agent.connect()
        await waitFor(() => orch.fleet.instances.length === 1, 'instance joined')
        await orch.fleet.createRoom({ type: 'match', roomId: 'keep-me', placement: { processUid: agent.processUid } })
        await waitFor(() => orch.fleet.getRoom('keep-me'), 'room present before the drop')

        const firstUid = agent.processUid
        const firstId = orch.fleet.instances[0].id

        // Drop the socket out from under the agent — it reconnects with backoff.
        realClient.disconnect()

        await waitFor(() => joins.length === 2, 'a second join fires after reconnection', 8000)
        await waitFor(() => orch.fleet.instances.length === 1, 'exactly one live instance after reconnection', 8000)

        const rejoined = orch.fleet.instances[0]
        assert.equal(rejoined.processUid, firstUid, 'processUid is stable across the reconnect (correlates the pair)')
        assert.notEqual(rejoined.id, firstId, 'a reconnect yields a NEW connection-scoped instanceId')
        assert.equal(joins[0].processUid, joins[1].processUid, 'both joins carry the same processUid — dashboards can correlate')
        assert.notEqual(joins[0].id, joins[1].id)
        assert.ok(leaves.includes(firstId), 'a leave for the old id fired before the new join — a correlatable pair')

        // The full snapshot on reconnect restores the fleet room (origin survives — §7).
        await waitFor(() => orch.fleet.getRoom('keep-me'), 'rooms restored from the reconnect snapshot', 8000)
        assert.equal(orch.fleet.getRoom('keep-me')!.local, false, 'fleet provenance survives the reconnect')
    } finally {
        await agent.disconnect()
        await server.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// task 005 + 011 criterion — ALL FIVE topics round-trip through
// @toolcase/serializer over real WebSockets (encode on one half, decode on the
// other), with a live agent + orchestrator. Strict orchestrator-driven
// request/reply: agent→orch reply topics (state/ack) are observed by recording
// what the transport sends; orch→agent request topics (hello/poll/cmd) are
// observed by their effects on the agent.
// ===========================================================================

test('all five binary topics round-trip over real WS (orchestrator-driven request/reply)', async () => {
    const port = await freePort()
    const { ws } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any)
    await orch.listen()

    // Record every topic the agent sends, passing the binary frame straight to the
    // real hardened WSClient — proves agent→orch encode + orch decode end-to-end.
    const sentTopics: string[] = []
    let realClient: any = null
    const createClient = (url: string) => {
        realClient = new CoreWSClient(url, { ticketSource: 'protocol' })
        return {
            get connected() { return realClient.connected },
            connect: (t?: string) => realClient.connect(t),
            disconnect: () => realClient.disconnect(),
            send: (topic: string, payload: Uint8Array) => { sentTopics.push(topic); realClient.send(topic, payload) },
            on: (e: string, fn: (...a: any[]) => void) => realClient.on(e, fn),
            off: (e: string, fn: (...a: any[]) => void) => realClient.off(e, fn),
            removeAllListeners: (e?: string) => realClient.removeAllListeners(e)
        }
    }

    const server = makeGameServer(['match'])
    const agent = newAgent(server, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' }, { createClient })
    try {
        // fleet/hello (orch→agent): connect() resolves only on it. fleet/poll
        // (orch→agent) follows; the agent answers with a full fleet/state (agent→orch).
        await agent.connect()
        await waitFor(() => orch.fleet.instances.length === 1, 'instance joined (hello + poll + first state)')
        assert.ok(sentTopics.includes(Topics.state), 'agent→orch fleet/state round-tripped')

        // fleet/cmd (orch→agent) + fleet/ack (agent→orch): a placement create.
        const created = await orch.fleet.createRoom({ type: 'match', roomId: 'rt-room' })
        assert.equal(created.id, 'rt-room')
        assert.ok(server.rooms.get('rt-room') !== null, 'fleet/cmd create executed on the instance')
        assert.ok(sentTopics.includes(Topics.ack), 'agent→orch fleet/ack round-tripped')

        // fleet/poll keeps coming (every heartbeat); the agent keeps replying with
        // fleet/state — observe a fresh reply after the create.
        const statesBefore = sentTopics.filter((t) => t === Topics.state).length
        await waitFor(() => sentTopics.filter((t) => t === Topics.state).length > statesBefore,
            'the orchestrator keeps polling and the agent keeps answering with fleet/state')
        assert.ok(orch.fleet.getRoom('rt-room'), 'state remains consistent across poll cycles')

        // agent.drain() rides the poll-echo confirmation (orch→agent poll status echo).
        await agent.drain()
        assert.equal(agent.status, 'draining')
        await waitFor(() => orch.fleet.instances[0]?.status === 'draining', 'the orchestrator records the drained status')

        // Both agent→orch reply topics were exercised over the real binary wire.
        for (const topic of [Topics.state, Topics.ack]) {
            assert.ok(sentTopics.includes(topic), `agent sent ${topic} over the binary wire`)
        }
    } finally {
        await agent.disconnect()
        await server.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// task 011 criterion 1 — every agent frame carries the correlation id of an
// outstanding orchestrator request, and a healthy run sends ZERO unsolicited
// frames. The strongest end-to-end proof of the latter: under the kick rule a
// single unsolicited frame would evict the agent, so a multi-cycle run that
// never evicts (same connection id throughout, no instance:leave) proves it.
// ===========================================================================

test('every agent frame carries an outstanding correlation id — zero unsolicited frames over several poll cycles', async () => {
    const port = await freePort()
    const { ws } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any)
    await orch.listen()

    // Decode every frame the agent sends so each can be checked for its correlation id.
    const frames: Array<{ topic: string; payload: any }> = []
    let realClient: any = null
    const createClient = (url: string) => {
        realClient = new CoreWSClient(url, { ticketSource: 'protocol' })
        return {
            get connected() { return realClient.connected },
            connect: (t?: string) => realClient.connect(t),
            disconnect: () => realClient.disconnect(),
            send: (topic: string, payload: Uint8Array) => { frames.push({ topic, payload: decodeFrame(topic, payload) }); realClient.send(topic, payload) },
            on: (e: string, fn: (...a: any[]) => void) => realClient.on(e, fn),
            off: (e: string, fn: (...a: any[]) => void) => realClient.off(e, fn),
            removeAllListeners: (e?: string) => realClient.removeAllListeners(e)
        }
    }

    const leaves: string[] = []
    orch.on('instance:leave', (i: any) => leaves.push(i.id))

    const server = makeGameServer(['match'])
    const agent = newAgent(server, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' }, { createClient })
    try {
        await agent.connect()
        await waitFor(() => orch.fleet.instances.length === 1, 'joined')
        const firstId = orch.fleet.instances[0].id

        // A create exercises the cmd/ack reply path.
        await orch.fleet.createRoom({ type: 'match', roomId: 'corr-room' })

        // Let several poll cycles elapse (heartbeat 60 ms) — verifies dedup across ≥3 cycles too.
        await waitFor(() => frames.filter((f) => f.topic === Topics.state).length >= 3, 'at least three fleet/state replies')

        // Every agent→orch frame is a reply carrying a correlation id: fleet/state ←
        // reqId, fleet/ack ← cmdId. The agent sends nothing else.
        assert.ok(frames.length > 0)
        for (const f of frames) {
            assert.ok(f.topic === Topics.state || f.topic === Topics.ack, `agent only sends reply topics, got ${f.topic}`)
            if (f.topic === Topics.state) { assert.equal(typeof f.payload.reqId, 'string'); assert.ok(f.payload.reqId.length > 0, 'state carries a poll reqId') }
            if (f.topic === Topics.ack) { assert.equal(typeof f.payload.cmdId, 'string'); assert.ok(f.payload.cmdId.length > 0, 'ack carries a cmdId') }
        }

        // Some replies were full and some hash-only (dedup across cycles, criterion 3).
        const states = frames.filter((f) => f.topic === Topics.state)
        assert.ok(states.some((f) => f.payload.full === true), 'at least one full state')
        assert.ok(states.some((f) => f.payload.full === false), 'at least one hash-only state (unchanged → dedup)')

        // Zero unsolicited frames ⇒ never kicked: same connection id, no eviction.
        assert.equal(orch.fleet.instances.length, 1)
        assert.equal(orch.fleet.instances[0].id, firstId, 'the instance was never kicked (an unsolicited frame would evict it)')
        assert.deepEqual(leaves, [], 'no eviction across the run')
    } finally {
        await agent.disconnect()
        await server.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// task 002 — a SLOW agent (one poll reply delayed past a poll interval, but well
// under the 3-miss evict threshold) is NOT kicked: its late reply still matches
// the single outstanding poll and liveness recovers. Regression for the bug where
// a missed tick reissued the poll, so the delayed reply was kicked as a duplicate.
// ===========================================================================

test('a single delayed poll reply does not kick the agent — it recovers over real WS (task 002)', async () => {
    const port = await freePort()
    const { ws } = baseUrlOf(port)
    // A larger heartbeat than the suite default keeps the timing margins robust: the
    // reply is held ~1.25× the interval (well below the 3× evict threshold).
    const HB = 200
    const HOLD = 250
    const orch = new Orchestrator({ ...orchestratorOptions(port), heartbeatMs: HB } as any)
    await orch.listen()

    const leaves: string[] = []
    orch.on('instance:leave', (i: any) => leaves.push(i.id))

    // A pass-through client that can hold back exactly ONE fleet/state reply.
    let delayNextState = 0
    let stateSends = 0
    let realClient: any = null
    const createClient = (url: string) => {
        realClient = new CoreWSClient(url, { ticketSource: 'protocol' })
        return {
            get connected() { return realClient.connected },
            connect: (t?: string) => realClient.connect(t),
            disconnect: () => realClient.disconnect(),
            send: (topic: string, payload: Uint8Array) => {
                if (topic === Topics.state) {
                    stateSends++
                    if (delayNextState > 0) {
                        const d = delayNextState
                        delayNextState = 0
                        setTimeout(() => realClient.send(topic, payload), d)
                        return
                    }
                }
                realClient.send(topic, payload)
            },
            on: (e: string, fn: (...a: any[]) => void) => realClient.on(e, fn),
            off: (e: string, fn: (...a: any[]) => void) => realClient.off(e, fn),
            removeAllListeners: (e?: string) => realClient.removeAllListeners(e)
        }
    }

    const server = makeGameServer(['match'])
    const agent = newAgent(server, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' }, { createClient })
    try {
        await agent.connect()
        await waitFor(() => orch.fleet.instances.length === 1, 'joined')
        const firstId = orch.fleet.instances[0].id

        // Arm a one-shot hold: the NEXT poll reply is delayed past one interval. With the
        // bug, the orchestrator would reissue the poll and kick the late reply.
        delayNextState = HOLD
        const before = stateSends
        await waitFor(() => stateSends > before, 'the delayed reply was eventually sent')

        // Let the held reply land and a couple more poll cycles run.
        await delay(HB * 6)

        assert.deepEqual(leaves, [], 'a merely-slow agent is never evicted/kicked')
        assert.equal(orch.fleet.instances.length, 1, 'still exactly one live instance')
        assert.equal(orch.fleet.instances[0].id, firstId, 'same connection id — never kicked + reconnected')
        // Polling recovered: the agent keeps answering, so more state replies flowed.
        assert.ok(stateSends > before + 1, 'polling resumed after the delayed reply was consumed')
    } finally {
        await agent.disconnect()
        await server.shutdown()
        await orch.shutdown()
    }
})

// ===========================================================================
// task 011 criterion 6 — a LOCAL room create surfaces in the read model within a
// poll interval (no event push anymore; the next poll carries it).
// ===========================================================================

// ===========================================================================
// task 003 — the §11 reservation visibility gap: a create that times out (504)
// while the agent actually created the room must NOT let the §10 retry-with-the-
// same-roomId double-create on another instance. The id reservation is held past
// the timeout until the owning instance's snapshot reconciles the room, so the
// retry gets a fast 409 ROOM_EXISTS instead.
// ===========================================================================

test('timeout → late success → retry with the same roomId returns ROOM_EXISTS, never a cross-instance duplicate (task 003)', async () => {
    const port = await freePort()
    const { ws, http } = baseUrlOf(port)
    // commandTimeout well under heartbeat, so the create times out BEFORE the room
    // reconciles via the next poll — the exact visibility-gap window.
    const orch = new Orchestrator({ ...orchestratorOptions(port), heartbeatMs: 800, commandTimeoutMs: 80 } as any)
    await orch.listen()

    // Agent A swallows the FIRST fleet/ack it would send: the orchestrator's create
    // times out (504) even though A actually created the room — the §10 late-ack case.
    // (Only the ack is dropped; A keeps answering polls, so it is never evicted.)
    let dropNextAck = true
    let realClientA: any = null
    const createClientA = (url: string) => {
        realClientA = new CoreWSClient(url, { ticketSource: 'protocol' })
        return {
            get connected() { return realClientA.connected },
            connect: (t?: string) => realClientA.connect(t),
            disconnect: () => realClientA.disconnect(),
            send: (topic: string, payload: Uint8Array) => {
                if (topic === Topics.ack && dropNextAck) { dropNextAck = false; return }
                realClientA.send(topic, payload)
            },
            on: (e: string, fn: (...a: any[]) => void) => realClientA.on(e, fn),
            off: (e: string, fn: (...a: any[]) => void) => realClientA.off(e, fn),
            removeAllListeners: (e?: string) => realClientA.removeAllListeners(e)
        }
    }

    const serverA = makeGameServer(['match'])
    const serverB = makeGameServer(['match'])
    const agentA = newAgent(serverA, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' }, { createClient: createClientA })
    const agentB = newAgent(serverB, ws, { endpointUrl: 'wss://us1.game.example.com', name: 'us1' })
    try {
        await agentA.connect()
        await agentB.connect()
        await waitFor(() => orch.fleet.instances.length === 2, 'both instances present')

        // Pin the create to A (the agent that drops the ack) so we know who creates it.
        const first = await rest(http, 'POST', '/v1/rooms',
            { type: 'match', roomId: 'dup-42', placement: { processUid: agentA.processUid } })
        assert.equal(first.status, 504, 'create times out (ack swallowed) → COMMAND_TIMEOUT')
        assert.equal(first.json.cause, 'COMMAND_TIMEOUT')
        // A really created the room despite the dropped ack (the §10 late-success case).
        assert.ok(serverA.rooms.get('dup-42') !== null, 'A actually created the room')

        // Retry per the §10 contract with the SAME roomId. With the fix the id is still
        // reserved (held past the timeout), so this is a fast 409 ROOM_EXISTS — and it
        // must NEVER place a second 'dup-42' on B.
        const retry = await rest(http, 'POST', '/v1/rooms', { type: 'match', roomId: 'dup-42' })
        assert.equal(retry.status, 409, 'retry returns 409 ROOM_EXISTS, not a duplicate or a 502')
        assert.equal(retry.json.cause, 'ROOM_EXISTS')
        assert.equal(serverB.rooms.get('dup-42'), null, 'no duplicate room was created on the other instance')

        // Eventually the room reconciles into the read model from A's own snapshot.
        const reconciled = await waitFor(() => orch.fleet.getRoom('dup-42'), 'the room reconciles from the owning snapshot', 4000)
        const idA = orch.fleet.instances.find((i) => i.processUid === agentA.processUid)!.id
        assert.equal(reconciled.instanceId, idA, 'the room belongs to the instance that created it')

        // A later retry still 409s — now via the read model rather than the held reservation.
        const retry2 = await rest(http, 'POST', '/v1/rooms', { type: 'match', roomId: 'dup-42' })
        assert.equal(retry2.status, 409)
        assert.equal(retry2.json.cause, 'ROOM_EXISTS')
        assert.equal(serverB.rooms.get('dup-42'), null, 'still no duplicate on the other instance')
    } finally {
        await agentA.disconnect()
        await agentB.disconnect()
        await serverA.shutdown()
        await serverB.shutdown()
        await orch.shutdown()
    }
})

test('a local room create surfaces in the read model within a poll interval', async () => {
    const port = await freePort()
    const { ws } = baseUrlOf(port)
    const orch = new Orchestrator(orchestratorOptions(port) as any) // heartbeat 60 ms
    await orch.listen()

    const server = makeGameServer(['match'])
    const agent = newAgent(server, ws, { endpointUrl: 'wss://eu1.game.example.com', name: 'eu1' })
    try {
        await agent.connect()
        await waitFor(() => orch.fleet.instances.length === 1, 'joined')

        // Create a room directly on the instance (origin:local) — it pushes nothing.
        server.rooms.create('match', 'local-late')
        assert.equal(orch.fleet.getRoom('local-late'), null, 'not visible yet — local changes do not push (task 011)')

        // It surfaces at the next poll; latency is bounded by the poll cadence.
        const start = Date.now()
        const room = await waitFor(() => orch.fleet.getRoom('local-late'), 'local room surfaces at the next poll', 2000)
        assert.ok(Date.now() - start < 1500, 'surfaced within a small multiple of the 60 ms poll interval')
        assert.equal(room.local, true, 'a directly-created room is origin:local')
    } finally {
        await agent.disconnect()
        await server.shutdown()
        await orch.shutdown()
    }
})
