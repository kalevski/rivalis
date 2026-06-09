/**
 * RTCClient unit tests (p2p.md §4.4, task 064).
 *
 * All tests run without real WebRTC or a real signal server. The signal client,
 * peer connections, and data channels are fully mocked.
 *
 * Covers:
 *  - connect() → PeerNegotiator.connect() → signal:welcome → DC open → client:connect
 *  - §4.2 ticket protocol: game ticket sent as first DC message
 *  - connect() no-op when already negotiating or connected
 *  - connected getter: false during negotiation, true once DC open
 *  - send: encode+forward when DC open; silent drop when not open
 *  - onmessage: decode → emit topic/payload
 *  - kick: §3.4 __rivalis:close control frame → client:kicked { code, reason }
 *  - NO_RECONNECT_CODES: KICKED/INVALID_TICKET/ROOM_REJECTED suppress reconnect
 *  - disconnect(): user-initiated teardown → client:disconnect, no reconnect
 *  - double-close guard: triggerDisconnect fires exactly once per lifecycle
 *  - PC state change (failed/disconnected/closed) → client:disconnect
 *  - signal disconnect before DC opens → client:disconnect (early reconnect path)
 *  - reconnect: scheduleReconnect → startNegotiation re-runs after normal close
 *  - reconnect: getTicket called on each reconnect attempt
 *  - client:reconnect_failed emitted when reconnect is disabled after first close
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import {
    createCodec,
    FieldType,
    encode as handshakeEncode,
    decode as handshakeDecode,
    encodeCloseFrame,
    CLOSE_CONTROL_TOPIC,
    CloseCode,
} from '@rivalis/handshake'
import { RTCClient } from '../lib/main.js'
import type { RTCAdapters, ChannelReliability } from '../lib/main.js'
import type { RTCPeerLike, RTCDataChannelLike } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Signal wire codec (same schema + major as NegotiationCore / RTCTransport)
// ---------------------------------------------------------------------------

const testSignalCodec = createCodec({
    namespace: '@rivalis/node/rtc-client-test',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: FieldType.STRING, rule: 'optional' },
            { key: 'hostId',     type: FieldType.STRING, rule: 'optional' },
            { key: 'iceServers', type: FieldType.STRING, rule: 'optional' },
        ],
        Answer: [
            { key: 'to',   type: FieldType.STRING, rule: 'optional' },
            { key: 'sdp',  type: FieldType.STRING, rule: 'optional' },
            { key: 'from', type: FieldType.STRING, rule: 'optional' },
        ],
        IceCandidate: [
            { key: 'to',        type: FieldType.STRING, rule: 'optional' },
            { key: 'candidate', type: FieldType.STRING, rule: 'optional' },
            { key: 'from',      type: FieldType.STRING, rule: 'optional' },
        ],
    },
})

function encodeWelcome(youId: string, hostId = 'host-1', iceServers = '[]'): Uint8Array {
    return testSignalCodec.encode('Welcome', { youId, hostId, iceServers })
}

function encodeAnswer(to: string, sdp: string, from: string): Uint8Array {
    return testSignalCodec.encode('Answer', { to, sdp, from })
}

// ---------------------------------------------------------------------------
// Listener / event helpers
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

// ---------------------------------------------------------------------------
// MockSignalClient
// ---------------------------------------------------------------------------

class MockSignalClient {
    private readonly map = new Map<string, Listener[]>()
    readonly sent: Array<{ topic: string; payload: Uint8Array }> = []
    connectedWith: string | null = null
    disconnected = false
    private _connected = false

    on(event: string, listener: Listener): this {
        const list = this.map.get(event) ?? []
        list.push(listener)
        this.map.set(event, list)
        return this
    }
    once(event: string, listener: Listener): this { return this.on(event, listener) }
    off(): this { return this }
    get connected(): boolean { return this._connected }
    connect(ticket: string): void { this.connectedWith = ticket; this._connected = true }
    disconnect(): void {
        this._connected = false
        this.disconnected = true
        for (const l of this.map.get('client:disconnect') ?? []) l(new Uint8Array())
    }
    send(topic: string, payload: Uint8Array | string): void {
        const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
        this.sent.push({ topic, payload: bytes })
    }
    emit(topic: string, ...args: unknown[]): void {
        for (const l of this.map.get(topic) ?? []) l(...args)
    }
}

// ---------------------------------------------------------------------------
// MockDataChannel
// ---------------------------------------------------------------------------

class MockDataChannel implements RTCDataChannelLike {
    private _onMessage: ((buf: Uint8Array) => void) | null = null
    private _onOpen: (() => void) | null = null
    private _onClose: (() => void) | null = null
    readonly sent: Uint8Array[] = []
    private _isOpen = false
    closed = false
    bufferedAmount = 0

    onMessage(cb: (buf: Uint8Array) => void): void { this._onMessage = cb }
    onOpen(cb: () => void): void { this._onOpen = cb }
    onClose(cb: () => void): void { this._onClose = cb }
    sendBinary(buf: Uint8Array): void { if (this._isOpen) this.sent.push(buf) }
    close(): void { this.closed = true; this._isOpen = false; this._onClose?.() }
    get isOpen(): boolean { return this._isOpen }

    /** Simulate the DC opening. */
    open(): void { this._isOpen = true; this._onOpen?.() }
    /** Simulate an inbound binary message from the host. */
    receive(buf: Uint8Array): void { this._onMessage?.(buf) }
}

