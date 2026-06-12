/**
 * Shared isomorphic RTC negotiation core (p2p.md §4.5).
 *
 * Offer/answer/ICE state machine driven by injected RTCAdapters. No imports of
 * environment-specific libraries — adapters supply the concrete RTCPeerConnection
 * and signaling Client implementations. Both @rivalis/browser and @rivalis/node
 * supply adapters suited to their platform.
 *
 * Fleet precedent: FleetTransportClient.createClient injection
 * (fleet/src/agent/FleetAgent.ts:99 — createClient?: (url: string) => Client).
 *
 * ── 'from' field in signal wire frames ───────────────────────────────────────
 * The @rivalis/signal relay passes offer/answer/ice payloads verbatim. Without a
 * sender identity field the host cannot route incoming ICE candidates to the
 * correct RTCPeerConnection when multiple peers negotiate concurrently. This core
 * appends a 'from' field (tag 3 — APPEND ONLY) to Offer, Answer, and IceCandidate
 * frames so the receiver can identify the sender without server-side injection.
 * Old decoders that lack tag 3 in their schema silently skip it; the relay's
 * decodeRelayTo reads only tag 1 ('to') and is unaffected.
 */

import type { Client } from '@rivalis/core'
import { createCodec, FieldType, present } from '@rivalis/handshake'
import type { RTCPeerLike, RTCDataChannelLike, ChannelReliability } from './RTCPeer'

/** Default channel reliability: ordered delivery, no retransmit cap (p2p.md §7). */
const DEFAULT_RELIABILITY: ChannelReliability = { ordered: true }

// ── RTCAdapters — injection seam (p2p.md §4.5) ───────────────────────────────

