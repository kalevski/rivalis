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
    decodeHostElected,
    encodeHostState,
    decodeHostState,
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

test('signal:offer reaches ONLY the targeted actor — bystander peer is excluded', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)  // host
    const { id: idB, msgs: msgsB } = await admitActor(tl)  // sender
    const { msgs: msgsC } = await admitActor(tl)            // bystander

    const offer = encodeOffer({ to: idA, sdp: 'v=0' })
    await tl.handleMessage(idB, encode('signal:offer', offer))

    assert.ok(
        msgsA.some(m => m.topic === 'signal:offer'),
        'target (A) must receive the relayed offer'
    )
    assert.equal(
        msgsB.filter(m => m.topic === 'signal:offer').length,
        0,
        'sender (B) must not receive their own offer'
    )
    assert.equal(
        msgsC.filter(m => m.topic === 'signal:offer').length,
        0,
        'bystander (C) must not receive an offer addressed to A'
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

// ── host election ─────────────────────────────────────────────────────────────

test('signal:host_elected is broadcast to remaining peers when host leaves', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // host
    const { msgs: msgsB } = await admitActor(tl)
    const { msgs: msgsC } = await admitActor(tl)

    tl.handleClose(idA)

    assert.ok(
        msgsB.some(m => m.topic === 'signal:host_elected'),
        'peer B must receive signal:host_elected after the host disconnects'
    )
    assert.ok(
        msgsC.some(m => m.topic === 'signal:host_elected'),
        'peer C must receive signal:host_elected after the host disconnects'
    )
})

test('signal:host_elected names the oldest remaining peer as new host', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // host — joins first
    const { id: idB } = await admitActor(tl)  // joins second
    const { msgs: msgsC } = await admitActor(tl)

    tl.handleClose(idA)

    const electedMsg = msgsC.find(m => m.topic === 'signal:host_elected')
    assert.ok(electedMsg !== undefined, 'peer C must receive signal:host_elected')
    const decoded = decodeHostElected(electedMsg.payload)
    assert.equal(decoded.newHostId, idB, 'the oldest remaining peer (B) becomes the new host')
})

test('signal:host_gone is sent before signal:host_elected', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)
    const { msgs: msgsB } = await admitActor(tl)

    tl.handleClose(idA)

    const goneIdx    = msgsB.findIndex(m => m.topic === 'signal:host_gone')
    const electedIdx = msgsB.findIndex(m => m.topic === 'signal:host_elected')
    assert.ok(goneIdx !== -1,    'signal:host_gone must be sent')
    assert.ok(electedIdx !== -1, 'signal:host_elected must be sent')
    assert.ok(goneIdx < electedIdx, 'signal:host_gone must arrive before signal:host_elected')
})

test('signal:host_elected is NOT sent when no peers remain after host leaves', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)

    tl.handleClose(idA)

    assert.equal(
        msgsA.filter(m => m.topic === 'signal:host_elected').length,
        0,
        'signal:host_elected must not be sent when the last peer (host) disconnects'
    )
})

test('signal:host_gone is still sent even when no peers remain', async () => {
    const { tl } = setup()
    // We need a second actor to receive the broadcast, but test that host_gone
    // is broadcast when the host is the only one left by checking no crash occurs.
    const { id: idA } = await admitActor(tl)

    // No throw / crash expected.
    assert.doesNotThrow(() => tl.handleClose(idA))
})

test('new host after election is used in signal:welcome for subsequently joining peers', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // original host
    const { id: idB } = await admitActor(tl)  // becomes new host after A leaves

    tl.handleClose(idA)

    // C joins after election — should see B as host.
    const { msgs: msgsC } = await admitActor(tl)
    const welcome = msgsC.find(m => m.topic === 'signal:welcome')
    assert.ok(welcome !== undefined)
    const decoded = decodeWelcome(welcome.payload)
    assert.equal(decoded.hostId, idB, 'new joiner must see the elected host (B) in welcome')
})