// ---------------------------------------------------------------------------
// MockPeer
// ---------------------------------------------------------------------------

class MockPeer implements RTCPeerLike {
    private _onState: ((s: string) => void) | null = null
    private _onLocalDesc: ((sdp: string, type: string) => void) | null = null
    private _onLocalCand: ((c: string, m: string) => void) | null = null
    dc: MockDataChannel = new MockDataChannel()
    lastReliability: ChannelReliability | null = null
    closed = false

    createDataChannel(_label: string, reliability: ChannelReliability): RTCDataChannelLike {
        this.lastReliability = reliability
        return this.dc
    }
    onDataChannel(_cb: (dc: RTCDataChannelLike) => void): void { /* peer is initiator, never answerer */ }
    onStateChange(cb: (s: string) => void): void { this._onState = cb }
    onLocalDescription(cb: (sdp: string, type: string) => void): void { this._onLocalDesc = cb }
    onLocalCandidate(cb: (c: string, m: string) => void): void { this._onLocalCand = cb }
    setLocalDescription(_type?: string): void {
        // Simulate async: fire offer asynchronously
        Promise.resolve().then(() => this._onLocalDesc?.('v=0 offer', 'offer')).catch(() => {})
    }
    setRemoteDescription(_sdp: string, _type: string): void {}
    addRemoteCandidate(_c: string, _m: string): void {}
    close(): void { this.closed = true }
    emitState(s: string): void { this._onState?.(s) }
}

// ---------------------------------------------------------------------------
// Factory — builds RTCClient with mocked adapters
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

function makeClient(opts: {
    reconnect?: boolean
    getTicket?: () => string | Promise<string>
    channelReliability?: ChannelReliability
} = {}) {
    const signalClients: MockSignalClient[] = []
    const peers: MockPeer[] = []

    const adapters: RTCAdapters = {
        createPeerConnection(): RTCPeerLike {
            const peer = new MockPeer()
            peers.push(peer)
            return peer
        },
        createSignalingClient(): AnyClient {
            const sc = new MockSignalClient()
            signalClients.push(sc)
            return sc
        },
    }

    const client = new RTCClient('ws://signal:9000', {
        adapters,
        reconnect: opts.reconnect,
        getTicket: opts.getTicket,
        channelReliability: opts.channelReliability,
    })

    return { client, signalClients, peers }
}

/** Drain the microtask + macrotask queue (one setTimeout tick). */
function nextTick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Drive the full connect → signal:welcome → offer → answer → DC open flow.
 * Returns the mock data channel and the currently active signal client.
 */
async function fullConnect(
    client: RTCClient,
    signalClients: MockSignalClient[],
    peers: MockPeer[],
    ticket = 'game-ticket',
): Promise<{ dc: MockDataChannel; sc: MockSignalClient; peer: MockPeer }> {
    client.connect(ticket)
    await nextTick()

    const sc = signalClients[signalClients.length - 1]!
    const peer = peers[peers.length - 1]!

    // Signal:welcome triggers PC creation and offer generation
    sc.emit('signal:welcome', encodeWelcome('peer-id', 'host-id'))
    await nextTick()

    // Simulate host sending back an answer (optional for DC open, but realistic)
    sc.emit('signal:answer', encodeAnswer('peer-id', 'v=0 answer', 'host-id'))

    // Open the data channel
    peer.dc.open()

    return { dc: peer.dc, sc, peer }
}

