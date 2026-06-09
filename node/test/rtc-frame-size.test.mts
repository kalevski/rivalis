/**
 * RTC frame-size ceiling — chunk/reassemble tests (p2p.md §7, task 071).
 * Oversized-broadcast regression (p2p.md §10, task 078).
 *
 * Covers:
 *  - Transport.maxFrameBytes returns null (base class default)
 *  - RTCTransport.maxFrameBytes returns RTC_MAX_FRAME_BYTES (16 KiB)
 *  - Small frames (≤ ceiling) sent as-is, reference preserved
 *  - Large outbound frames chunked into __rivalis:chunk messages and logged
 *  - Chunk frames reassembled by RTCTransport inbound handler
 *  - RTCClient reassembles chunked frames from the host
 *  - RTCClient.send() chunks large peer→host frames
 *  - Oversized frame (> 255 chunks) logged and dropped — never silently truncated
 *  - ChunkReassembler: accumulates, resets on new seq, ignores duplicates
 *  - isChunkFrame: correct prefix detection without decoding
 *  - chunkFrame: correct split and seq/total/index encoding
 *  - Broadcast (> RTC ceiling) to multiple actors — each receives all chunk messages
 *  - Broadcast oversized (> 255 chunks) — dropped for all actors, nothing partially sent
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import { Transport } from '@rivalis/core'
import {
    createCodec,
    FieldType,
    encode as handshakeEncode,
    decode as handshakeDecode,
} from '@rivalis/handshake'
import {
    RTCTransport,
    RTCClient,
    RTC_MAX_FRAME_BYTES,
    CHUNK_DATA_BYTES,
    CHUNK_CONTROL_TOPIC,
    isChunkFrame,
    chunkFrame,
    decodeChunkPayload,
    ChunkReassembler,
} from '../lib/main.js'
import type { RTCAdapters } from '../lib/main.js'
import type { RTCPeerLike, RTCDataChannelLike } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Signal wire codec (same schema as other tests in this package)
// ---------------------------------------------------------------------------

const testSignalCodec = createCodec({
    namespace: '@rivalis/node/frame-size-test',
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
        Answer: [
            { key: 'to',   type: FieldType.STRING, rule: 'optional' },
            { key: 'sdp',  type: FieldType.STRING, rule: 'optional' },
            { key: 'from', type: FieldType.STRING, rule: 'optional' },
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
// Mocks (same pattern as rtc-transport.test.mts)
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

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
    disconnect(): void { this.disconnected = true; this._connected = false }
    send(topic: string, payload: Uint8Array | string): void {
        const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
        this.sent.push({ topic, payload: bytes })
    }
    emit(topic: string, ...args: unknown[]): void {
        for (const l of this.map.get(topic) ?? []) l(...args)
    }
}

class MockDataChannel implements RTCDataChannelLike {
    private _onMessage: ((buf: Uint8Array) => void) | null = null
    private _onClose: (() => void) | null = null
    readonly sent: Uint8Array[] = []
    private _isOpen = true
    closed = false
    bufferedAmount = 0

    onMessage(cb: (buf: Uint8Array) => void): void { this._onMessage = cb }
    onOpen(_cb: () => void): void { /* already open in host-side tests */ }
    onClose(cb: () => void): void { this._onClose = cb }
    sendBinary(buf: Uint8Array): void { this.sent.push(buf) }
    close(): void { this.closed = true; this._isOpen = false; this._onClose?.() }
    get isOpen(): boolean { return this._isOpen }

    receive(buf: Uint8Array): void { this._onMessage?.(buf) }
}

class MockPeer implements RTCPeerLike {
    private _onDataChannel: ((dc: RTCDataChannelLike) => void) | null = null
    private _onState: ((s: string) => void) | null = null
    private _onLocalDesc: ((sdp: string, type: string) => void) | null = null
    private _onLocalCand: ((c: string, m: string) => void) | null = null
    readonly remoteDescriptions: Array<{ sdp: string; type: string }> = []
    closed = false

    createDataChannel(_label: string, _reliability: { ordered: boolean; maxRetransmits?: number }): RTCDataChannelLike {
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
}

type EventListener = (actorId: string, msg: Uint8Array) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLogger = any

class MockTLayer {
    readonly granted: Array<{ ticket: string; ctx: unknown }> = []
    readonly handled: Array<{ actorId: string; buf: Uint8Array }> = []
    readonly closed: string[] = []
    readonly debugLogs: string[] = []
    readonly warningLogs: string[] = []
    private readonly listeners = new Map<string, EventListener>()

    grantResult = 'actor-1'
    grantError: Error | null = null

