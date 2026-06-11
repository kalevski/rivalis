import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FleetState, FleetError } from '../lib/FleetState.js'

// ---------------------------------------------------------------------------
// Helpers. FleetState consumes validated `fleet/sync` payloads; these builders
// produce well-formed snapshots so the tests focus on the read model and
// placement engine (field validation is §13 / task 011, upstream of here).
// ---------------------------------------------------------------------------

let seqCounter = 0

function snapshot(over: any = {}): any {
    return {
        seq: over.seq ?? ++seqCounter,
        hash: over.hash ?? 'h',
        name: over.name ?? 'eu1',
        processUid: over.processUid ?? 'p_eu1',
        agentVersion: over.agentVersion ?? '1.0.0',
        protocolVersion: over.protocolVersion ?? 1,
        endpointUrl: over.endpointUrl ?? 'wss://eu1.game.example.com',
        labels: over.labels ?? {},
        capacity: over.capacity ?? { maxConnections: null, maxRooms: null },
        autoCreate: over.autoCreate ?? true,
        roomTypes: over.roomTypes ?? ['match'],
        rooms: over.rooms ?? [],
        status: over.status ?? 'active'
    }
}

function room(id: string, over: any = {}): any {
    return {
        id,
        type: over.type ?? 'match',
        connections: over.connections ?? 0,
        origin: over.origin ?? 'fleet'
    }
}

/** Deterministic RNG that always picks the first tied candidate (index 0). */
const PICK_FIRST = () => 0

// ---------------------------------------------------------------------------
// Read model: snapshot → InstanceInfo / RoomInfo.
// ---------------------------------------------------------------------------

test('applySnapshot builds the read model with summed connections and agent-reported local flag', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({
        name: 'eu1', endpointUrl: 'wss://eu1', labels: { region: 'eu' },
        capacity: { maxConnections: 100, maxRooms: 10 },
        rooms: [room('r1', { connections: 3, origin: 'fleet' }), room('r2', { connections: 5, origin: 'local' })]
    }), 1000)

    const instance = state.getInstance('i_a')
    assert.ok(instance)
    assert.equal(instance!.name, 'eu1')
    assert.equal(instance!.connections, 8, 'connections summed across rooms')
    assert.deepEqual(instance!.labels, { region: 'eu' })
    assert.equal(instance!.lastSyncAt, 1000)

    const r1 = state.getRoom('r1')!
    assert.equal(r1.local, false, 'origin=fleet → local:false')
    assert.equal(r1.endpointUrl, 'wss://eu1', 'endpointUrl denormalized from instance')
    assert.equal(r1.instanceId, 'i_a')
    assert.equal(state.getRoom('r2')!.local, true, 'origin=local → local:true')

    assert.equal(state.rooms.length, 2)
    assert.equal(state.instances.length, 1)
    assert.equal(state.getInstance('missing'), null)
    assert.equal(state.getRoom('missing'), null)
})

test('findRooms filters by type, instanceId, and owning-instance labels', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ processUid: 'p_a', labels: { region: 'eu' }, roomTypes: ['match', 'lobby'],
        rooms: [room('a1', { type: 'match' }), room('a2', { type: 'lobby' })] }), 1)
    state.applySnapshot('i_b', snapshot({ processUid: 'p_b', labels: { region: 'us' }, roomTypes: ['match'],
        rooms: [room('b1', { type: 'match' })] }), 1)

    assert.deepEqual(state.findRooms({ type: 'match' }).map((r) => r.id).sort(), ['a1', 'b1'])
    assert.deepEqual(state.findRooms({ instanceId: 'i_a' }).map((r) => r.id).sort(), ['a1', 'a2'])
    assert.deepEqual(state.findRooms({ labels: { region: 'eu' } }).map((r) => r.id).sort(), ['a1', 'a2'])
    assert.deepEqual(state.findRooms({ type: 'match', labels: { region: 'us' } }).map((r) => r.id), ['b1'])
})

