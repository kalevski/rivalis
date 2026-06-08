import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { Orchestrator, controlPlaneRateLimiterOptions } from '../lib/Orchestrator.js'
import { MAX_INFLIGHT_COMMANDS, PROTOCOL_VERSION, Topics, encodeFrame } from '../lib/wire.js'

// core via its CJS entry (its ESM build pulls a broken serializer ESM — see agent.test).
const require = createRequire(import.meta.url)
const { TokenBucketRateLimiter } = require('@rivalis/core') as typeof import('@rivalis/core')

// ---------------------------------------------------------------------------
// Test doubles. The control plane runs entirely against AgentLink seams and an
// injectable scheduler, so these tests drive join/poll/state/ack and the
// command + poller engine directly — no live WebSocket (§15). `listen()` is the
// only path that touches core/network and is exercised by task 013.
//
// Strict orchestrator-driven request/reply (task 011): the orchestrator polls
// (fleet/poll) and the agent replies (fleet/state). A reply must match an
// outstanding poll's reqId; an unsolicited / duplicate / post-settle frame is a
// kick. Liveness is measured by MISSED poll replies (2 → stale, 3 → evict).
// ---------------------------------------------------------------------------

/** Virtual-time scheduler: timers fire deterministically as `advance` crosses them. */
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
        /** Advance virtual time, firing due timers in chronological order. */
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

/** A fake agent link that records every outbound frame. */
function makeAgent(instanceId: string) {
    const sent: Array<{ topic: string; payload: any }> = []
    let closed = false
    const link = {
        instanceId,
        send: (topic: string, payload: unknown) => { sent.push({ topic, payload }) },
        close: () => { closed = true }
    }
    return {
        link,
        sent,
        isClosed: () => closed,
        byTopic: (t: string) => sent.filter((m) => m.topic === t),
        lastPoll: () => sent.filter((m) => m.topic === Topics.poll).pop(),
        lastCmd: () => sent.filter((m) => m.topic === Topics.cmd).pop()
    }
}

// Encode an agent→orch frame exactly as the real agent does (§7, binary wire,
// task 005) — the topic selects the serializer message type.
const bytes = (topic: string, obj: unknown) => encodeFrame(topic, obj)

/** A full fleet/state body (the agent populates every field on a full reply). */
function statePayload(over: any = {}): any {
    return {
        reqId: over.reqId ?? 'poll_1',
        full: over.full ?? true,
        seq: over.seq ?? 1,
        hash: over.hash ?? 'h1',
        name: over.name ?? 'eu1',
        processUid: over.processUid ?? 'p1',
        agentVersion: over.agentVersion ?? '1.0.0',
        protocolVersion: over.protocolVersion ?? PROTOCOL_VERSION,
        endpointUrl: over.endpointUrl ?? 'wss://eu1.example.com',
        labels: over.labels ?? {},
        capacity: over.capacity ?? { maxConnections: null, maxRooms: null },
        autoCreate: over.autoCreate ?? true,
        roomTypes: over.roomTypes ?? ['match'],
        rooms: over.rooms ?? [],
        status: over.status ?? 'active'
    }
}

const room = (id: string, over: any = {}) => ({
    id, type: over.type ?? 'match', connections: over.connections ?? 0, origin: over.origin ?? 'fleet'
})

// api:false so resolveConfig does not require an adminKey (REST is task 010).
const BASE_OPTS = { port: 0, agentKey: 'agent-key', api: false as const }

function makeOrch(heartbeatMs = 5000, commandTimeoutMs = 10000) {
    const clock = makeClock()
    const orch = new Orchestrator(
        { ...BASE_OPTS, heartbeatMs, commandTimeoutMs },
        { scheduler: clock.scheduler, now: clock.now }
    )
    return { orch, clock }
}

/**
 * Join an agent and reply to its first poll with a full snapshot so it is a
 * placement candidate. handleAgentJoin sends hello + the first poll (knownHash:null
 * → forced full); the agent answers with a full fleet/state carrying its reqId.
 */
