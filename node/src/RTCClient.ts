/**
 * RTCClient — peer-side WebRTC Client (p2p.md §4.4).
 *
 * Extends Client<TTopics> (§3.2), API-identical to WSClient.
 *
 * Connect flow:
 *   connect(ticket) → PeerNegotiator.connect() → signal:welcome →
 *     create PC + DataChannel → offer → relay → answer → trickle ICE →
 *     DC open → send game ticket as first message (§4.2) → emit client:connect
 *
 * Kick: §3.4 __rivalis:close control frame → client:kicked { code, reason }.
 *   Same NO_RECONNECT_CODES gate as WSClient so reconnect logic works identically
 *   across transports.
 *
 * Reconnect: jittered exponential backoff; re-runs full negotiation per attempt,
 *   gated by NO_RECONNECT_CODES (INVALID_TICKET, KICKED, ROOM_REJECTED).
 *
 * Double-close guard: both RTCDataChannel.onClose and PC state-change (failed/
 *   disconnected/closed) can fire for the same lifecycle. The `disconnecting` flag
 *   ensures triggerDisconnect() fires exactly once.
 *
 * A new PeerNegotiator is created per negotiation attempt (not reused) because
 * PeerNegotiator.connect() registers persistent listeners on its internal signal
 * client and there is no removal path — re-creating avoids listener duplication.
 */

import { Client } from '@rivalis/core'
import type { ClientKickedEvent } from '@rivalis/core'
import { encode, decode, CloseCode, CLOSE_CONTROL_TOPIC, decodeCloseFrame } from '@rivalis/handshake'
import { createPeerConnection } from './peer/RTCPeer'
import type { RTCDataChannelLike } from './peer/RTCPeer'
import { PeerNegotiator } from './peer/NegotiationCore'
import type { RTCAdapters } from './peer/NegotiationCore'
import SignalClient from './SignalClient'
import {
    RTC_MAX_FRAME_BYTES,
    isChunkFrame,
    chunkFrame,
    decodeChunkPayload,
    ChunkReassembler,
    CHUNK_CONTROL_TOPIC,
} from './peer/RtcFrameChunker'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Close codes that are terminal for the reconnect loop (mirrors browser WSClient
 * NO_RECONNECT_CODES, browser/src/WSClient.ts:79-83). The §3.4 control frame
 * carries these codes over RTC so the gate works identically across transports.
 */
const NO_RECONNECT_CODES = new Set<number>([
    CloseCode.INVALID_TICKET,
    CloseCode.KICKED,
    CloseCode.ROOM_REJECTED,
])

const encoder = new TextEncoder()
const EMPTY_PAYLOAD = new Uint8Array()

// ── Options ───────────────────────────────────────────────────────────────────

/**
 * Callback that returns (or resolves to) a fresh auth ticket.
 * Required for short-lived tokens that may expire by the time a reconnect window
 * opens. If this throws/rejects the reconnect loop terminates with
 * `client:reconnect_failed`.
 */
export type GetTicketFn = () => string | Promise<string>

export type RTCClientReconnectOptions = {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
}

type ReconnectConfig = {
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
}

const RECONNECT_DEFAULTS: ReconnectConfig = {
    maxAttempts: Infinity,
    baseDelayMs: 500,
    maxDelayMs: 10000,
}

export type RTCClientOptions = {
    /**
     * Reconnect behavior. Set to `true` for defaults; pass an object to override
     * `maxAttempts`, `baseDelayMs`, and/or `maxDelayMs`. When omitted or `false`,
     * no automatic reconnect (caller layers its own policy, like fleet).
     */
    reconnect?: boolean | RTCClientReconnectOptions
    /**
     * Called before each reconnect attempt to fetch a fresh ticket.
     * The initial `connect(ticket)` call uses its argument verbatim; `getTicket`
     * only kicks in for subsequent reconnect attempts.
     */
    getTicket?: GetTicketFn
    /**
     * Adapter overrides for testing (p2p.md §4.5 injection seam).
     * Production callers omit this; defaults are node-datachannel + SignalClient.
     */
    adapters?: Partial<RTCAdapters>
    /** RTCDataChannel label. Default: 'rivalis' */
    channelLabel?: string
}

// ── RTCClient ─────────────────────────────────────────────────────────────────

class RTCClient<TTopics extends string = string> extends Client<TTopics> {

