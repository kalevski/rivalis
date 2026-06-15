/**
 * RTCPeerLike / RTCDataChannelLike — the canonical adapter interfaces that
 * decouple RTCTransport and RTCClient from any concrete WebRTC library (§4.5).
 *
 * Default implementation: node-datachannel (prebuilt native binary, libdatachannel).
 * Dev/CI fallback:        werift           (pure TypeScript, no native build),
 *                         enabled by setting RIVALIS_WEBRTC_BACKEND=werift.
 *                         WeriftPeer is a full adapter (Phase 4, p2p.md §12).
 *
 * Neither RTCTransport nor RTCClient imports a library name directly — they
 * receive a createPeerConnection factory (§4.5 RTCAdapters) and remain
 * completely library-agnostic.
 *
 * Decision D4 — decided 2026-06-09. See node/CHANGELOG.md for full rationale.
 */

import logging from '@toolcase/logging'

import type { PeerConnection, DataChannel, DescriptionType } from 'node-datachannel'

// ---------------------------------------------------------------------------
// Adapter interfaces — programmed against throughout @rivalis/node
// ---------------------------------------------------------------------------

/**
 * Per-channel reliability settings (p2p.md §7).
 *
 * Default `{ ordered: true }` ≈ WebSocket semantics (safe drop-in; correct for
 * `ttt`/`counter`/`lobby`). Use `{ ordered: false, maxRetransmits: 0 }` for
 * high-rate state (e.g. `arena`, ARENA_TICK_HZ=30) where the newest snapshot
 * supersedes lost frames. Phase 1 uses a single reliable channel for parity.
 */
export type ChannelReliability = {
    ordered: boolean
    /** When set, the channel retransmits at most this many times (unreliable mode). */
    maxRetransmits?: number
}

export interface RTCDataChannelLike {
    /** Register the message handler. Called once, before the channel opens. */
    onMessage(cb: (buf: Uint8Array) => void): void
    onOpen(cb: () => void): void
    onClose(cb: () => void): void
    sendBinary(buf: Uint8Array): void
    close(): void
    readonly isOpen: boolean
    /** Bytes currently queued for delivery (analog of WebSocket.bufferedAmount). */
    readonly bufferedAmount: number
    /** The channel's label (e.g. 'rivalis' for the reliable channel, 'rivalis:unreliable' for the unreliable channel). */
    readonly label: string
}

export interface RTCPeerLike {
    /** Create an outbound data channel (caller is the initiating side). */
    createDataChannel(label: string, reliability: ChannelReliability): RTCDataChannelLike
    /** Receive an inbound data channel (answering side). */
    onDataChannel(cb: (channel: RTCDataChannelLike) => void): void
    /** Connection state changes: 'connected' | 'disconnected' | 'failed' | 'closed'. */
    onStateChange(cb: (state: string) => void): void
    onLocalDescription(cb: (sdp: string, type: string) => void): void
    onLocalCandidate(cb: (candidate: string, mid: string) => void): void
    setLocalDescription(type?: string): void
    setRemoteDescription(sdp: string, type: string): void
    addRemoteCandidate(candidate: string, mid: string): void
    close(): void
}

// ---------------------------------------------------------------------------
// Factory — selects backend via RIVALIS_WEBRTC_BACKEND env var
// ---------------------------------------------------------------------------

/**
 * Create a new peer connection using the configured backend.
 *
 *   RIVALIS_WEBRTC_BACKEND=node-datachannel  (default) prebuilt native binary
 *   RIVALIS_WEBRTC_BACKEND=werift            pure TypeScript, no native build
 */
export function createPeerConnection(config: RTCConfiguration): RTCPeerLike {
    const backend = process.env['RIVALIS_WEBRTC_BACKEND'] ?? 'node-datachannel'
    if (backend === 'werift') {
        return new WeriftPeer(config)
    }
    return new NodeDataChannelPeer(config)
}

// ---------------------------------------------------------------------------
// node-datachannel adapter (default — D4)
// ---------------------------------------------------------------------------

export class NodeDCDataChannel implements RTCDataChannelLike {
    constructor(private readonly dc: DataChannel) {}

    onMessage(cb: (buf: Uint8Array) => void): void {
        this.dc.onMessage((msg) => {
            if (msg instanceof Buffer) {
                cb(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength))
            } else {
                cb(new TextEncoder().encode(msg as string))
            }
        })
    }

    onOpen(cb: () => void): void { this.dc.onOpen(cb) }
    onClose(cb: () => void): void { this.dc.onClosed(cb) }

    sendBinary(buf: Uint8Array): void {
        this.dc.sendMessageBinary(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
    }

    close(): void { this.dc.close() }

    get isOpen(): boolean { return this.dc.isOpen() }

    get bufferedAmount(): number { return this.dc.bufferedAmount() }

    get label(): string { return this.dc.getLabel() }
}