function joinSynced(orch: any, instanceId = 'i1', over: any = {}) {
    const agent = makeAgent(instanceId)
    orch.handleAgentJoin(agent.link)
    const poll = agent.lastPoll()!.payload
    orch.handleAgentMessage(instanceId, Topics.state, bytes(Topics.state, statePayload({ ...over, reqId: poll.reqId, full: true })))
    return agent
}

// ---------------------------------------------------------------------------
// Join handshake (§7): hello, then the first poll.
// ---------------------------------------------------------------------------

test('an agent that joins receives fleet/hello with its id, the protocol major, and the heartbeat, then a first poll', () => {
    const { orch } = makeOrch(7000)
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link)
    const hello = agent.byTopic(Topics.hello)[0]
    assert.ok(hello)
    assert.deepEqual(hello.payload, { instanceId: 'i1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 7000 })

    // hello is followed by the first poll (task 011): knownHash:null → forced full.
    const poll = agent.byTopic(Topics.poll)[0]
    assert.ok(poll, 'a first poll follows hello')
    assert.equal(poll.payload.knownHash, null, 'the first poll forces a full reply (no prior state)')
    assert.equal(poll.payload.status, 'active', 'the poll echoes the (default) recorded status')
    assert.equal(typeof poll.payload.reqId, 'string')
})

// ---------------------------------------------------------------------------
// Acceptance: the rate-limiter budget is re-derived for reply-only traffic — a
// full ack volley + the one poll reply must NOT kick (§7 budget coupling, §15).
// ---------------------------------------------------------------------------

test('control-plane rate-limiter budget is derived from MAX_INFLIGHT_COMMANDS and survives a worst-case reply burst', () => {
    const opts = controlPlaneRateLimiterOptions()
    const maxOutstanding = MAX_INFLIGHT_COMMANDS + 1 // acks + 1 poll reply (task 011)
    assert.equal(opts.capacity, 2 * maxOutstanding, 'capacity = 2× (in-flight cap + 1 poll)')
    assert.equal(opts.refillPerSecond, maxOutstanding, 'refill = in-flight cap + 1 poll')

    // Worst-case legitimate burst with no refill window: a full 32-ack volley plus
    // the one outstanding poll reply — every frame must pass (no kick).
    const limiter = new TokenBucketRateLimiter(opts)
    for (let i = 0; i < maxOutstanding; i++) {
        assert.equal(limiter.check('i1'), true, `frame ${i} of a legit reply burst must not be rate-limited`)
    }

    // Capacity boundary: exactly the derived capacity fits, beyond it is dropped.
    const boundary = new TokenBucketRateLimiter(opts)
    for (let i = 0; i < 2 * maxOutstanding; i++) { assert.equal(boundary.check('i2'), true) }
    assert.equal(boundary.check('i2'), false, 'beyond the derived capacity is dropped')

    // Sanity: core's DEFAULT limiter (capacity 30) WOULD kick during a 33-frame
    // reply burst — the derived budget exists to give legitimate replies headroom.
    const dflt = new TokenBucketRateLimiter()
    let kicked = false
    for (let i = 0; i < maxOutstanding; i++) { if (!dflt.check('i3')) { kicked = true } }
    assert.equal(kicked, true, 'the core default would kick during a worst-case reply burst')
})

// ---------------------------------------------------------------------------
// Acceptance: a wedged (connected, silent) agent → stale at 2 missed poll
// replies (excluded from placement), evicted at 3 (§15).
// ---------------------------------------------------------------------------

test('a wedged agent goes stale at 2 missed poll replies and is evicted at 3', async () => {
    const { orch, clock } = makeOrch(5000)
    const stales: any[] = []
    const leaves: any[] = []
    orch.on('instance:stale', (i: any) => stales.push(i))
    orch.on('instance:leave', (i: any) => leaves.push(i))

    const agent = joinSynced(orch, 'i1', { rooms: [room('r1')] })
    assert.ok(orch.fleet.getInstance('i1'), 'present after the first poll reply')

    // From here the agent answers NOTHING; each interval tick that finds the
    // previous poll unanswered counts as a missed reply.
    clock.advance(5000) // first tick saw poll#1 answered → missed 0; sends poll#2
    assert.equal(stales.length, 0)
    clock.advance(5000) // poll#2 unanswered → missed 1
    assert.equal(stales.length, 0)
    assert.equal(orch.fleet.getInstance('i1').status, 'active')

    clock.advance(5000) // missed 2 → stale; kept in the read model, excluded from placement
    assert.equal(stales.length, 1, 'instance:stale fired at 2 missed poll replies')
    assert.ok(orch.fleet.getInstance('i1'), 'a stale instance stays in the read model')
    await assert.rejects(orch.fleet.createRoom({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE',
        'a stale instance is excluded from auto-placement')

    clock.advance(5000) // missed 3 → evict; gone, socket kicked
    assert.equal(orch.fleet.getInstance('i1'), null, 'evicted at 3 missed poll replies')
    assert.equal(leaves.length, 1, 'instance:leave fired on eviction')
    assert.equal(agent.isClosed(), true, 'the wedged socket is kicked on eviction')
})

test('a poll-miss eviction rejects in-flight commands with INSTANCE_DISCONNECTED', async () => {
    // commandTimeoutMs far beyond the 3-missed-poll eviction so eviction settles first.
    const { orch, clock } = makeOrch(5000, 100000)
    const agent = joinSynced(orch, 'i1')

    const pending = orch.fleet.createRoom({ type: 'match', roomId: 'm1' })
    assert.ok(agent.lastCmd(), 'fleet/cmd was pushed')

    clock.advance(20000) // 3 missed poll replies → evict, rejecting in-flight commands
    await assert.rejects(pending, (e: any) => e.code === 'INSTANCE_DISCONNECTED')
    assert.equal(orch.fleet.getInstance('i1'), null, 'evicted')
    assert.equal(agent.isClosed(), true, 'the wedged socket is kicked on eviction')
})

test('answering every poll keeps a healthy agent from going stale', () => {
    const { orch, clock } = makeOrch(5000)
    const stales: any[] = []
    orch.on('instance:stale', (i: any) => stales.push(i))
    const agent = joinSynced(orch, 'i1')

    // Answer each poll (hash-only) before the next tick — liveness never lapses.
    for (let i = 0; i < 10; i++) {
        clock.advance(5000)
        const poll = agent.lastPoll()!.payload
        orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: false, seq: i + 2, hash: 'h1' })))
    }
    assert.equal(stales.length, 0, 'a live agent that answers every poll is never marked stale')
    assert.ok(orch.fleet.getInstance('i1'))
})

