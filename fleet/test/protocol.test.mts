import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PROTOCOL_VERSION, MAX_INFLIGHT_COMMANDS, Topics, encodeFrame, decodeFrame, WireVersionError } from '../lib/wire.js'
// ESM build (clean named exports — the CJS `main.js` adds interop-synthetic
// `default`/`module.exports` keys that would pollute the surface assertion).
import * as fleet from '../lib/module.js'

/** A full StatePayload body (the agent always populates every field on a full reply). */
function statePayload(over: any = {}): any {
    return {
        reqId: over.reqId ?? 'poll_1',
        full: over.full ?? true,
        seq: over.seq ?? 1,
        hash: over.hash ?? 'h',
        name: over.name ?? 'eu1',
        processUid: over.processUid ?? 'p',
        agentVersion: over.agentVersion ?? '1.0.0',
        protocolVersion: over.protocolVersion ?? PROTOCOL_VERSION,
        endpointUrl: over.endpointUrl ?? 'wss://eu1.example.com',
        labels: over.labels ?? {},
        capacity: over.capacity ?? { maxConnections: null, maxRooms: null },
        autoCreate: over.autoCreate ?? true,
        roomTypes: over.roomTypes ?? [],
        rooms: over.rooms ?? [],
        status: over.status ?? 'active'
    }
}

test('PROTOCOL_VERSION is the single integer protocol major (§7)', () => {
    // 1 → 2 (task 005: JSON → binary), 2 → 3 (task 011: push → orchestrator-driven
    // request/reply) — both breaking wire changes.
    assert.equal(PROTOCOL_VERSION, 3)
    assert.equal(typeof PROTOCOL_VERSION, 'number')
})

test('MAX_INFLIGHT_COMMANDS is the single in-flight cap source (§7)', () => {
    assert.equal(MAX_INFLIGHT_COMMANDS, 32)
})

test('no duplicate literals: the constants appear exactly once in source', () => {
    const protocolSrc = readFileSync(
        fileURLToPath(new URL('../src/wire/topics.ts', import.meta.url)),
        'utf8'
    )
    // The value 32 must only be declared by MAX_INFLIGHT_COMMANDS (no second
    // literal that could drift from the rate-limiter budget, §7).
    const inflightDecls = protocolSrc.match(/MAX_INFLIGHT_COMMANDS\s*=\s*32/g) ?? []
    assert.equal(inflightDecls.length, 1)
    const versionDecls = protocolSrc.match(/PROTOCOL_VERSION\s*=\s*3\b/g) ?? []
    assert.equal(versionDecls.length, 1)
})

test('Topics cover every §7 fleet/* message with the spec names (orchestrator-driven request/reply)', () => {
    // Strict request/reply (task 011): the orchestrator polls, the agent replies;
    // the pre-011 push topics (sync/ping/resync/status/status-ack) are gone.
    assert.deepEqual(Topics, {
        hello: 'fleet/hello',
        poll: 'fleet/poll',
        state: 'fleet/state',
        cmd: 'fleet/cmd',
        ack: 'fleet/ack'
    })
})

// ---------------------------------------------------------------------------
// Binary wire codec (§7, task 005 + 011): every topic round-trips through
// @toolcase/serializer; the 2-byte version header gates incompatible peers.
// ---------------------------------------------------------------------------