test('removeInstance drops it from the read model and returns the prior info', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ rooms: [room('r1')] }), 1)
    const removed = state.removeInstance('i_a')
    assert.equal(removed!.id, 'i_a')
    assert.equal(state.getInstance('i_a'), null)
    assert.equal(state.rooms.length, 0)
    assert.equal(state.removeInstance('i_a'), null, 'second remove is a no-op')
})

// ---------------------------------------------------------------------------
// Acceptance: stateHash excludes lastSyncAt; changes on semantic state.
// ---------------------------------------------------------------------------

test('stateHash is unchanged when only lastSyncAt advances', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ hash: 'x', rooms: [room('r1', { connections: 2 })] }), 1000)
    const h0 = state.stats.stateHash

    state.touch('i_a', 5000)
    assert.equal(state.getInstance('i_a')!.lastSyncAt, 5000, 'lastSyncAt advanced')
    assert.equal(state.stats.stateHash, h0, 'liveness bookkeeping must not churn the stateHash')
})

test('stateHash changes on room/count/status/capacity changes', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ rooms: [room('r1', { connections: 1 })] }), 1)
    const base = state.stats.stateHash

    // connection count change
    state.applySnapshot('i_a', snapshot({ rooms: [room('r1', { connections: 2 })] }), 2)
    const afterCount = state.stats.stateHash
    assert.notEqual(afterCount, base, 'connection count change must change stateHash')

    // room added
    state.applySnapshot('i_a', snapshot({ rooms: [room('r1', { connections: 2 }), room('r2')] }), 3)
    const afterRoom = state.stats.stateHash
    assert.notEqual(afterRoom, afterCount, 'adding a room must change stateHash')

    // status change
    state.applySnapshot('i_a', snapshot({ status: 'draining', rooms: [room('r1', { connections: 2 }), room('r2')] }), 4)
    const afterStatus = state.stats.stateHash
    assert.notEqual(afterStatus, afterRoom, 'status change must change stateHash')

    // capacity change
    state.applySnapshot('i_a', snapshot({ status: 'draining', capacity: { maxConnections: 50, maxRooms: 5 },
        rooms: [room('r1', { connections: 2 }), room('r2')] }), 5)
    assert.notEqual(state.stats.stateHash, afterStatus, 'capacity change must change stateHash')
})

test('stateHash is independent of instance insertion order', () => {
    const a = new FleetState()
    a.applySnapshot('i_a', snapshot({ processUid: 'p_a', rooms: [room('r1')] }), 1)
    a.applySnapshot('i_b', snapshot({ processUid: 'p_b', rooms: [room('r2')] }), 1)

    const b = new FleetState()
    b.applySnapshot('i_b', snapshot({ processUid: 'p_b', rooms: [room('r2')] }), 9)
    b.applySnapshot('i_a', snapshot({ processUid: 'p_a', rooms: [room('r1')] }), 9)

    assert.equal(a.stats.stateHash, b.stats.stateHash, 'hash must not depend on Map iteration order or lastSyncAt')
})

// ---------------------------------------------------------------------------
// Acceptance: out-of-order seq snapshot dropped without read-model corruption.
// ---------------------------------------------------------------------------

test('out-of-order seq snapshot is dropped, never applied', () => {
    const state = new FleetState()
    assert.equal(state.applySnapshot('i_a', snapshot({ seq: 1, rooms: [room('r1', { connections: 1 })] }), 1), true)
    assert.equal(state.applySnapshot('i_a', snapshot({ seq: 3, rooms: [room('r1', { connections: 9 })] }), 2), true)

    // A stale seq=2 arriving after seq=3 must be dropped, leaving seq=3 state intact.
    const applied = state.applySnapshot('i_a', snapshot({ seq: 2, rooms: [room('r1', { connections: 0 }), room('rX')] }), 3)
    assert.equal(applied, false, 'lower seq must be dropped')
    assert.equal(state.getRoom('r1')!.connections, 9, 'read model retains the seq=3 state')
    assert.equal(state.getRoom('rX'), null, 'dropped frame must not leak rooms into the read model')

    // A duplicate seq is also dropped (strictly-increasing required).
    assert.equal(state.applySnapshot('i_a', snapshot({ seq: 3, rooms: [] }), 4), false, 'equal seq dropped')
    assert.equal(state.getRoom('r1')!.connections, 9)
})