// ---------------------------------------------------------------------------
// Acceptance (task 002): a merely-SLOW agent (reply delayed past one interval but
// under the 3-miss evict threshold) is NOT kicked — it follows the stale→recover
// path. Regression for the bug where a missed tick reissued the poll, orphaning
// the previous reqId so the late reply was kicked as a "duplicate".
// ---------------------------------------------------------------------------

test('a poll reply delayed past one interval (but under evict) is not kicked — it goes stale then recovers (task 002)', () => {
    const { orch, clock } = makeOrch(5000)
    const stales: any[] = []
    const leaves: any[] = []
    orch.on('instance:stale', (i: any) => stales.push(i))
    orch.on('instance:leave', (i: any) => leaves.push(i))
    const agent = joinSynced(orch, 'i1') // poll#1 answered → no outstanding poll

    clock.advance(5000)                  // poll#2 issued (prev answered)
    const slow = agent.lastPoll()!.payload

    // The agent is busy: poll#2 is not answered within the interval. No new poll is
    // issued while one is outstanding, so the agent keeps seeing the SAME poll.
    clock.advance(5000)                  // tick: poll#2 unanswered → missed=1
    assert.equal(agent.lastPoll()!.payload.reqId, slow.reqId, 'no new poll while one is outstanding')
    clock.advance(5000)                  // missed=2 → stale (not kicked, not evicted)
    assert.equal(stales.length, 1, 'stale at 2 missed replies')
    assert.equal(agent.isClosed(), false, 'a merely-slow agent is not kicked')
    assert.ok(orch.fleet.getInstance('i1'), 'still in the read model while stale')

    // The long-delayed reply to the outstanding poll arrives (≈2.x intervals, < the
    // 3-miss evict). It matches the outstanding reqId → recovers; no kick.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: slow.reqId, full: false, seq: 2, hash: 'h1' })))
    assert.equal(agent.isClosed(), false, 'the late reply matches the outstanding poll → not kicked')
    assert.equal(leaves.length, 0, 'no eviction')
    assert.ok(orch.fleet.getInstance('i1'), 'recovered: still present')

    // Recovered → the stale exclusion is lifted; it is a placement candidate again.
    const pending = orch.fleet.createRoom({ type: 'match' })
    assert.ok(agent.lastCmd(), 'a recovered instance is a placement candidate again')
    pending.catch(() => {})

    // And polling resumes on the next tick (the consumed reply unblocked it).
    clock.advance(5000)
    assert.notEqual(agent.lastPoll()!.payload.reqId, slow.reqId, 'a new poll goes out after the reply is consumed')
    assert.ok(orch.fleet.getInstance('i1'), 'a recovered agent is not evicted')
})