export class NodeDataChannelPeer implements RTCPeerLike {
    private readonly pc: PeerConnection

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: RTCConfiguration, ndc?: any) {
        const lib = ndc ?? requireNodeDataChannel()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const options: Record<string, any> = { iceServers: mapIceServers(config) }
        if (config.iceTransportPolicy) options['iceTransportPolicy'] = config.iceTransportPolicy
        this.pc = new lib.PeerConnection('', options)
    }

    createDataChannel(label: string, reliability: ChannelReliability): RTCDataChannelLike {
        const opts: { ordered: boolean; maxRetransmits?: number } = { ordered: reliability.ordered }
        if (reliability.maxRetransmits !== undefined) {
            opts.maxRetransmits = reliability.maxRetransmits
        }
        return new NodeDCDataChannel(this.pc.createDataChannel(label, opts))
    }

    onDataChannel(cb: (channel: RTCDataChannelLike) => void): void {
        this.pc.onDataChannel((dc) => cb(new NodeDCDataChannel(dc)))
    }

    onStateChange(cb: (state: string) => void): void {
        this.pc.onConnectionStateChange(cb)
    }

    onLocalDescription(cb: (sdp: string, type: string) => void): void {
        this.pc.onLocalDescription(cb)
    }

    onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
        this.pc.onLocalCandidate(cb)
    }

    setLocalDescription(type?: string): void {
        this.pc.setLocalDescription(type as DescriptionType | undefined)
    }

    setRemoteDescription(sdp: string, type: string): void {
        this.pc.setRemoteDescription(sdp, type as DescriptionType)
    }

    addRemoteCandidate(candidate: string, mid: string): void {
        this.pc.addRemoteCandidate(candidate, mid)
    }

    close(): void { this.pc.close() }
}

// ---------------------------------------------------------------------------
// werift adapter (dev/CI fallback — Phase 4, p2p.md §12)
//
// Pure-TypeScript WebRTC — no native build required. Selected by setting
// RIVALIS_WEBRTC_BACKEND=werift. werift must be installed as an optional dep:
//   npm install werift
//
// Design notes:
//  • werift's RTCPeerConnection API is async (createOffer/createAnswer/
//    setLocalDescription/setRemoteDescription/addIceCandidate return Promises).
//    The RTCPeerLike interface is synchronous, so operations are serialised via
//    an internal promise queue (_enqueue). Back-to-back calls like
//      pc.setRemoteDescription(offer)
//      pc.setLocalDescription('answer')
//    are safe because _enqueue chains them; the answer is only created after
//    the offer is fully applied.
//  • onLocalDescription fires after setLocalDescription resolves and the SDP
//    is available. ICE candidates trickle in via onicecandidate.
//  • The adapter is intentionally not exported from RTCPeer.ts in a way that
//    forces callers to depend on werift types; all werift objects are typed as
//    `any` (the module is lazily required).
// ---------------------------------------------------------------------------

/** werift RTCDataChannel wrapped as RTCDataChannelLike. */
export class WeriftDataChannel implements RTCDataChannelLike {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly dc: any) {}

    onMessage(cb: (buf: Uint8Array) => void): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.dc.onmessage = (event: any) => {
            const data: unknown = event.data
            if (Buffer.isBuffer(data)) {
                cb(new Uint8Array((data as Buffer).buffer, (data as Buffer).byteOffset, (data as Buffer).byteLength))
            } else if (data instanceof Uint8Array) {
                cb(data)
            } else if (data instanceof ArrayBuffer) {
                cb(new Uint8Array(data))
            } else if (typeof data === 'string') {
                cb(new TextEncoder().encode(data))
            }
        }
    }

    onOpen(cb: () => void): void { this.dc.onopen = cb }
    onClose(cb: () => void): void { this.dc.onclose = cb }

    sendBinary(buf: Uint8Array): void {
        // werift accepts Uint8Array directly
        this.dc.send(buf)
    }

    close(): void { this.dc.close() }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    get isOpen(): boolean { return this.dc.readyState === 'open' }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    get bufferedAmount(): number { return this.dc.bufferedAmount as number }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    get label(): string { return this.dc.label as string }
}

/** werift RTCPeerConnection wrapped as RTCPeerLike. */
export class WeriftPeer implements RTCPeerLike {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly pc: any
    /** Serialise the async werift calls so synchronous back-to-back calls chain correctly. */
    private opQueue: Promise<void> = Promise.resolve()
    private readonly logger = logging.getLogger('peer:werift')
    private _localDescHandler: ((sdp: string, type: string) => void) | null = null
    private _localCandHandler: ((candidate: string, mid: string) => void) | null = null