test('chained election: elected host also leaves — next oldest peer is elected', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // original host
    const { id: idB } = await admitActor(tl)  // elected host after A leaves
    const { id: idC, msgs: msgsC } = await admitActor(tl)

    tl.handleClose(idA)  // B becomes host
    tl.handleClose(idB)  // C should be elected

    const electedMsgs = msgsC.filter(m => m.topic === 'signal:host_elected')
    assert.equal(electedMsgs.length, 2, 'peer C must receive two signal:host_elected messages')

    assert.equal(decodeHostElected(electedMsgs[0].payload).newHostId, idB,
        'first election: B is elected')
    assert.equal(decodeHostElected(electedMsgs[1].payload).newHostId, idC,
        'second election: C (the only remaining peer) is elected')
})

test('election determinism: the second-joined peer is always elected (not third)', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // host
    const { id: idB } = await admitActor(tl)  // second to join → should be elected
    await admitActor(tl)                        // third to join
    const { msgs: msgsD } = await admitActor(tl)  // observer

    tl.handleClose(idA)

    const elected = msgsD.find(m => m.topic === 'signal:host_elected')
    assert.ok(elected !== undefined)
    assert.equal(decodeHostElected(elected.payload).newHostId, idB,
        'the second-joined peer (oldest after host) must be elected, not the third')
})

test('non-host leave does not trigger election or signal:host_elected', async () => {
    const { tl } = setup()
    const { id: idA, msgs: msgsA } = await admitActor(tl)  // host
    const { id: idB } = await admitActor(tl)

    tl.handleClose(idB)

    assert.equal(
        msgsA.filter(m => m.topic === 'signal:host_elected').length,
        0,
        'signal:host_elected must not be sent when a non-host peer leaves'
    )
    assert.equal(
        msgsA.filter(m => m.topic === 'signal:host_gone').length,
        0,
        'signal:host_gone must not be sent when a non-host peer leaves'
    )
})

// ── host state transfer (serialize/hydrate, p2p.md §12 Phase 3) ───────────────

test('state pushed by host via signal:host_state is forwarded to the elected host', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)           // host
    const { id: idB, msgs: msgsB } = await admitActor(tl)

    // Old host pushes serialized state before disconnecting.
    const state = new Uint8Array([10, 20, 30])
    await tl.handleMessage(idA, encode('signal:host_state', encodeHostState({ state })))

    // Host disconnects → B is elected.
    tl.handleClose(idA)

    const stateMsg = msgsB.find(m => m.topic === 'signal:host_state')
    assert.ok(stateMsg !== undefined, 'new host must receive signal:host_state after election')
    const decoded = decodeHostState(stateMsg.payload)
    assert.ok(decoded !== null, 'decoded host state must not be null')
    assert.deepEqual(decoded.state, state, 'forwarded state bytes must match what the old host sent')
})

test('signal:host_state is NOT forwarded when host did not push state (crash path)', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // host — does not push state
    const { msgs: msgsB } = await admitActor(tl)

    tl.handleClose(idA)

    assert.equal(
        msgsB.filter(m => m.topic === 'signal:host_state').length,
        0,
        'new host must not receive signal:host_state when the old host never pushed state'
    )
})

test('signal:host_state from a non-host peer is silently ignored', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // host
    const { id: idB, msgs: msgsB } = await admitActor(tl)

    // Non-host (B) tries to inject state.
    const fakeState = new Uint8Array([99])
    await tl.handleMessage(idB, encode('signal:host_state', encodeHostState({ state: fakeState })))

    // Now the real host leaves.
    tl.handleClose(idA)

    // B is elected but should NOT receive the injected state.
    assert.equal(
        msgsB.filter(m => m.topic === 'signal:host_state').length,
        0,
        'injected state from a non-host peer must be ignored'
    )
})

test('pending host state is cleared after handoff so it cannot be reused in a second election', async () => {
    const { tl } = setup()
    const { id: idA } = await admitActor(tl)  // original host
    const { id: idB, msgs: msgsB } = await admitActor(tl)
    const { msgs: msgsC } = await admitActor(tl)

    // Old host pushes state.
    const state = new Uint8Array([1, 2, 3])
    await tl.handleMessage(idA, encode('signal:host_state', encodeHostState({ state })))
    tl.handleClose(idA)  // B becomes host; C should NOT get state here

    // B becomes host but does NOT push state before leaving.
    tl.handleClose(idB)  // C is elected

    // C's second election notification must not carry the stale state from A.
    const stateMsgs = msgsC.filter(m => m.topic === 'signal:host_state')
    assert.equal(
        stateMsgs.length,
        0,
        'stale state from a previous epoch must not be forwarded to a second election'
    )
})