test('a reply with a never-issued reqId still kicks even after a missed tick (task 002)', () => {
    const { orch, clock } = makeOrch(5000)
    const leaves: any[] = []
    orch.on('instance:leave', (i: any) => leaves.push(i))
    const agent = joinSynced(orch, 'i1')

    clock.advance(5000)                  // poll#2 issued
    clock.advance(5000)                  // poll#2 unanswered → missed=1 (still outstanding)

    // A reply carrying a reqId that was NEVER issued matches no outstanding poll → kick.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: 'poll_never', full: false, seq: 2, hash: 'h1' })))
    assert.equal(agent.isClosed(), true, 'a reply to a never-issued reqId is kicked')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the offender is torn down')
    assert.equal(leaves.length, 1)
})

// ---------------------------------------------------------------------------
// Acceptance: agent disconnect with commands in flight → immediate
// INSTANCE_DISCONNECTED, no timeout wait.
// ---------------------------------------------------------------------------

test('an agent disconnect rejects in-flight commands immediately with INSTANCE_DISCONNECTED', async () => {
    const { orch, clock } = makeOrch(5000, 10000)
    const agent = joinSynced(orch, 'i1')

    const pending = orch.fleet.createRoom({ type: 'match', roomId: 'match-1' })
    assert.ok(agent.lastCmd(), 'fleet/cmd was pushed')

    orch.handleAgentLeave('i1') // socket close

    await assert.rejects(pending, (e: any) => e.code === 'INSTANCE_DISCONNECTED')
    assert.equal(clock.now(), 0, 'rejection was immediate — no commandTimeoutMs wait elapsed')
})

// ---------------------------------------------------------------------------
// Acceptance: a command timeout followed by a late ack must not corrupt state
// or double-resolve. Under strict request/reply the post-settle ack is an
// unsolicited frame → kick (task 011) (§15).
// ---------------------------------------------------------------------------

test('a command timeout followed by a late ack kicks the agent (frame after settle) without double-resolving', async () => {
    const { orch, clock } = makeOrch(5000, 10000)
    const leaves: any[] = []
    orch.on('instance:leave', (i: any) => leaves.push(i))
    const agent = joinSynced(orch, 'i1')

    const pending = orch.fleet.createRoom({ type: 'match', roomId: 'match-1' })
    const cmd = agent.lastCmd()!.payload

    clock.advance(10000) // cross commandTimeoutMs (poll ticks also fire; missed≤1, no evict)
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_TIMEOUT')

    // A late ack for the now-settled command matches no pending command → unsolicited
    // → kick. No throw, no second settle.
    assert.doesNotThrow(() => orch.handleAgentMessage('i1', Topics.ack,
        bytes(Topics.ack, { cmdId: cmd.cmdId, ok: true, room: { id: 'match-1', type: 'match' } })))
    assert.equal(agent.isClosed(), true, 'a post-settle ack kicks the agent (§7 enforcement)')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the kicked instance is torn down')
    assert.equal(leaves.length, 1, 'instance:leave fired on the kick')
})