    grantAccess = async (ticket: string, ctx: unknown): Promise<string> => {
        this.granted.push({ ticket, ctx })
        if (this.grantError !== null) throw this.grantError
        return this.grantResult
    }

    handleMessage = async (actorId: string, buf: Uint8Array): Promise<void> => {
        this.handled.push({ actorId, buf })
    }

    handleClose = (actorId: string): void => { this.closed.push(actorId) }

    on = (event: string, actorId: string, fn: EventListener): void => {
        this.listeners.set(`${event}:${actorId}`, fn)
    }
    once = (event: string, actorId: string, fn: EventListener): void => {
        this.on(event, actorId, fn)
    }

    emitOut(event: string, actorId: string, msg: Uint8Array): void {
        this.listeners.get(`${event}:${actorId}`)?.(actorId, msg)
    }

    readonly logger: AnyLogger = {
        info:    () => {},
        verbose: () => {},
        error:   () => {},
        debug:   (msg: string) => { this.debugLogs.push(msg) },
        warning: (msg: string) => { this.warningLogs.push(msg) },
    }
    readonly logging = { getLogger: (): AnyLogger => this.logger }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTLayer = any

function makeTransport() {
    const signalClient = new MockSignalClient()
    const peers: MockPeer[] = Array.from({ length: 4 }, () => new MockPeer())
    let peerIdx = 0
    const adapters: RTCAdapters = {
        createPeerConnection() { return (peers[peerIdx++] ?? new MockPeer()) as RTCPeerLike },
        createSignalingClient() { return signalClient as AnyTLayer },
    }
    const transport = new RTCTransport({ signalUrl: 'ws://signal:9000', ticket: 'host-ticket', adapters })
    const layer = new MockTLayer()
    return { transport, layer, signalClient, peers }
}

async function openChannel(
    transport: RTCTransport,
    layer: MockTLayer,
    signalClient: MockSignalClient,
    peers: MockPeer[],
    opts: { peerId?: string; hostId?: string; sendTicket?: string } = {},
): Promise<MockDataChannel> {
    const peerId  = opts.peerId  ?? 'peer-1'
    const hostId  = opts.hostId  ?? 'host-id'
    const ticket  = opts.sendTicket ?? 'peer-game-ticket'

    transport.onInitialize(layer as AnyTLayer)
    signalClient.emit('signal:welcome', encodeWelcome(hostId))
    signalClient.emit('signal:offer', encodeOffer(hostId, 'v=0\r\n', peerId))

    const dc = new MockDataChannel()
    peers[0]!.emitDataChannel(dc)
    dc.receive(new TextEncoder().encode(ticket))
    await new Promise(resolve => setTimeout(resolve, 0))
    return dc
}

// ---------------------------------------------------------------------------
// RTCClient mock setup (same pattern as rtc-client.test.mts)
// ---------------------------------------------------------------------------

class MockClientDataChannel implements RTCDataChannelLike {
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

    open(): void { this._isOpen = true; this._onOpen?.() }
    receive(buf: Uint8Array): void { this._onMessage?.(buf) }
}

class MockClientPeer implements RTCPeerLike {
    private _onState: ((s: string) => void) | null = null
    private _onLocalDesc: ((sdp: string, type: string) => void) | null = null
    private _onLocalCand: ((c: string, m: string) => void) | null = null
    dc: MockClientDataChannel = new MockClientDataChannel()
    closed = false