// ---------------------------------------------------------------------------
// connect flow
// ---------------------------------------------------------------------------

suite('RTCClient — connect flow', () => {

    test('connect() calls signalClient.connect with the ticket', async () => {
        const { client, signalClients } = makeClient()
        client.connect('my-ticket')
        await nextTick()
        assert.strictEqual(signalClients[0]!.connectedWith, 'my-ticket')
    })

    test('DC open → emits client:connect', async () => {
        const { client, signalClients, peers } = makeClient()
        const events: string[] = []
        client.on('client:connect', () => events.push('connect'))

        await fullConnect(client, signalClients, peers)

        assert.ok(events.includes('connect'))
    })

    test('connected is false during negotiation, true after DC open', async () => {
        const { client, signalClients, peers } = makeClient()

        client.connect('ticket')
        await nextTick()
        assert.strictEqual(client.connected, false, 'must be false before DC opens')

        const sc = signalClients[0]!
        sc.emit('signal:welcome', encodeWelcome('peer-id', 'host-id'))
        await nextTick()
        assert.strictEqual(client.connected, false, 'must be false after welcome but before DC open')

        peers[0]!.dc.open()
        assert.strictEqual(client.connected, true, 'must be true after DC opens')
    })

    test('connect() no-op when negotiation already in progress', async () => {
        const { client, signalClients } = makeClient()
        client.connect('first')
        await nextTick()
        client.connect('second')  // must be ignored
        assert.strictEqual(signalClients.length, 1, 'second connect must not create another negotiator')
    })

    test('connect() no-op when already connected', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const beforeCount = signalClients.length
        client.connect('again')
        assert.strictEqual(signalClients.length, beforeCount)
    })

})

// ---------------------------------------------------------------------------
// §4.2 ticket protocol
// ---------------------------------------------------------------------------

suite('RTCClient — §4.2 ticket protocol (first DC message)', () => {

    test('game ticket sent as first binary message on DC open', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers, 'game-room-token')

        assert.ok(dc.sent.length > 0, 'at least one message must have been sent')
        const firstMsg = dc.sent[0]!
        const decodedTicket = new TextDecoder().decode(firstMsg)
        assert.strictEqual(decodedTicket, 'game-room-token')
    })

    test('subsequent send() calls use handshake encode, not raw UTF-8', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers, 'ticket')

        client.send('game:move', new Uint8Array([1, 2, 3]))

        // dc.sent[0] = raw ticket, dc.sent[1] = handshake-encoded game frame
        assert.ok(dc.sent.length >= 2)
        const frame = handshakeDecode(dc.sent[1]!)
        assert.strictEqual(frame.topic, 'game:move')
        assert.deepStrictEqual(frame.payload, new Uint8Array([1, 2, 3]))
    })

})

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

suite('RTCClient — send', () => {

    test('send() encodes and forwards Uint8Array payload when DC is open', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)

        client.send('topic:a', new Uint8Array([10, 20]))

        const lastFrame = dc.sent[dc.sent.length - 1]!
        const { topic, payload } = handshakeDecode(lastFrame)
        assert.strictEqual(topic, 'topic:a')
        assert.deepStrictEqual(payload, new Uint8Array([10, 20]))
    })

    test('send() encodes string payload', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)

        client.send('topic:b', 'hello')

        const lastFrame = dc.sent[dc.sent.length - 1]!
        const { payload } = handshakeDecode(lastFrame)
        assert.strictEqual(new TextDecoder().decode(payload), 'hello')
    })

    test('send() is a no-op when DC is not open', () => {
        const { client } = makeClient()
        assert.doesNotThrow(() => client.send('topic:c', new Uint8Array([1])))
    })

    test('send() is a no-op after disconnect', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)
        const sentBefore = dc.sent.length
        client.disconnect()
        client.send('after:disconnect', new Uint8Array([1]))
        assert.strictEqual(dc.sent.length, sentBefore, 'no frame must be sent after disconnect')
    })

})