// ---------------------------------------------------------------------------
// Acceptance: snapshot dedup driven by the orchestrator's knownHash — a hash-only
// reply touches; a full reply applies (task 011).
// ---------------------------------------------------------------------------

test('the orchestrator polls with its knownHash; a hash-only reply touches, a full reply applies', () => {
    const { orch, clock } = makeOrch()
    const agent = joinSynced(orch, 'i1', { seq: 1, hash: 'h1', rooms: [room('r1', { connections: 1 })] })
    assert.equal(orch.fleet.getRoom('r1').connections, 1)

    // The next poll carries the orchestrator's last applied hash (h1) for dedup.
    clock.advance(5000)
    let poll = agent.lastPoll()!.payload
    assert.equal(poll.knownHash, 'h1', 'the poll carries the last applied hash')

    // A hash-only reply (unchanged) → liveness touch, no read-model change.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: false, seq: 2, hash: 'h1' })))
    assert.equal(orch.fleet.getRoom('r1').connections, 1, 'a hash-only reply leaves the read model unchanged')

    // A full reply with new state applies → the view updates.
    clock.advance(5000)
    poll = agent.lastPoll()!.payload
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: true, seq: 3, hash: 'h2', rooms: [room('r1', { connections: 7 })] })))
    assert.equal(orch.fleet.getRoom('r1').connections, 7, 'a full reply applies the new snapshot')
})

// ---------------------------------------------------------------------------
// Acceptance: enforcement — an unsolicited / duplicate / post-settle agent frame
// is kicked and evicted (§7 enforcement, task 011).
// ---------------------------------------------------------------------------

test('an unsolicited fleet/state (no outstanding poll) kicks and evicts the agent', () => {
    const { orch } = makeOrch()
    const leaves: any[] = []
    orch.on('instance:leave', (i: any) => leaves.push(i))
    const agent = joinSynced(orch, 'i1') // poll#1 already answered → no outstanding poll

    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: 'not-a-real-poll', full: true, seq: 9, hash: 'hx' })))
    assert.equal(agent.isClosed(), true, 'a spontaneous state reply is kicked')
    assert.equal(orch.fleet.getInstance('i1'), null, 'the offender is torn down')
    assert.equal(leaves.length, 1)
})

test('a duplicate fleet/state reply (reqId already consumed) kicks the agent', () => {
    const { orch, clock } = makeOrch()
    const agent = joinSynced(orch, 'i1')
    clock.advance(5000)
    const poll = agent.lastPoll()!.payload
    // First reply consumes the poll.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: false, seq: 2, hash: 'h1' })))
    assert.equal(agent.isClosed(), false, 'the first (matching) reply is accepted')
    // The duplicate matches no outstanding poll → kick.
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: false, seq: 3, hash: 'h1' })))
    assert.equal(agent.isClosed(), true, 'a duplicate reply is kicked')
})

// ---------------------------------------------------------------------------
// Acceptance: the 33rd concurrent command to one instance → INSTANCE_BUSY.
// ---------------------------------------------------------------------------

test('the 33rd concurrent command to one instance is rejected with INSTANCE_BUSY', async () => {
    const { orch } = makeOrch()
    const agent = joinSynced(orch, 'i1')

    const inflight: Array<Promise<unknown>> = []
    for (let i = 0; i < MAX_INFLIGHT_COMMANDS; i++) {
        inflight.push(orch.fleet.createRoom({ type: 'match' }).catch(() => {}))
    }
    assert.equal(agent.byTopic(Topics.cmd).length, MAX_INFLIGHT_COMMANDS, 'all 32 commands were pushed')

    await assert.rejects(orch.fleet.createRoom({ type: 'match' }), (e: any) => e.code === 'INSTANCE_BUSY')
    assert.equal(agent.byTopic(Topics.cmd).length, MAX_INFLIGHT_COMMANDS, 'the busy-rejected command never hit the wire')
    void inflight
})

// ---------------------------------------------------------------------------
// Command happy paths: create resolves with RoomInfo; drain/undrain ride the
// cmd/ack path.
// ---------------------------------------------------------------------------

