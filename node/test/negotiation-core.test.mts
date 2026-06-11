/**
 * NegotiationCore unit tests (p2p.md §4.5, task 059).
 *
 * All tests run without real WebRTC or a real signal server. The signal client
 * and RTCPeerLike are fully mocked; the test codec mirrors the NegotiationCore's
 * signal wire schema (same major + field order) so encoded frames are
 * bitwise-compatible.
 *
 * Covers:
 *  - RTCAdapters interface contract
 *  - PeerNegotiator: connect flow, offer/ICE encoding, answer/ICE application,
 *    DC open callback, disconnect, welcome with no host (skips negotiation),
 *    welcome where youId === hostId (skip — peer is the host side)
 *  - HostNegotiator: offer handling, answer/ICE encoding, ICE routing by peerId,
 *    DC open callback, unknown-from ICE ignored, closePeer, dispose
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import { createCodec, FieldType, present } from '@rivalis/handshake'
import { PeerNegotiator, HostNegotiator } from '../lib/main.js'
import type { RTCAdapters, PeerNegotiatorCallbacks, HostNegotiatorCallbacks } from '../lib/main.js'
import type { RTCPeerLike, RTCDataChannelLike, ChannelReliability } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Test codec — same schema + major as NegotiationCore, different namespace.
// The namespace is only a serializer scope key; identical field layouts produce
// bitwise-identical binary, so test frames can be decoded by NegotiationCore.
// ---------------------------------------------------------------------------

const F = FieldType
const testCodec = createCodec({
    namespace: '@rivalis/node/signal-test',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: F.STRING, rule: 'optional' },
            { key: 'hostId',     type: F.STRING, rule: 'optional' },
            { key: 'iceServers', type: F.STRING, rule: 'optional' },
        ],
        Offer: [
            { key: 'to',   type: F.STRING, rule: 'optional' },
            { key: 'sdp',  type: F.STRING, rule: 'optional' },
            { key: 'from', type: F.STRING, rule: 'optional' },
        ],
        Answer: [
            { key: 'to',   type: F.STRING, rule: 'optional' },
            { key: 'sdp',  type: F.STRING, rule: 'optional' },
            { key: 'from', type: F.STRING, rule: 'optional' },
        ],
        IceCandidate: [
            { key: 'to',        type: F.STRING, rule: 'optional' },
            { key: 'candidate', type: F.STRING, rule: 'optional' },
            { key: 'from',      type: F.STRING, rule: 'optional' },
        ],
    }
})

function encodeWelcome(youId: string, hostId: string | null, iceServers = '[]'): Uint8Array {
    const msg: Record<string, unknown> = { youId, iceServers }
    if (hostId !== null) msg['hostId'] = hostId
    return testCodec.encode('Welcome', msg)
}

function encodeOffer(to: string, sdp: string, from: string): Uint8Array {
    return testCodec.encode('Offer', { to, sdp, from })
}

function encodeAnswer(to: string, sdp: string, from: string): Uint8Array {
    return testCodec.encode('Answer', { to, sdp, from })
}

function encodeIce(to: string, candidate: string, sdpMid: string, from: string): Uint8Array {
    return testCodec.encode('IceCandidate', {
        to,
        candidate: JSON.stringify({ candidate, sdpMid }),
        from,
    })
}

function decodeSentOffer(p: Uint8Array): { to: string; sdp: string; from: string } {
    const m = testCodec.decode('Offer', p)
    return { to: String(m['to'] ?? ''), sdp: String(m['sdp'] ?? ''), from: String(m['from'] ?? '') }
}

function decodeSentAnswer(p: Uint8Array): { to: string; sdp: string; from: string } {
    const m = testCodec.decode('Answer', p)
    return { to: String(m['to'] ?? ''), sdp: String(m['sdp'] ?? ''), from: String(m['from'] ?? '') }
}

function decodeSentIce(p: Uint8Array): { to: string; candidate: string; sdpMid: string; from: string } {
    const m = testCodec.decode('IceCandidate', p)
    const raw = JSON.parse(String(m['candidate'] ?? '{}')) as { candidate?: string; sdpMid?: string }
    return {
        to: String(m['to'] ?? ''),
        candidate: raw.candidate ?? '',
        sdpMid: raw.sdpMid ?? '',
        from: String(m['from'] ?? ''),
    }
}

// ---------------------------------------------------------------------------
// Mock signal client (duck-typed to satisfy the Client interface)
// ---------------------------------------------------------------------------

type Listener = (payload: Uint8Array) => void

class MockSignalClient {
    private readonly map = new Map<string, Listener[]>()
    readonly sent: Array<{ topic: string; payload: Uint8Array }> = []
    connectedWith: string | null = null
    disconnected = false

    on(event: string, listener: Listener, _context?: unknown): this {
        const list = this.map.get(event) ?? []
        list.push(listener)
        this.map.set(event, list)
        return this
    }
    once(event: string, listener: Listener, _context?: unknown): this { return this.on(event, listener) }
    off(event: string, listener: Listener, _context?: unknown): this {
        const list = this.map.get(event) ?? []
        const idx = list.indexOf(listener)
        if (idx >= 0) list.splice(idx, 1)
        return this
    }
    connect(ticket: string): void { this.connectedWith = ticket }
    disconnect(): void { this.disconnected = true }
    send(topic: string, payload: Uint8Array | string): void {
        const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
        this.sent.push({ topic, payload: bytes })
    }
    emit(topic: string, payload: Uint8Array): void {
        for (const l of this.map.get(topic) ?? []) l(payload)
    }
}

// ---------------------------------------------------------------------------
// Mock RTCDataChannelLike
// ---------------------------------------------------------------------------

class MockDataChannel implements RTCDataChannelLike {
    private _onOpen: (() => void) | null = null
    readonly sent: Uint8Array[] = []
    private _isOpen = false
    closed = false
    bufferedAmount = 0
    readonly label: string

    constructor(label = 'rivalis') { this.label = label }

    onMessage(_cb: (buf: Uint8Array) => void): void { /* no-op in this test */ }
    onOpen(cb: () => void): void { this._onOpen = cb }
    onClose(_cb: () => void): void { /* no-op */ }
    sendBinary(buf: Uint8Array): void { this.sent.push(buf) }
    close(): void { this.closed = true; this._isOpen = false }
    get isOpen(): boolean { return this._isOpen }

    emitOpen(): void { this._isOpen = true; this._onOpen?.() }
}