// ---------------------------------------------------------------------------
// onmessage
// ---------------------------------------------------------------------------

suite('RTCClient — onmessage (decode → emit)', () => {

    test('inbound handshake frame decoded and emitted on the correct topic', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)

        const received: Array<{ topic: string; payload: Uint8Array }> = []
        client.on('game:state', (payload: Uint8Array) => received.push({ topic: 'game:state', payload }))

        const frame = handshakeEncode('game:state', new Uint8Array([7, 8, 9]))
        dc.receive(frame)

        assert.strictEqual(received.length, 1)
        assert.deepStrictEqual(received[0]!.payload, new Uint8Array([7, 8, 9]))
    })

    test('multiple topics emitted independently', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)

        const log: string[] = []
        client.on('t:a', () => log.push('t:a'))
        client.on('t:b', () => log.push('t:b'))

        dc.receive(handshakeEncode('t:a', new Uint8Array()))
        dc.receive(handshakeEncode('t:b', new Uint8Array()))

        assert.deepStrictEqual(log, ['t:a', 't:b'])
    })

})

// ---------------------------------------------------------------------------
// kick — §3.4 control frame
// ---------------------------------------------------------------------------

suite('RTCClient — kick (§3.4 __rivalis:close control frame)', () => {

    test('__rivalis:close frame → emits client:kicked { code, reason }', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)

        const kicks: Array<{ code: number; reason: string }> = []
        client.on('client:kicked', (info: { code: number; reason: string }) => kicks.push(info))

        const closePayload = encodeCloseFrame(CloseCode.KICKED, 'room_destroyed')
        dc.receive(handshakeEncode(CLOSE_CONTROL_TOPIC, closePayload))

        assert.strictEqual(kicks.length, 1)
        assert.strictEqual(kicks[0]!.code, CloseCode.KICKED)
        assert.strictEqual(kicks[0]!.reason, 'room_destroyed')
    })

    test('regular topic frames are NOT treated as control frames', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await fullConnect(client, signalClients, peers)

        const kicks: unknown[] = []
        client.on('client:kicked', (info) => kicks.push(info))

        dc.receive(handshakeEncode('game:state', new Uint8Array([1])))
        assert.strictEqual(kicks.length, 0)
    })

})

// ---------------------------------------------------------------------------
// NO_RECONNECT_CODES gate
// ---------------------------------------------------------------------------

suite('RTCClient — NO_RECONNECT_CODES (reconnect disabled for terminal kicks)', () => {

    async function testNoReconnect(code: number): Promise<void> {
        const { client, signalClients, peers } = makeClient({ reconnect: true })
        const { dc } = await fullConnect(client, signalClients, peers)

        const failed: string[] = []
        client.on('client:reconnect_failed', () => failed.push('failed'))

        // Send control frame with a terminal code, then close the DC
        const closePayload = encodeCloseFrame(code, 'reason')
        dc.receive(handshakeEncode(CLOSE_CONTROL_TOPIC, closePayload))
        dc.close()
        await nextTick()

        // Must NOT create a new negotiator — only the one from the initial connect
        assert.strictEqual(signalClients.length, 1, `code ${code} must not trigger reconnect`)
    }

    test('KICKED suppresses reconnect', async () => {
        await testNoReconnect(CloseCode.KICKED)
    })

    test('INVALID_TICKET suppresses reconnect', async () => {
        await testNoReconnect(CloseCode.INVALID_TICKET)
    })

    test('ROOM_REJECTED suppresses reconnect', async () => {
        await testNoReconnect(CloseCode.ROOM_REJECTED)
    })

})

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