test('createRoom places, pushes fleet/cmd, and resolves with RoomInfo on the ack', async () => {
    const { orch } = makeOrch()
    const agent = joinSynced(orch, 'i1')

    const pending = orch.fleet.createRoom({ type: 'match', roomId: 'match-1' })
    const cmd = agent.lastCmd()!.payload
    assert.equal(cmd.op, 'create')
    assert.equal(cmd.roomId, 'match-1')
    assert.equal(cmd.roomType, 'match')

    orch.handleAgentMessage('i1', Topics.ack, bytes(Topics.ack, { cmdId: cmd.cmdId, ok: true, room: { id: 'match-1', type: 'match' } }))
    const created = await pending
    assert.equal(created.id, 'match-1')
    assert.equal(created.type, 'match')
    assert.equal(created.instanceId, 'i1')
    assert.equal(created.endpointUrl, 'wss://eu1.example.com')
    assert.equal(created.local, false)
})

test('a command that the agent acks ok:false rejects with COMMAND_FAILED', async () => {
    const { orch } = makeOrch()
    const agent = joinSynced(orch, 'i1')
    const pending = orch.fleet.createRoom({ type: 'match', roomId: 'match-1' })
    const cmd = agent.lastCmd()!.payload
    orch.handleAgentMessage('i1', Topics.ack, bytes(Topics.ack, { cmdId: cmd.cmdId, ok: false, error: 'boom' }))
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_FAILED' && /boom/.test(e.message))
})

test('drainInstance asks via fleet/cmd {op:drain} and resolves on the ack', async () => {
    const { orch } = makeOrch()
    const agent = joinSynced(orch, 'i1')
    const pending = orch.fleet.drainInstance('i1')
    const cmd = agent.lastCmd()!.payload
    assert.equal(cmd.op, 'drain')
    orch.handleAgentMessage('i1', Topics.ack, bytes(Topics.ack, { cmdId: cmd.cmdId, ok: true }))
    await pending

    const undrain = orch.fleet.undrainInstance('i1')
    const cmd2 = agent.lastCmd()!.payload
    assert.equal(cmd2.op, 'undrain')
    orch.handleAgentMessage('i1', Topics.ack, bytes(Topics.ack, { cmdId: cmd2.cmdId, ok: true }))
    await undrain
})

test('the poll echoes the recorded status so the agent can confirm a drain (task 011)', () => {
    const { orch, clock } = makeOrch()
    const agent = joinSynced(orch, 'i1')
    // The agent reports draining on its next full state (status is part of its hash).
    clock.advance(5000)
    let poll = agent.lastPoll()!.payload
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: true, seq: 2, hash: 'h2', status: 'draining' })))
    assert.equal(orch.fleet.getInstance('i1').status, 'draining', 'the orchestrator records the agent-owned status')

    // The next poll echoes the recorded status — this is what resolves agent.drain().
    clock.advance(5000)
    poll = agent.lastPoll()!.payload
    assert.equal(poll.status, 'draining', 'the poll echoes the last recorded status')
})

test('control methods against an unknown instance are coded errors', async () => {
    const { orch } = makeOrch()
    await assert.rejects(orch.fleet.destroyRoom('nope'), (e: any) => e.code === 'ROOM_NOT_FOUND')
    await assert.rejects(orch.fleet.drainInstance('nope'), (e: any) => e.code === 'INSTANCE_NOT_FOUND')
})

// ---------------------------------------------------------------------------
// Events derived from the snapshot read model (§9).
// ---------------------------------------------------------------------------

