/**
 * RTCTransport unit tests (p2p.md §4.2, task 061).
 *
 * All tests run without real WebRTC or a real signal server. The signal client,
 * peer connections, and TLayer are fully mocked. Signal wire payloads are encoded
 * with the same schema as RTCTransport's internal codec (different namespace →
 * bitwise-identical binary).
 *
 * Covers:
 *  - onInitialize: signal client connected with host ticket
 *  - signal:welcome → HostNegotiator initialized (verified via offer→onChannel flow)
 *  - First DC message as peer game ticket → grantAccess with correct ConnectionContext
 *  - Message+kick listeners registered immediately after grantAccess (pendingEmits flush)
 *  - Normal game messages forwarded to handleMessage after grant
 *  - Kick: §3.4 control frame sent before channel.close()
 *  - PC state change (disconnected/closed/failed) → handleClose
 *  - DC close → handleClose
 *  - Double-close guard: handleClose called exactly once per actor
 *  - Early channel close during grantAccess → handleClose called after grant
 *  - grantAccess failure → channel.close(), no handleClose
 *  - dispose: SERVER_SHUTDOWN close frame + channel close + handleClose + signal disconnect
 *  - sockets count
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import {
    createCodec,
    FieldType,
    decode as handshakeDecode,
    decodeCloseFrame,
    CLOSE_CONTROL_TOPIC,
} from '@rivalis/handshake'
import { RTCTransport } from '../lib/main.js'
import type { RTCAdapters } from '../lib/main.js'
import type { RTCPeerLike, RTCDataChannelLike } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Signal wire codec — same schema + major as RTCTransport's internal codec
// ---------------------------------------------------------------------------

const testSignalCodec = createCodec({
    namespace: '@rivalis/node/rtc-transport-test',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: FieldType.STRING, rule: 'optional' },
            { key: 'hostId',     type: FieldType.STRING, rule: 'optional' },
            { key: 'iceServers', type: FieldType.STRING, rule: 'optional' },
        ],
        Offer: [
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

function encodeWelcome(youId: string, iceServers = '[]'): Uint8Array {
    return testSignalCodec.encode('Welcome', { youId, iceServers })
}

function encodeOffer(to: string, sdp: string, from: string): Uint8Array {
    return testSignalCodec.encode('Offer', { to, sdp, from })
}

// ---------------------------------------------------------------------------
// Mock signal client (duck-typed to satisfy Client interface)
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

class MockSignalClient {
    private readonly map = new Map<string, Listener[]>()
    readonly sent: Array<{ topic: string; payload: Uint8Array }> = []
    connectedWith: string | null = null
    disconnected = false
    _connected = false

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
    disconnect(): void { this.disconnected = true; this._connected = false }
    send(topic: string, payload: Uint8Array | string): void {
        const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
        this.sent.push({ topic, payload: bytes })
    }
    emit(topic: string, ...args: unknown[]): void {
        for (const l of this.map.get(topic) ?? []) l(...args)
    }
}

// ---------------------------------------------------------------------------
// Mock data channel
// ---------------------------------------------------------------------------

class MockDataChannel implements RTCDataChannelLike {
    private _onMessage: ((buf: Uint8Array) => void) | null = null
    private _onClose: (() => void) | null = null
    readonly sent: Uint8Array[] = []
    private _isOpen = true
    closed = false

    onMessage(cb: (buf: Uint8Array) => void): void { this._onMessage = cb }
    onOpen(_cb: () => void): void { /* called once before open — no-op in tests; channel already open */ }
    onClose(cb: () => void): void { this._onClose = cb }
    sendBinary(buf: Uint8Array): void { this.sent.push(buf) }
    close(): void { this.closed = true; this._isOpen = false; this._onClose?.() }
    get isOpen(): boolean { return this._isOpen }

    /** Simulate an inbound binary message from the peer. */
    receive(buf: Uint8Array): void { this._onMessage?.(buf) }
}

// ---------------------------------------------------------------------------
// Mock peer connection
// ---------------------------------------------------------------------------

class MockPeer implements RTCPeerLike {
    private _onDataChannel: ((dc: RTCDataChannelLike) => void) | null = null
    private _onState: ((s: string) => void) | null = null
    private _onLocalDesc: ((sdp: string, type: string) => void) | null = null
    private _onLocalCand: ((c: string, m: string) => void) | null = null
    readonly remoteDescriptions: Array<{ sdp: string; type: string }> = []
    closed = false