// ---------------------------------------------------------------------------
// Mock RTCPeerLike
// ---------------------------------------------------------------------------

class MockPeer implements RTCPeerLike {
    private _onDataChannel: ((dc: RTCDataChannelLike) => void) | null = null
    private _onState: ((s: string) => void) | null = null
    private _onLocalDesc: ((sdp: string, type: string) => void) | null = null
    private _onLocalCand: ((candidate: string, mid: string) => void) | null = null

    readonly channels: MockDataChannel[] = []
    readonly channelReliabilities: ChannelReliability[] = []
    readonly remoteDescriptions: Array<{ sdp: string; type: string }> = []
    readonly remoteCandidates: Array<{ candidate: string; mid: string }> = []
    readonly localDescriptionCalls: Array<{ type: string | undefined }> = []
    closed = false

    createDataChannel(label: string, reliability: ChannelReliability): RTCDataChannelLike {
        const dc = new MockDataChannel(label)
        this.channels.push(dc)
        this.channelReliabilities.push(reliability)
        return dc
    }
    onDataChannel(cb: (dc: RTCDataChannelLike) => void): void { this._onDataChannel = cb }
    onStateChange(cb: (s: string) => void): void { this._onState = cb }
    onLocalDescription(cb: (sdp: string, type: string) => void): void { this._onLocalDesc = cb }
    onLocalCandidate(cb: (c: string, m: string) => void): void { this._onLocalCand = cb }
    setLocalDescription(type?: string): void { this.localDescriptionCalls.push({ type }) }
    setRemoteDescription(sdp: string, type: string): void { this.remoteDescriptions.push({ sdp, type }) }
    addRemoteCandidate(candidate: string, mid: string): void { this.remoteCandidates.push({ candidate, mid }) }
    close(): void { this.closed = true }

    emitLocalDescription(sdp: string, type: string): void { this._onLocalDesc?.(sdp, type) }
    emitLocalCandidate(c: string, mid: string): void { this._onLocalCand?.(c, mid) }
    emitDataChannel(dc: RTCDataChannelLike): void { this._onDataChannel?.(dc) }
    emitState(s: string): void { this._onState?.(s) }
}