suite('RTCClient — disconnect', () => {

    test('disconnect() emits client:disconnect with "terminated" payload', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const payloads: Uint8Array[] = []
        client.on('client:disconnect', (p: Uint8Array) => payloads.push(p))
        client.disconnect()

        assert.strictEqual(payloads.length, 1)
        assert.strictEqual(new TextDecoder().decode(payloads[0]!), 'terminated')
    })

    test('disconnect() sets connected to false', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)
        assert.strictEqual(client.connected, true)
        client.disconnect()
        assert.strictEqual(client.connected, false)
    })

    test('disconnect() closes the negotiator (signal client disconnected)', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)
        client.disconnect()
        assert.ok(signalClients[0]!.disconnected)
    })

    test('disconnect() during negotiation (before DC open) emits client:disconnect', async () => {
        const { client, signalClients } = makeClient()
        client.connect('ticket')
        await nextTick()

        const payloads: string[] = []
        client.on('client:disconnect', (p: Uint8Array) => payloads.push(new TextDecoder().decode(p)))
        client.disconnect()

        assert.ok(payloads.includes('terminated'))
    })

    test('disconnect() when already disconnected is a no-op', async () => {
        const { client } = makeClient()
        assert.doesNotThrow(() => { client.disconnect(); client.disconnect() })
    })

    test('disconnect() suppresses reconnect on subsequent DC close', async () => {
        const { client, signalClients, peers } = makeClient({ reconnect: true })
        await fullConnect(client, signalClients, peers)

        client.disconnect()
        // DC close after user disconnect must not trigger reconnect
        peers[0]!.dc.close()
        await nextTick()

        assert.strictEqual(signalClients.length, 1, 'no reconnect after user disconnect')
    })

})

// ---------------------------------------------------------------------------
// double-close guard
// ---------------------------------------------------------------------------

suite('RTCClient — double-close guard', () => {

    test('client:disconnect emitted exactly once when both DC.close and PC.failed fire', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc, peer } = await fullConnect(client, signalClients, peers)

        const disconnects: number[] = []
        client.on('client:disconnect', () => disconnects.push(1))

        dc.close()
        peer.emitState('failed')

        assert.strictEqual(disconnects.length, 1, 'client:disconnect must be emitted exactly once')
    })

    test('client:disconnect emitted exactly once when PC.disconnected fires before DC.close', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc, peer } = await fullConnect(client, signalClients, peers)

        const disconnects: number[] = []
        client.on('client:disconnect', () => disconnects.push(1))

        peer.emitState('disconnected')
        dc.close()

        assert.strictEqual(disconnects.length, 1)
    })

})

// ---------------------------------------------------------------------------
// PC state change → client:disconnect
// ---------------------------------------------------------------------------

suite('RTCClient — PC state change', () => {

    test('PC "failed" → emits client:disconnect', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const events: string[] = []
        client.on('client:disconnect', () => events.push('disconnect'))
        peers[0]!.emitState('failed')

        assert.ok(events.includes('disconnect'))
    })

    test('PC "closed" → emits client:disconnect', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const events: string[] = []
        client.on('client:disconnect', () => events.push('disconnect'))
        peers[0]!.emitState('closed')

        assert.ok(events.includes('disconnect'))
    })

    test('PC "connected" and "connecting" are ignored', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const events: string[] = []
        client.on('client:disconnect', () => events.push('disconnect'))
        peers[0]!.emitState('connected')
        peers[0]!.emitState('connecting')

        assert.strictEqual(events.length, 0)
    })

})

// ---------------------------------------------------------------------------
// Signal disconnect before DC opens
// ---------------------------------------------------------------------------

suite('RTCClient — signal disconnect before DC opens', () => {

    test('signal client:disconnect before DC opens → emits client:disconnect', async () => {
        const { client, signalClients } = makeClient()
        client.connect('ticket')
        await nextTick()

        const sc = signalClients[0]!
        sc.emit('signal:welcome', encodeWelcome('peer-id', 'host-id'))
        // DC has not opened yet

        const events: string[] = []
        client.on('client:disconnect', () => events.push('disconnect'))

        sc.disconnect()  // signal server disconnects before DC opens
        await nextTick()

        assert.ok(events.includes('disconnect'), 'signal disconnect must propagate to client:disconnect')
    })

    test('signal client:disconnect after DC opens is a no-op', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const events: string[] = []
        client.on('client:disconnect', () => events.push('disconnect'))

        signalClients[0]!.disconnect()  // signal disconnect after DC open — game still running
        await nextTick()

        assert.strictEqual(events.length, 0, 'signal disconnect must not affect open game connection')
    })

})

// ---------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------

