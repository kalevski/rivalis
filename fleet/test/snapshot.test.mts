import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { Snapshot, MAX_SNAPSHOT_BYTES } from '../lib/Snapshot.js'
import { PROTOCOL_VERSION } from '../lib/wire.js'

const pkg = createRequire(import.meta.url)('../package.json') as { version: string }

// ---------------------------------------------------------------------------
// Test doubles. Snapshot only touches the documented core surface
// (`rooms.definitions()` / `keys()` / `get()` and `room.type` / `actorCount`),
// so a faithful fake RoomManager exercises it without booting a real Rivalis.
// ---------------------------------------------------------------------------

function makeLogger() {
    const calls: Record<string, unknown[][]> = {
        error: [], warning: [], info: [], debug: [], verbose: [], log: []
    }
    const mk = (k: string) => (...args: unknown[]) => { calls[k].push(args) }
    return {
        error: mk('error'),
        warning: mk('warning'),
        info: mk('info'),
        debug: mk('debug'),
        verbose: mk('verbose'),
        log: mk('log'),
        calls
    }
}

function makeFakeRivalis(defs: string[], logger = makeLogger()) {
    const definitions = new Set(defs)
    const rooms = new Map<string, { type: unknown; actorCount: number }>()
    const manager = {
        definitions: () => [...definitions],
        keys: () => rooms.keys(),
        get: (id: string) => rooms.get(id) ?? null
    }
    const rivalis = { rooms: manager, logging: { getLogger: () => logger } }
    return {
        rivalis,
        logger,
        addRoom: (id: string, type: unknown, count = 0) => rooms.set(id, { type, actorCount: count }),
        setCount: (id: string, count: number) => { rooms.get(id)!.actorCount = count },
        removeRoom: (id: string) => { rooms.delete(id) },
        addDef: (key: string) => { definitions.add(key) }
    }
}

const OPTS = { name: 'eu1', endpointUrl: 'wss://eu1.game.example.com', processUid: 'p_test' }

// ---------------------------------------------------------------------------
// Acceptance: snapshot includes pre-existing definitions + running rooms with
// correct types and counts.
// ---------------------------------------------------------------------------

test('snapshot reports all definitions and running rooms with correct types/counts', () => {
    const fake = makeFakeRivalis(['match', 'lobby'])
    fake.addRoom('r1', 'match', 3)
    fake.addRoom('r2', 'lobby', 0)

    const snap = new Snapshot(fake.rivalis as any, { ...OPTS, labels: { region: 'eu' }, capacity: { maxConnections: 2000, maxRooms: 100 } })
    const frame = snap.pollReply('poll_1', null)

    assert.equal(frame.kind, 'state')
    assert.equal(frame.full, true, 'knownHash null → a full reply')
    const p = frame.payload
    assert.deepEqual([...p.roomTypes].sort(), ['lobby', 'match'])

    const byId = Object.fromEntries(p.rooms.map((r) => [r.id, r]))
    assert.equal(byId.r1.type, 'match')
    assert.equal(byId.r1.connections, 3)
    assert.equal(byId.r2.type, 'lobby')
    assert.equal(byId.r2.connections, 0)

    assert.equal(p.name, 'eu1')
    assert.equal(p.endpointUrl, 'wss://eu1.game.example.com')
    assert.equal(p.processUid, 'p_test')
    assert.equal(p.protocolVersion, PROTOCOL_VERSION)
    assert.equal(p.status, 'active')
    assert.equal(p.autoCreate, true)
    assert.deepEqual(p.labels, { region: 'eu' })
    assert.deepEqual(p.capacity, { maxConnections: 2000, maxRooms: 100 })
    // seq is per-connection monotonic.
    assert.equal(typeof p.seq, 'number')
})

test('agentVersion defaults to the resolved package version, not a literal (task 009)', () => {
    const fake = makeFakeRivalis(['match'])
    const snap = new Snapshot(fake.rivalis as any, OPTS)
    assert.equal(snap.pollReply('poll_1', null).payload.agentVersion, pkg.version)
})

test('capacity defaults to unlimited (null) on both dimensions', () => {
    const fake = makeFakeRivalis(['match'])
    const snap = new Snapshot(fake.rivalis as any, OPTS)
    assert.deepEqual(snap.pollReply('poll_1', null).payload.capacity, { maxConnections: null, maxRooms: null })
})