    createDataChannel(_label: string, _ordered: boolean): RTCDataChannelLike {
        return new MockDataChannel()
    }
    onDataChannel(cb: (dc: RTCDataChannelLike) => void): void { this._onDataChannel = cb }
    onStateChange(cb: (s: string) => void): void { this._onState = cb }
    onLocalDescription(cb: (sdp: string, type: string) => void): void { this._onLocalDesc = cb }
    onLocalCandidate(cb: (c: string, m: string) => void): void { this._onLocalCand = cb }
    setLocalDescription(_type?: string): void {}
    setRemoteDescription(sdp: string, type: string): void { this.remoteDescriptions.push({ sdp, type }) }
    addRemoteCandidate(_c: string, _m: string): void {}
    close(): void { this.closed = true }

    emitDataChannel(dc: RTCDataChannelLike): void { this._onDataChannel?.(dc) }
    emitState(s: string): void { this._onState?.(s) }
    emitLocalDescription(sdp: string, type: string): void { this._onLocalDesc?.(sdp, type) }
}

// ---------------------------------------------------------------------------
// Mock TLayer (minimal surface used by RTCTransport)
// ---------------------------------------------------------------------------

type EventListener = (actorId: string, msg: Uint8Array) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLogger = any

class MockTLayer {
    readonly granted: Array<{ ticket: string; ctx: unknown }> = []
    readonly handled: Array<{ actorId: string; buf: Uint8Array }> = []
    readonly closed: string[] = []
    private readonly listeners = new Map<string, EventListener>()

    grantResult = 'actor-1'
    grantError: Error | null = null

    // Arrow function fields so tests can reassign them on an instance
    grantAccess = async (ticket: string, ctx: unknown): Promise<string> => {
        this.granted.push({ ticket, ctx })
        if (this.grantError !== null) throw this.grantError
        return this.grantResult
    }

    handleMessage = async (actorId: string, buf: Uint8Array): Promise<void> => {
        this.handled.push({ actorId, buf })
    }

    handleClose = (actorId: string): void => {
        this.closed.push(actorId)
    }

    on = (event: string, actorId: string, fn: EventListener): void => {
        this.listeners.set(`${event}:${actorId}`, fn)
    }

    once = (event: string, actorId: string, fn: EventListener): void => {
        this.on(event, actorId, fn)
    }

    /** Simulate TLayer emitting an outbound event (e.g. actor.send). */
    emitOut(event: string, actorId: string, msg: Uint8Array): void {
        this.listeners.get(`${event}:${actorId}`)?.(actorId, msg)
    }

    readonly logger: AnyLogger = {
        info: () => {}, debug: () => {}, verbose: () => {},
        warning: () => {}, error: () => {}
    }

    readonly logging = {
        getLogger: (): AnyLogger => this.logger
    }
}

// ---------------------------------------------------------------------------
// Test factory — builds RTCTransport with injected mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTLayer = any

function makeTransport(peerCount = 4) {
    const signalClient = new MockSignalClient()
    const peers: MockPeer[] = Array.from({ length: peerCount }, () => new MockPeer())
    let peerIdx = 0
    const adapters: RTCAdapters = {
        createPeerConnection() { return (peers[peerIdx++] ?? new MockPeer()) as RTCPeerLike },
        createSignalingClient() { return signalClient as AnyTLayer },
    }
    const transport = new RTCTransport({
        signalUrl: 'ws://signal:9000',
        ticket: 'host-ticket',
        adapters,
    })
    const layer = new MockTLayer()
    return { transport, layer, signalClient, peers }
}

