/**
 * Proves that multiple transports feeding the same Rivalis instance all share
 * one TLayer and one room space (p2p.md §3.6, task 042).
 *
 * §3.6 wiring in one sentence:
 *   Rivalis.constructor calls `transport.onInitialize(this.transportLayer)` for
 *   every transport in the array (Rivalis.ts:33-34), so every transport receives
 *   the identical TLayer reference.  From that point forward, actors admitted by
 *   any transport are indistinguishable inside a Room — actorCount, each(),
 *   broadcast(), send(), kick() all work the same regardless of which transport
 *   the actor came through.
 *
 * Constraints (documented here so they are visible alongside the test):
 *   1. All transports share a single AuthMiddleware and RateLimiter
 *      (per-transport overrides are deferred to Phase 4, task 043/086).
 *   2. actorId allocation is CSPRNG-based and globally unique across transports
 *      inside one Rivalis instance.
 *   3. Room.onJoin / onLeave / onMessage are transport-agnostic; a Room subclass
 *      cannot tell which transport admitted an actor.
 *   4. The TLayer pre-listener buffer (pendingEmits, max 256 frames per key)
 *      applies to every transport identically: a transport must register its
 *      per-actor message/kick listeners promptly after grantAccess.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { WebSocket } from 'ws'

import { Rivalis, Room, Actor, AuthMiddleware, Transport } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'
import { WSTransport } from '../lib/ws.js'
import { encode, decode } from '@rivalis/handshake'

// ── helpers ──────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, () => {
            const address = srv.address()
            const port = typeof address === 'object' && address !== null ? address.port : 0
            srv.close(() => resolve(port))
        })
    })
}

/**
 * StubTransport simulates a second transport (e.g. an RTCTransport that has not
 * been implemented yet). It captures the TLayer passed to onInitialize so the
 * test can drive actors through it directly — the same five-step seam that any
 * real transport uses (grantAccess → handleMessage / on('message') / on('kick') →
 * handleClose).
 */
class StubTransport extends Transport {
    layer: any = null

    override onInitialize(tl: any): void {
        this.layer = tl
    }

    override get sockets(): number { return 0 }
}

class SimpleAuth extends AuthMiddleware<null> {
    async authenticate(ticket: string): Promise<AuthResult<null> | null> {
        if (ticket === 'ws-ticket' || ticket === 'rtc-ticket') {
            return { data: null, roomId: 'shared-room' }
        }
        return null
    }
}

// ── AC1: both transports receive the identical TLayer on initialization ────────

test('all transports in the array receive the same TLayer instance', () => {
    const stub1 = new StubTransport()
    const stub2 = new StubTransport()

    new Rivalis<null>({
        transports: [stub1, stub2],
        authMiddleware: new SimpleAuth()
    })

    assert.ok(stub1.layer !== null, 'first transport must receive a TLayer')
    assert.ok(stub2.layer !== null, 'second transport must receive a TLayer')
    assert.strictEqual(
        stub1.layer,
        stub2.layer,
        'both transports must share the exact same TLayer reference'
    )
})

// ── AC2: actors admitted by different transports occupy the same room ─────────

test('actors from two different transports join the same room', async () => {
    const stub1 = new StubTransport()
    const stub2 = new StubTransport()

    const rivalis = new Rivalis<null>({
        transports: [stub1, stub2],
        authMiddleware: new SimpleAuth()
    })
    rivalis.rooms.define('shared', class extends Room<null> {})
    rivalis.rooms.create('shared', 'shared-room')

    // Admit actor-A through stub1 (simulating a WS peer)
    const idA = await stub1.layer.grantAccess('ws-ticket', { kind: 'ws', remoteId: '127.0.0.1' })
    // Admit actor-B through stub2 (simulating an RTC peer)
    const idB = await stub2.layer.grantAccess('rtc-ticket', { kind: 'webrtc', remoteId: 'peer-99' })

    assert.ok(idA !== idB, 'actors from different transports get unique ids')

    const tl: any = stub1.layer
    assert.equal(tl.connections, 2, 'TLayer should count 2 in-room connections')

    const room = rivalis.rooms.get('shared-room')
    assert.ok(room !== null, 'room must exist')
    assert.equal(room!.actorCount, 2, 'both actors occupy the same room')
})

// ── AC3: WS client + stub RTC peer share one room and route messages across ───