// ---------------------------------------------------------------------------
// Acceptance: identical state → same hash (fleet/ping); any change → new hash.
// ---------------------------------------------------------------------------

test('identical state twice → same hash; room/count/status change → new hash', () => {
    const fake = makeFakeRivalis(['match'])
    fake.addRoom('r1', 'match', 1)
    const snap = new Snapshot(fake.rivalis as any, OPTS)

    const h0 = snap.rebuild().hash
    assert.equal(h0, snap.rebuild().hash, 'unchanged state must hash identically')

    fake.setCount('r1', 2)
    const h1 = snap.rebuild().hash
    assert.notEqual(h1, h0, 'connection-count change must change the hash')

    fake.addRoom('r2', 'match', 0)
    const h2 = snap.rebuild().hash
    assert.notEqual(h2, h1, 'adding a room must change the hash')

    snap.setStatus('draining')
    const h3 = snap.rebuild().hash
    assert.notEqual(h3, h2, 'status change must change the hash')
})

test('pollReply returns a full state when the hash differs from knownHash, hash-only when it matches', () => {
    const fake = makeFakeRivalis(['match'])
    fake.addRoom('r1', 'match', 1)
    const snap = new Snapshot(fake.rivalis as any, OPTS)

    const f1 = snap.pollReply('p1', null)
    assert.equal(f1.kind, 'state')
    assert.equal(f1.full, true, 'knownHash null → a full reply (no prior orchestrator state)')
    const hash = f1.hash

    const f2 = snap.pollReply('p2', hash)
    assert.equal(f2.full, false, 'unchanged state → hash-only reply')
    assert.equal(f2.payload.hash, hash, 'the hash-only reply carries the current (unchanged) hash')
    assert.ok(f2.payload.seq > f1.payload.seq, 'seq is monotonic across frames')

    fake.setCount('r1', 9)
    const f3 = snap.pollReply('p3', hash)
    assert.equal(f3.full, true, 'a change → a full reply')
    assert.notEqual(f3.hash, hash)
    assert.ok(f3.payload.seq > f2.payload.seq)
})

test('resetConnection resets the per-connection seq; knownHash null is always a full reply', () => {
    const fake = makeFakeRivalis(['match'])
    fake.addRoom('r1', 'match', 1)
    const snap = new Snapshot(fake.rivalis as any, OPTS)

    const f1 = snap.pollReply('p1', null) // full, seq 1
    assert.equal(f1.payload.seq, 1)
    snap.pollReply('p2', f1.hash)         // hash-only, seq 2

    snap.resetConnection()
    const after = snap.pollReply('p3', null)
    assert.equal(after.full, true, 'reconnect → the orchestrator polls with knownHash:null → a full reply')
    assert.equal(after.payload.seq, 1, 'seq resets per connection')
})

// ---------------------------------------------------------------------------
// Acceptance: fleet-created vs locally created rooms carry correct origin.
// ---------------------------------------------------------------------------

test('provenance: fleet-created rooms stamp origin=fleet, others local', () => {
    const fake = makeFakeRivalis(['match'])
    fake.addRoom('rf', 'match', 0)
    fake.addRoom('rl', 'match', 0)
    const snap = new Snapshot(fake.rivalis as any, OPTS)

    snap.markFleetOrigin('rf')
    const origin = Object.fromEntries(snap.rebuild().content.rooms.map((r) => [r.id, r.origin]))
    assert.equal(origin.rf, 'fleet')
    assert.equal(origin.rl, 'local')

    // Forgetting provenance (room destroyed) reverts a future id reuse to local.
    snap.forgetRoom('rf')
    const after = Object.fromEntries(snap.rebuild().content.rooms.map((r) => [r.id, r.origin]))
    assert.equal(after.rf, 'local')
})

// ---------------------------------------------------------------------------
// Acceptance: size guard — warn at 50%, error at 90% of the 4 MiB cap.
// ---------------------------------------------------------------------------

function addRooms(fake: ReturnType<typeof makeFakeRivalis>, count: number): void {
    for (let i = 0; i < count; i++) {
        // 40-char ids keep per-room bytes ~constant so the band is predictable.
        const id = 'room-' + String(i).padStart(35, '0')
        fake.addRoom(id, 'match', 0)
    }
}