test('every topic round-trips symmetrically through the binary codec', () => {
    const cases: Array<[string, any]> = [
        [Topics.hello, { instanceId: 'i1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 5000 }],
        [Topics.poll, { reqId: 'poll_7', knownHash: 'abc123', status: 'draining' }],
        [Topics.state, statePayload({
            reqId: 'poll_8', full: true, seq: 3, hash: 'abc123', name: 'eu1', processUid: 'p_x',
            endpointUrl: 'wss://eu1.example.com',
            labels: { region: 'eu', tier: 'premium' }, capacity: { maxConnections: 2000, maxRooms: 100 },
            autoCreate: true, roomTypes: ['lobby', 'match'],
            rooms: [
                { id: 'r1', type: 'match', connections: 0, origin: 'fleet' },
                { id: 'r2', type: 'lobby', connections: 7, origin: 'local' }
            ], status: 'draining'
        })],
        [Topics.cmd, { cmdId: 'c1', op: 'create', roomId: 'm-1', roomType: 'match' }],
        [Topics.ack, { cmdId: 'c1', ok: true, room: { id: 'm-1', type: 'match' } }]
    ]
    for (const [topic, payload] of cases) {
        const decoded = decodeFrame(topic, encodeFrame(topic, payload))
        assert.deepEqual(decoded, payload, `${topic} must round-trip unchanged`)
    }
})

test('a poll with knownHash null round-trips as null (forced full / no prior state)', () => {
    const decoded = decodeFrame(Topics.poll, encodeFrame(Topics.poll, { reqId: 'poll_9', knownHash: null, status: 'active' }))
    assert.deepEqual(decoded, { reqId: 'poll_9', knownHash: null, status: 'active' })
})

test('a hash-only fleet/state (full:false) omits the heavy snapshot fields on the wire', () => {
    // The whole point of the dedup: an unchanged reply does not resend the snapshot.
    const decoded = decodeFrame(Topics.state, encodeFrame(Topics.state, statePayload({
        reqId: 'poll_3', full: false, seq: 5, hash: 'h5', name: 'eu1',
        rooms: [{ id: 'r', type: 'match', connections: 1, origin: 'fleet' }], roomTypes: ['match']
    }))) as any
    assert.equal(decoded.reqId, 'poll_3')
    assert.equal(decoded.full, false)
    assert.equal(decoded.seq, 5)
    assert.equal(decoded.hash, 'h5')
    // Heavy fields were not transmitted → decode defaults, not the agent's values.
    assert.equal(decoded.name, '')
    assert.deepEqual(decoded.rooms, [])
    assert.deepEqual(decoded.roomTypes, [])
})

test('capacity distinguishes null (unlimited) from an explicit 0 across the wire', () => {
    const unlimited = decodeFrame(Topics.state, encodeFrame(Topics.state, statePayload({ capacity: { maxConnections: null, maxRooms: null } }))) as any
    assert.deepEqual(unlimited.capacity, { maxConnections: null, maxRooms: null }, 'null stays null (unlimited)')
    const zero = decodeFrame(Topics.state, encodeFrame(Topics.state, statePayload({ capacity: { maxConnections: 0, maxRooms: 0 } }))) as any
    assert.deepEqual(zero.capacity, { maxConnections: 0, maxRooms: 0 }, 'an explicit 0 is preserved, not coerced to null')
})

test('an optional cmd field absent on the wire decodes as not-a-string (not empty string)', () => {
    // The agent guards create on `typeof roomId !== "string"`; an absent roomId
    // must NOT round-trip as '' or it would create a room with an empty id.
    const decoded = decodeFrame(Topics.cmd, encodeFrame(Topics.cmd, { cmdId: 'c2', op: 'drain' })) as any
    assert.equal(decoded.cmdId, 'c2')
    assert.equal(decoded.op, 'drain')
    assert.notEqual(typeof decoded.roomId, 'string', 'absent roomId is not a string')
    assert.notEqual(typeof decoded.roomType, 'string', 'absent roomType is not a string')
})

test('the 2-byte version header rejects a legacy JSON frame and a wrong major', () => {
    // A legacy JSON frame: first byte `{` = 123, never a valid major.
    assert.throws(
        () => decodeFrame(Topics.hello, Buffer.from(JSON.stringify({ instanceId: 'i', protocolVersion: 1, heartbeatMs: 5000 }))),
        (e: unknown) => e instanceof WireVersionError && (e as WireVersionError).theirVersion === 123
    )
    // A frame stamped with a different major (header byte 0 = 99).
    const real = encodeFrame(Topics.state, statePayload({ full: false, seq: 1, hash: 'h' }))
    const tampered = Uint8Array.from(real)
    tampered[0] = 99
    assert.throws(() => decodeFrame(Topics.state, tampered), (e: unknown) => e instanceof WireVersionError && (e as WireVersionError).theirVersion === 99)
})

test('a truncated/empty frame throws (logged + dropped by callers, never applied)', () => {
    assert.throws(() => decodeFrame(Topics.state, new Uint8Array(0)), /truncated/)
    assert.throws(() => decodeFrame(Topics.state, Uint8Array.from([PROTOCOL_VERSION])), /truncated/)
    // Valid header, garbage body → protobuf decode throws (a plain Error, not a version error).
    assert.throws(() => decodeFrame(Topics.state, Uint8Array.from([PROTOCOL_VERSION, 0, 0xff, 0xff, 0xff, 0xff])))
})

test('main.ts exports exactly the §5 public surface', () => {
    // Runtime (value) exports — types are erased, so they cannot be asserted
    // here; the build of the rest of the package is what type-checks them.
    const runtimeExports = Object.keys(fleet).sort()
    // `FleetError` is a value export (task 010): embedders `instanceof`-match coded
    // errors off the supported entry. `FleetEventType`/`FleetApi` are type-only (erased).
    assert.deepEqual(runtimeExports, ['FleetAgent', 'FleetError', 'Orchestrator', 'PROTOCOL_VERSION'])
    assert.equal(fleet.PROTOCOL_VERSION, PROTOCOL_VERSION)
})