test('seq resets per connection — a reconnect (new instanceId) accepts seq=1', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ seq: 5, rooms: [room('r1')] }), 1)
    // Reconnect yields a NEW instanceId, so its seq counter starts fresh.
    assert.equal(state.applySnapshot('i_b', snapshot({ seq: 1, processUid: 'p_a', rooms: [room('r1')] }), 2), true)
})

// ---------------------------------------------------------------------------
// Acceptance: placement scoring — least-loaded, mixed-capacity fallback,
// autoCreate filter, strategies.
// ---------------------------------------------------------------------------

test('least-loaded scores by connections/maxConnections when all declare capacity', () => {
    const state = new FleetState({ random: PICK_FIRST })
    // a: 80/100 = 0.80 ; b: 30/50 = 0.60 (lower ratio wins despite higher raw if it were raw)
    state.applySnapshot('a', snapshot({ processUid: 'pa', capacity: { maxConnections: 100, maxRooms: null }, rooms: [room('ra', { connections: 80 })] }), 1)
    state.applySnapshot('b', snapshot({ processUid: 'pb', capacity: { maxConnections: 50, maxRooms: null }, rooms: [room('rb', { connections: 30 })] }), 1)

    const { instance } = state.place({ type: 'match' })
    assert.equal(instance.id, 'b', 'normalized least-loaded picks the lower ratio')
})

test('mixed-capacity fallback: any undeclared maxConnections → score all by raw connections', () => {
    const state = new FleetState({ random: PICK_FIRST })
    // If normalized: a=0.99 (99/100), b=raw 50. Mixing scales would wrongly prefer b.
    // Fallback rule scores BOTH by raw connections → a (99) vs b (50) → b wins, correctly,
    // but we make the point sharp: give the undeclared one MORE raw connections so the
    // two scales would disagree.
    // a declares: 10/100 = 0.10 normalized, raw 10.
    // b undeclared: raw 50.
    // Normalized-vs-raw would compare 0.10 (a) to 50 (b) → a. Raw compares 10 to 50 → a too.
    // To prove the fallback engaged, use a config where normalized would flip the winner:
    // a declares 90/100 = 0.90 normalized, raw 90 ; b undeclared raw 50.
    // Normalized (wrong, mixing): 0.90 vs 50 → a. Raw (correct fallback): 90 vs 50 → b.
    state.applySnapshot('a', snapshot({ processUid: 'pa', capacity: { maxConnections: 100, maxRooms: null }, rooms: [room('ra', { connections: 90 })] }), 1)
    state.applySnapshot('b', snapshot({ processUid: 'pb', capacity: { maxConnections: null, maxRooms: null }, rooms: [room('rb', { connections: 50 })] }), 1)

    const { instance } = state.place({ type: 'match' })
    assert.equal(instance.id, 'b', 'with any undeclared capacity, all candidates score by raw connections')
})

test('most-loaded picks the highest score; random ignores load', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ processUid: 'pa', capacity: { maxConnections: null, maxRooms: null }, rooms: [room('ra', { connections: 5 })] }), 1)
    state.applySnapshot('b', snapshot({ processUid: 'pb', capacity: { maxConnections: null, maxRooms: null }, rooms: [room('rb', { connections: 50 })] }), 1)

    assert.equal(state.place({ type: 'match', strategy: 'most-loaded' }).instance.id, 'b')
    assert.equal(state.place({ type: 'match', strategy: 'least-loaded' }).instance.id, 'a')
    // random with rng=0 picks index 0 of the candidate list (insertion order).
    assert.equal(state.place({ type: 'match', strategy: 'random' }).instance.id, 'a')
})

test('autoCreate:false instances are never candidates', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ processUid: 'pa', autoCreate: false, rooms: [] }), 1)
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e instanceof FleetError && e.code === 'NO_CANDIDATE')

    // Add an autoCreate:true instance — now placement succeeds, choosing only it.
    state.applySnapshot('b', snapshot({ processUid: 'pb', autoCreate: true, rooms: [] }), 1)
    assert.equal(state.place({ type: 'match' }).instance.id, 'b')
})