    constructor(config: RTCConfiguration) {
        const werift = requireWerift()
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.pc = new werift.RTCPeerConnection(config)
        // Wire ICE candidate gathering immediately so candidates produced during
        // setLocalDescription are captured regardless of when onLocalCandidate is called.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.pc.onicecandidate = (event: any) => {
            // event.candidate is null when ICE gathering is complete
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const cand = event?.candidate
            if (!cand || !cand.candidate) return
            const candidate = String(cand.candidate)
            const mid = String(cand.sdpMid ?? '0')
            this._localCandHandler?.(candidate, mid)
        }
    }

    createDataChannel(label: string, reliability: ChannelReliability): RTCDataChannelLike {
        const opts: Record<string, unknown> = { ordered: reliability.ordered }
        if (reliability.maxRetransmits !== undefined) {
            opts['maxRetransmits'] = reliability.maxRetransmits
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        return new WeriftDataChannel(this.pc.createDataChannel(label, opts))
    }

    onDataChannel(cb: (channel: RTCDataChannelLike) => void): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.pc.ondatachannel = (event: any) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            cb(new WeriftDataChannel(event.channel))
        }
    }

    onStateChange(cb: (state: string) => void): void {
        this.pc.onconnectionstatechange = () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            cb(String(this.pc.connectionState))
        }
    }

    onLocalDescription(cb: (sdp: string, type: string) => void): void {
        this._localDescHandler = cb
    }

    onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
        this._localCandHandler = cb
    }

    setLocalDescription(type?: string): void {
        this._enqueue('setLocalDescription', async () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            const desc: { sdp?: string; type: string } = (!type || type === 'offer')
                ? await this.pc.createOffer()
                : await this.pc.createAnswer()
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            await this.pc.setLocalDescription(desc)
            if (desc.sdp && this._localDescHandler) {
                this._localDescHandler(desc.sdp, desc.type || type || 'offer')
            }
        })
    }

    setRemoteDescription(sdp: string, type: string): void {
        this._enqueue('setRemoteDescription', async () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            await this.pc.setRemoteDescription({ sdp, type })
        })
    }

    addRemoteCandidate(candidate: string, mid: string): void {
        this._enqueue('addRemoteCandidate', async () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            await this.pc.addIceCandidate({ candidate, sdpMid: mid })
        })
    }

    close(): void {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.pc.close()
    }

    private _enqueue(op: string, fn: () => Promise<void>): void {
        this.opQueue = this.opQueue.then(fn).catch((error: unknown) => {
            // Errors in the queue are suppressed — the connection will time out
            // naturally. This matches node-datachannel's behaviour where a failed
            // negotiation step does not crash the process. We still log the failure
            // so a malformed (possibly attacker-supplied) SDP/ICE or a real bug is
            // diagnosable instead of silently producing a dead connection.
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.warning(`negotiation step "${op}" failed: ${reason}`)
        })
    }
}

// ---------------------------------------------------------------------------
// Lazy loaders — keep native/optional deps out of the module load path
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireNodeDataChannel(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('node-datachannel')
    } catch {
        throw new Error(
            '[rivalis/node] node-datachannel is not installed. ' +
            'Run: npm install node-datachannel'
        )
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireWerift(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('werift')
    } catch {
        throw new Error(
            '[rivalis/node] werift is not installed. ' +
            'Run: npm install werift  — or unset RIVALIS_WEBRTC_BACKEND.'
        )
    }
}

// ---------------------------------------------------------------------------
// ICE server mapping helper
// ---------------------------------------------------------------------------

function mapIceServers(config: RTCConfiguration): Array<{ hostname: string; port: number; username?: string; password?: string; relayType?: string }> {
    return (config.iceServers ?? []).flatMap((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
        return urls.map((url) => ({
            hostname: extractHostname(url),
            port: extractPort(url),
            username: s.username as string | undefined,
            password: s.credential as string | undefined,
            relayType: url.startsWith('turn:') ? 'TurnUdp' : url.startsWith('turns:') ? 'TurnTls' : undefined,
        }))
    })
}

function extractHostname(url: string): string {
    return url.replace(/^(stuns?|turns?):\/?\/?/i, '').split(/[:?/]/)[0] ?? ''
}

function extractPort(url: string): number {
    const withoutScheme = url.replace(/^(stuns?|turns?):\/?\/?/i, '')
    const portStr = withoutScheme.split(':')[1]?.split(/[?/]/)[0]
    if (portStr != null && portStr !== '') return parseInt(portStr, 10)
    return url.startsWith('turns:') ? 5349 : 3478
}