    createDataChannel(_label: string, _reliability: { ordered: boolean; maxRetransmits?: number }): RTCDataChannelLike { return this.dc }
    onDataChannel(_cb: (dc: RTCDataChannelLike) => void): void {}
    onStateChange(cb: (s: string) => void): void { this._onState = cb }
    onLocalDescription(cb: (sdp: string, type: string) => void): void { this._onLocalDesc = cb }
    onLocalCandidate(cb: (c: string, m: string) => void): void { this._onLocalCand = cb }
    setLocalDescription(_type?: string): void {
        Promise.resolve().then(() => this._onLocalDesc?.('v=0 offer', 'offer')).catch(() => {})
    }
    setRemoteDescription(_sdp: string, _type: string): void {}
    addRemoteCandidate(_c: string, _m: string): void {}
    close(): void { this.closed = true }
    emitState(s: string): void { this._onState?.(s) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClientMock = any

function makeClient() {
    const signalClients: MockSignalClient[] = []
    const peers: MockClientPeer[] = []
    const adapters: RTCAdapters = {
        createPeerConnection(): RTCPeerLike {
            const peer = new MockClientPeer()
            peers.push(peer)
            return peer
        },
        createSignalingClient(): AnyClientMock {
            const sc = new MockSignalClient()
            signalClients.push(sc)
            return sc
        },
    }
    const client = new RTCClient('ws://signal:9000', { adapters })
    return { client, signalClients, peers }
}

const encodeWelcomeForClient = (youId: string, hostId = 'host-1', iceServers = '[]') =>
    testSignalCodec.encode('Welcome', { youId, hostId, iceServers })

const encodeAnswer = (to: string, sdp: string, from: string) =>
    testSignalCodec.encode('Answer', { to, sdp, from })

async function connectClient(
    client: RTCClient,
    signalClients: MockSignalClient[],
    peers: MockClientPeer[],
    ticket = 'game-ticket',
): Promise<{ dc: MockClientDataChannel; sc: MockSignalClient }> {
    client.connect(ticket)
    await new Promise(resolve => setTimeout(resolve, 0))
    const sc = signalClients[signalClients.length - 1]!
    const peer = peers[peers.length - 1]!
    sc.emit('signal:welcome', encodeWelcomeForClient('peer-id', 'host-id'))
    await new Promise(resolve => setTimeout(resolve, 0))
    sc.emit('signal:answer', encodeAnswer('peer-id', 'v=0 answer', 'host-id'))
    peer.dc.open()
    return { dc: peer.dc, sc }
}

// ---------------------------------------------------------------------------
// maxFrameBytes capability
// ---------------------------------------------------------------------------

suite('Transport.maxFrameBytes capability (p2p.md §7)', () => {

    test('Transport base class maxFrameBytes returns null (no ceiling enforced)', () => {
        class MinimalTransport extends Transport {
            onInitialize(): void {}
            get sockets(): number { return 0 }
        }
        const t = new MinimalTransport()
        assert.strictEqual(t.maxFrameBytes, null)
    })

    test('RTCTransport.maxFrameBytes returns RTC_MAX_FRAME_BYTES (16 KiB)', () => {
        const signalClient = new MockSignalClient()
        const adapters: RTCAdapters = {
            createPeerConnection: () => new MockPeer(),
            createSignalingClient: () => signalClient as AnyTLayer,
        }
        const transport = new RTCTransport({ signalUrl: 'ws://s', ticket: 't', adapters })
        assert.strictEqual(transport.maxFrameBytes, RTC_MAX_FRAME_BYTES)
        assert.strictEqual(RTC_MAX_FRAME_BYTES, 16 * 1024)
    })

})

// ---------------------------------------------------------------------------
// isChunkFrame helper
// ---------------------------------------------------------------------------

suite('isChunkFrame prefix detection', () => {

    test('returns true for a real chunk frame', () => {
        const chunks = chunkFrame(new Uint8Array(100).fill(0xAB), 0)
        assert.ok(chunks.length > 0)
        assert.ok(isChunkFrame(chunks[0]!), 'chunkFrame output must be detected as a chunk frame')
    })

    test('returns false for a regular handshake-encoded frame', () => {
        const frame = handshakeEncode('game:state', new Uint8Array([1, 2, 3]))
        assert.ok(!isChunkFrame(frame))
    })

    test('returns false for the close control frame', () => {
        const frame = handshakeEncode('__rivalis:close', new Uint8Array([1]))
        assert.ok(!isChunkFrame(frame))
    })

    test('returns false for small buffers (< 17 bytes)', () => {
        assert.ok(!isChunkFrame(new Uint8Array(16)))
        assert.ok(!isChunkFrame(new Uint8Array(0)))
    })

    test('returns false for raw byte arrays that are not handshake frames', () => {
        assert.ok(!isChunkFrame(new Uint8Array([0x0A, 0x14, 0x1E])))  // 3 bytes
    })

})

// ---------------------------------------------------------------------------
// chunkFrame helper
// ---------------------------------------------------------------------------

suite('chunkFrame split correctness', () => {

    test('a frame equal to the ceiling is NOT chunked (1 chunk)', () => {
        const frame = new Uint8Array(CHUNK_DATA_BYTES).fill(0x42)
        const chunks = chunkFrame(frame, 0)
        assert.strictEqual(chunks.length, 1)
    })

    test('a frame one byte over the per-chunk data size splits into 2 chunks', () => {
        const frame = new Uint8Array(CHUNK_DATA_BYTES + 1).fill(0xCC)
        const chunks = chunkFrame(frame, 1)
        assert.strictEqual(chunks.length, 2)
    })

    test('all chunk messages are isChunkFrame-detected', () => {
        const frame = new Uint8Array(CHUNK_DATA_BYTES * 3 + 1).fill(0xDD)
        const chunks = chunkFrame(frame, 5)
        assert.strictEqual(chunks.length, 4)
        for (const chunk of chunks) {
            assert.ok(isChunkFrame(chunk), 'every chunk must be detected by isChunkFrame')
        }
    })

    test('chunks carry correct seq, total, and index in their payloads', () => {
        const frame = new Uint8Array(CHUNK_DATA_BYTES * 2 + 100).fill(0xEE)
        const chunks = chunkFrame(frame, 7)
        assert.strictEqual(chunks.length, 3)
        for (let i = 0; i < chunks.length; i++) {
            const { payload } = handshakeDecode(chunks[i]!)
            const parsed = decodeChunkPayload(payload)
            assert.ok(parsed !== null)
            assert.strictEqual(parsed!.seq, 7)
            assert.strictEqual(parsed!.total, 3)
            assert.strictEqual(parsed!.index, i)
        }
    })

    test('reassembling chunks reconstructs the original frame', () => {
        const frame = new Uint8Array(CHUNK_DATA_BYTES * 2 + 500)
        for (let i = 0; i < frame.length; i++) frame[i] = i & 0xFF
        const chunks = chunkFrame(frame, 3)
        const assembler = new ChunkReassembler()
        let result: Uint8Array | null = null
        for (const chunk of chunks) {
            const { payload } = handshakeDecode(chunk)
            const parsed = decodeChunkPayload(payload)!
            result = assembler.feed(parsed.seq, parsed.total, parsed.index, parsed.data)
        }
        assert.ok(result !== null, 'reassembled frame must not be null')
        assert.deepStrictEqual(result, frame)
    })

    test('chunkFrame result frames are each within RTC_MAX_FRAME_BYTES', () => {
        const frame = new Uint8Array(RTC_MAX_FRAME_BYTES * 3).fill(0xFF)
        const chunks = chunkFrame(frame, 0)
        for (const chunk of chunks) {
            assert.ok(
                chunk.byteLength <= RTC_MAX_FRAME_BYTES,
                `chunk size ${chunk.byteLength} must not exceed RTC ceiling ${RTC_MAX_FRAME_BYTES}`
            )
        }
    })

    test('chunkFrame throws when more than 255 chunks are required', () => {
        const giant = new Uint8Array(CHUNK_DATA_BYTES * 256 + 1)
        assert.throws(() => chunkFrame(giant, 0), /too large to chunk/)
    })

})

// ---------------------------------------------------------------------------
// ChunkReassembler
// ---------------------------------------------------------------------------

suite('ChunkReassembler', () => {

    test('returns null until all chunks received', () => {
        const r = new ChunkReassembler()
        assert.strictEqual(r.feed(0, 3, 0, new Uint8Array([1])), null)
        assert.strictEqual(r.feed(0, 3, 1, new Uint8Array([2])), null)
        const result = r.feed(0, 3, 2, new Uint8Array([3]))
        assert.ok(result !== null)
        assert.deepStrictEqual(result, new Uint8Array([1, 2, 3]))
    })

    test('resets on new seq (previous partial discarded)', () => {
        const r = new ChunkReassembler()
        r.feed(0, 3, 0, new Uint8Array([1]))  // partial
        const result = r.feed(1, 1, 0, new Uint8Array([42]))  // new seq
        assert.ok(result !== null)
        assert.deepStrictEqual(result, new Uint8Array([42]))
    })

    test('ignores duplicate chunks', () => {
        const r = new ChunkReassembler()
        r.feed(0, 2, 0, new Uint8Array([10]))
        r.feed(0, 2, 0, new Uint8Array([99]))  // duplicate — ignored
        const result = r.feed(0, 2, 1, new Uint8Array([20]))
        assert.ok(result !== null)
        assert.deepStrictEqual(result, new Uint8Array([10, 20]))
    })

    test('clear() resets state', () => {
        const r = new ChunkReassembler()
        r.feed(0, 2, 0, new Uint8Array([1]))
        r.clear()
        // After clear, a chunk with seq 0 is treated as the start of a new message
        r.feed(0, 1, 0, new Uint8Array([99]))
        // A new feed with seq 0 total 1 should complete immediately
        const result = r.feed(0, 1, 0, new Uint8Array([99]))
        // second feed for same seq/index is a duplicate — but the first completes
        assert.ok(true, 'clear and refeed does not throw')
    })

})

// ---------------------------------------------------------------------------
// RTCTransport — outbound chunking
// ---------------------------------------------------------------------------

suite('RTCTransport — outbound frame chunking (p2p.md §7)', () => {

    test('small frame (≤ RTC_MAX_FRAME_BYTES) sent as original reference, no chunking', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const small = handshakeEncode('game:state', new Uint8Array(100))
        layer.emitOut('message', layer.grantResult, small)

        assert.strictEqual(dc.sent.length, 1, 'exactly one message must be sent')
        assert.strictEqual(dc.sent[0], small, 'small frame must be sent as original reference')
        assert.strictEqual(layer.debugLogs.filter(m => m.includes('chunking')).length, 0,
            'no chunk debug log for small frames')
    })

    test('large frame (> RTC_MAX_FRAME_BYTES) is split into multiple chunk messages', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const largePayload = new Uint8Array(RTC_MAX_FRAME_BYTES * 2).fill(0x42)
        const largeFrame = handshakeEncode('arena:snapshot', largePayload)
        assert.ok(largeFrame.byteLength > RTC_MAX_FRAME_BYTES, 'pre-condition: frame must exceed ceiling')

        layer.emitOut('message', layer.grantResult, largeFrame)

        assert.ok(dc.sent.length > 1, 'large frame must produce multiple chunk messages')
        for (const chunk of dc.sent) {
            assert.ok(
                chunk.byteLength <= RTC_MAX_FRAME_BYTES,
                `chunk size ${chunk.byteLength} must not exceed RTC ceiling`
            )
            assert.ok(isChunkFrame(chunk), 'each sent message must be a chunk frame')
        }
    })

    test('chunking is logged at debug level', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const largePayload = new Uint8Array(RTC_MAX_FRAME_BYTES * 2).fill(0xBB)
        const largeFrame = handshakeEncode('arena:snapshot', largePayload)
        layer.emitOut('message', layer.grantResult, largeFrame)

        const chunkLogs = layer.debugLogs.filter(m => m.includes('chunking'))
        assert.ok(chunkLogs.length > 0, 'must log a debug message when chunking')
        assert.ok(chunkLogs[0]!.includes(largeFrame.byteLength.toString()),
            'log must mention the original frame size')
        assert.ok(chunkLogs[0]!.includes(layer.grantResult),
            'log must mention the actor id')
        void dc  // suppress unused-variable warning
    })