// ---------------------------------------------------------------------------
// Helpers: build adapter + negotiator pairs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any
// ---------------------------------------------------------------------------

function makePeerNeg() {
    const signalClient = new MockSignalClient()
    const peer = new MockPeer()
    const adapters: RTCAdapters = {
        createPeerConnection() { return peer },
        createSignalingClient() { return signalClient as AnyClient },
    }
    const neg = new PeerNegotiator(adapters, 'ws://signal:9000')
    return { neg, signalClient, peer }
}

function makeHostNeg(peerCount = 2) {
    const signalClient = new MockSignalClient()
    const peers = Array.from({ length: peerCount }, () => new MockPeer())
    let peerIdx = 0
    const adapters: RTCAdapters = {
        createPeerConnection() { return (peers[peerIdx++] ?? new MockPeer()) },
        createSignalingClient() { return signalClient as AnyClient },
    }
    const neg = new HostNegotiator(adapters, signalClient as AnyClient)
    return { neg, signalClient, peers }
}

// ---------------------------------------------------------------------------
// PeerNegotiator tests
// ---------------------------------------------------------------------------

suite('PeerNegotiator', () => {

    const callbacks: PeerNegotiatorCallbacks = { onChannel: () => {}, onPeerStateChange: () => {} }

    test('exposes signalClient as a readonly field', () => {
        const { neg, signalClient } = makePeerNeg()
        assert.strictEqual(neg.signalClient as unknown, signalClient)
    })

    test('connect() calls signalClient.connect with the provided ticket', () => {
        const { neg, signalClient } = makePeerNeg()
        neg.connect('my-ticket', callbacks)
        assert.strictEqual(signalClient.connectedWith, 'my-ticket')
    })

    test('signal:welcome → creates PC + DC, calls setLocalDescription("offer")', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        assert.strictEqual(peer.channels.length, 1)
        assert.strictEqual(peer.localDescriptionCalls.length, 1)
        assert.strictEqual(peer.localDescriptionCalls[0]!.type, 'offer')
    })

    test('signal:welcome with null hostId → skips negotiation (no host yet)', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', null))
        assert.strictEqual(peer.channels.length, 0, 'no DC created without a host')
    })

    test('signal:welcome with youId === hostId → skips (this peer is the host)', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('host-1', 'host-1'))
        assert.strictEqual(peer.channels.length, 0)
    })

    test('welcome iceServers JSON is parsed and passed to createPeerConnection', () => {
        const signalClient = new MockSignalClient()
        const captured: RTCConfiguration[] = []
        const adapters: RTCAdapters = {
            createPeerConnection(config) { captured.push(config); return new MockPeer() },
            createSignalingClient() { return signalClient as AnyClient },
        }
        const neg = new PeerNegotiator(adapters, 'ws://signal:9000')
        neg.connect('t', callbacks)
        const ice = JSON.stringify([{ urls: 'stun:s.example.com' }])
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1', ice))
        assert.strictEqual(captured.length, 1)
        assert.deepStrictEqual((captured[0]!.iceServers as RTCIceServer[])[0]!.urls, 'stun:s.example.com')
    })

    test('onLocalDescription("offer") → sends signal:offer {to=hostId, sdp, from=youId}', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        peer.emitLocalDescription('v=0\r\n...offer', 'offer')
        const sent = signalClient.sent.find(s => s.topic === 'signal:offer')
        assert.ok(sent, 'signal:offer must be sent')
        const d = decodeSentOffer(sent.payload)
        assert.strictEqual(d.to, 'host-1')
        assert.strictEqual(d.sdp, 'v=0\r\n...offer')
        assert.strictEqual(d.from, 'peer-1')
    })

    test('onLocalDescription("answer") → not forwarded (only "offer" type triggers signal:offer)', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        peer.emitLocalDescription('v=0\r\n...answer', 'answer')
        assert.strictEqual(signalClient.sent.filter(s => s.topic === 'signal:offer').length, 0)
    })

    test('onLocalCandidate → sends signal:ice {to=hostId, JSON candidate+mid, from=youId}', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        peer.emitLocalCandidate('candidate:abc 1 udp 123 1.2.3.4 1234 typ host', '0')
        const sent = signalClient.sent.find(s => s.topic === 'signal:ice')
        assert.ok(sent, 'signal:ice must be sent')
        const d = decodeSentIce(sent.payload)
        assert.strictEqual(d.to, 'host-1')
        assert.strictEqual(d.from, 'peer-1')
        assert.ok(d.candidate.includes('candidate:abc'))
        assert.strictEqual(d.sdpMid, '0')
    })

    test('signal:answer → calls setRemoteDescription("answer") on the PC', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        signalClient.emit('signal:answer', encodeAnswer('peer-1', 'v=0\r\n...answer', 'host-1'))
        assert.strictEqual(peer.remoteDescriptions.length, 1)
        assert.strictEqual(peer.remoteDescriptions[0]!.sdp, 'v=0\r\n...answer')
        assert.strictEqual(peer.remoteDescriptions[0]!.type, 'answer')
    })

    test('signal:ice → calls addRemoteCandidate with parsed candidate + sdpMid', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        signalClient.emit('signal:ice', encodeIce('peer-1', 'candidate:xyz 1 udp 456', '1', 'host-1'))
        assert.strictEqual(peer.remoteCandidates.length, 1)
        assert.strictEqual(peer.remoteCandidates[0]!.candidate, 'candidate:xyz 1 udp 456')
        assert.strictEqual(peer.remoteCandidates[0]!.mid, '1')
    })

    test('DC open → fires onChannel callback with the data channel', () => {
        const opened: RTCDataChannelLike[] = []
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', { onChannel: dc => opened.push(dc), onPeerStateChange: () => {} })
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        const dc = peer.channels[0] as MockDataChannel
        assert.ok(dc)
        dc.emitOpen()
        assert.strictEqual(opened.length, 1)
        assert.strictEqual(opened[0], dc)
    })

    test('PC state change → fires onPeerStateChange callback', () => {
        const states: string[] = []
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', { onChannel: () => {}, onPeerStateChange: s => states.push(s) })
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        peer.emitState('disconnected')
        peer.emitState('failed')
        assert.deepStrictEqual(states, ['disconnected', 'failed'])
    })

    test('disconnect() → closes PC and disconnects signal client', () => {
        const { neg, signalClient, peer } = makePeerNeg()
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))
        neg.disconnect()
        assert.ok(peer.closed)
        assert.ok(signalClient.disconnected)
    })

    test('signal:ice before welcome → safely ignored (no PC created yet)', () => {
        const { neg, signalClient } = makePeerNeg()
        neg.connect('t', callbacks)
        assert.doesNotThrow(() =>
            signalClient.emit('signal:ice', encodeIce('peer-1', 'candidate:xyz', '0', 'host-1'))
        )
    })

    test('signal:answer before welcome → safely ignored', () => {
        const { neg, signalClient } = makePeerNeg()
        neg.connect('t', callbacks)
        assert.doesNotThrow(() =>
            signalClient.emit('signal:answer', encodeAnswer('peer-1', 'v=0', 'host-1'))
        )
    })

})