test('candidates must host the requested room type and match all labels', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ processUid: 'pa', roomTypes: ['lobby'], labels: { region: 'eu' } }), 1)
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    state.applySnapshot('b', snapshot({ processUid: 'pb', roomTypes: ['match'], labels: { region: 'us' } }), 1)
    assert.throws(() => state.place({ type: 'match', labels: { region: 'eu' } }), (e: any) => e.code === 'NO_CANDIDATE')
    assert.equal(state.place({ type: 'match', labels: { region: 'us' } }).instance.id, 'b')
})

test('draining instances are excluded from auto-placement', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ processUid: 'pa', status: 'draining' }), 1)
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')
})

// ---------------------------------------------------------------------------
// task 004 — pending placement-status override: a drain/undrain ack shifts the
// effective status for placement before the read model catches up, without ever
// writing the agent-owned `status`.
// ---------------------------------------------------------------------------

test('setPendingStatus(draining) excludes from placement while the read model still reports active (task 004)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ processUid: 'pa', status: 'active' }), 1)

    state.setPendingStatus('a', 'draining')
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')
    // Status ownership intact: the read model still carries the agent-reported value.
    assert.equal(state.getInstance('a')!.status, 'active', 'read-model status untouched by the override (§7)')
})

test('setPendingStatus(active) re-includes a draining instance for placement (task 004)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ processUid: 'pa', status: 'draining' }), 1)
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    state.setPendingStatus('a', 'active')
    assert.equal(state.place({ type: 'match' }).instance.id, 'a')
    assert.equal(state.getInstance('a')!.status, 'draining', 'read-model status untouched by the override (§7)')
})

test('a placement override is dropped once a snapshot confirms the matching status, never stuck (task 004)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('a', snapshot({ seq: 1, processUid: 'pa', status: 'active' }), 1)

    // Drain ack → override excludes.
    state.setPendingStatus('a', 'draining')
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    // The agent's next snapshot carries draining → read model catches up; override clears.
    state.applySnapshot('a', snapshot({ seq: 2, hash: 'h2', processUid: 'pa', status: 'draining' }), 2)
    // A later undrain snapshot must make it a candidate again purely through the read-model
    // status — proving the override did not get stuck after the read model took over.
    state.applySnapshot('a', snapshot({ seq: 3, hash: 'h3', processUid: 'pa', status: 'active' }), 3)
    assert.equal(state.place({ type: 'match' }).instance.id, 'a')
})

test('setPendingStatus on an unknown instance is a no-op (task 004)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.setPendingStatus('ghost', 'draining')
    state.applySnapshot('ghost', snapshot({ processUid: 'pg', status: 'active' }), 1)
    // The override was never recorded (no instance at the time), so placement sees active.
    assert.equal(state.place({ type: 'match' }).instance.id, 'ghost')
})

// ---------------------------------------------------------------------------
// Acceptance: pinning.
// ---------------------------------------------------------------------------

test('pinning by instanceId / processUid; both set → VALIDATION; unknown → INSTANCE_NOT_FOUND', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ processUid: 'p_a' }), 1)

    assert.equal(state.place({ type: 'match', instanceId: 'i_a' }).instance.id, 'i_a')
    assert.equal(state.place({ type: 'match', processUid: 'p_a' }).instance.id, 'i_a')
    assert.throws(() => state.place({ type: 'match', instanceId: 'i_a', processUid: 'p_a' }),
        (e: any) => e.code === 'VALIDATION')
    assert.throws(() => state.place({ type: 'match', instanceId: 'nope' }),
        (e: any) => e.code === 'INSTANCE_NOT_FOUND')
    assert.throws(() => state.place({ type: 'match', processUid: 'nope' }),
        (e: any) => e.code === 'INSTANCE_NOT_FOUND')
})

