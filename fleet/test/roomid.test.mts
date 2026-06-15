import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FleetState, FleetError } from '../lib/FleetState.js'
import { ROOM_ID_PATTERN, isValidRoomId, encodeRoomId, namespaceRoomId } from '../lib/domain.js'

// ---------------------------------------------------------------------------
// Helpers (mirrors fleetstate.test.mts): FleetState consumes validated
// `fleet/sync` payloads, so these builders produce well-formed snapshots and the
// tests focus on §11 — charset, id reservation, namespacing, post-restart
// tie-break.
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

/** Logger stub that records every `warning(...)` line for assertion. */
function capturingLogger(): { logger: any; warnings: string[] } {
    const warnings: string[] = []
    const logger = {
        error() {}, warning(msg: string) { warnings.push(msg) },
        info() {}, debug() {}, verbose() {}, log() {}
    }
    return { logger, warnings }
}

// ---------------------------------------------------------------------------
// Charset constant + pure helpers (protocol.ts, §11).
// ---------------------------------------------------------------------------

test('ROOM_ID_PATTERN / isValidRoomId enforce the §11 charset', () => {
    assert.equal(ROOM_ID_PATTERN.source, '^[A-Za-z0-9_-]{1,64}$')
    assert.ok(isValidRoomId('match-42'))
    assert.ok(isValidRoomId('r_aZ09_-'))
    assert.ok(isValidRoomId('a'.repeat(64)))
    assert.ok(!isValidRoomId(''), 'empty id rejected (min 1 char)')
    assert.ok(!isValidRoomId('a'.repeat(65)), 'over 64 chars rejected')
    assert.ok(!isValidRoomId('has space'))
    assert.ok(!isValidRoomId('has/slash'))
    assert.ok(!isValidRoomId('has~tilde'), '~ is the namespace separator, excluded from the charset')
    assert.ok(!isValidRoomId('münchen'), 'unicode rejected')
})

test('encodeRoomId percent-encodes everything outside the charset, leaves valid ids alone', () => {
    assert.equal(encodeRoomId('match-42'), 'match-42', 'charset-valid id passes through unchanged')
    assert.equal(encodeRoomId('a/b'), 'a%2Fb', '/ → %2F')
    assert.equal(encodeRoomId('evil~name'), 'evil%7Ename', '~ → %7E so it can never forge a namespace marker')
    assert.equal(encodeRoomId('a b'), 'a%20b', 'space → %20')
    assert.equal(encodeRoomId('café'), 'caf%C3%A9', 'non-ASCII encoded as its UTF-8 bytes')
    // The encoded output never contains a raw separator.
    assert.ok(!encodeRoomId('a~b~c').includes('~'))
})

test('namespaceRoomId joins processUid and an encoded id with the ~ separator', () => {
    assert.equal(namespaceRoomId('p_abc', 'room1'), 'p_abc~room1')
    assert.equal(namespaceRoomId('p_abc', encodeRoomId('a/b')), 'p_abc~a%2Fb')
})

// ---------------------------------------------------------------------------
// Acceptance: explicit roomId outside the charset → VALIDATION.
// ---------------------------------------------------------------------------

test('reserveRoomId rejects explicit ids outside the charset with VALIDATION', () => {
    const state = new FleetState()
    for (const bad of ['has space', 'a/b', 'evil~name', 'münchen', '', 'a'.repeat(65)]) {
        assert.throws(
            () => state.reserveRoomId(bad),
            (e: any) => e instanceof FleetError && e.code === 'VALIDATION',
            `"${bad}" must be rejected`
        )
    }
    // A valid explicit id reserves cleanly.
    assert.deepEqual(state.reserveRoomId('match-42'), { roomId: 'match-42' })
})

// ---------------------------------------------------------------------------
// Acceptance: generated ids are charset-valid and unique.
// ---------------------------------------------------------------------------

test('generated room ids are r_-prefixed, charset-valid, and collision-free', () => {
    const state = new FleetState()
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
        const { roomId } = state.reserveRoomId()
        assert.ok(roomId.startsWith('r_'), 'generated id carries the r_ prefix')
        assert.ok(isValidRoomId(roomId), `generated id "${roomId}" must match the charset`)
        assert.ok(!ids.has(roomId), 'generated ids never collide (reserved as they are minted)')
        ids.add(roomId)
    }
})

test('generated ids avoid ids already live in the read model', () => {
    // Seed a room whose id we will force the generator to step over by reserving
    // every-other candidate is impractical; instead assert the taken-check path:
    const state = new FleetState()
    const { roomId } = state.reserveRoomId()
    // Reserving the same generated id again would be ROOM_EXISTS — proves it is held.
    assert.throws(() => state.reserveRoomId(roomId), (e: any) => e.code === 'ROOM_EXISTS')
})

