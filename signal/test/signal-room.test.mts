/**
 * SignalRoom unit tests (p2p.md §4.3, §10).
 *
 * All tests run in-process — no real WebRTC, no open sockets.
 * Actors are driven directly through the TLayer five-step seam, exactly
 * as any real transport (WS, RTC) would.
 *
 * Covers:
 *  - host assignment: first peer to join becomes hostId
 *  - welcome message: signal:welcome carries youId + hostId + iceServers JSON
 *  - ICE servers: valid JSON array; includes TURN creds when env vars are set
 *  - relay routing: offer/answer/ice reach ONLY the targeted actor (O(1) via getActor)
 *  - host-gone fanout: host leave broadcasts signal:host_gone to remaining peers
 *  - presence: __presence:join / __presence:leave auto-broadcast (presence=true)
 *  - drop policy: unknown topics are silently dropped, not kicked (unknownTopicPolicy='drop')
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rivalis, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { encode, decode } from '@rivalis/handshake'
import {
    SignalRoom,
    encodeOffer,
    encodeAnswer,
    encodeIceCandidate,
    decodeWelcome,
} from '../lib/main.js'

// ── test harness ──────────────────────────────────────────────────────────────

class TestAuth extends AuthMiddleware<null> {
    async authenticate(_ticket: string): Promise<AuthResult<null> | null> {
        return { data: null, roomId: 'signal-room' }
    }
}

function setup() {
    const rivalis = new Rivalis<null>({
        transports: [],
        authMiddleware: new TestAuth(),
    })
    rivalis.rooms.define('signal', SignalRoom)
    rivalis.rooms.create('signal', 'signal-room')
    const tl: any = (rivalis as any)['transportLayer']
    return { tl }
}

type Msg = { topic: string; payload: Uint8Array }

/**
 * Admit an actor and immediately register its outbound listener.
 *
 * grantAccess buffers the welcome + presence:join in the TLayer pending queue
 * (no listener yet); the tl.on() call flushes the buffer synchronously — so
 * msgs already contains the welcome by the time this function returns.
 */
async function admitActor(tl: any): Promise<{ id: string; msgs: Msg[] }> {
    const msgs: Msg[] = []
    const id: string = await tl.grantAccess('ticket')
    tl.on('message', id, (_actorId: string, bytes: Uint8Array) => {
        const { topic, payload } = decode(bytes)
        msgs.push({ topic, payload })
    })
    return { id, msgs }
}

// ── host assignment ───────────────────────────────────────────────────────────

test('first actor to join is both youId and hostId in the welcome', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)

    const welcome = msgsA.find(m => m.topic === 'signal:welcome')
    assert.ok(welcome !== undefined, 'first actor must receive signal:welcome')
    const decoded = decodeWelcome(welcome.payload)
    assert.equal(decoded.youId, idA, 'youId must match the actor id')
    assert.equal(decoded.hostId, idA, 'first actor is its own host')
    // iceServers must be a valid JSON string (content depends on env config)
    assert.doesNotThrow(() => JSON.parse(decoded.iceServers), 'iceServers must be valid JSON')
    assert.ok(Array.isArray(JSON.parse(decoded.iceServers)), 'iceServers must be a JSON array')
})

test('second actor receives the first actor as host', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)
    const { id: idB, msgs: msgsB } = await admitActor(tl)

    const welcome = msgsB.find(m => m.topic === 'signal:welcome')
    assert.ok(welcome !== undefined, 'second actor must receive signal:welcome')
    const decoded = decodeWelcome(welcome.payload)
    assert.equal(decoded.youId, idB)
    assert.equal(decoded.hostId, idA, 'second actor is told the first actor is host')
})

test('third actor receives the same hostId as the second', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)
    await admitActor(tl)
    const { msgs: msgsC } = await admitActor(tl)

    const welcome = msgsC.find(m => m.topic === 'signal:welcome')
    assert.ok(welcome !== undefined)
    const decoded = decodeWelcome(welcome.payload)
    assert.equal(decoded.hostId, idA, 'host does not change when non-host peers join')
})

// ── ICE servers in welcome ────────────────────────────────────────────────────

test('welcome includes TURN creds when ICE_TURN_* env vars are set', async () => {
    const prev = {
        ICE_TURN_URLS: process.env['ICE_TURN_URLS'],
        ICE_TURN_SECRET: process.env['ICE_TURN_SECRET'],
    }
    try {
        process.env['ICE_TURN_URLS'] = 'turn:turn.example.com:3478'
        process.env['ICE_TURN_SECRET'] = 'room-test-secret'

        const { tl } = setup()
        const { id: idA, msgs: msgsA } = await admitActor(tl)

        const welcome = msgsA.find(m => m.topic === 'signal:welcome')
        assert.ok(welcome !== undefined)
        const decoded = decodeWelcome(welcome.payload)
        const servers = JSON.parse(decoded.iceServers)

        assert.ok(servers.length > 0, 'iceServers must be non-empty when TURN is configured')
        const turnEntry = servers.find((s: any) => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls as string]
            return (urls as string[]).some((u: string) => u.startsWith('turn:'))
        })
        assert.ok(turnEntry !== undefined, 'iceServers must contain a TURN entry')
        assert.ok(typeof turnEntry.username === 'string', 'TURN entry must have a username')
        assert.ok(turnEntry.username.endsWith(':' + idA), 'TURN username must contain the actor id as peerId')
        assert.ok(typeof turnEntry.credential === 'string', 'TURN entry must have a credential')
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
})