test('pinned placement bypasses type/labels filters but not status (force required for draining)', () => {
    const state = new FleetState()
    // Draining + does not host the type + label mismatch: a pin still resolves it,
    // but draining without force is rejected; force overrides only the status gate.
    state.applySnapshot('i_a', snapshot({ processUid: 'p_a', status: 'draining', roomTypes: ['lobby'], labels: { region: 'us' } }), 1)

    assert.throws(() => state.place({ type: 'match', instanceId: 'i_a' }),
        (e: any) => e instanceof FleetError && e.code === 'INSTANCE_DRAINING')
    // force bypasses the draining gate; type/labels are not enforced for pins.
    assert.equal(state.place({ type: 'match', instanceId: 'i_a', force: true }).instance.id, 'i_a')
})

test('pinned placement still respects autoCreate', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ processUid: 'p_a', autoCreate: false }), 1)
    assert.throws(() => state.place({ type: 'match', instanceId: 'i_a' }),
        (e: any) => e.code === 'NO_CANDIDATE')
})

// ---------------------------------------------------------------------------
// task 011 — processUid resolves to the NEWEST connection (reconnect overlap),
// and pinning to a stale instance fails fast instead of waiting out the timeout.
// ---------------------------------------------------------------------------

test('pinning by processUid targets the newest connection during a reconnect overlap (task 011)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    // Reconnect overlap: the old wedged connection (i_old) is still present and
    // marked stale; the agent has reconnected as i_new under the SAME processUid.
    state.applySnapshot('i_old', snapshot({ processUid: 'p_eu1' }), 1)   // lower joinSeq
    state.applySnapshot('i_new', snapshot({ processUid: 'p_eu1' }), 1)   // higher joinSeq (newest)
    state.setStale('i_old', true)

    // processUid is the documented stable handle across reconnects — it must resolve
    // to the LIVE new connection. First-match (map insertion order) would have picked
    // i_old, the dead connection in exactly the scenario the pin exists for.
    assert.equal(state.place({ type: 'match', processUid: 'p_eu1' }).instance.id, 'i_new')
    // The read API resolves identically.
    assert.equal(state.getInstanceByProcessUid('p_eu1')!.id, 'i_new')
    assert.equal(state.getInstanceByProcessUid('nope'), null, 'unknown processUid → null')
})

test('pinning to a stale instance fails fast with INSTANCE_DISCONNECTED; force overrides (task 011)', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ processUid: 'p_a' }), 1)
    state.setStale('i_a', true)   // 2 missed poll replies → stale (likely wedged/disconnecting)

    // Stale pin → fast coded failure the caller can retry on, not a slow COMMAND_TIMEOUT.
    // Strategy placement already excludes a stale instance; the pinned path now matches.
    assert.throws(() => state.place({ type: 'match', instanceId: 'i_a' }),
        (e: any) => e instanceof FleetError && e.code === 'INSTANCE_DISCONNECTED')
    assert.throws(() => state.place({ type: 'match', processUid: 'p_a' }),
        (e: any) => e instanceof FleetError && e.code === 'INSTANCE_DISCONNECTED')

    // force: true bypasses the staleness gate (mirrors the draining rule).
    assert.equal(state.place({ type: 'match', instanceId: 'i_a', force: true }).instance.id, 'i_a')
})

// ---------------------------------------------------------------------------
// Acceptance: reservation race — N parallel placements never overshoot
// maxRooms; reservations released restore headroom; maxConnections respected.
// ---------------------------------------------------------------------------

test('N parallel placements never overshoot maxRooms (reservation race)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    // Capacity for 5 rooms, 3 already exist → headroom for exactly 2 more.
    state.applySnapshot('i_a', snapshot({
        capacity: { maxConnections: null, maxRooms: 5 },
        rooms: [room('r1'), room('r2'), room('r3')]
    }), 1)

    // 10 concurrent placement decisions (synchronous — no awaits between them).
    const results: Array<{ ok: boolean; code?: string }> = []
    const reservations = []
    for (let i = 0; i < 10; i++) {
        try {
            const placement = state.place({ type: 'match' })
            reservations.push(placement.reservation)
            results.push({ ok: true })
        } catch (e: any) {
            results.push({ ok: false, code: e.code })
        }
    }

    const successes = results.filter((r) => r.ok).length
    assert.equal(successes, 2, 'reservations cap successes at the remaining headroom (5 - 3)')
    assert.equal(state.reservedRooms('i_a'), 2, 'two in-flight reservations held')
    assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'NO_CANDIDATE'),
        'over-capacity requests fail with NO_CANDIDATE')

    // 3 existing + 2 reserved = 5 = maxRooms → no overshoot.
    assert.ok(state.getInstance('i_a')!.rooms.length + state.reservedRooms('i_a') <= 5)
})