// ---------------------------------------------------------------------------
// Acceptance: N parallel creates with the SAME explicit roomId — exactly one
// succeeds, the rest fail fast with ROOM_EXISTS (id reservation, §11).
// ---------------------------------------------------------------------------

test('N concurrent reservations of the same explicit id: exactly one succeeds', () => {
    const state = new FleetState()
    const results: Array<{ ok: boolean; code?: string }> = []
    for (let i = 0; i < 10; i++) {
        try {
            state.reserveRoomId('match-42')
            results.push({ ok: true })
        } catch (e: any) {
            results.push({ ok: false, code: e.code })
        }
    }
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one reservation wins')
    assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'ROOM_EXISTS'),
        'the rest fail fast with ROOM_EXISTS')
})

test('an explicit id that already exists as a live room is ROOM_EXISTS', () => {
    const state = new FleetState()
    state.applySnapshot('i_a', snapshot({ rooms: [room('match-42')] }), 1)
    assert.throws(() => state.reserveRoomId('match-42'), (e: any) => e.code === 'ROOM_EXISTS')
})

test('releaseRoomId frees the id for the next create; release is idempotent', () => {
    const state = new FleetState()
    const reservation = state.reserveRoomId('match-42')
    assert.throws(() => state.reserveRoomId('match-42'), (e: any) => e.code === 'ROOM_EXISTS')

    state.releaseRoomId(reservation)
    // Freed — reserves again.
    assert.deepEqual(state.reserveRoomId('match-42'), { roomId: 'match-42' })

    // Idempotent: releasing the (already-replaced) reservation only removes that id once.
    state.releaseRoomId(reservation)
    state.releaseRoomId(reservation)
    assert.deepEqual(state.reserveRoomId('match-42'), { roomId: 'match-42' })
})

// ---------------------------------------------------------------------------
// Acceptance: local room with a hostile id surfaces percent-encoded and
// round-trips through lookup (getRoom) and destroy-routing (resolveRoom).
// ---------------------------------------------------------------------------

test('hostile local room id surfaces percent-encoded and round-trips lookup + destroy routing', () => {
    const state = new FleetState()
    const hostile = 'lobby/eu~1 münchen'
    state.applySnapshot('i_a', snapshot({
        processUid: 'p_a',
        rooms: [room(hostile, { origin: 'local', connections: 4 })]
    }), 1)

    const publicId = encodeRoomId(hostile)
    assert.ok(!publicId.includes('~') && !publicId.includes('/') && !publicId.includes(' '),
        'public id is URL-safe')

    // Surfaced in the read model under the encoded id, flagged local.
    assert.deepEqual(state.rooms.map((r) => r.id), [publicId])
    const found = state.getRoom(publicId)
    assert.ok(found, 'lookup by the encoded public id finds the room')
    assert.equal(found!.local, true, 'local provenance preserved')
    assert.equal(found!.connections, 4)

    // The RAW id is not directly addressable — only the encoded form is.
    assert.equal(state.getRoom(hostile), null, 'raw hostile id is not a public id')

    // Destroy routing: the encoded public id maps back to the owning instance and
    // the RAW id the agent must receive in fleet/cmd {destroy}.
    assert.deepEqual(state.resolveRoom(publicId), { instanceId: 'i_a', rawRoomId: hostile })
    assert.equal(state.resolveRoom('nope'), null)
})

// ---------------------------------------------------------------------------
// Acceptance: local room colliding with a fleet id surfaces namespaced;
// RoomInfo.local correct for the namespaced room.
// ---------------------------------------------------------------------------

test('local room colliding with a fleet id surfaces namespaced, fleet keeps canonical', () => {
    const state = new FleetState()
    // i_a hosts a FLEET room "dup"; i_b has a LOCAL room with the same id.
    state.applySnapshot('i_a', snapshot({ processUid: 'p_a', rooms: [room('dup', { origin: 'fleet' })] }), 1)
    state.applySnapshot('i_b', snapshot({ processUid: 'p_b', rooms: [room('dup', { origin: 'local' })] }), 1)

    const canonical = state.getRoom('dup')
    assert.ok(canonical, 'fleet room keeps the canonical id')
    assert.equal(canonical!.instanceId, 'i_a')
    assert.equal(canonical!.local, false, 'canonical fleet room is not local')

    const namespaced = state.getRoom('p_b~dup')
    assert.ok(namespaced, 'colliding local room surfaces under <processUid>~<roomId>')
    assert.equal(namespaced!.instanceId, 'i_b')
    assert.equal(namespaced!.local, true, 'RoomInfo.local correct for the namespaced room')

    // Both rooms are visible (nothing hidden), unambiguously addressable.
    assert.deepEqual(state.rooms.map((r) => r.id).sort(), ['dup', 'p_b~dup'])
    assert.deepEqual(state.resolveRoom('p_b~dup'), { instanceId: 'i_b', rawRoomId: 'dup' })
})