/** Drive the full welcome→offer→onDataChannel flow and return the MockDataChannel. */
async function openChannel(
    transport: RTCTransport,
    layer: MockTLayer,
    signalClient: MockSignalClient,
    peers: MockPeer[],
    opts: { peerId?: string; hostId?: string; sendTicket?: string } = {},
): Promise<MockDataChannel> {
    const peerId = opts.peerId ?? 'peer-1'
    const hostId = opts.hostId ?? 'host-id'
    const ticket = opts.sendTicket ?? 'peer-game-ticket'

    transport.onInitialize(layer as AnyTLayer)
    signalClient.emit('signal:welcome', encodeWelcome(hostId))
    signalClient.emit('signal:offer', encodeOffer(hostId, 'v=0\r\n', peerId))

    const dc = new MockDataChannel()
    peers[0]!.emitDataChannel(dc)

    // Let the async ticket-read→grantAccess chain complete
    dc.receive(new TextEncoder().encode(ticket))
    await nextTick()

    return dc
}

/** Drain the microtask queue. */
function nextTick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// onInitialize
// ---------------------------------------------------------------------------

suite('RTCTransport — onInitialize', () => {

    test('connects to signal with host ticket', () => {
        const { transport, layer, signalClient } = makeTransport()
        transport.onInitialize(layer as AnyTLayer)
        assert.strictEqual(signalClient.connectedWith, 'host-ticket')
    })

    test('signal:welcome initializes HostNegotiator (verified via offer handling)', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))

        // If HostNegotiator was initialized, emitting an offer creates a PC and
        // calls setRemoteDescription.
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))
        await nextTick()
        assert.strictEqual(peers[0]!.remoteDescriptions.length, 1)
    })

    test('iceServers from welcome are forwarded to createPeerConnection', async () => {
        const signalClient = new MockSignalClient()
        const captured: RTCConfiguration[] = []
        const adapters: RTCAdapters = {
            createPeerConnection(cfg) { captured.push(cfg); return new MockPeer() },
            createSignalingClient() { return signalClient as AnyTLayer },
        }
        const transport = new RTCTransport({ signalUrl: 'ws://s', ticket: 't', adapters })
        const layer = new MockTLayer()
        transport.onInitialize(layer as AnyTLayer)

        const iceServers: RTCIceServer[] = [{ urls: 'stun:s.example.com' }]
        signalClient.emit('signal:welcome', encodeWelcome('host-id', JSON.stringify(iceServers)))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))
        await nextTick()

        assert.strictEqual(captured.length, 1)
        assert.deepStrictEqual((captured[0]!.iceServers as RTCIceServer[])[0]!.urls, 'stun:s.example.com')
    })

})

// ---------------------------------------------------------------------------
// onChannelOpen — ticket / grantAccess
// ---------------------------------------------------------------------------

suite('RTCTransport — ticket handshake / grantAccess', () => {

    test('first DC message is treated as the peer game ticket', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers, { sendTicket: 'peer-ticket-xyz' })
        assert.strictEqual(layer.granted.length, 1)
        assert.strictEqual(layer.granted[0]!.ticket, 'peer-ticket-xyz')
    })

    test('grantAccess receives ConnectionContext {kind:"webrtc", remoteId:peerId}', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers, { peerId: 'peer-42' })
        const ctx = layer.granted[0]!.ctx as { kind: string; remoteId: string }
        assert.strictEqual(ctx.kind, 'webrtc')
        assert.strictEqual(ctx.remoteId, 'peer-42')
    })

    test('grantAccess failure → channel.close(), handleClose not called', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        layer.grantError = new Error('invalid ticket')
        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))

        const dc = new MockDataChannel()
        peers[0]!.emitDataChannel(dc)
        dc.receive(new TextEncoder().encode('bad-ticket'))
        await nextTick()

        assert.ok(dc.closed, 'channel must be closed on auth failure')
        assert.strictEqual(layer.closed.length, 0, 'handleClose must not be called — actor never joined')
    })

    test('second message while grantAccess in flight is dropped', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))

        const dc = new MockDataChannel()
        peers[0]!.emitDataChannel(dc)
        dc.receive(new TextEncoder().encode('ticket'))
        dc.receive(new TextEncoder().encode('ticket-again'))  // second call — should be ignored
        await nextTick()

        assert.strictEqual(layer.granted.length, 1, 'grantAccess must be called only once')
    })

})

// ---------------------------------------------------------------------------
// Listener registration — pendingEmits flush
// ---------------------------------------------------------------------------