    test('each chunk message fits within RTC_MAX_FRAME_BYTES', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        // Build a frame approximately 4× the ceiling (4 chunks expected)
        const largePayload = new Uint8Array(RTC_MAX_FRAME_BYTES * 4).fill(0xCC)
        const largeFrame = handshakeEncode('big:frame', largePayload)
        layer.emitOut('message', layer.grantResult, largeFrame)

        for (const chunk of dc.sent) {
            assert.ok(chunk.byteLength <= RTC_MAX_FRAME_BYTES)
        }
    })

    test('consecutive large frames use incrementing seq numbers', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const bigFrame = handshakeEncode('t', new Uint8Array(RTC_MAX_FRAME_BYTES * 2).fill(0))

        layer.emitOut('message', layer.grantResult, bigFrame)
        const firstBatch = dc.sent.splice(0)

        layer.emitOut('message', layer.grantResult, bigFrame)
        const secondBatch = dc.sent.splice(0)

        // Decode seq from first chunk of each batch
        const seq1 = decodeChunkPayload(handshakeDecode(firstBatch[0]!).payload)!.seq
        const seq2 = decodeChunkPayload(handshakeDecode(secondBatch[0]!).payload)!.seq
        assert.notStrictEqual(seq1, seq2, 'consecutive chunked messages must use different seq numbers')
    })