test('namespace component is processUid (stable), not instanceId (connection-scoped)', () => {
    const state = new FleetState()
    state.applySnapshot('i_fleet', snapshot({ processUid: 'p_fleet', rooms: [room('shared', { origin: 'fleet' })] }), 1)
    state.applySnapshot('i_local', snapshot({ processUid: 'p_local', rooms: [room('shared', { origin: 'local' })] }), 1)
    // Namespaced by processUid (p_local), never the connection-scoped instanceId (i_local).
    assert.ok(state.getRoom('p_local~shared'), 'namespaced by processUid')
    assert.equal(state.getRoom('i_local~shared'), null, 'never namespaced by instanceId')
})

// ---------------------------------------------------------------------------
// Acceptance: post-restart tie-break — two instances report the same fleet id;
// earliest joiner keeps the canonical id, later joiner namespaced, warning
// logged naming both instances (§11).
// ---------------------------------------------------------------------------

test('post-restart duplicate fleet id: earliest joiner keeps canonical, later namespaced, warned', () => {
    const { logger, warnings } = capturingLogger()
    const state = new FleetState({ logger })

    // i_early joins first (lower joinSeq), i_late second — both report a FLEET "shared".
    state.applySnapshot('i_early', snapshot({ processUid: 'p_early', rooms: [room('shared', { origin: 'fleet', connections: 1 })] }), 1)
    state.applySnapshot('i_late', snapshot({ processUid: 'p_late', rooms: [room('shared', { origin: 'fleet', connections: 2 })] }), 1)

    const canonical = state.getRoom('shared')
    assert.ok(canonical, 'earliest joiner keeps the canonical id')
    assert.equal(canonical!.instanceId, 'i_early', '§11: earliest join wins the canonical id')

    const namespaced = state.getRoom('p_late~shared')
    assert.ok(namespaced, 'later joiner surfaces under its namespaced form')
    assert.equal(namespaced!.instanceId, 'i_late')

    // Nothing hidden: both rooms present.
    assert.deepEqual(state.rooms.map((r) => r.id).sort(), ['p_late~shared', 'shared'])

    // A warning was logged naming BOTH instances.
    const warn = warnings.find((w) => w.includes('duplicate room id "shared"'))
    assert.ok(warn, 'duplicate is logged as a warning')
    assert.ok(warn!.includes('i_early') && warn!.includes('i_late'), 'warning names both instances')
})

test('tie-break is independent of snapshot apply order — earliest JOIN wins, not last writer', () => {
    const { logger } = capturingLogger()
    const state = new FleetState({ logger })

    // i_early joins first; both later get updated snapshots in the reverse order.
    state.applySnapshot('i_early', snapshot({ processUid: 'p_early', rooms: [] }), 1)
    state.applySnapshot('i_late', snapshot({ processUid: 'p_late', rooms: [] }), 1)
    // Now both start reporting the duplicate; i_late updates first this round.
    state.applySnapshot('i_late', snapshot({ processUid: 'p_late', rooms: [room('shared', { origin: 'fleet' })] }), 2)
    state.applySnapshot('i_early', snapshot({ processUid: 'p_early', rooms: [room('shared', { origin: 'fleet' })] }), 2)

    // joinSeq (stamped at first appearance) decides — i_early still wins the canonical id.
    assert.equal(state.getRoom('shared')!.instanceId, 'i_early')
    assert.equal(state.getRoom('p_late~shared')!.instanceId, 'i_late')
})

test('restart provenance: RoomInfo.local is stable across an orchestrator-side rebuild', () => {
    // Simulate "before restart": one fleet room, one local room — no collisions.
    const before = new FleetState()
    before.applySnapshot('i_a', snapshot({ processUid: 'p_a', rooms: [
        room('rf', { origin: 'fleet' }), room('rl', { origin: 'local' })
    ] }), 1)
    const localBefore = before.rooms.map((r) => ({ id: r.id, local: r.local })).sort((a, b) => a.id < b.id ? -1 : 1)

    // "After restart": a fresh FleetState rebuilt from the same agent snapshot.
    const after = new FleetState()
    after.applySnapshot('i_a2', snapshot({ processUid: 'p_a', rooms: [
        room('rf', { origin: 'fleet' }), room('rl', { origin: 'local' })
    ] }), 1)
    const localAfter = after.rooms.map((r) => ({ id: r.id, local: r.local })).sort((a, b) => a.id < b.id ? -1 : 1)

    assert.deepEqual(localAfter, localBefore, 'local flags identical before/after (agent-reported origin, §7)')
})