test('size guard warns between 50% and 90% of the 4 MiB frame limit', () => {
    const fake = makeFakeRivalis(['match'])
    // Counts are calibrated to the binary wire size (§7, task 005), ~60 B/room at
    // 40-char ids — denser than the old JSON form, so the bands sit higher.
    addRooms(fake, 40000)
    const snap = new Snapshot(fake.rivalis as any, OPTS, fake.logger as any)

    const frame = snap.pollReply('poll_1', null)
    assert.ok(
        frame.encodedBytes >= MAX_SNAPSHOT_BYTES * 0.5 && frame.encodedBytes < MAX_SNAPSHOT_BYTES * 0.9,
        `expected the encoded size to land in the warn band, got ${frame.encodedBytes} bytes`
    )
    assert.equal(fake.logger.calls.warning.length, 1, 'one warning at >=50%')
    assert.equal(fake.logger.calls.error.length, 0, 'no error below 90%')
})

test('size guard errors with remediation hints at >=90% of the 4 MiB frame limit', () => {
    const fake = makeFakeRivalis(['match'])
    addRooms(fake, 65000)
    const snap = new Snapshot(fake.rivalis as any, OPTS, fake.logger as any)

    const frame = snap.pollReply('poll_1', null)
    assert.ok(
        frame.encodedBytes >= MAX_SNAPSHOT_BYTES * 0.9,
        `expected the encoded size to cross the error threshold, got ${frame.encodedBytes} bytes`
    )
    assert.equal(fake.logger.calls.error.length, 1, 'one error at >=90%')
    assert.equal(fake.logger.calls.warning.length, 0, 'error band does not also warn')
    assert.match(String(fake.logger.calls.error[0][0]), /reconnect loop/i, 'error message explains the failure mode')
})

// ---------------------------------------------------------------------------
// Acceptance: a ≥1000-room fleet/state is measurably smaller binary-encoded than
// the JSON form (§7, task 005). The frame's encodedBytes is the binary wire size;
// JSON.stringify of the same payload is the old form.
// ---------------------------------------------------------------------------

test('encoded fleet/state for a 1000-room snapshot is measurably smaller than JSON', () => {
    const fake = makeFakeRivalis(['match'])
    addRooms(fake, 1000)
    const snap = new Snapshot(fake.rivalis as any, OPTS)

    const frame = snap.pollReply('poll_1', null)
    const binaryBytes = frame.encodedBytes
    const jsonBytes = Buffer.byteLength(JSON.stringify(frame.payload))
    const ratio = jsonBytes / binaryBytes

    // Recorded ratio (criterion 6): with the 40-char ids these rooms use, binary is
    // ~2× smaller; the win is larger for shorter, realistic room ids.
    console.log(`fleet/state 1000 rooms: binary=${binaryBytes}B json=${jsonBytes}B ratio=${ratio.toFixed(3)}× smaller`)
    assert.ok(binaryBytes < jsonBytes, `binary (${binaryBytes}) must be smaller than JSON (${jsonBytes})`)
    assert.ok(ratio > 1.5, `expected a meaningful reduction, got ${ratio.toFixed(3)}×`)
})

// ---------------------------------------------------------------------------
// Acceptance: constructor throws a clear, version-naming error against a core
// lacking definitions() / room.type.
// ---------------------------------------------------------------------------

test('constructor throws naming the min core version when definitions() is absent', () => {
    const logger = makeLogger()
    const broken = {
        rooms: { keys: () => [].values(), get: () => null },
        logging: { getLogger: () => logger }
    }
    assert.throws(
        () => new Snapshot(broken as any, OPTS, logger as any),
        (err: Error) => /6\.1\.0/.test(err.message) && /definitions/.test(err.message)
    )
})

test('constructor throws naming the min core version when Room.type is absent', () => {
    const logger = makeLogger()
    const broken = {
        rooms: {
            definitions: () => ['match'],
            keys: () => ['r1'].values(),
            get: () => ({ actorCount: 0 }) // no `type`
        },
        logging: { getLogger: () => logger }
    }
    assert.throws(
        () => new Snapshot(broken as any, OPTS, logger as any),
        (err: Error) => /6\.1\.0/.test(err.message) && /type/i.test(err.message)
    )
})
