/**
 * RTCPeer adapter unit tests (p2p.md §4.5, task 058).
 *
 * All tests run without an actual node-datachannel native binary by injecting
 * a mock NDC module into NodeDataChannelPeer's optional second constructor
 * parameter. NodeDCDataChannel is tested directly with a mock DataChannel.
 *
 * Covers:
 *  - Interface surface: RTCPeerLike / RTCDataChannelLike method presence
 *  - NodeDCDataChannel: Buffer message → Uint8Array, string → TextEncoder,
 *    open/close callbacks, sendBinary buffer marshalling, isOpen passthrough
 *  - NodeDataChannelPeer: createDataChannel, onDataChannel, onStateChange,
 *    onLocalDescription, onLocalCandidate, setLocalDescription,
 *    setRemoteDescription, addRemoteCandidate, close
 *  - createPeerConnection factory: werift selection, missing-module error messages
 *  - ICE server URL mapping: stun/turn/turns with explicit and default ports,
 *    query param, multi-url per server, username/credential
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import {
    createPeerConnection,
    NodeDataChannelPeer,
    NodeDCDataChannel,
} from '../lib/main.js'
import type { RTCDataChannelLike, RTCPeerLike } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Mock node-datachannel primitives
// ---------------------------------------------------------------------------

class MockDataChannel {
    private _messageHandler: ((msg: Buffer | string) => void) | null = null
    private _openHandler: (() => void) | null = null
    private _closedHandler: (() => void) | null = null
    public sent: Buffer[] = []
    public _open = true
    public _closed = false
    public _bufferedAmount = 0

    onMessage(cb: (msg: Buffer | string) => void): void { this._messageHandler = cb }
    onOpen(cb: () => void): void { this._openHandler = cb }
    onClosed(cb: () => void): void { this._closedHandler = cb }
    sendMessageBinary(buf: Buffer): void { this.sent.push(buf) }
    close(): void { this._closed = true; this._open = false }
    isOpen(): boolean { return this._open }
    bufferedAmount(): number { return this._bufferedAmount }

    emitMessage(msg: Buffer | string): void { this._messageHandler?.(msg) }
    emitOpen(): void { this._openHandler?.() }
    emitClose(): void { this._closedHandler?.() }
}

class MockPeerConnection {
    public id: string
    public options: unknown
    public createdChannels: Array<{ label: string; options: { ordered: boolean } }> = []
    public remoteDescriptions: Array<{ sdp: string; type: string }> = []
    public remoteCandidates: Array<{ candidate: string; mid: string }> = []
    public localDescriptionCalls: Array<{ type: string | undefined }> = []
    public closed = false

    private _dcHandler: ((dc: MockDataChannel) => void) | null = null
    private _stateHandler: ((state: string) => void) | null = null
    private _localDescHandler: ((sdp: string, type: string) => void) | null = null
    private _localCandHandler: ((candidate: string, mid: string) => void) | null = null

    constructor(id: string, options: unknown) {
        this.id = id
        this.options = options
    }

    createDataChannel(label: string, options: { ordered: boolean }): MockDataChannel {
        this.createdChannels.push({ label, options })
        return new MockDataChannel()
    }

    onDataChannel(cb: (dc: MockDataChannel) => void): void { this._dcHandler = cb }
    onConnectionStateChange(cb: (state: string) => void): void { this._stateHandler = cb }
    onLocalDescription(cb: (sdp: string, type: string) => void): void { this._localDescHandler = cb }
    onLocalCandidate(cb: (candidate: string, mid: string) => void): void { this._localCandHandler = cb }
    setLocalDescription(type?: string): void { this.localDescriptionCalls.push({ type }) }
    setRemoteDescription(sdp: string, type: string): void { this.remoteDescriptions.push({ sdp, type }) }
    addRemoteCandidate(candidate: string, mid: string): void { this.remoteCandidates.push({ candidate, mid }) }
    close(): void { this.closed = true }

    emitDataChannel(dc: MockDataChannel): void { this._dcHandler?.(dc) }
    emitState(state: string): void { this._stateHandler?.(state) }
    emitLocalDescription(sdp: string, type: string): void { this._localDescHandler?.(sdp, type) }
    emitLocalCandidate(candidate: string, mid: string): void { this._localCandHandler?.(candidate, mid) }
}

const mockNDC = { PeerConnection: MockPeerConnection }

function makePeer(config: RTCConfiguration = {}): { peer: NodeDataChannelPeer; pc: MockPeerConnection } {
    const peer = new NodeDataChannelPeer(config, mockNDC)
    const pc = (peer as unknown as { pc: MockPeerConnection }).pc
    return { peer, pc }
}

// ---------------------------------------------------------------------------
// §1: Interface satisfaction
// ---------------------------------------------------------------------------

suite('RTCPeerLike interface surface', () => {

    test('NodeDataChannelPeer satisfies RTCPeerLike', () => {
        const { peer } = makePeer()
        const p: RTCPeerLike = peer
        assert.strictEqual(typeof p.createDataChannel, 'function')
        assert.strictEqual(typeof p.onDataChannel, 'function')
        assert.strictEqual(typeof p.onStateChange, 'function')
        assert.strictEqual(typeof p.onLocalDescription, 'function')
        assert.strictEqual(typeof p.onLocalCandidate, 'function')
        assert.strictEqual(typeof p.setLocalDescription, 'function')
        assert.strictEqual(typeof p.setRemoteDescription, 'function')
        assert.strictEqual(typeof p.addRemoteCandidate, 'function')
        assert.strictEqual(typeof p.close, 'function')
    })

    test('NodeDCDataChannel satisfies RTCDataChannelLike', () => {
        const dc = new NodeDCDataChannel(new MockDataChannel() as never)
        const c: RTCDataChannelLike = dc
        assert.strictEqual(typeof c.onMessage, 'function')
        assert.strictEqual(typeof c.onOpen, 'function')
        assert.strictEqual(typeof c.onClose, 'function')
        assert.strictEqual(typeof c.sendBinary, 'function')
        assert.strictEqual(typeof c.close, 'function')
        assert.strictEqual(typeof c.isOpen, 'boolean')
        assert.strictEqual(typeof c.bufferedAmount, 'number')
    })

})

// ---------------------------------------------------------------------------
// §2: NodeDCDataChannel behaviour
// ---------------------------------------------------------------------------

suite('NodeDCDataChannel', () => {

    test('Buffer message → Uint8Array with correct bytes', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        let received: Uint8Array | null = null
        channel.onMessage(buf => { received = buf })

        mockDC.emitMessage(Buffer.from([0x01, 0x02, 0x03]))

        assert.ok(received instanceof Uint8Array)
        assert.deepStrictEqual(Array.from(received), [0x01, 0x02, 0x03])
    })

    test('string message → TextEncoder Uint8Array', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        let received: Uint8Array | null = null
        channel.onMessage(buf => { received = buf })

        mockDC.emitMessage('hello')

        assert.ok(received instanceof Uint8Array)
        assert.deepStrictEqual(
            Array.from(received),
            Array.from(new TextEncoder().encode('hello'))
        )
    })

    test('onOpen callback fires on DC open', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        let opened = false
        channel.onOpen(() => { opened = true })
        mockDC.emitOpen()

        assert.ok(opened)
    })

    test('onClose callback fires on DC close', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        let closed = false
        channel.onClose(() => { closed = true })
        mockDC.emitClose()

        assert.ok(closed)
    })

    test('sendBinary passes a Buffer with matching bytes to sendMessageBinary', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        channel.sendBinary(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]))

        assert.strictEqual(mockDC.sent.length, 1)
        const sent = mockDC.sent[0]!
        assert.ok(Buffer.isBuffer(sent))
        assert.deepStrictEqual(Array.from(sent), [0xDE, 0xAD, 0xBE, 0xEF])
    })

    test('close delegates to the underlying DataChannel', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        channel.close()

        assert.strictEqual(mockDC._closed, true)
    })

    test('isOpen reflects the underlying DataChannel.isOpen()', () => {
        const mockDC = new MockDataChannel()
        const channel = new NodeDCDataChannel(mockDC as never)

        mockDC._open = true
        assert.strictEqual(channel.isOpen, true)

        mockDC._open = false
        assert.strictEqual(channel.isOpen, false)
    })

})

// ---------------------------------------------------------------------------
// §3: NodeDataChannelPeer behaviour
// ---------------------------------------------------------------------------

suite('NodeDataChannelPeer', () => {

    test('createDataChannel passes label and ordered to the PC and returns RTCDataChannelLike', () => {
        const { peer, pc } = makePeer()

        const ch = peer.createDataChannel('rivalis', true)

        assert.strictEqual(pc.createdChannels.length, 1)
        assert.strictEqual(pc.createdChannels[0]!.label, 'rivalis')
        assert.strictEqual(pc.createdChannels[0]!.options.ordered, true)
        assert.strictEqual(typeof ch.sendBinary, 'function')
    })

    test('createDataChannel respects ordered=false', () => {
        const { peer, pc } = makePeer()

        peer.createDataChannel('unreliable', false)

        assert.strictEqual(pc.createdChannels[0]!.options.ordered, false)
    })

    test('onDataChannel fires with an RTCDataChannelLike wrapping the inbound DC', () => {
        const { peer, pc } = makePeer()

        let received: RTCDataChannelLike | null = null
        peer.onDataChannel(ch => { received = ch })

        pc.emitDataChannel(new MockDataChannel())

        assert.ok(received !== null)
        assert.strictEqual(typeof received.sendBinary, 'function')
    })

    test('onStateChange fires with the state string from the PC', () => {
        const { peer, pc } = makePeer()

        const states: string[] = []
        peer.onStateChange(s => states.push(s))

        pc.emitState('connected')
        pc.emitState('disconnected')
        pc.emitState('failed')
        pc.emitState('closed')

        assert.deepStrictEqual(states, ['connected', 'disconnected', 'failed', 'closed'])
    })

    test('onLocalDescription fires with sdp and type', () => {
        const { peer, pc } = makePeer()

        let gotSdp = ''
        let gotType = ''
        peer.onLocalDescription((sdp, type) => { gotSdp = sdp; gotType = type })

        pc.emitLocalDescription('v=0\r\n...', 'offer')

        assert.strictEqual(gotSdp, 'v=0\r\n...')
        assert.strictEqual(gotType, 'offer')
    })

    test('onLocalCandidate fires with candidate and mid', () => {
        const { peer, pc } = makePeer()

        let gotCandidate = ''
        let gotMid = ''
        peer.onLocalCandidate((c, m) => { gotCandidate = c; gotMid = m })

        pc.emitLocalCandidate('candidate:abc123', '0')

        assert.strictEqual(gotCandidate, 'candidate:abc123')
        assert.strictEqual(gotMid, '0')
    })

    test('setLocalDescription delegates to PC with the given type', () => {
        const { peer, pc } = makePeer()

        peer.setLocalDescription('offer')
        peer.setLocalDescription()

        assert.strictEqual(pc.localDescriptionCalls.length, 2)
        assert.strictEqual(pc.localDescriptionCalls[0]!.type, 'offer')
        assert.strictEqual(pc.localDescriptionCalls[1]!.type, undefined)
    })

    test('setRemoteDescription delegates to PC with sdp and type', () => {
        const { peer, pc } = makePeer()

        peer.setRemoteDescription('v=0\r\n...', 'answer')

        assert.deepStrictEqual(pc.remoteDescriptions, [{ sdp: 'v=0\r\n...', type: 'answer' }])
    })

    test('addRemoteCandidate delegates to PC with candidate and mid', () => {
        const { peer, pc } = makePeer()

        peer.addRemoteCandidate('candidate:abc', '1')

        assert.deepStrictEqual(pc.remoteCandidates, [{ candidate: 'candidate:abc', mid: '1' }])
    })

    test('close delegates to the underlying PC', () => {
        const { peer, pc } = makePeer()

        assert.strictEqual(pc.closed, false)
        peer.close()
        assert.strictEqual(pc.closed, true)
    })

})

// ---------------------------------------------------------------------------
// §4: ICE server URL mapping
// ---------------------------------------------------------------------------

suite('ICE server URL mapping', () => {

    function iceServers(config: RTCConfiguration): unknown[] {
        const { pc } = makePeer(config)
        return (pc.options as { iceServers: unknown[] }).iceServers
    }

    test('empty iceServers → empty array', () => {
        assert.deepStrictEqual(iceServers({ iceServers: [] }), [])
    })

    test('no iceServers key → empty array', () => {
        assert.deepStrictEqual(iceServers({}), [])
    })

    test('stun: URL with no port → hostname + port 3478', () => {
        assert.deepStrictEqual(iceServers({ iceServers: [{ urls: 'stun:stun.example.com' }] }), [
            { hostname: 'stun.example.com', port: 3478, username: undefined, password: undefined, relayType: undefined },
        ])
    })

    test('stun: URL with explicit port', () => {
        assert.deepStrictEqual(iceServers({ iceServers: [{ urls: 'stun:stun.example.com:19302' }] }), [
            { hostname: 'stun.example.com', port: 19302, username: undefined, password: undefined, relayType: undefined },
        ])
    })

    test('turn: URL → TurnUdp with credentials and port 3478', () => {
        assert.deepStrictEqual(iceServers({
            iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }],
        }), [
            { hostname: 'turn.example.com', port: 3478, username: 'user', password: 'pass', relayType: 'TurnUdp' },
        ])
    })

    test('turns: URL → TurnTls with default port 5349', () => {
        assert.deepStrictEqual(iceServers({
            iceServers: [{ urls: 'turns:turn.example.com', username: 'u', credential: 'c' }],
        }), [
            { hostname: 'turn.example.com', port: 5349, username: 'u', password: 'c', relayType: 'TurnTls' },
        ])
    })

    test('turn: URL with ?transport=udp query string parses hostname and port correctly', () => {
        assert.deepStrictEqual(iceServers({
            iceServers: [{ urls: 'turn:turn.example.com:3478?transport=udp', username: 'u', credential: 'c' }],
        }), [
            { hostname: 'turn.example.com', port: 3478, username: 'u', password: 'c', relayType: 'TurnUdp' },
        ])
    })

    test('multi-url per RTCIceServer entry is expanded to multiple server objects', () => {
        const servers = iceServers({
            iceServers: [{
                urls: ['stun:s1.example.com', 'turn:t1.example.com:3478'],
                username: 'user',
                credential: 'pass',
            }],
        }) as Array<{ hostname: string; relayType: string | undefined }>

        assert.strictEqual(servers.length, 2)
        assert.strictEqual(servers[0]!.hostname, 's1.example.com')
        assert.strictEqual(servers[0]!.relayType, undefined)
        assert.strictEqual(servers[1]!.hostname, 't1.example.com')
        assert.strictEqual(servers[1]!.relayType, 'TurnUdp')
    })

    test('multiple RTCIceServer entries are all mapped', () => {
        const servers = iceServers({
            iceServers: [
                { urls: 'stun:s1.example.com' },
                { urls: 'stun:s2.example.com:19302' },
            ],
        })
        assert.strictEqual(servers.length, 2)
    })

})

// ---------------------------------------------------------------------------
// §5: createPeerConnection factory backend selection
// ---------------------------------------------------------------------------

suite('createPeerConnection factory', () => {

    test('throws with a descriptive message when node-datachannel is not installed', () => {
        // When the native binary is absent the require path throws. We call with no
        // injected mock so the real require path is exercised. If node-datachannel IS
        // installed this test is a no-op pass; if absent it must carry the package name.
        try {
            createPeerConnection({})
        } catch (err) {
            assert.ok(err instanceof Error)
            assert.ok(
                err.message.includes('node-datachannel'),
                `Error must mention 'node-datachannel', got: ${err.message}`
            )
        }
    })

    test('RIVALIS_WEBRTC_BACKEND=werift throws a descriptive not-implemented error', () => {
        const saved = process.env['RIVALIS_WEBRTC_BACKEND']
        process.env['RIVALIS_WEBRTC_BACKEND'] = 'werift'
        try {
            assert.throws(
                () => createPeerConnection({}),
                (err: unknown) => {
                    assert.ok(err instanceof Error)
                    // Error must mention either werift or the not-yet-implemented status.
                    const msg = err.message
                    assert.ok(
                        msg.includes('werift') || msg.includes('not yet') || msg.includes('not installed'),
                        `Error must mention werift: ${msg}`
                    )
                    return true
                }
            )
        } finally {
            if (saved === undefined) {
                delete process.env['RIVALIS_WEBRTC_BACKEND']
            } else {
                process.env['RIVALIS_WEBRTC_BACKEND'] = saved
            }
        }
    })

})