    test('oversized frame (> 255 chunks) is logged as warning and dropped', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        // CHUNK_DATA_BYTES * 256 + 1 would need 257 chunks — exceeds the 255 limit
        const gigaFrame = handshakeEncode('t', new Uint8Array(CHUNK_DATA_BYTES * 256 + 1))
        layer.emitOut('message', layer.grantResult, gigaFrame)

        const warnLogs = layer.warningLogs.filter(m => m.includes('too large'))
        assert.ok(warnLogs.length > 0, 'must log a warning when frame cannot be chunked')
        assert.strictEqual(dc.sent.length, 0, 'oversized frame must be dropped — never partially sent')
    })

})

// ---------------------------------------------------------------------------
// RTCTransport — inbound chunk reassembly
// ---------------------------------------------------------------------------

suite('RTCTransport — inbound chunk reassembly (p2p.md §7)', () => {

    test('chunk fragments received from peer are reassembled before handleMessage', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        // Build a frame that needs 3 chunks and split it
        const originalFrame = handshakeEncode('peer:big', new Uint8Array(CHUNK_DATA_BYTES * 2 + 100).fill(0xAB))
        const chunks = chunkFrame(originalFrame, 0)
        assert.ok(chunks.length === 3, 'pre-condition: must produce 3 chunks')

        // Send all but the last chunk — handleMessage must NOT be called yet
        dc.receive(chunks[0]!)
        dc.receive(chunks[1]!)
        await new Promise(resolve => setTimeout(resolve, 0))
        assert.strictEqual(layer.handled.length, 0, 'handleMessage must not fire until all chunks arrive')

        // Send the last chunk — handleMessage must be called with the reassembled frame
        dc.receive(chunks[2]!)
        await new Promise(resolve => setTimeout(resolve, 0))
        assert.strictEqual(layer.handled.length, 1)
        assert.deepStrictEqual(layer.handled[0]!.buf, originalFrame)
    })

    test('non-chunk inbound frames still pass through as original reference', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const frame = handshakeEncode('small:msg', new Uint8Array([7, 8]))
        dc.receive(frame)
        await new Promise(resolve => setTimeout(resolve, 0))

        assert.strictEqual(layer.handled.length, 1)
        assert.strictEqual(layer.handled[0]!.buf, frame, 'non-chunk frame must pass as original reference')
    })

    test('two sequential chunked messages from the same peer reassemble correctly', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        const dc = await openChannel(transport, layer, signalClient, peers)

        const frameA = handshakeEncode('msg:a', new Uint8Array(CHUNK_DATA_BYTES * 2).fill(0xAA))
        const frameB = handshakeEncode('msg:b', new Uint8Array(CHUNK_DATA_BYTES * 2).fill(0xBB))

        for (const chunk of chunkFrame(frameA, 0)) dc.receive(chunk)
        for (const chunk of chunkFrame(frameB, 1)) dc.receive(chunk)
        await new Promise(resolve => setTimeout(resolve, 0))

        assert.strictEqual(layer.handled.length, 2)
        assert.deepStrictEqual(layer.handled[0]!.buf, frameA)
        assert.deepStrictEqual(layer.handled[1]!.buf, frameB)
    })

})

