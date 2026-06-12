/**
 * Verifies the core-level inbound payload size ceiling (task 033).
 *
 * `TLayer.handleMessage` enforces `maxPayloadBytes` alongside the
 * topic-length check: a decoded payload larger than the limit is kicked
 * with `invalid_message` and never reaches `room.handleMessage`, while an
 * at-limit payload dispatches normally. This is independent of any
 * transport's advisory `maxFrameBytes` — a stub/custom transport without a
 * payload cap cannot push arbitrarily large payloads into room handlers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rivalis, Room, AuthMiddleware } from '../lib/main.js'
import type { AuthResult, Actor } from '../lib/main.js'
import { encode } from '@rivalis/handshake'

const LIMIT = 1024

class EchoRoom extends Room<null> {
    received: Array<Uint8Array> = []
    protected override onCreate(): void {
        this.bind('echo', (_actor: Actor<null>, payload: Uint8Array) => {
            this.received.push(payload)
        })
    }
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
        rateLimiter: null,
        maxPayloadBytes: LIMIT,
    })
    rivalis.rooms.define('echo', EchoRoom)
    const room = rivalis.rooms.create('echo', 'r1') as EchoRoom
    const tl: any = (rivalis as any)['transportLayer']
    return { tl, room }
}

test('Config rejects a non-positive / non-integer maxPayloadBytes', () => {
    for (const bad of [0, -1, 1.5, '1024' as unknown as number]) {
        assert.throws(
            () => new Rivalis<null>({
                transports: [],
                authMiddleware: new FixedAuth(),
                maxPayloadBytes: bad,
            }),
            /maxPayloadBytes must be a positive integer/,
        )
    }
})

test('an at-limit payload is dispatched to the room', async () => {
    const { tl, room } = setup()
    const actorId = await tl.grantAccess('ticket')

    let kicked = false
    tl.on('kick', actorId, () => { kicked = true })

    const payload = new Uint8Array(LIMIT)
    await tl.handleMessage(actorId, encode('echo', payload))

    assert.equal(kicked, false, 'at-limit payload must not be kicked')
    assert.equal(room.received.length, 1, 'at-limit payload must reach the room')
    assert.equal(room.received[0]!.byteLength, LIMIT)
})

test('an over-limit payload is rejected with invalid_message and never dispatched', async () => {
    const { tl, room } = setup()
    const actorId = await tl.grantAccess('ticket')

    let kickReason: string | null = null
    tl.on('kick', actorId, (_: string, reason: Uint8Array) => {
        kickReason = Buffer.from(reason).toString('utf-8')
    })

    const payload = new Uint8Array(LIMIT + 1)
    await tl.handleMessage(actorId, encode('echo', payload))

    assert.equal(kickReason, 'invalid_message', 'over-limit payload must kick with invalid_message')
    assert.equal(room.received.length, 0, 'over-limit payload must not reach the room')
    // The actor must still be tracked: cleanup is the authoritative
    // handleClose path driven by the kick-closed socket, not handleMessage.
    assert.equal(tl.connections, 1, 'handleMessage must not leak/early-evict the actor')
})