test('WS client and stub RTC peer share one room; messages route across transports', async (t) => {
    const port = await getFreePort()
    const rtcStub = new StubTransport()

    // Room counts joins and broadcasts every inbound message back to all actors.
    let joinCount = 0
    let allJoinedResolve: (() => void) | null = null
    const allJoined = new Promise<void>(resolve => { allJoinedResolve = resolve })

    class SharedRoom extends Room<null> {
        protected override onJoin(_actor: Actor<null>): void {
            joinCount++
            if (joinCount >= 2) allJoinedResolve?.()
        }
        protected override onMessage(_actor: Actor<null>, topic: string, payload: Uint8Array): void {
            this.broadcast(topic, payload)
        }
    }

    const rivalis = new Rivalis<null>({
        transports: [
            new WSTransport({ port }, null, { ticketSource: 'protocol' }),
            rtcStub
        ],
        authMiddleware: new SimpleAuth()
    })
    rivalis.rooms.define('shared', SharedRoom)
    rivalis.rooms.create('shared', 'shared-room')

    t.after(() => rivalis.shutdown())

    // ── connect the WS client (simulates a WS peer) ───────────────────────────
    const wsMessages: Array<{ topic: string; payload: Uint8Array }> = []
    const wsClient = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['ws-ticket'])
        ws.on('open', () => resolve(ws))
        ws.on('error', reject)
    })
    wsClient.on('message', (data) => {
        const bytes = new Uint8Array(data as Buffer)
        try {
            const { topic, payload } = decode(bytes)
            wsMessages.push({ topic, payload })
        } catch { /* ignore non-handshake frames */ }
    })

    // ── connect the RTC peer via stub transport ───────────────────────────────
    const rtcActorId: string = await rtcStub.layer.grantAccess('rtc-ticket', { kind: 'webrtc', remoteId: 'peer-99' })

    // Register the stub actor's outbound listener — mirrors what a real RTCTransport does.
    const rtcMessages: Array<{ topic: string; payload: Uint8Array }> = []
    rtcStub.layer.on('message', rtcActorId, (_id: string, bytes: Uint8Array) => {
        const { topic, payload } = decode(bytes)
        rtcMessages.push({ topic, payload })
    })

    // Wait until both actors are in the room.
    await allJoined

    const room = rivalis.rooms.get('shared-room')
    assert.ok(room !== null, 'shared room must exist')
    assert.equal(room!.actorCount, 2, 'both actors (WS + RTC) occupy the same room')

    // ── RTC peer sends a message; WS client should receive it ─────────────────
    const rtcPayload = new TextEncoder().encode('hello-from-rtc')
    await rtcStub.layer.handleMessage(
        rtcActorId,
        encode('chat', rtcPayload)
    )

    // ── WS client sends a message; RTC peer should receive it ─────────────────
    const wsPayload = new TextEncoder().encode('hello-from-ws')
    wsClient.send(encode('chat', wsPayload))

    // Allow the async message paths to settle.
    await new Promise(resolve => setTimeout(resolve, 50))

    // WS client should have received the RTC broadcast (and its own echo).
    const wsGotRtc = wsMessages.some(m => m.topic === 'chat' &&
        new TextDecoder().decode(m.payload) === 'hello-from-rtc')
    assert.ok(wsGotRtc, 'WS client must receive the RTC peer broadcast via the shared TLayer')

    // RTC peer should have received the WS broadcast (and its own echo).
    const rtcGotWs = rtcMessages.some(m => m.topic === 'chat' &&
        new TextDecoder().decode(m.payload) === 'hello-from-ws')
    assert.ok(rtcGotWs, 'RTC peer must receive the WS client broadcast via the shared TLayer')

    wsClient.close()
})

// ── AC4: three transports all share one TLayer ────────────────────────────────

test('three transports all receive the same TLayer', () => {
    const stubs = [new StubTransport(), new StubTransport(), new StubTransport()]

    new Rivalis<null>({
        transports: stubs,
        authMiddleware: new SimpleAuth()
    })

    for (const stub of stubs) {
        assert.ok(stub.layer !== null, 'every transport must receive a TLayer')
    }
    assert.strictEqual(stubs[0]!.layer, stubs[1]!.layer, 'stub[0] and stub[1] share the TLayer')
    assert.strictEqual(stubs[1]!.layer, stubs[2]!.layer, 'stub[1] and stub[2] share the TLayer')
})