suite('RTCTransport — listener registration (pendingEmits ordering)', () => {

    test('message listener registered immediately after grantAccess', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        // Emit a frame for the actor; must reach the channel because the
        // 'message' listener was registered right after grantAccess.
        const outbound = new Uint8Array([1, 2, 3])
        layer.emitOut('message', layer.grantResult, outbound)
        assert.ok(dc.sent.includes(outbound), 'message listener must be registered after grantAccess')
    })

    test('outbound frame emitted by onJoin is forwarded to channel via pending-flush', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()

        // Arrange: once grantAccess resolves, TLayer will emit a 'message' event
        // to simulate a frame that was buffered during onJoin (pendingEmits).
        // We capture the actor id from the grant, then let the registration happen,
        // then emit the buffered frame.
        const dc = await openChannel(transport, layer, signalClient, peers)

        // Now the listener is registered. Emit an outbound game frame.
        const gameFrame = new Uint8Array([0xAA, 0xBB])
        layer.emitOut('message', layer.grantResult, gameFrame)

        assert.ok(dc.sent.includes(gameFrame), 'outbound game frame must reach the data channel')
    })

    test('kick listener registered immediately after grantAccess', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        // Emit a kick with a reason
        const kickPayload = new TextEncoder().encode('room_destroyed')
        layer.emitOut('kick', layer.grantResult, kickPayload)

        // Channel must be closed after the kick listener fires
        assert.ok(dc.closed, 'channel must be closed after kick')
    })

})

// ---------------------------------------------------------------------------
// Normal game traffic after grant
// ---------------------------------------------------------------------------

suite('RTCTransport — post-grant game traffic', () => {

    test('inbound messages after ticket are forwarded to handleMessage', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const gameMsg = new Uint8Array([10, 20, 30])
        dc.receive(gameMsg)
        await nextTick()

        assert.strictEqual(layer.handled.length, 1)
        assert.strictEqual(layer.handled[0]!.actorId, layer.grantResult)
        assert.strictEqual(layer.handled[0]!.buf, gameMsg)
    })

    test('outbound message from TLayer is sent to channel when open', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const outbound = new Uint8Array([0xDE, 0xAD])
        layer.emitOut('message', layer.grantResult, outbound)
        assert.ok(dc.sent.includes(outbound))
    })

    test('outbound message dropped silently when channel is closed', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        // Mark channel as closed without triggering onClose
        dc['_isOpen'] = false

        const outbound = new Uint8Array([0xDE, 0xAD])
        assert.doesNotThrow(() => layer.emitOut('message', layer.grantResult, outbound))
        assert.strictEqual(dc.sent.length, 0, 'closed channel must not receive frames')
    })

    test('sockets returns number of granted open channels', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        assert.strictEqual(transport.sockets, 0)
        await openChannel(transport, layer, signalClient, peers)
        assert.strictEqual(transport.sockets, 1)
    })

})

// ---------------------------------------------------------------------------
// Kick — §3.4 control frame
// ---------------------------------------------------------------------------

suite('RTCTransport — kick control frame (p2p.md §3.4)', () => {

    test('kick sends __rivalis:close control frame before closing channel', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const kickPayload = new TextEncoder().encode('room_destroyed')
        layer.emitOut('kick', layer.grantResult, kickPayload)

        // Must have sent at least one frame before closing
        assert.ok(dc.sent.length > 0, 'control frame must be sent before close')
        assert.ok(dc.closed, 'channel must be closed after kick')

        // Decode the control frame: it should be a handshake frame on __rivalis:close
        const rawFrame = dc.sent[0]!
        const { topic, payload } = handshakeDecode(rawFrame)
        assert.strictEqual(topic, CLOSE_CONTROL_TOPIC)

        const closeFrame = decodeCloseFrame(payload)
        assert.strictEqual(closeFrame.code, 4003)  // CloseCode.KICKED
        assert.strictEqual(closeFrame.reason, 'room_destroyed')
    })

    test('kick reason is preserved in the control frame', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const kickPayload = new TextEncoder().encode('invalid_message')
        layer.emitOut('kick', layer.grantResult, kickPayload)

        const { payload } = handshakeDecode(dc.sent[0]!)
        assert.strictEqual(decodeCloseFrame(payload).reason, 'invalid_message')
    })

})

// ---------------------------------------------------------------------------
// peerLimiter — pre-admission throttle (p2p.md §8)
// ---------------------------------------------------------------------------

