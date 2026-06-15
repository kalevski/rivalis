/**
 * Shared isomorphic RTC negotiation core (p2p.md §4.5) — browser copy.
 *
 * Offer/answer/ICE state machine driven by injected RTCAdapters. No
 * environment-specific imports — adapters supply the concrete WebRTC
 * peer and signaling Client. Browser adapters inject native
 * RTCPeerConnection + browser WSClient; node adapters inject
 * node-datachannel + node WSClient (node/src/peer/NegotiationCore.ts).
 *
 * This file is structurally identical to node/src/peer/NegotiationCore.ts;
 * it exists as a local copy so @rivalis/browser has no dependency on
 * @rivalis/node. The two copies share the same SIGNAL_WIRE_MAJOR constant
 * and APPEND-ONLY field layout — any divergence is a bug.
 *
 * ── 'from' field in signal wire frames ───────────────────────────────────────
 * The @rivalis/signal relay passes offer/answer/ice payloads verbatim. Without a
 * sender identity field the host cannot route incoming ICE candidates to the
 * correct RTCPeerConnection when multiple peers negotiate concurrently. This core
 * appends a 'from' field (tag 3 — APPEND ONLY) to Offer, Answer, and IceCandidate
 * frames so the receiver can identify the sender without server-side injection.
 * Old decoders that lack tag 3 silently skip it; the relay's decodeRelayTo reads
 * only tag 1 ('to') and is unaffected.
 */

import type { Client } from '@rivalis/core'
import { createCodec, FieldType, present } from '@rivalis/handshake'
import type { RTCPeerLike, RTCDataChannelLike } from './RTCPeer'

// ── RTCAdapters — injection seam (p2p.md §4.5) ───────────────────────────────

/**
 * Environment-supplied factories that decouple the negotiation state machine
 * from any concrete WebRTC library or WebSocket client.
 *
 * browser: { native RTCPeerConnection,  browser WSClient }
 * node:    { NodeDataChannelPeer,        node    WSClient }
 */
export interface RTCAdapters {
    createPeerConnection(config: RTCConfiguration): RTCPeerLike
    createSignalingClient(url: string): Client
}

// ── Signal wire codec ─────────────────────────────────────────────────────────
// Local copy of the @rivalis/signal wire schema.
//
// APPEND-ONLY tag rule: field order within each type is the on-wire tag.
// Never reorder or remove — only append. Tags MUST stay in sync with
// @rivalis/signal/src/wire/index.ts and node/src/peer/NegotiationCore.ts.
// A breaking layout change requires bumping SIGNAL_WIRE_MAJOR and coordinating
// with @rivalis/signal.

const SIGNAL_WIRE_MAJOR = 1
const F = FieldType