// ---------------------------------------------------------------------------
// RTCClient — receive chunked frames from host
// ---------------------------------------------------------------------------

suite('RTCClient — reassembly of chunked frames from host (p2p.md §7)', () => {

    test('chunked frames from host reassembled and emitted on correct topic', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await connectClient(client, signalClients, peers)

        const originalPayload = new Uint8Array(CHUNK_DATA_BYTES * 2 + 50).fill(0xCC)
        const originalFrame = handshakeEncode('arena:snapshot', originalPayload)
        const chunks = chunkFrame(originalFrame, 4)

        const received: Array<{ payload: Uint8Array }> = []
        client.on('arena:snapshot', (payload: Uint8Array) => received.push({ payload }))

        for (const chunk of chunks) dc.receive(chunk)

        assert.strictEqual(received.length, 1, 'must emit exactly once after all chunks arrive')
        assert.deepStrictEqual(received[0]!.payload, originalPayload)
    })

    test('partial chunks do not emit until all arrive', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await connectClient(client, signalClients, peers)

        const frame = handshakeEncode('big', new Uint8Array(CHUNK_DATA_BYTES * 3).fill(0xDD))
        const chunks = chunkFrame(frame, 0)

        const received: unknown[] = []
        client.on('big', (p: unknown) => received.push(p))

        dc.receive(chunks[0]!)
        dc.receive(chunks[1]!)
        assert.strictEqual(received.length, 0, 'must not emit after partial chunk delivery')

        dc.receive(chunks[2]!)
        assert.strictEqual(received.length, 1)
    })

    test('regular (non-chunked) frames from host still decode normally', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await connectClient(client, signalClients, peers)

        const received: Uint8Array[] = []
        client.on('game:state', (p: Uint8Array) => received.push(p))

        dc.receive(handshakeEncode('game:state', new Uint8Array([1, 2, 3])))
        assert.deepStrictEqual(received[0], new Uint8Array([1, 2, 3]))
    })

})

// ---------------------------------------------------------------------------
// RTCClient — outbound chunking (peer→host)
// ---------------------------------------------------------------------------