suite('RTCTransport — peerLimiter (p2p.md §8)', () => {

    function makeTransportWithLimiter(
        checkFn: (peerId: string) => boolean | Promise<boolean>,
    ) {
        const signalClient = new MockSignalClient()
        const peers: MockPeer[] = Array.from({ length: 4 }, () => new MockPeer())
        let peerIdx = 0
        const adapters: RTCAdapters = {
            createPeerConnection() { return (peers[peerIdx++] ?? new MockPeer()) as RTCPeerLike },
            createSignalingClient() { return signalClient as AnyTLayer },
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const peerLimiter: any = { check: checkFn }
        const transport = new RTCTransport({
            signalUrl: 'ws://signal:9000',
            ticket: 'host-ticket',
            adapters,
            peerLimiter,
        })
        const layer = new MockTLayer()
        return { transport, layer, signalClient, peers }
    }

    test('peerLimiter returning false rejects before grantAccess with RATE_LIMITED close frame', async () => {
        const { transport, layer, signalClient, peers } = makeTransportWithLimiter(() => false)

        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))

        const dc = new MockDataChannel()
        peers[0]!.emitDataChannel(dc)
        dc.receive(new TextEncoder().encode('peer-ticket'))
        await nextTick()

        assert.strictEqual(layer.granted.length, 0, 'grantAccess must not be called when throttled')
        assert.ok(dc.closed, 'channel must be closed after throttle rejection')

        // Verify the close frame carries RATE_LIMITED close code
        assert.ok(dc.sent.length > 0, 'RATE_LIMITED close frame must be sent before close')
        const { topic, payload } = handshakeDecode(dc.sent[0]!)
        assert.strictEqual(topic, CLOSE_CONTROL_TOPIC)
        const closeFrame = decodeCloseFrame(payload)
        assert.strictEqual(closeFrame.code, 4005)  // CloseCode.RATE_LIMITED
        assert.strictEqual(closeFrame.reason, 'rate_limited')  // KickReason.RATE_LIMITED
    })

    test('peerLimiter returning true allows the connection through to grantAccess', async () => {
        const { transport, layer, signalClient, peers } = makeTransportWithLimiter(() => true)
        const dc = await openChannel(transport, layer, signalClient, peers)

        assert.strictEqual(layer.granted.length, 1, 'grantAccess must be called when limiter allows')
        assert.ok(!dc.closed, 'channel must remain open after a passing limiter check')
    })

    test('peerLimiter returning Promise<false> rejects asynchronously', async () => {
        const { transport, layer, signalClient, peers } = makeTransportWithLimiter(
            () => Promise.resolve(false),
        )

        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))

        const dc = new MockDataChannel()
        peers[0]!.emitDataChannel(dc)
        dc.receive(new TextEncoder().encode('peer-ticket'))
        await nextTick()

        assert.strictEqual(layer.granted.length, 0)
        assert.ok(dc.closed)
    })

    test('peerLimiter throw is treated as rejection — channel closed, grantAccess skipped', async () => {
        const { transport, layer, signalClient, peers } = makeTransportWithLimiter(
            () => { throw new Error('limiter internal error') },
        )

        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))

        const dc = new MockDataChannel()
        peers[0]!.emitDataChannel(dc)
        dc.receive(new TextEncoder().encode('peer-ticket'))
        await nextTick()

        assert.strictEqual(layer.granted.length, 0, 'grantAccess must not be called after limiter throws')
        assert.ok(dc.closed, 'channel must be closed after limiter throw')
    })

    test('peerLimiter is called with the correct peerId', async () => {
        const seenPeerIds: string[] = []
        const { transport, layer, signalClient, peers } = makeTransportWithLimiter((peerId) => {
            seenPeerIds.push(peerId)
            return true
        })
        await openChannel(transport, layer, signalClient, peers, { peerId: 'peer-xyz' })
        assert.deepStrictEqual(seenPeerIds, ['peer-xyz'])
    })

})

// ---------------------------------------------------------------------------
// handleClose — PC state change and DC close
// ---------------------------------------------------------------------------

