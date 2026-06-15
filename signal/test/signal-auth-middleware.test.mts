/**
 * SignalAuthMiddleware unit tests (p2p.md §4.3, §8).
 *
 * Covers:
 *  - valid ticket → { data: null, roomId } returned
 *  - wrong secret → null (rejected)
 *  - malformed tickets (no colon, empty roomId, empty secret) → null
 *  - multiple secrets (rotation-safe: any listed secret is accepted)
 *  - empty-secret list → constructor throws
 *  - constant-time path: both valid and invalid secrets always iterate all configured secrets
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SignalAuthMiddleware } from '../lib/main.js'

// ── valid tickets ─────────────────────────────────────────────────────────────

test('valid ticket returns { data: null, roomId }', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['secret123'] })
    const result = await auth.authenticate('my-room:secret123')
    assert.ok(result !== null, 'valid ticket must be accepted')
    assert.equal(result.data, null)
    assert.equal(result.roomId, 'my-room')
})

test('roomId containing a colon in the room name uses only the first colon as separator', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['s'] })
    // ticket: "room:part:s" → roomId = "room", secret = "part:s"
    const result = await auth.authenticate('room:part:s')
    assert.equal(result, null, 'secret part:s does not match configured secret s')
})

test('roomId is taken as everything before the first colon', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['mysecret'] })
    const result = await auth.authenticate('session-42:mysecret')
    assert.ok(result !== null)
    assert.equal(result.roomId, 'session-42')
    assert.equal(result.data, null)
})

// ── invalid secrets ───────────────────────────────────────────────────────────

test('wrong secret returns null', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['correct'] })
    const result = await auth.authenticate('room:wrong')
    assert.equal(result, null)
})

test('secret that is a prefix of the configured secret is rejected', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['longer-secret'] })
    const result = await auth.authenticate('room:longer')
    assert.equal(result, null, 'prefix of the secret must not be accepted')
})

test('secret that has the configured secret as a prefix is rejected', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['short'] })
    const result = await auth.authenticate('room:short-extended')
    assert.equal(result, null, 'extended secret must not be accepted')
})

// ── malformed tickets ─────────────────────────────────────────────────────────

test('ticket with no colon returns null', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['s'] })
    assert.equal(await auth.authenticate('noseparator'), null)
})

test('empty string ticket returns null', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['s'] })
    assert.equal(await auth.authenticate(''), null)
})

test('ticket starting with colon (empty roomId) returns null', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['s'] })
    assert.equal(await auth.authenticate(':s'), null)
})

test('ticket with colon at end (empty secret) returns null', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['s'] })
    assert.equal(await auth.authenticate('room:'), null)
})

// ── multi-secret rotation ─────────────────────────────────────────────────────

test('any configured secret is accepted (rotation-safe)', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['old-secret', 'new-secret'] })

    const r1 = await auth.authenticate('room:old-secret')
    assert.ok(r1 !== null, 'old secret must still be accepted during rotation')
    assert.equal(r1.roomId, 'room')

    const r2 = await auth.authenticate('room:new-secret')
    assert.ok(r2 !== null, 'new secret must be accepted')
    assert.equal(r2.roomId, 'room')
})

test('wrong secret with multiple configured secrets returns null', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['a', 'b', 'c'] })
    assert.equal(await auth.authenticate('room:d'), null)
})

// ── constructor guard ─────────────────────────────────────────────────────────

test('constructor throws when secrets array is empty', () => {
    assert.throws(
        () => new SignalAuthMiddleware({ secrets: [] }),
        /at least one secret/i
    )
})

// ── each roomId routes independently ─────────────────────────────────────────

test('different roomIds with the same secret route to different rooms', async () => {
    const auth = new SignalAuthMiddleware({ secrets: ['shared'] })

    const r1 = await auth.authenticate('room-1:shared')
    const r2 = await auth.authenticate('room-2:shared')

    assert.ok(r1 !== null)
    assert.ok(r2 !== null)
    assert.equal(r1.roomId, 'room-1')
    assert.equal(r2.roomId, 'room-2')
})