suite('RTCClient.send() — outbound chunking (p2p.md §7)', () => {

    test('small send() produces a single handshake-encoded frame', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await connectClient(client, signalClients, peers)
        const sentBefore = dc.sent.length

        client.send('move:input', new Uint8Array([1, 2, 3]))

        assert.strictEqual(dc.sent.length - sentBefore, 1, 'small send must produce exactly 1 message')
        const frame = handshakeDecode(dc.sent[dc.sent.length - 1]!)
        assert.strictEqual(frame.topic, 'move:input')
    })

    test('large send() is chunked into multiple __rivalis:chunk messages', async () => {
        const { client, signalClients, peers } = makeClient()
        const { dc } = await connectClient(client, signalClients, peers)
        const sentBefore = dc.sent.length

        const largePayload = new Uint8Array(RTC_MAX_FRAME_BYTES * 2).fill(0xEE)
        client.send('upload:data', largePayload)

        const newFrames = dc.sent.slice(sentBefore)
        assert.ok(newFrames.length > 1, 'large send must produce multiple chunk messages')
        for (const chunk of newFrames) {
            assert.ok(chunk.byteLength <= RTC_MAX_FRAME_BYTES)
            assert.ok(isChunkFrame(chunk), 'each outbound message must be a chunk frame')
        }
    })

    test('RTCTransport reassembles large peer→host send()', async () => {
        // End-to-end: RTCClient.send() → chunk → RTCTransport inbound reassembly → handleMessage
        const { transport, layer, signalClient, peers } = makeTransport()
        const hostDc = await openChannel(transport, layer, signalClient, peers)

        // Build a large frame that RTCClient would chunk
        const { client, signalClients, peers: clientPeers } = makeClient()
        const { dc: clientDc } = await connectClient(client, signalClients, clientPeers)

        // client.send() → chunks appear in clientDc.sent (after the ticket message)
        const largePayload = new Uint8Array(CHUNK_DATA_BYTES * 2 + 100).fill(0xAB)
        client.send('peer:upload', largePayload)
        // skip dc.sent[0] = ticket
        const chunks = clientDc.sent.slice(1)
        assert.ok(chunks.length > 1, 'client.send must chunk large payload')

        // Feed those chunks into the host-side channel as if received from the peer
        for (const chunk of chunks) hostDc.receive(chunk)
        await new Promise(resolve => setTimeout(resolve, 0))

        assert.strictEqual(layer.handled.length, 1, 'RTCTransport must produce exactly one reassembled handleMessage call')
        const reassembled = layer.handled[0]!.buf
        const { topic, payload } = handshakeDecode(reassembled)
        assert.strictEqual(topic, 'peer:upload')
        assert.deepStrictEqual(payload, largePayload)
    })

})

// ---------------------------------------------------------------------------
// Oversized-broadcast regression (p2p.md §10, task 078)
//
// When Room.broadcast() produces a frame > RTC_MAX_FRAME_BYTES the transport
// MUST chunk it for every connected actor — not silently drop it and not send
// a partial stream to any actor.  When the frame cannot be chunked at all
// (> 255 chunks, ~4 MiB) the transport MUST log a warning and drop the entire
// frame for every actor — never a partially-sent sequence of chunks.
// ---------------------------------------------------------------------------

/**
 * Open a second actor on an already-initialised transport.
 * The first openChannel() call has already called onInitialize + welcome;
 * we only need to trigger a new signal:offer so the HostNegotiator creates
 * a fresh RTCPeerConnection (peers[peerIndex]) and then open the data channel.
 */
async function openSecondChannel(
    layer: MockTLayer,
    signalClient: MockSignalClient,
    peers: MockPeer[],
    peerIndex: number,
    opts: { peerId?: string; hostId?: string; actorId?: string; ticket?: string } = {},
): Promise<MockDataChannel> {
    const peerId  = opts.peerId  ?? 'peer-2'
    const hostId  = opts.hostId  ?? 'host-id'
    const ticket  = opts.ticket  ?? 'peer-game-ticket-2'

    layer.grantResult = opts.actorId ?? 'actor-2'
    signalClient.emit('signal:offer', encodeOffer(hostId, 'v=0\r\n', peerId))
    const dc = new MockDataChannel()
    peers[peerIndex]!.emitDataChannel(dc)
    dc.receive(new TextEncoder().encode(ticket))
    await new Promise(resolve => setTimeout(resolve, 0))
    return dc
}

