/**
 * Native browser WebRTC adapters implementing RTCPeerLike / RTCDataChannelLike
 * (p2p.md §4.5 injection seam). Uses native RTCPeerConnection / RTCDataChannel —
 * no new runtime dependency.
 *
 * The adapter interfaces are redefined locally so @rivalis/browser has no
 * dependency on @rivalis/node. Both sets of interfaces are structurally
 * identical; conformance is verified by the RTCAdapters injection seam.
 *
 * Async operations (createOffer / createAnswer / setLocalDescription /
 * setRemoteDescription / addIceCandidate) are serialised on a promise queue so
 * callers can invoke setRemoteDescription + setLocalDescription back-to-back
 * (as NegotiationCore does) without hitting "no remote description" errors.
 */

// ── Adapter interfaces ────────────────────────────────────────────────────────
// Mirror of node/src/peer/RTCPeer.ts; defined locally to avoid a cross-package
// dependency.

export interface RTCDataChannelLike {
    onMessage(cb: (buf: Uint8Array) => void): void
    onOpen(cb: () => void): void
    onClose(cb: () => void): void
    sendBinary(buf: Uint8Array): void
    close(): void
    readonly isOpen: boolean
    /** Bytes currently queued for delivery (analog of WebSocket.bufferedAmount). */
    readonly bufferedAmount: number
}

export interface RTCPeerLike {
    createDataChannel(label: string, ordered: boolean): RTCDataChannelLike
    onDataChannel(cb: (channel: RTCDataChannelLike) => void): void
    onStateChange(cb: (state: string) => void): void
    onLocalDescription(cb: (sdp: string, type: string) => void): void
    onLocalCandidate(cb: (candidate: string, mid: string) => void): void
    setLocalDescription(type?: string): void
    setRemoteDescription(sdp: string, type: string): void
    addRemoteCandidate(candidate: string, mid: string): void
    close(): void
}

// ── NativeBrowserDataChannel ──────────────────────────────────────────────────

export class NativeBrowserDataChannel implements RTCDataChannelLike {
    constructor(private readonly dc: RTCDataChannel) {}

    onMessage(cb: (buf: Uint8Array) => void): void {
        this.dc.onmessage = (ev: MessageEvent) => {
            if (ev.data instanceof ArrayBuffer) {
                cb(new Uint8Array(ev.data))
            } else if (ev.data instanceof Uint8Array) {
                cb(ev.data)
            } else {
                cb(new TextEncoder().encode(String(ev.data)))
            }
        }
    }

    onOpen(cb: () => void): void {
        if (this.dc.readyState === 'open') {
            cb()
        } else {
            this.dc.onopen = () => cb()
        }
    }

    onClose(cb: () => void): void {
        this.dc.onclose = () => cb()
    }

    sendBinary(buf: Uint8Array): void {
        this.dc.send(buf)
    }

    close(): void {
        this.dc.close()
    }

    get isOpen(): boolean {
        return this.dc.readyState === 'open'
    }

    get bufferedAmount(): number {
        return this.dc.bufferedAmount
    }
}

// ── NativeBrowserPeer ─────────────────────────────────────────────────────────

export class NativeBrowserPeer implements RTCPeerLike {
    private readonly pc: RTCPeerConnection
    private localDescriptionCb: ((sdp: string, type: string) => void) | null = null
    // Serialise async SDP operations so setRemoteDescription + setLocalDescription
    // called back-to-back (as NegotiationCore does) execute in order.
    private opQueue: Promise<void> = Promise.resolve()

    constructor(config: RTCConfiguration) {
        this.pc = new RTCPeerConnection(config)
    }

    createDataChannel(label: string, ordered: boolean): RTCDataChannelLike {
        const dc = this.pc.createDataChannel(label, { ordered })
        return new NativeBrowserDataChannel(dc)
    }

    onDataChannel(cb: (channel: RTCDataChannelLike) => void): void {
        this.pc.ondatachannel = (ev) => cb(new NativeBrowserDataChannel(ev.channel))
    }

    onStateChange(cb: (state: string) => void): void {
        this.pc.onconnectionstatechange = () => cb(this.pc.connectionState)
    }

    onLocalDescription(cb: (sdp: string, type: string) => void): void {
        this.localDescriptionCb = cb
    }

    onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
        this.pc.onicecandidate = (ev) => {
            if (ev.candidate === null) return
            cb(ev.candidate.candidate, ev.candidate.sdpMid ?? '0')
        }
    }

    setLocalDescription(type?: string): void {
        const sdpType = type ?? 'offer'
        this.opQueue = this.opQueue
            .then(() => this.doSetLocalDescription(sdpType))
            .catch(() => { /* PC closed before async resolution */ })
    }

    private async doSetLocalDescription(type: string): Promise<void> {
        const desc = type === 'offer'
            ? await this.pc.createOffer()
            : await this.pc.createAnswer()
        await this.pc.setLocalDescription(desc)
        if (this.localDescriptionCb && desc.sdp) {
            this.localDescriptionCb(desc.sdp, type)
        }
    }

    setRemoteDescription(sdp: string, type: string): void {
        this.opQueue = this.opQueue
            .then(() => this.pc.setRemoteDescription(
                new RTCSessionDescription({ sdp, type: type as RTCSdpType })
            ))
            .catch(() => { /* PC closed before async resolution */ })
    }

    addRemoteCandidate(candidate: string, mid: string): void {
        this.opQueue = this.opQueue
            .then(() => this.pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid: mid })))
            .catch(() => { /* PC closed or candidate rejected */ })
    }

    close(): void {
        this.pc.close()
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createPeerConnection(config: RTCConfiguration): RTCPeerLike {
    return new NativeBrowserPeer(config)
}