test('releasing a reservation restores headroom for the next placement', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('i_a', snapshot({ capacity: { maxConnections: null, maxRooms: 1 }, rooms: [] }), 1)

    const first = state.place({ type: 'match' })
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    state.release(first.reservation)
    assert.equal(state.reservedRooms('i_a'), 0)
    // Headroom restored — placement succeeds again.
    assert.ok(state.place({ type: 'match' }))

    // release is idempotent.
    state.release(first.reservation)
    assert.equal(state.reservedRooms('i_a'), 1)
})

test('connection-saturated instances are excluded so placement never overshoots maxConnections', () => {
    const state = new FleetState({ random: PICK_FIRST })
    // connections (10) == maxConnections (10) → no headroom, never selected.
    state.applySnapshot('full', snapshot({ processUid: 'pf', capacity: { maxConnections: 10, maxRooms: null }, rooms: [room('rf', { connections: 10 })] }), 1)
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    // An instance with connection headroom is selectable; placing empty rooms
    // never raises its connection count, so maxConnections is never overshot.
    state.applySnapshot('open', snapshot({ processUid: 'po', capacity: { maxConnections: 10, maxRooms: null }, rooms: [room('ro', { connections: 9 })] }), 1)
    const placement = state.place({ type: 'match' })
    assert.equal(placement.instance.id, 'open')
    assert.ok(state.getInstance('open')!.connections <= 10, 'connection count never exceeds maxConnections')
})

// ---------------------------------------------------------------------------
// Acceptance: the id-resolution pass and the state-hash are memoized between
// mutations — computed once per SEMANTIC mutation, not once per query (task 009).
// Counter seam: the read model logs a distinct `debug(...)` line each time it
// rebuilds the resolution view / recomputes the hash, so a counting logger
// pins the recompute frequency without any public-API change.
// ---------------------------------------------------------------------------

/** Logger that counts the task-009 recompute markers (resolution view / state hash). */
function countingLogger(): { logger: any; resolves: () => number; hashes: () => number } {
    const debugs: string[] = []
    const logger = {
        error() {}, warning() {}, info() {},
        debug(msg: string) { debugs.push(msg) },
        verbose() {}, log() {}
    }
    return {
        logger,
        resolves: () => debugs.filter((m) => m.includes('rebuilt id-resolution view')).length,
        hashes: () => debugs.filter((m) => m.includes('computed semantic state hash')).length
    }
}

test('resolution + state-hash compute once per semantic mutation, not per query', () => {
    const { logger, resolves, hashes } = countingLogger()
    const state = new FleetState({ logger })

    const N = 5
    for (let i = 0; i < N; i++) {
        // One semantic mutation (a brand-new instance) per iteration.
        state.applySnapshot(`i_${i}`, snapshot({ processUid: `p_${i}`, rooms: [room(`r_${i}`, { connections: i })] }), i)
        // Many queries after each mutation: only the FIRST may recompute; the rest
        // must hit the memo. Mix every read-model entry point.
        for (let q = 0; q < 4; q++) {
            void state.instances
            void state.rooms
            void state.getInstance(`i_${i}`)
            void state.getRoom(`r_${i}`)
            void state.findRooms({ type: 'match' })
            void state.stats           // also drives the state-hash path
            void state.stats.stateHash // a second stats read in the same request (the §10 ETag case)
        }
    }

    assert.equal(resolves(), N, 'id-resolution pass runs exactly once per applied snapshot, not per query')
    assert.equal(hashes(), N, 'state hash computed exactly once per applied snapshot, not per stats read')
})