test('instance:join / room:create / room:destroy / sync are emitted from snapshot diffs (poll replies)', () => {
    const { orch, clock } = makeOrch()
    const joins: any[] = []
    const roomCreates: any[] = []
    const roomDestroys: any[] = []
    let syncs = 0
    orch.on('instance:join', (i: any) => joins.push(i))
    orch.on('room:create', (r: any) => roomCreates.push(r))
    orch.on('room:destroy', (r: any) => roomDestroys.push(r))
    orch.on('sync', () => { syncs++ })

    const agent = joinSynced(orch, 'i1', { seq: 1, hash: 'a', rooms: [room('r1')] })
    assert.equal(joins.length, 1, 'instance:join on the first poll reply')
    assert.equal(roomCreates.length, 1, 'room:create for r1')
    assert.equal(roomCreates[0].id, 'r1')

    const replyFull = (over: any) => {
        clock.advance(5000)
        const poll = agent.lastPoll()!.payload
        orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ ...over, reqId: poll.reqId, full: true })))
    }

    // Add a room.
    replyFull({ seq: 2, hash: 'b', rooms: [room('r1'), room('r2')] })
    assert.equal(roomCreates.length, 2, 'room:create for r2')

    // Remove r1.
    replyFull({ seq: 3, hash: 'c', rooms: [room('r2')] })
    assert.equal(roomDestroys.length, 1, 'room:destroy for r1')
    assert.equal(roomDestroys[0].id, 'r1')
    assert.ok(syncs >= 3, 'a sync event fires on each semantic change')
})

// ---------------------------------------------------------------------------
// Acceptance (task 005): the orchestrator's timer/transport/core-dispatch entry
// points are guarded — one throw must degrade to a logged failure on one
// instance, never an orchestrator-wide crash (§14). The agent wraps these in
// guard() already; the orchestrator is the single point of coordination, so the
// same contract is load-bearing here.
// ---------------------------------------------------------------------------

test('a throwing AgentLink.send during a poll tick is contained — no crash, the instance survives and goes stale (task 005)', () => {
    const { orch, clock } = makeOrch(5000)
    const stales: any[] = []
    orch.on('instance:stale', (i: any) => stales.push(i))

    // A link whose poll send throws once armed (e.g. core Room.send against a
    // half-closed actor). hello/state sends still go through so the instance syncs.
    let throwOnPoll = false
    const sent: Array<{ topic: string; payload: any }> = []
    const link = {
        instanceId: 'i1',
        send: (topic: string, payload: unknown) => {
            if (throwOnPoll && topic === Topics.poll) { throw new Error('core Room.send: bad actor state') }
            sent.push({ topic, payload })
        },
        close: () => {}
    }
    orch.handleAgentJoin(link)
    const firstPoll = sent.filter((m) => m.topic === Topics.poll).pop()!.payload
    orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: firstPoll.reqId, full: true })))
    assert.ok(orch.fleet.getInstance('i1'), 'synced and present after the first poll reply')

    // Arm the throw: from now every poll send throws inside the Poller's raw timer.
    throwOnPoll = true
    // The scheduler callback must NOT propagate the throw (an uncaughtException would
    // crash the whole control plane). The outstanding reqId is still recorded, so the
    // unanswered polls accrue as missed replies → stale, exactly the wedged path.
    assert.doesNotThrow(() => clock.advance(5000), 'poll send throw does not escape the scheduler callback')
    assert.doesNotThrow(() => clock.advance(5000))
    assert.doesNotThrow(() => clock.advance(5000))
    assert.equal(stales.length, 1, 'the instance is marked stale via missed poll replies, not a crash')
    assert.ok(orch.fleet.getInstance('i1'), 'the instance survived orchestrator-side (logged, not crashed)')
})

test('a throw inside snapshot application is logged and contained — the connection survives, no crash (task 005)', () => {
    const { orch } = makeOrch()
    const agent = makeAgent('i1')
    orch.handleAgentJoin(agent.link)
    const poll = agent.lastPoll()!.payload

    // Simulate a read-model bug: applySnapshot throws while applying a valid full reply.
    // The poll reply already consumed its reqId (liveness stands); the throw must be
    // contained inside core's room dispatch, not propagated.
    ;(orch as any).state.applySnapshot = () => { throw new Error('read-model bug') }

    assert.doesNotThrow(
        () => orch.handleAgentMessage('i1', Topics.state, bytes(Topics.state, statePayload({ reqId: poll.reqId, full: true }))),
        'a throw in snapshot application is contained, not propagated into core dispatch'
    )
    assert.equal(agent.isClosed(), false, 'a contained read-model throw is not a protocol violation — the connection survives')
})