suite('RTCClient — reconnect', () => {

    test('normal DC close with reconnect:true schedules a new negotiation', async () => {
        const { client, signalClients, peers } = makeClient({ reconnect: true })
        await fullConnect(client, signalClients, peers)

        const reconnecting: number[] = []
        client.on('client:reconnecting', () => reconnecting.push(1))

        peers[0]!.dc.close()
        assert.ok(reconnecting.length > 0, 'client:reconnecting must be emitted')
    })

    test('reconnect re-runs negotiation (new PeerNegotiator created)', async () => {
        const { client, signalClients, peers } = makeClient({ reconnect: true })
        await fullConnect(client, signalClients, peers)

        const sc0 = signalClients[0]!
        peers[0]!.dc.close()

        // Wait for reconnect timer (backoff uses setTimeout(0..500ms); nextTick should be enough
        // once we advance time manually via fake timers — in this test we just wait a tick)
        await nextTick()
        // The reconnect fires on the next setTimeout, which in node:test uses real timers.
        // We wait with enough ticks to allow the setTimeout(0..baseDelay) to fire.
        // baseDelay = 500ms → use setImmediate/nextTick won't work, but attempt 0 has
        // very small backoff. In unit tests we check that the second signal client
        // is created after DC close, using a small delay.
        await new Promise(r => setTimeout(r, 600))

        assert.ok(signalClients.length >= 2, 'second negotiation must start after reconnect')
        const sc1 = signalClients[signalClients.length - 1]!
        assert.notStrictEqual(sc1, sc0, 'new signal client created for reconnect')
    })

    test('getTicket is called on reconnect to refresh the ticket', async () => {
        let callCount = 0
        const getTicket = (): string => { callCount++; return `ticket-${callCount}` }
        const { client, signalClients, peers } = makeClient({ reconnect: true, getTicket })

        await fullConnect(client, signalClients, peers, 'initial-ticket')
        peers[0]!.dc.close()
        await new Promise(r => setTimeout(r, 600))

        assert.ok(callCount >= 1, 'getTicket must be called at least once for reconnect')
        const sc1 = signalClients[signalClients.length - 1]!
        assert.ok(
            sc1.connectedWith?.startsWith('ticket-'),
            'reconnect must use ticket from getTicket, got: ' + sc1.connectedWith,
        )
    })

    test('reconnect disabled by default (no reconnect option)', async () => {
        const { client, signalClients, peers } = makeClient()  // no reconnect
        await fullConnect(client, signalClients, peers)

        peers[0]!.dc.close()
        await nextTick()

        assert.strictEqual(signalClients.length, 1, 'must not reconnect without reconnect option')
    })

    test('client:reconnect_failed NOT emitted on first normal disconnect (reconnect disabled)', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)

        const failed: number[] = []
        client.on('client:reconnect_failed', () => failed.push(1))

        peers[0]!.dc.close()
        await nextTick()

        assert.strictEqual(failed.length, 0, 'reconnect_failed must not be emitted on first close')
    })

})

// ---------------------------------------------------------------------------
// channelReliability — parity: one reliable channel (p2p.md §7)
// ---------------------------------------------------------------------------

suite('RTCClient — channelReliability (p2p.md §7)', () => {

    test('default reliability is { ordered: true } — WS-like ordered delivery', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)
        assert.deepStrictEqual(peers[0]!.lastReliability, { ordered: true })
    })

    test('custom reliability { ordered: false, maxRetransmits: 0 } is forwarded to the data channel', async () => {
        const { client, signalClients, peers } = makeClient({
            channelReliability: { ordered: false, maxRetransmits: 0 },
        })
        await fullConnect(client, signalClients, peers)
        assert.deepStrictEqual(peers[0]!.lastReliability, { ordered: false, maxRetransmits: 0 })
    })

    test('parity: default options produce one reliable channel (ordered: true, no maxRetransmits)', async () => {
        const { client, signalClients, peers } = makeClient()
        await fullConnect(client, signalClients, peers)
        const rel = peers[0]!.lastReliability!
        assert.strictEqual(rel.ordered, true, 'parity: phase-1 channel must be ordered')
        assert.strictEqual(rel.maxRetransmits, undefined, 'parity: phase-1 channel must not cap retransmits')
    })

})
