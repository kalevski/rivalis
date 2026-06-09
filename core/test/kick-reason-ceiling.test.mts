/**
 * Verifies that TLayer.kick() enforces the 123-byte close-reason ceiling
 * (p2p.md §3.4, task 038). The ceiling constant is imported from
 * @rivalis/handshake — the single source of truth shared with the
 * control-frame convention (encodeCloseFrame).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rivalis, Room, AuthMiddleware } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'
import { MAX_CLOSE_REASON_BYTES } from '@rivalis/handshake'

class TestRoom extends Room<null> {
    protected override onJoin(): void {}
}

class FixedAuth extends AuthMiddleware<null> {
    async authenticate(): Promise<AuthResult<null> | null> {
        return { data: null, roomId: 'r1' }
    }
}

function setup() {
    const rivalis = new Rivalis<null>({
        transports: [],
        authMiddleware: new FixedAuth(),
    })
    rivalis.rooms.define('test', TestRoom)
    rivalis.rooms.create('test', 'r1')
    const tl: any = (rivalis as any)['transportLayer']
    return { tl }
}

test('MAX_CLOSE_REASON_BYTES from handshake is 123 (RFC 6455 §5.5 WebSocket cap)', () => {
    assert.equal(MAX_CLOSE_REASON_BYTES, 123)
})

test('kick() passes a short reason through unchanged', async () => {
    const { tl } = setup()
    const actorId = await tl.grantAccess('ticket')

    let received: Uint8Array | null = null
    tl.on('kick', actorId, (_: string, payload: Uint8Array) => {
        received = payload
    })

    const reason = Buffer.from('room_destroyed', 'utf-8')
    tl.kick(actorId, reason)

    assert.ok(received !== null, 'kick event must be emitted')
    assert.ok((received as Uint8Array).byteLength <= MAX_CLOSE_REASON_BYTES)
    assert.equal(Buffer.from(received as Uint8Array).toString('utf-8'), 'room_destroyed')
})

test('kick() truncates a long ASCII reason to exactly 123 bytes', async () => {
    const { tl } = setup()
    const actorId = await tl.grantAccess('ticket')

    let received: Uint8Array | null = null
    tl.on('kick', actorId, (_: string, payload: Uint8Array) => {
        received = payload
    })

    const longReason = Buffer.from('x'.repeat(200), 'utf-8')
    tl.kick(actorId, longReason)

    assert.ok(received !== null, 'kick event must be emitted')
    assert.equal((received as Uint8Array).byteLength, MAX_CLOSE_REASON_BYTES)
    assert.equal(
        Buffer.from(received as Uint8Array).toString('utf-8'),
        'x'.repeat(MAX_CLOSE_REASON_BYTES)
    )
})

test('kick() truncates at a UTF-8 codepoint boundary for multibyte strings', async () => {
    const { tl } = setup()
    const actorId = await tl.grantAccess('ticket')

    let received: Uint8Array | null = null
    tl.on('kick', actorId, (_: string, payload: Uint8Array) => {
        received = payload
    })

    // '€' encodes to 3 bytes; 42 × 3 = 126 bytes (exceeds 123)
    const euroReason = Buffer.from('€'.repeat(42), 'utf-8')
    assert.equal(euroReason.byteLength, 126)
    tl.kick(actorId, euroReason)

    assert.ok(received !== null, 'kick event must be emitted')
    assert.ok((received as Uint8Array).byteLength <= MAX_CLOSE_REASON_BYTES)
    // Result must decode to whole '€' characters (no split codepoint)
    const decoded = Buffer.from(received as Uint8Array).toString('utf-8')
    assert.ok(decoded.length > 0)
    assert.ok(decoded.split('').every(c => c === '€'), 'truncation must not split a codepoint')
})

test('kick() with a reason exactly 123 bytes passes through unchanged', async () => {
    const { tl } = setup()
    const actorId = await tl.grantAccess('ticket')

    let received: Uint8Array | null = null
    tl.on('kick', actorId, (_: string, payload: Uint8Array) => {
        received = payload
    })

    const exact = Buffer.from('a'.repeat(MAX_CLOSE_REASON_BYTES), 'utf-8')
    assert.equal(exact.byteLength, MAX_CLOSE_REASON_BYTES)
    tl.kick(actorId, exact)

    assert.ok(received !== null)
    assert.equal((received as Uint8Array).byteLength, MAX_CLOSE_REASON_BYTES)
    assert.equal(
        Buffer.from(received as Uint8Array).toString('utf-8'),
        'a'.repeat(MAX_CLOSE_REASON_BYTES)
    )
})