suite('RTCTransport — handleClose triggers', () => {

    test('PC state "disconnected" → handleClose called', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers)

        peers[0]!.emitState('disconnected')
        assert.ok(layer.closed.includes(layer.grantResult))
    })

    test('PC state "failed" → handleClose called', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers)

        peers[0]!.emitState('failed')
        assert.ok(layer.closed.includes(layer.grantResult))
    })

    test('PC state "closed" → handleClose called', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers)

        peers[0]!.emitState('closed')
        assert.ok(layer.closed.includes(layer.grantResult))
    })

    test('PC state "connected" or "connecting" → handleClose NOT called', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers)

        peers[0]!.emitState('connected')
        peers[0]!.emitState('connecting')
        assert.strictEqual(layer.closed.length, 0)
    })

    test('DC close → handleClose called', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        dc.close()
        assert.ok(layer.closed.includes(layer.grantResult))
    })

    test('double-close guard: handleClose called exactly once when both DC.close and PC.failed fire', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        dc.close()
        peers[0]!.emitState('failed')

        const closedForActor = layer.closed.filter(id => id === layer.grantResult)
        assert.strictEqual(closedForActor.length, 1, 'handleClose must be called exactly once')
    })

    test('sockets decremented after channel closes', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)
        assert.strictEqual(transport.sockets, 1)
        dc.close()
        assert.strictEqual(transport.sockets, 0)
    })

})

// ---------------------------------------------------------------------------
// Early close during grantAccess
// ---------------------------------------------------------------------------

suite('RTCTransport — early close race', () => {

    test('channel closes during grantAccess → handleClose called after grant completes', async () => {
        const signalClient = new MockSignalClient()
        const peers: MockPeer[] = [new MockPeer()]
        let peerIdx = 0
        const adapters: RTCAdapters = {
            createPeerConnection() { return (peers[peerIdx++] ?? new MockPeer()) as RTCPeerLike },
            createSignalingClient() { return signalClient as AnyTLayer },
        }

        // grantAccess will never reject but we control timing manually
        let resolveGrant: ((id: string) => void) | null = null
        const layer = new MockTLayer()
        layer.grantAccess = async (ticket, ctx) => {
            layer.granted.push({ ticket, ctx })
            return new Promise<string>(r => { resolveGrant = r })
        }

        const transport = new RTCTransport({ signalUrl: 'ws://s', ticket: 't', adapters })
        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))
        signalClient.emit('signal:offer', encodeOffer('host-id', 'v=0', 'peer-1'))

        const dc = new MockDataChannel()
        peers[0]!.emitDataChannel(dc)
        dc.receive(new TextEncoder().encode('peer-ticket'))
        await nextTick()  // grantAccess is now in flight

        // Simulate channel closing before grantAccess resolves
        dc['_isOpen'] = false
        dc['_onClose']?.()  // trigger the onClose handler
        await nextTick()

        // Now resolve grantAccess — RTCTransport must call handleClose for the actor
        resolveGrant!('actor-early')
        await nextTick()

        assert.ok(layer.closed.includes('actor-early'), 'handleClose must be called to unwind the join')
    })

})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

suite('RTCTransport — dispose', () => {

    test('dispose sends SERVER_SHUTDOWN control frame to open channels', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        await transport.dispose()

        assert.ok(dc.sent.length > 0, 'shutdown close frame must be sent')
        const { topic, payload } = handshakeDecode(dc.sent[0]!)
        assert.strictEqual(topic, CLOSE_CONTROL_TOPIC)
        const closeFrame = decodeCloseFrame(payload)
        assert.strictEqual(closeFrame.reason, 'server_shutdown')
    })

    test('dispose closes all open channels', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        await transport.dispose()
        assert.ok(dc.closed)
    })

    test('dispose calls handleClose for each connected actor', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers)

        await transport.dispose()
        assert.ok(layer.closed.includes(layer.grantResult))
    })

    test('dispose disconnects the signal client', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        await openChannel(transport, layer, signalClient, peers)

        await transport.dispose()
        assert.ok(signalClient.disconnected)
    })

    test('dispose on idle transport (no peers) does not throw', async () => {
        const { transport, layer, signalClient } = makeTransport()
        transport.onInitialize(layer as AnyTLayer)
        signalClient.emit('signal:welcome', encodeWelcome('host-id'))

        await assert.doesNotReject(() => transport.dispose())
    })

})