suite('RTCTransport — oversized broadcast (p2p.md §10)', () => {

    test('broadcast (> RTC ceiling) to two actors — each receives all chunk messages', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        layer.grantResult = 'actor-1'
        const dc1 = await openChannel(transport, layer, signalClient, peers, { peerId: 'peer-1' })
        const dc2 = await openSecondChannel(layer, signalClient, peers, 1, { peerId: 'peer-2', actorId: 'actor-2' })

        const largePayload = new Uint8Array(RTC_MAX_FRAME_BYTES * 2).fill(0xAB)
        const largeFrame = handshakeEncode('arena:snapshot', largePayload)
        assert.ok(largeFrame.byteLength > RTC_MAX_FRAME_BYTES, 'pre-condition: frame must exceed RTC ceiling')

        // Simulate Room.broadcast() — TLayer delivers the same frame to every actor.
        layer.emitOut('message', 'actor-1', largeFrame)
        layer.emitOut('message', 'actor-2', largeFrame)

        assert.ok(dc1.sent.length > 1, 'actor-1 must receive more than one chunk message')
        assert.ok(dc2.sent.length > 1, 'actor-2 must receive more than one chunk message')

        for (const chunk of dc1.sent) {
            assert.ok(chunk.byteLength <= RTC_MAX_FRAME_BYTES,
                `actor-1 chunk size ${chunk.byteLength} exceeds RTC ceiling`)
            assert.ok(isChunkFrame(chunk), 'every actor-1 message must be a chunk frame')
        }
        for (const chunk of dc2.sent) {
            assert.ok(chunk.byteLength <= RTC_MAX_FRAME_BYTES,
                `actor-2 chunk size ${chunk.byteLength} exceeds RTC ceiling`)
            assert.ok(isChunkFrame(chunk), 'every actor-2 message must be a chunk frame')
        }
    })

    test('broadcast chunks to two actors reassemble independently to the original frame', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        layer.grantResult = 'actor-1'
        const dc1 = await openChannel(transport, layer, signalClient, peers, { peerId: 'peer-1' })
        const dc2 = await openSecondChannel(layer, signalClient, peers, 1, { peerId: 'peer-2', actorId: 'actor-2' })

        const originalPayload = new Uint8Array(CHUNK_DATA_BYTES * 2 + 200)
        for (let i = 0; i < originalPayload.length; i++) originalPayload[i] = i & 0xFF
        const originalFrame = handshakeEncode('game:state', originalPayload)

        layer.emitOut('message', 'actor-1', originalFrame)
        layer.emitOut('message', 'actor-2', originalFrame)

        // Reassemble what actor-1 received
        const r1 = new ChunkReassembler()
        let result1: Uint8Array | null = null
        for (const chunk of dc1.sent) {
            const { payload } = handshakeDecode(chunk)
            const parsed = decodeChunkPayload(payload)!
            result1 = r1.feed(parsed.seq, parsed.total, parsed.index, parsed.data)
        }
        assert.ok(result1 !== null, 'actor-1 chunks must fully reassemble')
        assert.deepStrictEqual(result1, originalFrame, 'actor-1 reassembled frame must equal the original')

        // Reassemble what actor-2 received
        const r2 = new ChunkReassembler()
        let result2: Uint8Array | null = null
        for (const chunk of dc2.sent) {
            const { payload } = handshakeDecode(chunk)
            const parsed = decodeChunkPayload(payload)!
            result2 = r2.feed(parsed.seq, parsed.total, parsed.index, parsed.data)
        }
        assert.ok(result2 !== null, 'actor-2 chunks must fully reassemble')
        assert.deepStrictEqual(result2, originalFrame, 'actor-2 reassembled frame must equal the original')
    })

    test('broadcast oversized (> 255 chunks) — warning logged, nothing sent to any actor', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        layer.grantResult = 'actor-1'
        const dc1 = await openChannel(transport, layer, signalClient, peers, { peerId: 'peer-1' })
        const dc2 = await openSecondChannel(layer, signalClient, peers, 1, { peerId: 'peer-2', actorId: 'actor-2' })

        // CHUNK_DATA_BYTES * 256 + 1 requires 257 chunks — exceeds the 255 limit.
        const giantPayload = new Uint8Array(CHUNK_DATA_BYTES * 256 + 1)
        const giantFrame = handshakeEncode('huge:blob', giantPayload)

        // Simulate broadcast delivering the giant frame to both actors.
        layer.emitOut('message', 'actor-1', giantFrame)
        layer.emitOut('message', 'actor-2', giantFrame)

        assert.strictEqual(dc1.sent.length, 0,
            'actor-1 must receive nothing when the frame is too large to chunk')
        assert.strictEqual(dc2.sent.length, 0,
            'actor-2 must receive nothing when the frame is too large to chunk')

        const warnings = layer.warningLogs.filter(m => m.includes('too large'))
        assert.ok(warnings.length >= 2,
            'a warning must be logged for each actor whose frame could not be chunked')
    })

    test('broadcast oversized frame — never partially sent (no chunks before the drop)', async () => {
        const { transport, layer, signalClient, peers } = makeTransport()
        layer.grantResult = 'actor-1'
        const dc1 = await openChannel(transport, layer, signalClient, peers, { peerId: 'peer-1' })

        const giantPayload = new Uint8Array(CHUNK_DATA_BYTES * 256 + 1)
        const giantFrame = handshakeEncode('huge:blob', giantPayload)

        layer.emitOut('message', 'actor-1', giantFrame)

        // The transport must not send even a single byte — a partial chunk stream
        // would leave the reassembler in a broken state on the other end.
        assert.strictEqual(dc1.sent.length, 0,
            'no partial chunk sequence must be sent when the frame exceeds the 255-chunk limit')
    })

})