    private readonly signalUrl: string
    private readonly resolvedAdapters: RTCAdapters
    private readonly channelLabel: string
    private readonly reconnectConfig: ReconnectConfig | null
    private readonly getTicketFn: GetTicketFn | null

    /** Open data channel; null during negotiation, after close, and after disconnect. */
    private channel: RTCDataChannelLike | null = null
    /** Active PeerNegotiator; non-null during negotiation and while connected. */
    private negotiator: PeerNegotiator | null = null
    /** Ticket for the current or last connect(); needed to re-run negotiation on reconnect. */
    private lastTicket: string | null = null
    /** Set by disconnect() to suppress reconnect scheduling. */
    private userDisconnected = false
    /**
     * Code received via a §3.4 __rivalis:close control frame before the DC closes.
     * Consumed in triggerDisconnect() so the NO_RECONNECT_CODES gate sees it even
     * though RTCDataChannel carries no native close code.
     */
    private pendingCloseCode: number | null = null
    private reconnectAttempts = 0
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * Per-negotiation close guard. Prevents double-fire when both DC.onClose and
     * PC state-change (disconnected/failed/closed) trigger triggerDisconnect() for
     * the same lifecycle. Reset to false in startNegotiation().
     */
    private disconnecting = false
    /**
     * Outbound chunk sequence number (uint16, wraps at 65535).
     * Incremented each time a large frame is split into chunks (p2p.md §7).
     */
    private outboundSeq = 0
    /**
     * Inbound chunk reassembler.
     * Accumulates chunk fragments received from the host until the full frame arrives.
     */
    private readonly inboundReassembler = new ChunkReassembler()

    constructor(signalUrl: string, options: RTCClientOptions = {}) {
        super()
        this.signalUrl = signalUrl
        this.channelLabel = options.channelLabel ?? 'rivalis'
        this.reconnectConfig = this.resolveReconnect(options.reconnect)
        this.getTicketFn = options.getTicket ?? null
        this.resolvedAdapters = {
            createPeerConnection: options.adapters?.createPeerConnection ?? createPeerConnection,
            createSignalingClient: options.adapters?.createSignalingClient
                ?? ((url: string) => new SignalClient(url)),
        }
    }

    // ── Client contract ───────────────────────────────────────────────────────

    /**
     * `true` only while the data channel is OPEN — not during negotiation,
     * not during reconnect delay, not after disconnect.
     */
    override get connected(): boolean {
        return this.channel !== null && this.channel.isOpen
    }

    /**
     * Begin connecting. `ticket` is forwarded to @rivalis/signal for signal-room
     * auth AND sent as the first binary message on the data channel for game-host
     * auth (§4.2 ticket protocol — RTCTransport reads it as grantAccess input).
     *
     * No-op if negotiation is already in progress or the channel is open.
     */
    override connect(ticket = ''): void {
        if (this.negotiator !== null || this.channel !== null) {
            return
        }
        if (typeof ticket !== 'string') {
            throw new Error(`ticket must be a string, ${ticket} provided`)
        }
        this.cancelReconnect()
        this.userDisconnected = false
        this.reconnectAttempts = 0
        this.lastTicket = ticket
        this.startNegotiation(ticket)
    }

    /** Terminate the connection and suppress all future reconnect attempts. */
    override disconnect(): void {
        this.userDisconnected = true
        this.cancelReconnect()
        this.lastTicket = null
        this.pendingCloseCode = null
        const wasActive = this.negotiator !== null || this.channel !== null
        this.disconnecting = true
        this.channel = null
        this.inboundReassembler.clear()
        this.closeNegotiation()
        if (wasActive) {
            this.emit('client:disconnect', encoder.encode('terminated'))
        }
    }