test('a dropped (out-of-order) snapshot does not invalidate the memo', () => {
    const { logger, resolves } = countingLogger()
    const state = new FleetState({ logger })

    state.applySnapshot('i_a', snapshot({ seq: 3, rooms: [room('r1', { connections: 9 })] }), 1)
    void state.instances                  // resolve #1
    assert.equal(resolves(), 1)

    // Lower seq → dropped, never applied → must not dirty the cache.
    assert.equal(state.applySnapshot('i_a', snapshot({ seq: 2, rooms: [room('rX')] }), 2), false)
    void state.instances
    void state.getRoom('r1')
    assert.equal(resolves(), 1, 'a dropped frame must leave the memo intact')
})

test('removeInstance invalidates the memo; subsequent read re-resolves', () => {
    const { logger, resolves } = countingLogger()
    const state = new FleetState({ logger })

    state.applySnapshot('i_a', snapshot({ rooms: [room('r1')] }), 1)
    void state.instances                  // resolve #1
    state.removeInstance('i_a')           // semantic mutation → invalidate
    assert.equal(state.instances.length, 0) // resolve #2 (rebuilt from empty records)
    assert.equal(resolves(), 2)

    // A no-op remove (already gone) must NOT invalidate.
    assert.equal(state.removeInstance('i_a'), null)
    void state.instances
    assert.equal(resolves(), 2, 'a no-op remove leaves the memo intact')
})

// ---------------------------------------------------------------------------
// Acceptance: lastSyncAt freshness after `touch` is explicit. `touch` is
// non-semantic — it must NOT re-resolve or re-hash — yet a read of the shared
// cached InstanceInfo must still observe the advanced lastSyncAt, and the
// stateHash must NOT churn (it excludes lastSyncAt, §6).
// ---------------------------------------------------------------------------

test('touch keeps lastSyncAt fresh in the cached view without re-resolving or re-hashing', () => {
    const { logger, resolves, hashes } = countingLogger()
    const state = new FleetState({ logger })

    state.applySnapshot('i_a', snapshot({ rooms: [room('r1', { connections: 2 })] }), 1000)
    const h0 = state.stats.stateHash       // resolve #1 + hash #1, memo populated
    assert.equal(state.getInstance('i_a')!.lastSyncAt, 1000)
    assert.equal(resolves(), 1)
    assert.equal(hashes(), 1)

    // Ping path: advance lastSyncAt on the live record.
    state.touch('i_a', 5000)

    // Freshness: the shared cached InstanceInfo reflects the new lastSyncAt...
    assert.equal(state.getInstance('i_a')!.lastSyncAt, 5000, 'cached view tracks lastSyncAt advanced by touch')
    assert.equal(state.instances[0]!.lastSyncAt, 5000)
    // ...with no re-resolution and no hash churn (liveness bookkeeping is excluded, §6).
    assert.equal(state.stats.stateHash, h0, 'stateHash excludes lastSyncAt — touch must not churn it')
    assert.equal(resolves(), 1, 'touch is non-semantic — no re-resolution')
    assert.equal(hashes(), 1, 'touch is non-semantic — no state-hash recompute')

    // touch on an unknown instance is a no-op and still must not invalidate.
    state.touch('missing', 9999)
    void state.instances
    assert.equal(resolves(), 1)
})

test('setStale is non-semantic — it does not invalidate the memo', () => {
    const { logger, resolves } = countingLogger()
    const state = new FleetState({ logger })

    state.applySnapshot('i_a', snapshot({ rooms: [room('r1')] }), 1)
    void state.instances                  // resolve #1
    state.setStale('i_a', true)
    state.setStale('i_a', false)
    void state.instances
    void state.getRoom('r1')
    assert.equal(resolves(), 1, 'stale marking is excluded from the resolution and hash (§6)')
})

// ---------------------------------------------------------------------------
// Acceptance (task 003): a settled create's room id is held PAST the command
// settle (ack/timeout) until the room is visible in an applied snapshot from the
// owning instance — closing the §11 window where a 504-then-retry could
// re-reserve the id and double-create on another instance.
// ---------------------------------------------------------------------------