/**
 * Environment-supplied factories that decouple the negotiation state machine from
 * any concrete WebRTC library or WebSocket client.
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
// @rivalis/signal/src/wire/index.ts. A breaking layout change requires bumping
// SIGNAL_WIRE_MAJOR and coordinating with @rivalis/signal.

const SIGNAL_WIRE_MAJOR = 1
const F = FieldType

const codec = createCodec({
    namespace: '@rivalis/node/signal',
    major: SIGNAL_WIRE_MAJOR,
    schema: {
        Welcome: [
            { key: 'youId',     type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'hostId',    type: F.STRING, rule: 'optional' },  // tag 2
            { key: 'iceServers',type: F.STRING, rule: 'optional' },  // tag 3
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
        private readonly channelReliability: ChannelReliability = DEFAULT_RELIABILITY,
        /**
         * When set, a second unreliable/unordered data channel with this label is opened
         * alongside the primary reliable channel (p2p.md §7, task 084).
         * Use `channelLabel + ':unreliable'` as the conventional label.
         */
        private readonly unreliableChannelLabel?: string,
    ) {
        this.signalClient = adapters.createSignalingClient(signalUrl)
    }

    connect(ticket: string, callbacks: PeerNegotiatorCallbacks): void {
        const { onChannel, onPeerStateChange } = callbacks

        this.signalClient.on('signal:welcome', (payload: Uint8Array) => {
            const msg = codec.decode('Welcome', payload)
            this.youId = String(msg['youId'] ?? '')
            this.hostId = present(msg, 'hostId') && msg['hostId'] ? String(msg['hostId']) : null

            // Guard: if no host yet (we are the first — should not happen for a pure peer)
            // or if we are the host, skip offer (RTCTransport handles that side).
            if (!this.hostId || this.hostId === this.youId) return

            const iceServers = parseIceServers(String(msg['iceServers'] ?? '[]'))
            const pc = this.adapters.createPeerConnection({ iceServers })
            this.pc = pc

            const dc = pc.createDataChannel(this.channelLabel, this.channelReliability)
            dc.onOpen(() => onChannel(dc))

            // Dual-channel: open a second unreliable/unordered channel for high-rate state (p2p.md §7).
            if (this.unreliableChannelLabel) {
                const unreliableDc = pc.createDataChannel(
                    this.unreliableChannelLabel,
                    { ordered: false, maxRetransmits: 0 },
                )
                unreliableDc.onOpen(() => onChannel(unreliableDc))
            }

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

export interface HostNegotiatorCallbacks {
    onChannel: (channel: RTCDataChannelLike, peerId: string) => void
    onPeerStateChange: (peerId: string, state: string) => void
}

/**
 * Admission-control limits applied at offer time, before a native PC is allocated
 * (task 040, p2p.md §8). The host side answers attacker-supplied offers, so PC
 * creation itself is a DoS surface: each unguarded `signal:offer` allocates a
 * native RTCPeerConnection keyed by the sender-supplied `from` id.
 */
export interface HostNegotiationGuardOptions {
    /**
     * Maximum number of simultaneous peer connections (in-negotiation or
     * connected). Offers that would push `pcs.size` past this cap are rejected
     * before any native PC is allocated. Default: {@link DEFAULT_MAX_CONCURRENT_NEGOTIATIONS}.
     */
    maxConcurrentNegotiations?: number
    /**
     * Window (ms) within which a freshly created PC must reach the `connected`
     * state. A PC that has not connected in time is closed and removed, freeing
     * the native resource an attacker would otherwise pin by flooding offers that
     * never complete ICE. A value `<= 0` disables the timeout (not recommended for
     * untrusted peers). Default: {@link DEFAULT_NEGOTIATION_TIMEOUT_MS}.
     */
    negotiationTimeoutMs?: number
}

/**
 * Default cap on concurrent host-side peer connections. Generous enough for real
 * deployments while bounding the native-PC count an offer flood can allocate.
 */
export const DEFAULT_MAX_CONCURRENT_NEGOTIATIONS = 1024

/**
 * Default negotiation timeout (ms). A PC that has not reached `connected` within
 * this window is closed and evicted. 15 s comfortably covers ICE gathering +
 * connectivity checks even on slow networks with TURN relaying.
 */
export const DEFAULT_NEGOTIATION_TIMEOUT_MS = 15_000

/**
 * Offer/answer/ICE state machine for the answering (host) side.
 * Used internally by RTCTransport.
 *
 * The signal client is provided already-constructed; RTCTransport creates it,
 * connects it, and calls initialize() once signal:welcome arrives (passing the
 * youId and iceServers from the welcome payload).
 *
 * Sequence (per incoming peer):
 *   signal:offer {from:peerId} → create PC + setRemoteDescription + setLocalDescription('answer')
 *   → onLocalDescription(answer) → signal:answer {to:peerId, from:myId}
 *   → onLocalCandidate → signal:ice {to:peerId, from:myId}
 *   ← signal:ice {from:peerId} → addRemoteCandidate on peerId's PC
 *   → DC.onDataChannel → callbacks.onChannel(dc, peerId)
 *
 * Offer-time admission control (task 040, p2p.md §8): before a native PC is
 * allocated, an offer is rejected if (a) the concurrency cap is reached or (b) the
 * `from` id already has a live PC (a duplicate must not clobber an in-progress
 * peer). Every created PC is armed with a negotiation timeout that closes and
 * removes it if `connected` is not reached in time.
 */
export class HostNegotiator {
    private readonly pcs = new Map<string, RTCPeerLike>()
    /** peerId → negotiation-timeout handle, cleared on connect/close/timeout. */
    private readonly negotiationTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private myId: string = ''
    private iceServers: RTCIceServer[] = []
    private callbacks: HostNegotiatorCallbacks | null = null
    private readonly maxConcurrentNegotiations: number
    private readonly negotiationTimeoutMs: number

    constructor(
        private readonly adapters: RTCAdapters,
        private readonly signalClient: Client,
        private readonly channelLabel: string = 'rivalis',
        guard: HostNegotiationGuardOptions = {},
    ) {
        this.maxConcurrentNegotiations =
            guard.maxConcurrentNegotiations ?? DEFAULT_MAX_CONCURRENT_NEGOTIATIONS
        this.negotiationTimeoutMs =
            guard.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS
    }

    /**
     * Wire up offer/ICE handlers after signal:welcome is received.
     * Must be called once before any peers attempt to connect.
     */
    initialize(myId: string, iceServers: RTCIceServer[], callbacks: HostNegotiatorCallbacks): void {
        this.myId = myId
        this.iceServers = iceServers
        this.callbacks = callbacks

        const { onChannel, onPeerStateChange } = callbacks

        this.signalClient.on('signal:offer', (payload: Uint8Array) => {
            const msg = codec.decode('Offer', payload)
            const peerId = present(msg, 'from') ? String(msg['from']) : ''
            if (!peerId || !msg['sdp']) return

            // ── Offer-time admission control (task 040) ──────────────────────
            // Reject BEFORE allocating a native PC so a flood of offers cannot
            // exhaust native resources. Both checks short-circuit cheaply.

            // Duplicate from-id: never overwrite an in-progress peer's PC. A later
            // offer reusing a live `from` is dropped; the existing PC is untouched.
            if (this.pcs.has(peerId)) return

            // Concurrency cap: bound the number of simultaneous native PCs.
            if (this.pcs.size >= this.maxConcurrentNegotiations) return

            const pc = this.adapters.createPeerConnection({ iceServers: this.iceServers })
            this.pcs.set(peerId, pc)
            this.armNegotiationTimeout(peerId)

            pc.onDataChannel(dc => onChannel(dc, peerId))
            pc.onStateChange(state => {
                // A connected PC has finished negotiating — cancel its timeout so
                // it is not torn down mid-session.
                if (state === 'connected') this.clearNegotiationTimer(peerId)
                onPeerStateChange(peerId, state)
            })

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

    /**
     * Arm the negotiation timeout for a freshly created PC. If the PC has not
     * reached `connected` when the timer fires, it is closed and removed and the
     * host is notified via onPeerStateChange so any partial transport state for
     * the peer is unwound. No-op when the timeout is disabled (`<= 0`).
     */
    private armNegotiationTimeout(peerId: string): void {
        if (this.negotiationTimeoutMs <= 0) return
        const timer = setTimeout(() => {
            this.negotiationTimers.delete(peerId)
            const stale = this.pcs.get(peerId)
            if (stale === undefined) return
            this.pcs.delete(peerId)
            stale.close()
            this.callbacks?.onPeerStateChange(peerId, 'failed')
        }, this.negotiationTimeoutMs)
        // Do not keep the event loop alive solely for a pending negotiation timer.
        timer.unref?.()
        this.negotiationTimers.set(peerId, timer)
    }

    /** Cancel and forget any pending negotiation timer for a peer. */
    private clearNegotiationTimer(peerId: string): void {
        const timer = this.negotiationTimers.get(peerId)
        if (timer === undefined) return
        clearTimeout(timer)
        this.negotiationTimers.delete(peerId)
    }

    /** Close and remove one peer's connection. Called by RTCTransport on DC close. */
    closePeer(peerId: string): void {
        this.clearNegotiationTimer(peerId)
        this.pcs.get(peerId)?.close()
        this.pcs.delete(peerId)
    }

    /** Close all peer connections. Called by RTCTransport.dispose(). */
    dispose(): void {
        for (const timer of this.negotiationTimers.values()) clearTimeout(timer)
        this.negotiationTimers.clear()
        for (const pc of this.pcs.values()) pc.close()
        this.pcs.clear()
    }
}