// ── relay routing ─────────────────────────────────────────────────────────────

test('signal:offer is forwarded only to the target actor', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)
    const { id: idB, msgs: msgsB } = await admitActor(tl)

    const offer = encodeOffer({ to: idA, sdp: 'v=0' })
    await tl.handleMessage(idB, encode('signal:offer', offer))

    const relayed = msgsA.find(m => m.topic === 'signal:offer')
    assert.ok(relayed !== undefined, 'target actor (A) must receive the relayed offer')
    assert.deepEqual(relayed.payload, offer, 'payload must be forwarded verbatim')

    assert.equal(
        msgsB.filter(m => m.topic === 'signal:offer').length,
        0,
        'sender (B) must not receive their own offer'
    )
})

test('signal:answer is forwarded only to the target actor', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)
    const { id: idB, msgs: msgsB } = await admitActor(tl)

    const answer = encodeAnswer({ to: idB, sdp: 'v=0' })
    await tl.handleMessage(idA, encode('signal:answer', answer))

    const relayed = msgsB.find(m => m.topic === 'signal:answer')
    assert.ok(relayed !== undefined, 'target actor (B) must receive the relayed answer')
    assert.deepEqual(relayed.payload, answer, 'payload must be forwarded verbatim')

    assert.equal(
        msgsA.filter(m => m.topic === 'signal:answer').length,
        0,
        'sender (A) must not receive their own answer'
    )
})

test('signal:ice is forwarded only to the target actor', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)
    const { id: idB, msgs: msgsB } = await admitActor(tl)

    const ice = encodeIceCandidate({ to: idA, candidate: '{}' })
    await tl.handleMessage(idB, encode('signal:ice', ice))

    const relayed = msgsA.find(m => m.topic === 'signal:ice')
    assert.ok(relayed !== undefined, 'target actor (A) must receive the relayed ICE candidate')

    assert.equal(
        msgsB.filter(m => m.topic === 'signal:ice').length,
        0,
        'sender (B) must not receive their own ICE candidate'
    )
})

test('relay to an unknown actorId is silently dropped (no bounce-back, no crash)', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)

    const offer = encodeOffer({ to: 'nonexistent-actor', sdp: 'v=0' })
    await tl.handleMessage(idA, encode('signal:offer', offer))

    assert.equal(
        msgsA.filter(m => m.topic === 'signal:offer').length,
        0,
        'sender must not receive a bounce-back for an unknown relay target'
    )
    assert.equal(tl.connections, 1, 'sender must remain connected')
})

// ── host-gone fanout ──────────────────────────────────────────────────────────

test('signal:host_gone is broadcast when the host leaves', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)
    const { msgs: msgsB } = await admitActor(tl)

    tl.handleClose(idA)

    assert.ok(
        msgsB.some(m => m.topic === 'signal:host_gone'),
        'remaining peers must receive signal:host_gone when the host disconnects'
    )
})

test('signal:host_gone is NOT sent when a non-host peer leaves', async () => {
    const { tl } = setup()
    const { msgs: msgsA } = await admitActor(tl)
    const { id: idB } = await admitActor(tl)

    tl.handleClose(idB)

    assert.equal(
        msgsA.filter(m => m.topic === 'signal:host_gone').length,
        0,
        'host must not receive signal:host_gone when a non-host peer leaves'
    )
})

// ── presence broadcasts ───────────────────────────────────────────────────────

test('__presence:join is broadcast when an actor joins (including to the joining actor)', async () => {
    const { tl } = setup()
    const { msgs: msgsA } = await admitActor(tl)

    assert.ok(
        msgsA.some(m => m.topic === '__presence:join'),
        'joining actor receives __presence:join for themselves (presence=true broadcasts to all actors in room)'
    )
})

test('__presence:join for a new peer is broadcast to already-connected peers', async () => {
    const { tl } = setup()
    const { msgs: msgsA } = await admitActor(tl)

    const joinCountBefore = msgsA.filter(m => m.topic === '__presence:join').length
    await admitActor(tl)  // second actor joins
    const joinCountAfter = msgsA.filter(m => m.topic === '__presence:join').length

    assert.equal(
        joinCountAfter - joinCountBefore,
        1,
        'first actor receives exactly one additional __presence:join when a second actor joins'
    )
})

test('__presence:leave is broadcast to remaining peers when an actor leaves', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)
    const { msgs: msgsB } = await admitActor(tl)

    tl.handleClose(idA)

    assert.ok(
        msgsB.some(m => m.topic === '__presence:leave'),
        'remaining peers must receive __presence:leave when an actor disconnects'
    )
})

// ── unknownTopicPolicy = drop ─────────────────────────────────────────────────

test('unknown topics are silently dropped; the actor is not kicked', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)

    // This topic is not bound in SignalRoom — policy='drop' means no kick.
    await tl.handleMessage(idA, encode('unknown:topic', new Uint8Array(0)))

    assert.equal(tl.connections, 1, 'actor must remain connected after an unknown topic (drop policy)')
})