test('holdUntilVisible keeps the room id reserved and the slot counted until the next snapshot (task 003)', () => {
    const state = new FleetState({ random: PICK_FIRST })
    state.applySnapshot('i_a', snapshot({ seq: 1, capacity: { maxConnections: null, maxRooms: 2 }, rooms: [room('r1')] }), 1)

    // Reserve + place a create for 'hold-me' (exactly as FleetControl.createRoom does),
    // then settle it as acked: the command engine calls holdUntilVisible, not release.
    const idRes = state.reserveRoomId('hold-me')
    const placement = state.place({ type: 'match' })
    assert.equal(state.reservedRooms('i_a'), 1, 'in-flight capacity reservation held pre-ack')
    state.holdUntilVisible(idRes, placement.reservation)

    // Post-ack: the in-flight capacity token is released, but the slot is still counted
    // as pending-visibility — net headroom unchanged (1 room + 1 pending = maxRooms 2).
    assert.equal(state.reservedRooms('i_a'), 0, 'in-flight capacity token released on hold')
    assert.equal(state.pendingRooms('i_a'), 1, 'slot now counted as pending-visibility')

    // The id is STILL taken — a retry with the same id fails fast (the §11 fix).
    assert.throws(() => state.reserveRoomId('hold-me'), (e: any) => e instanceof FleetError && e.code === 'ROOM_EXISTS')
    // maxRooms headroom still counts it: 1 room + 1 pending == maxRooms → no candidate.
    assert.throws(() => state.place({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    // The owning instance's next snapshot — now carrying the created room — reconciles
    // it: the hold clears (the read model holds the id) and the pending slot frees up.
    state.applySnapshot('i_a', snapshot({ seq: 2, capacity: { maxConnections: null, maxRooms: 2 }, rooms: [room('r1'), room('hold-me')] }), 2)
    assert.equal(state.pendingRooms('i_a'), 0, 'pending cleared once the room is visible')
    assert.equal(state.getRoom('hold-me')!.local, false, 'the room is now in the read model (origin fleet)')
    // Still taken — now via the read model rather than the hold.
    assert.throws(() => state.reserveRoomId('hold-me'), (e: any) => e.code === 'ROOM_EXISTS')
})

test('a snapshot that does not carry a held room frees its id (create truly failed — task 003)', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ seq: 1, rooms: [] }), 1)
    const idRes = state.reserveRoomId('ghost')
    state.holdUntilVisible(idRes, state.place({ type: 'match' }).reservation)
    assert.throws(() => state.reserveRoomId('ghost'), (e: any) => e.code === 'ROOM_EXISTS')

    // Next snapshot from the owning instance still has no 'ghost' (the create failed) →
    // the hold is released and the id is reusable.
    state.applySnapshot('i_a', snapshot({ seq: 2, rooms: [] }), 2)
    assert.equal(state.pendingRooms('i_a'), 0)
    assert.ok(state.reserveRoomId('ghost'), 'id freed once the snapshot proves it absent')
})

test('a hash-only reply (touch) also reconciles a held room id within one poll (task 003)', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ rooms: [] }), 1)
    const idRes = state.reserveRoomId('via-touch')
    state.holdUntilVisible(idRes, state.place({ type: 'match' }).reservation)
    assert.equal(state.pendingRooms('i_a'), 1)

    // A hash-only liveness reply confirms current state == last applied (no 'via-touch'),
    // so the hold is released within one poll — not only at the every-12-poll forced full.
    state.touch('i_a', 2000)
    assert.equal(state.pendingRooms('i_a'), 0)
    assert.ok(state.reserveRoomId('via-touch'), 'touch reconciled the absent held id')
})

test('eviction/removeInstance clears held room ids — no reservation leak (task 003)', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ capacity: { maxConnections: null, maxRooms: 5 }, rooms: [] }), 1)
    const idRes = state.reserveRoomId('on-evicted')
    state.holdUntilVisible(idRes, state.place({ type: 'match' }).reservation)
    assert.equal(state.pendingRooms('i_a'), 1)

    // The instance is evicted (socket close / liveness) — its rooms vanish, so the held
    // id is released with it (any room it created is gone too).
    state.removeInstance('i_a')
    assert.equal(state.pendingRooms('i_a'), 0, 'no pending-visibility leak after eviction')
    assert.ok(state.reserveRoomId('on-evicted'), 'the held id is reusable after eviction')
})