// ---------------------------------------------------------------------------
// PeerNegotiator — channel reliability (p2p.md §7)
// ---------------------------------------------------------------------------

suite('PeerNegotiator — channelReliability', () => {

    const callbacks: PeerNegotiatorCallbacks = { onChannel: () => {}, onPeerStateChange: () => {} }

    test('default reliability is { ordered: true } (WS-like semantics)', () => {
        const signalClient = new MockSignalClient()
        const peer = new MockPeer()
        const adapters: RTCAdapters = {
            createPeerConnection() { return peer },
            createSignalingClient() { return signalClient as AnyClient },
        }
        const neg = new PeerNegotiator(adapters, 'ws://signal:9000')
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))

        assert.strictEqual(peer.channelReliabilities.length, 1)
        assert.deepStrictEqual(peer.channelReliabilities[0], { ordered: true })
    })

    test('custom reliability is forwarded to createDataChannel', () => {
        const signalClient = new MockSignalClient()
        const peer = new MockPeer()
        const adapters: RTCAdapters = {
            createPeerConnection() { return peer },
            createSignalingClient() { return signalClient as AnyClient },
        }
        const channelReliability: ChannelReliability = { ordered: false, maxRetransmits: 0 }
        const neg = new PeerNegotiator(adapters, 'ws://signal:9000', 'rivalis', channelReliability)
        neg.connect('t', callbacks)
        signalClient.emit('signal:welcome', encodeWelcome('peer-1', 'host-1'))

        assert.strictEqual(peer.channelReliabilities.length, 1)
        assert.deepStrictEqual(peer.channelReliabilities[0], { ordered: false, maxRetransmits: 0 })
    })

})