    /**
     * Encode a handshake frame and send it over the open data channel.
     * Guards on `channel.isOpen !== true` — drops silently (mirrors WSClient
     * browser/src/WSClient.ts:184, core/src/clients/WSClient.ts:135).
     *
     * Large frames (> RTC_MAX_FRAME_BYTES) are split into chunk messages so they
     * survive the WebRTC SCTP ceiling (p2p.md §7). The host reassembles chunks
     * transparently before passing them to the Room.
     */
    override send(topic: string, payload: Uint8Array | string = EMPTY_PAYLOAD): void {
        if (this.channel === null || !this.channel.isOpen) {
            return
        }
        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }
        const bytes = payload instanceof Uint8Array ? payload : encoder.encode(payload)
        const frame = encode(topic, bytes)
        if (frame.byteLength <= RTC_MAX_FRAME_BYTES) {
            try { this.channel.sendBinary(frame) } catch { /* channel closed */ }
            return
        }
        // Frame exceeds the RTC ceiling — chunk and send (p2p.md §7).
        const seq = this.outboundSeq
        this.outboundSeq = (this.outboundSeq + 1) & 0xFFFF
        let chunks: Uint8Array[]
        try {
            chunks = chunkFrame(frame, seq)
        } catch {
            // Frame is too large even for 255 chunks — log and drop (never silently truncate).
            // RTCDataChannel carries no way to surface a send error to the Room, so we
            // drop here and rely on the maxFrameBytes capability for the caller to pre-split.
            return
        }
        const channel = this.channel
        for (const chunk of chunks) {
            if (!channel.isOpen) break
            try { channel.sendBinary(chunk) } catch { break }
        }
    }

    // ── Internal negotiation ──────────────────────────────────────────────────

    private startNegotiation(ticket: string): void {
        this.disconnecting = false
        this.outboundSeq = 0
        this.inboundReassembler.clear()

        // Create a fresh PeerNegotiator per attempt — reusing one would duplicate
        // the persistent event listeners registered in PeerNegotiator.connect().
        const negotiator = new PeerNegotiator(this.resolvedAdapters, this.signalUrl, this.channelLabel)
        this.negotiator = negotiator

        // Forward signal-level errors and kicks that arrive before the DC opens.
        negotiator.signalClient.on('client:kicked', (info: ClientKickedEvent) => {
            this.pendingCloseCode = info.code
            this.emit('client:kicked', info)
        })
        negotiator.signalClient.on('client:error', (error: Error) => {
            this.emit('client:error', error)
        })
        // If the signal server disconnects before the DC opens, trigger reconnect
        // immediately rather than waiting for the ICE timeout (which can take 10–30 s).
        negotiator.signalClient.on('client:disconnect', () => {
            if (this.channel === null) {
                this.triggerDisconnect()
            }
        })

        negotiator.connect(ticket, {
            onChannel:         (dc)    => this.onChannelOpen(dc, ticket),
            onPeerStateChange: (state) => this.onPeerStateChange(state),
        })
    }

    // ── DC open ───────────────────────────────────────────────────────────────

    private onChannelOpen(channel: RTCDataChannelLike, ticket: string): void {
        this.channel = channel

        // Register handlers before sending — no async event can fire during this
        // synchronous onOpen callback, so registration is safe before sendBinary.
        channel.onMessage((buf) => this.onMessage(buf))
        channel.onClose(()      => this.triggerDisconnect())

        // §4.2 ticket protocol: RTCTransport reads the first binary message as
        // the peer's game-room auth ticket and calls grantAccess before switching
        // to normal game-frame forwarding.
        channel.sendBinary(encoder.encode(ticket))

        this.emit('client:connect')
    }

    // ── Inbound message ───────────────────────────────────────────────────────

    private onMessage(buf: Uint8Array): void {
        // Chunk reassembly (p2p.md §7): detect chunk frames by their topic-field
        // prefix without decoding, then accumulate until the full frame is ready.
        if (isChunkFrame(buf)) {
            const { payload } = decode(buf)
            const parsed = decodeChunkPayload(payload)
            if (parsed === null) return  // malformed chunk — discard
            const complete = this.inboundReassembler.feed(
                parsed.seq, parsed.total, parsed.index, parsed.data,
            )
            if (complete === null) return  // waiting for remaining chunks
            this.dispatchFrame(complete)
            return
        }
        this.dispatchFrame(buf)
    }

    private dispatchFrame(buf: Uint8Array): void {
        const { topic, payload } = decode(buf)
        // §3.4: intercept transport-agnostic close/kick control frame so the
        // NO_RECONNECT_CODES gate works identically to the WS path. RTCTransport
        // sends this frame immediately before closing the DC so client:kicked
        // arrives before the DC close event.
        if (topic === CLOSE_CONTROL_TOPIC) {
            const { code, reason } = decodeCloseFrame(payload)
            this.pendingCloseCode = code
            this.emit('client:kicked', { code, reason } satisfies ClientKickedEvent)
            return
        }
        // Guard against the chunk topic leaking to the user layer (shouldn't happen,
        // but belt-and-suspenders: a chunk frame received via isChunkFrame goes through
        // reassembly above; a stray __rivalis:chunk with non-chunk prefix can't occur).
        if (topic === CHUNK_CONTROL_TOPIC) return
        this.emit(topic, payload)
    }

    // ── Close & reconnect ─────────────────────────────────────────────────────

    private onPeerStateChange(state: string): void {
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            // PC failure/closure — may fire before or alongside DC.onClose.
            // triggerDisconnect() is guarded against double-fire.
            this.triggerDisconnect()
        }
    }

    /**
     * Single entry point for all non-user-initiated close paths:
     *   - DC.onClose (after DC opened)
     *   - PC state-change: disconnected / failed / closed
     *   - Signal disconnect before DC opened
     *
     * Guarded by the `disconnecting` flag so it fires exactly once per
     * negotiation lifecycle regardless of which event arrives first.
     */
    private triggerDisconnect(): void {
        if (this.disconnecting) return
        this.disconnecting = true

        this.channel = null
        this.closeNegotiation()

        if (this.userDisconnected) return

        const pendingCode = this.pendingCloseCode
        this.pendingCloseCode = null
        // Use the control-frame code when present (p2p.md §3.4); fall back to
        // 1000 (normal close) when no control frame was received.
        const effectiveCode = pendingCode ?? 1000

        this.emit('client:disconnect', EMPTY_PAYLOAD)

        if (this.shouldReconnect(effectiveCode)) {
            this.scheduleReconnect()
        } else if (this.reconnectExhausted()) {
            this.emit('client:reconnect_failed')
        }
    }

    private closeNegotiation(): void {
        const neg = this.negotiator
        this.negotiator = null
        // disconnect() closes the PC and the signal WS; the resulting
        // signalClient 'client:disconnect' emission is harmless because
        // this.disconnecting is already true.
        neg?.disconnect()
    }

    private shouldReconnect(code: number): boolean {
        if (this.userDisconnected) return false
        if (this.reconnectConfig === null) return false
        if (this.lastTicket === null && this.getTicketFn === null) return false
        if (NO_RECONNECT_CODES.has(code)) return false
        if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) return false
        return true
    }

    private reconnectExhausted(): boolean {
        if (this.userDisconnected) return false
        if (this.reconnectConfig === null) return false
        if (this.reconnectAttempts === 0) return false
        return this.reconnectAttempts >= this.reconnectConfig.maxAttempts
    }

    private scheduleReconnect(): void {
        if (this.reconnectConfig === null) return
        const delay = this.computeBackoff(this.reconnectAttempts)
        this.reconnectAttempts += 1
        this.emit('client:reconnecting', encoder.encode(String(this.reconnectAttempts)))
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            void this.performReconnect()
        }, delay)
    }

    private async performReconnect(): Promise<void> {
        if (this.userDisconnected) return
        let ticket: string | null = null
        if (this.getTicketFn !== null) {
            try {
                const fresh = await this.getTicketFn()
                if (typeof fresh !== 'string') {
                    throw new Error(`getTicket must resolve to a string, got ${typeof fresh}`)
                }
                ticket = fresh
                this.lastTicket = fresh
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.emit('client:error', new Error(`getTicket failed: ${reason}`))
                this.emit('client:reconnect_failed')
                return
            }
        } else if (this.lastTicket !== null) {
            ticket = this.lastTicket
        } else {
            return
        }
        if (this.userDisconnected) return
        this.startNegotiation(ticket)
    }

    private computeBackoff(attempt: number): number {
        if (this.reconnectConfig === null) return 0
        const { baseDelayMs, maxDelayMs } = this.reconnectConfig
        const exp = baseDelayMs * Math.pow(2, attempt)
        const jitter = Math.random() * baseDelayMs
        return Math.min(exp + jitter, maxDelayMs)
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private resolveReconnect(option: RTCClientOptions['reconnect']): ReconnectConfig | null {
        if (option === undefined || option === false) return null
        if (option === true) return { ...RECONNECT_DEFAULTS }
        return {
            maxAttempts: option.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts,
            baseDelayMs: option.baseDelayMs ?? RECONNECT_DEFAULTS.baseDelayMs,
            maxDelayMs:  option.maxDelayMs  ?? RECONNECT_DEFAULTS.maxDelayMs,
        }
    }

}

export default RTCClient
