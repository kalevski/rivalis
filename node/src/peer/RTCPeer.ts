/**
 * RTCPeerLike / RTCDataChannelLike — the canonical adapter interfaces that
 * decouple RTCTransport and RTCClient from any concrete WebRTC library (§4.5).
 *
 * Default implementation: node-datachannel (prebuilt native binary, libdatachannel).
 * Dev/CI fallback:        werift           (pure TypeScript, no native build),
 *                         enabled by setting RIVALIS_WEBRTC_BACKEND=werift.
 *                         Full werift adapter ships in Phase 4 (p2p.md §12).
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

export interface RTCDataChannelLike {
    /** Register the message handler. Called once, before the channel opens. */
    onMessage(cb: (buf: Uint8Array) => void): void
    onOpen(cb: () => void): void
    onClose(cb: () => void): void
    sendBinary(buf: Uint8Array): void
    close(): void
    readonly isOpen: boolean
}

export interface RTCPeerLike {
    /** Create an outbound data channel (caller is the initiating side). */
    createDataChannel(label: string, ordered: boolean): RTCDataChannelLike
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
}

export class NodeDataChannelPeer implements RTCPeerLike {
    private readonly pc: PeerConnection

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: RTCConfiguration, ndc?: any) {
        const lib = ndc ?? requireNodeDataChannel()
        this.pc = new lib.PeerConnection('', {
            iceServers: mapIceServers(config),
        })
    }

    createDataChannel(label: string, ordered: boolean): RTCDataChannelLike {
        return new NodeDCDataChannel(this.pc.createDataChannel(label, { ordered }))
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
// werift stub (dev/CI fallback — Phase 4, p2p.md §12)
// Full implementation deferred; stub ensures the factory path exists and
// the package wires up cleanly before Phase 4 fills it in.
// ---------------------------------------------------------------------------

class WeriftPeer implements RTCPeerLike {
    constructor(_config: RTCConfiguration) {
        requireWerift() // verify package is installed before proceeding
        throw new Error(
            '[rivalis/node] werift backend is not yet fully implemented. ' +
            'Full adapter ships in Phase 4 (p2p.md §12). ' +
            'Unset RIVALIS_WEBRTC_BACKEND to use the default node-datachannel backend.'
        )
    }

    createDataChannel(_label: string, _ordered: boolean): RTCDataChannelLike { return null as never }
    onDataChannel(_cb: (channel: RTCDataChannelLike) => void): void {}
    onStateChange(_cb: (state: string) => void): void {}
    onLocalDescription(_cb: (sdp: string, type: string) => void): void {}
    onLocalCandidate(_cb: (candidate: string, mid: string) => void): void {}
    setLocalDescription(_type?: string): void {}
    setRemoteDescription(_sdp: string, _type: string): void {}
    addRemoteCandidate(_candidate: string, _mid: string): void {}
    close(): void {}
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