// ---------------------------------------------------------------------------
// HostNegotiator tests
// ---------------------------------------------------------------------------

suite('HostNegotiator', () => {

    const cb: HostNegotiatorCallbacks = { onChannel: () => {}, onPeerStateChange: () => {} }

    test('signal:offer with from → creates PC + setRemoteDescription("offer") + setLocalDescription("answer")', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0\r\n...offer', 'peer-1'))
        const pc = peers[0]!
        assert.strictEqual(pc.remoteDescriptions.length, 1)
        assert.strictEqual(pc.remoteDescriptions[0]!.sdp, 'v=0\r\n...offer')
        assert.strictEqual(pc.remoteDescriptions[0]!.type, 'offer')
        assert.strictEqual(pc.localDescriptionCalls.length, 1)
        assert.strictEqual(pc.localDescriptionCalls[0]!.type, 'answer')
    })

    test('signal:offer without from → ignored', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        // Encode with no 'from' field
        signalClient.emit('signal:offer', testCodec.encode('Offer', { to: 'host-1', sdp: 'v=0' }))
        assert.strictEqual(peers[0]!.remoteDescriptions.length, 0)
    })

    test('signal:offer with empty sdp → ignored', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', testCodec.encode('Offer', { to: 'host-1', from: 'peer-1' }))
        assert.strictEqual(peers[0]!.remoteDescriptions.length, 0)
    })

    test('onLocalDescription("answer") → sends signal:answer {to=peerId, sdp, from=myId}', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        peers[0]!.emitLocalDescription('v=0\r\n...answer', 'answer')
        const sent = signalClient.sent.find(s => s.topic === 'signal:answer')
        assert.ok(sent, 'signal:answer must be sent')
        const d = decodeSentAnswer(sent.payload)
        assert.strictEqual(d.to, 'peer-1')
        assert.strictEqual(d.sdp, 'v=0\r\n...answer')
        assert.strictEqual(d.from, 'host-1')
    })

    test('onLocalDescription("offer") → not forwarded (only "answer" type triggers signal:answer)', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        peers[0]!.emitLocalDescription('v=0', 'offer')
        assert.strictEqual(signalClient.sent.filter(s => s.topic === 'signal:answer').length, 0)
    })

    test('onLocalCandidate → sends signal:ice {to=peerId, JSON candidate, from=myId}', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        peers[0]!.emitLocalCandidate('candidate:host123', '0')
        const sent = signalClient.sent.find(s => s.topic === 'signal:ice')
        assert.ok(sent)
        const d = decodeSentIce(sent.payload)
        assert.strictEqual(d.to, 'peer-1')
        assert.strictEqual(d.from, 'host-1')
        assert.ok(d.candidate.includes('candidate:host123'))
    })

    test('signal:ice with known peerId → routes addRemoteCandidate to correct PC', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-2'))
        signalClient.emit('signal:ice', encodeIce('host-1', 'candidate:p2', '0', 'peer-2'))
        assert.strictEqual(peers[0]!.remoteCandidates.length, 0, 'peer-1 PC not touched')
        assert.strictEqual(peers[1]!.remoteCandidates.length, 1)
        assert.strictEqual(peers[1]!.remoteCandidates[0]!.candidate, 'candidate:p2')
    })

    test('signal:ice with unknown peerId → safely ignored', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        assert.doesNotThrow(() =>
            signalClient.emit('signal:ice', encodeIce('host-1', 'candidate:x', '0', 'no-such-peer'))
        )
        assert.strictEqual(peers[0]!.remoteCandidates.length, 0)
    })

    test('DC inbound (onDataChannel) → fires onChannel(dc, peerId)', () => {
        const opened: Array<{ dc: RTCDataChannelLike; peerId: string }> = []
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], {
            onChannel: (dc, peerId) => opened.push({ dc, peerId }),
            onPeerStateChange: () => {},
        })
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        const inbound = new MockDataChannel()
        peers[0]!.emitDataChannel(inbound)
        assert.strictEqual(opened.length, 1)
        assert.strictEqual(opened[0]!.dc, inbound)
        assert.strictEqual(opened[0]!.peerId, 'peer-1')
    })

    test('PC state change → fires onPeerStateChange(peerId, state)', () => {
        const events: Array<{ peerId: string; state: string }> = []
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], {
            onChannel: () => {},
            onPeerStateChange: (peerId, state) => events.push({ peerId, state }),
        })
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        peers[0]!.emitState('disconnected')
        assert.deepStrictEqual(events, [{ peerId: 'peer-1', state: 'disconnected' }])
    })

    test('iceServers from initialize() are passed to createPeerConnection', () => {
        const signalClient = new MockSignalClient()
        const captured: RTCConfiguration[] = []
        const adapters: RTCAdapters = {
            createPeerConnection(config) { captured.push(config); return new MockPeer() },
            createSignalingClient() { return signalClient as AnyClient },
        }
        const neg = new HostNegotiator(adapters, signalClient as AnyClient)
        const iceServers: RTCIceServer[] = [{ urls: 'stun:s.example.com' }]
        neg.initialize('host-1', iceServers, cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        assert.strictEqual(captured.length, 1)
        assert.deepStrictEqual(captured[0]!.iceServers, iceServers)
    })

    test('closePeer → closes and removes the PC; subsequent ICE for that peer is ignored', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        neg.closePeer('peer-1')
        assert.ok(peers[0]!.closed)
        // Ice for the now-closed peer must not throw
        assert.doesNotThrow(() =>
            signalClient.emit('signal:ice', encodeIce('host-1', 'candidate:x', '0', 'peer-1'))
        )
    })

    test('closePeer with unknown id → no throw', () => {
        const { neg } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        assert.doesNotThrow(() => neg.closePeer('no-such-peer'))
    })

    test('dispose() → closes all peer PCs', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-2'))
        neg.dispose()
        assert.ok(peers[0]!.closed)
        assert.ok(peers[1]!.closed)
    })

    test('dispose() then closePeer → no throw (map is empty)', () => {
        const { neg, signalClient } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'v=0', 'peer-1'))
        neg.dispose()
        assert.doesNotThrow(() => neg.closePeer('peer-1'))
    })

    test('two concurrent peers each get their own PC', () => {
        const { neg, signalClient, peers } = makeHostNeg()
        neg.initialize('host-1', [], cb)
        signalClient.emit('signal:offer', encodeOffer('host-1', 'sdp-a', 'peer-a'))
        signalClient.emit('signal:offer', encodeOffer('host-1', 'sdp-b', 'peer-b'))
        assert.strictEqual(peers[0]!.remoteDescriptions[0]!.sdp, 'sdp-a')
        assert.strictEqual(peers[1]!.remoteDescriptions[0]!.sdp, 'sdp-b')
    })

})

// ---------------------------------------------------------------------------
// RTCAdapters interface smoke tests
// ---------------------------------------------------------------------------

suite('RTCAdapters interface', () => {

    test('createPeerConnection receives the config', () => {
        const peer = new MockPeer()
        let received: RTCConfiguration | null = null
        const adapters: RTCAdapters = {
            createPeerConnection(config) { received = config; return peer },
            createSignalingClient() { return new MockSignalClient() as AnyClient },
        }
        const cfg = { iceServers: [{ urls: 'stun:s.example.com' }] }
        assert.strictEqual(adapters.createPeerConnection(cfg), peer)
        assert.deepStrictEqual(received, cfg)
    })

    test('createSignalingClient receives the URL and is stored on PeerNegotiator', () => {
        const sc = new MockSignalClient()
        let passedUrl = ''
        const adapters: RTCAdapters = {
            createPeerConnection() { return new MockPeer() },
            createSignalingClient(url) { passedUrl = url; return sc as AnyClient },
        }
        const neg = new PeerNegotiator(adapters, 'ws://sig:9000')
        assert.strictEqual(neg.signalClient as unknown, sc)
        assert.strictEqual(passedUrl, 'ws://sig:9000')
    })

})