const codec = createCodec({
    namespace: '@rivalis/browser/signal',
    major: SIGNAL_WIRE_MAJOR,
    schema: {
        Welcome: [
            { key: 'youId',      type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'hostId',     type: F.STRING, rule: 'optional' },  // tag 2
            { key: 'iceServers', type: F.STRING, rule: 'optional' },  // tag 3
        ],
        Offer: [
            { key: 'to',   type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'sdp',  type: F.STRING, rule: 'optional' },  // tag 2
            { key: 'from', type: F.STRING, rule: 'optional' },  // tag 3 — sender id
        ],
        Answer: [
            { key: 'to',   type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'sdp',  type: F.STRING, rule: 'optional' },  // tag 2
            { key: 'from', type: F.STRING, rule: 'optional' },  // tag 3 — sender id
        ],
        IceCandidate: [
            { key: 'to',        type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'candidate', type: F.STRING, rule: 'optional' },  // tag 2 — JSON RTCIceCandidateInit
            { key: 'from',      type: F.STRING, rule: 'optional' },  // tag 3 — sender id
        ],
        // APPEND ONLY — must stay in sync with @rivalis/signal/src/wire/index.ts
        HostElected: [
            { key: 'newHostId', type: F.STRING, rule: 'optional' },  // tag 1
        ],
    },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function iceToJson(candidate: string, mid: string): string {
    return JSON.stringify({ candidate, sdpMid: mid })
}

function iceFromJson(json: string): { candidate: string; mid: string } {
    try {
        const p = JSON.parse(json) as { candidate?: string; sdpMid?: string }
        return { candidate: p.candidate ?? '', mid: p.sdpMid ?? '0' }
    } catch {
        return { candidate: '', mid: '0' }
    }
}

function parseIceServers(json: string): RTCIceServer[] {
    try {
        return JSON.parse(json) as RTCIceServer[]
    } catch {
        return []
    }
}

// ── PeerNegotiator ────────────────────────────────────────────────────────────

export interface PeerNegotiatorCallbacks {
    onChannel: (channel: RTCDataChannelLike) => void
    onPeerStateChange: (state: string) => void
}

/**
 * Offer/answer/ICE state machine for the initiating (peer) side.
 * Used internally by RTCClient.
 *
 * Sequence:
 *   connect(ticket)
 *     → signal:welcome → create PC + DC + setLocalDescription('offer')
 *     → onLocalDescription(offer) → signal:offer {to:hostId, from:youId}
 *     → onLocalCandidate → signal:ice {to:hostId, from:youId}
 *     ← signal:answer → setRemoteDescription
 *     ← signal:ice → addRemoteCandidate
 *     → DC.onOpen → callbacks.onChannel(dc)
 */
export class PeerNegotiator {
    private pc: RTCPeerLike | null = null
    private youId: string = ''
    private hostId: string | null = null

    /** The signaling leg. RTCClient may listen on this for reconnect/kick events. */
    readonly signalClient: Client

    constructor(
        private readonly adapters: RTCAdapters,
        signalUrl: string,
        private readonly channelLabel: string = 'rivalis',
    ) {
        this.signalClient = adapters.createSignalingClient(signalUrl)
    }

    connect(ticket: string, callbacks: PeerNegotiatorCallbacks): void {
        const { onChannel, onPeerStateChange } = callbacks

        this.signalClient.on('signal:welcome', (payload: Uint8Array) => {
            const msg = codec.decode('Welcome', payload)
            this.youId = String(msg['youId'] ?? '')
            this.hostId = present(msg, 'hostId') && msg['hostId'] ? String(msg['hostId']) : null

            // Guard: if no host yet (we are the first — should not happen for a
            // pure peer) or if we are the host, skip offer.
            if (!this.hostId || this.hostId === this.youId) return

            const iceServers = parseIceServers(String(msg['iceServers'] ?? '[]'))
            const pc = this.adapters.createPeerConnection({ iceServers })
            this.pc = pc

            const dc = pc.createDataChannel(this.channelLabel, true)
            dc.onOpen(() => onChannel(dc))
            pc.onStateChange(onPeerStateChange)

            pc.onLocalDescription((sdp, type) => {
                if (type !== 'offer') return
                this.signalClient.send('signal:offer',
                    codec.encode('Offer', { to: this.hostId!, sdp, from: this.youId }))
            })

            pc.onLocalCandidate((candidate, mid) => {
                if (!this.hostId) return
                this.signalClient.send('signal:ice',
                    codec.encode('IceCandidate', {
                        to: this.hostId,
                        candidate: iceToJson(candidate, mid),
                        from: this.youId,
                    }))
            })

            pc.setLocalDescription('offer')
        })

        this.signalClient.on('signal:answer', (payload: Uint8Array) => {
            const msg = codec.decode('Answer', payload)
            if (!msg['sdp']) return
            this.pc?.setRemoteDescription(String(msg['sdp']), 'answer')
        })

        this.signalClient.on('signal:ice', (payload: Uint8Array) => {
            const msg = codec.decode('IceCandidate', payload)
            if (!msg['candidate']) return
            const { candidate, mid } = iceFromJson(String(msg['candidate']))
            if (!candidate) return
            this.pc?.addRemoteCandidate(candidate, mid)
        })

        // Host election (p2p.md §4.3, §12 Phase 3): update hostId so that any
        // subsequent ICE candidates are addressed to the newly elected host.
        // Full re-negotiation with the new host is driven by RTCClient's reconnect
        // loop once the previous WebRTC connection closes.
        this.signalClient.on('signal:host_elected', (payload: Uint8Array) => {
            const msg = codec.decode('HostElected', payload)
            if (msg['newHostId']) this.hostId = String(msg['newHostId'])
        })

        this.signalClient.connect(ticket)
    }

    disconnect(): void {
        this.pc?.close()
        this.pc = null
        this.signalClient.disconnect()
    }
}

// ── HostNegotiator ────────────────────────────────────────────────────────────
// Included for completeness (Phase 3 — browser-as-host). Not used by RTCClient.

export interface HostNegotiatorCallbacks {
    onChannel: (channel: RTCDataChannelLike, peerId: string) => void
    onPeerStateChange: (peerId: string, state: string) => void
}

/**
 * Offer/answer/ICE state machine for the answering (host) side.
 * Used by RTCTransport (Phase 3 browser-as-host, p2p.md §12).
 */
export class HostNegotiator {
    private readonly pcs = new Map<string, RTCPeerLike>()
    private myId: string = ''
    private iceServers: RTCIceServer[] = []

    constructor(
        private readonly adapters: RTCAdapters,
        private readonly signalClient: Client,
        private readonly channelLabel: string = 'rivalis',
    ) {}

    initialize(myId: string, iceServers: RTCIceServer[], callbacks: HostNegotiatorCallbacks): void {
        this.myId = myId
        this.iceServers = iceServers

        const { onChannel, onPeerStateChange } = callbacks

        this.signalClient.on('signal:offer', (payload: Uint8Array) => {
            const msg = codec.decode('Offer', payload)
            const peerId = present(msg, 'from') ? String(msg['from']) : ''
            if (!peerId || !msg['sdp']) return

            const pc = this.adapters.createPeerConnection({ iceServers: this.iceServers })
            this.pcs.set(peerId, pc)

            pc.onDataChannel(dc => onChannel(dc, peerId))
            pc.onStateChange(state => onPeerStateChange(peerId, state))

            pc.onLocalDescription((sdp, type) => {
                if (type !== 'answer') return
                this.signalClient.send('signal:answer',
                    codec.encode('Answer', { to: peerId, sdp, from: this.myId }))
            })

            pc.onLocalCandidate((candidate, mid) => {
                this.signalClient.send('signal:ice',
                    codec.encode('IceCandidate', {
                        to: peerId,
                        candidate: iceToJson(candidate, mid),
                        from: this.myId,
                    }))
            })

            pc.setRemoteDescription(String(msg['sdp']), 'offer')
            pc.setLocalDescription('answer')
        })

        this.signalClient.on('signal:ice', (payload: Uint8Array) => {
            const msg = codec.decode('IceCandidate', payload)
            const peerId = present(msg, 'from') ? String(msg['from']) : ''
            if (!peerId || !msg['candidate']) return
            const pc = this.pcs.get(peerId)
            if (!pc) return
            const { candidate, mid } = iceFromJson(String(msg['candidate']))
            if (!candidate) return
            pc.addRemoteCandidate(candidate, mid)
        })
    }

    closePeer(peerId: string): void {
        this.pcs.get(peerId)?.close()
        this.pcs.delete(peerId)
    }

    dispose(): void {
        for (const pc of this.pcs.values()) pc.close()
        this.pcs.clear()
    }
}
