/**
 * SignalServer bootstrap tests (p2p.md §4.3).
 *
 * Verifies the acceptance criteria from task 056:
 *  - SignalServer constructs successfully (starts, defines + creates signal room)
 *  - rate limiting + auth are applied (TokenBucketRateLimiter + SignalAuthMiddleware)
 *  - 'signal' room is defined and created on construction
 *  - additional sessions can be created via rooms.create()
 *  - shutdown() cleans up gracefully
 *
 * All tests use an HTTP server in non-listening mode (attached but not bound to
 * a port) so no real sockets are opened and no port-reservation races can occur.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
    SignalServer,
    SIGNAL_ROOM_TYPE,
    SIGNAL_ROOM_ID,
} from '../lib/main.js'

// ── construction ──────────────────────────────────────────────────────────────

test('SignalServer constructs without throwing', async () => {
    const http = createServer()
    const server = new SignalServer({ server: http, secrets: ['test-secret'] })
    await server.shutdown()
})

test('SignalServer creates the default signal room on construction', async () => {
    const http = createServer()
    const server = new SignalServer({ server: http, secrets: ['test-secret'] })

    const room = server.rooms.get(SIGNAL_ROOM_ID)
    assert.notEqual(room, null, 'signal room must be created')

    await server.shutdown()
})

test('SIGNAL_ROOM_TYPE is "signal"', () => {
    assert.equal(SIGNAL_ROOM_TYPE, 'signal')
})

test('SIGNAL_ROOM_ID is "signal"', () => {
    assert.equal(SIGNAL_ROOM_ID, 'signal')
})

// ── multi-session support ─────────────────────────────────────────────────────

test('rooms.create() creates additional signaling sessions', async () => {
    const http = createServer()
    const server = new SignalServer({ server: http, secrets: ['test-secret'] })

    server.rooms.create(SIGNAL_ROOM_TYPE, 'session-xyz')

    assert.notEqual(server.rooms.get('session-xyz'), null, 'additional session room must exist')
    assert.notEqual(server.rooms.get(SIGNAL_ROOM_ID), null, 'default room must still exist')

    await server.shutdown()
})

test('duplicate session id is rejected', async () => {
    const http = createServer()
    const server = new SignalServer({ server: http, secrets: ['test-secret'] })

    assert.throws(
        () => server.rooms.create(SIGNAL_ROOM_TYPE, SIGNAL_ROOM_ID),
        /room id.*taken/i,
        'creating a room with the same id as the default should throw'
    )

    await server.shutdown()
})

// ── shutdown ──────────────────────────────────────────────────────────────────

test('shutdown() resolves without error', async () => {
    const http = createServer()
    const server = new SignalServer({ server: http, secrets: ['test-secret'] })
    await assert.doesNotReject(server.shutdown())
})

test('shutdown() is idempotent', async () => {
    const http = createServer()
    const server = new SignalServer({ server: http, secrets: ['test-secret'] })
    await server.shutdown()
    await assert.doesNotReject(server.shutdown(), 'second shutdown must not throw')
})

// ── auth + rate limiter wired ──────────────────────────────────────────────────

test('SignalServer rejects construction with empty secrets', () => {
    const http = createServer()
    assert.throws(
        () => new SignalServer({ server: http, secrets: [] }),
        /at least one secret/i,
        'empty secrets array must be rejected by SignalAuthMiddleware'
    )
})

test('SignalServer accepts custom rate-limiter options', async () => {
    const http = createServer()
    const server = new SignalServer({
        server: http,
        secrets: ['s'],
        rateLimiter: { capacity: 10, refillPerSecond: 5 },
    })
    await server.shutdown()
})
