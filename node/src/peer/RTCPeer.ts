/**
 * RTCPeerLike / RTCDataChannelLike — the canonical adapter interfaces that
 * decouple RTCTransport and RTCClient from any concrete WebRTC library (§4.5).
 *
 * Implementation: node-datachannel (prebuilt native binary, libdatachannel).
 *
 * Neither RTCTransport nor RTCClient imports a library name directly — they
 * receive a createPeerConnection factory (§4.5 RTCAdapters) and remain
 * completely library-agnostic.
 *
 * Decision D4 — decided 2026-06-09. See node/CHANGELOG.md for full rationale.
 */

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
// Factory
// ---------------------------------------------------------------------------

/** Create a new peer connection backed by node-datachannel (prebuilt native binary). */
export function createPeerConnection(config: RTCConfiguration): RTCPeerLike {
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
        // disableAutoNegotiation: NegotiationCore drives negotiation explicitly
        // (createDataChannel / setRemoteDescription followed by an explicit
        // setLocalDescription, browser-RTCPeerConnection style). Without this,
        // node-datachannel auto-generates the offer inside createDataChannel and the
        // answer inside setRemoteDescription, which both races the onLocalDescription
        // handler registration and makes the later explicit setLocalDescription throw
        // ("Unexpected local description type ... in signaling state stable").
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const options: Record<string, any> = { iceServers: mapIceServers(config), disableAutoNegotiation: true }
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
        this.pc.onStateChange(cb)
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

// ---------------------------------------------------------------------------
// ICE server mapping helper
// ---------------------------------------------------------------------------

function mapIceServers(config: RTCConfiguration): Array<{ hostname: string; port: number; username?: string | undefined; password?: string | undefined; relayType?: string | undefined }> {
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
