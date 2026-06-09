/**
 * RTCTransport — host-side WebRTC Transport (p2p.md §4.2).
 *
 * Satisfies the five-step Transport seam over RTCDataChannel:
 *   (1) onInitialize  — connects to @rivalis/signal as host; wires HostNegotiator
 *                        after signal:welcome delivers myId + iceServers.
 *   (2) grantAccess   — called inside onChannelOpen once the peer sends its
 *                        game-room auth ticket as the first binary DC message.
 *   (3) handleMessage — registered immediately after grantAccess resolves.
 *   (4) on('message'/'kick') — registered immediately after grantAccess so
 *                        TLayer's pendingEmits buffer (TLayer.ts:58-66, cap 256)
 *                        drains synchronously before any chatty onJoin can overflow it.
 *   (5) handleClose   — called on PC disconnected/closed/failed or DC close.
 *
 * Kick delivery: a §3.4 control frame (CLOSE_CONTROL_TOPIC, encodeCloseFrame) is
 * sent over the channel immediately before channel.close(), so the peer receives
 * the numeric code + reason string even though RTCDataChannel.close() carries
 * no close-code metadata.
 *
 * Ticket protocol: the peer sends its game-room auth ticket as UTF-8 bytes in the
 * first binary message on the data channel. RTCTransport reads it, calls
 * grantAccess, then switches the channel.onMessage handler to normal game traffic.
 * This keeps the signal wire and game wire independent.
 *
 * Pre-admission throttling (p2p.md §8):
 *   First hop  — the signaling WS is guarded by WSTransport's ConnectionLimiter
 *                (per-IP, WSTransport.ts:172-185).
 *   Second hop — RTCTransport optionally runs a per-peerId ConnectionLimiter
 *                (`peerLimiter` option) immediately before grantAccess so the
 *                game-host side is never accidentally unthrottled even if the
 *                signaling leg is bypassed or saturated.
 */

import { Transport, KickReason, ConnectionLimiter, checkBackpressure, DEFAULT_MAX_BUFFERED_BYTES } from '@rivalis/core'
import type { TLayer, ConnectionContext, BackpressureDropFn } from '@rivalis/core'
import type { ChannelReliability } from './peer/RTCPeer'
import {
    encode,
    CloseCode,
    CLOSE_CONTROL_TOPIC,
    encodeCloseFrame,
    createCodec,
    FieldType,
    decode as handshakeDecode,
} from '@rivalis/handshake'
import { createPeerConnection } from './peer/RTCPeer'
import type { RTCDataChannelLike } from './peer/RTCPeer'
import { HostNegotiator } from './peer/NegotiationCore'
import type { RTCAdapters } from './peer/NegotiationCore'
import SignalClient from './SignalClient'
import {
    RTC_MAX_FRAME_BYTES,
    isChunkFrame,
    chunkFrame,
    decodeChunkPayload,
    ChunkReassembler,
} from './peer/RtcFrameChunker'

export type { BackpressureDropFn }

// ── Topic predicate helper ────────────────────────────────────────────────────

function resolveTopicPredicate(
    opt: ReadonlySet<string> | ((topic: string) => boolean) | undefined,
): ((topic: string) => boolean) | null {
    if (opt === undefined) return null
    if (typeof opt === 'function') return opt
    return (t: string) => opt.has(t)
}

/**
 * Fast topic extraction from a handshake-encoded frame.
 * Reads protobuf field 1 (wire type 2, length-delimited) without a full decode.
 * Returns an empty string if the frame does not start with a valid topic field.
 */
function extractFrameTopic(frame: Uint8Array): string {
    // Field 1, wire type 2 (length-delimited): tag byte = 0x0A
    if (frame.length < 2 || frame[0] !== 0x0A) return ''
    let len = 0, shift = 0, i = 1
    while (i < frame.length) {
        const b = frame[i++]!
        len |= (b & 0x7F) << shift
        if ((b & 0x80) === 0) break
        shift += 7
        if (shift > 28) return ''  // malformed varint
    }
    if (i + len > frame.length) return ''
    return new TextDecoder().decode(frame.subarray(i, i + len))
}

// ── Welcome codec (subset of NegotiationCore's signal wire codec) ─────────────
// Same schema major and field order → bitwise-identical binary. Namespace differs
// intentionally; it is a serializer scope key only and does not affect the wire.

const signalCodec = createCodec({
    namespace: '@rivalis/node/rtc-transport',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: FieldType.STRING, rule: 'optional' },  // tag 1
            { key: 'hostId',     type: FieldType.STRING, rule: 'optional' },  // tag 2
            { key: 'iceServers', type: FieldType.STRING, rule: 'optional' },  // tag 3
        ],
    },
})

// ── Options ───────────────────────────────────────────────────────────────────

export type RTCTransportOptions = {
    /** @rivalis/signal server WebSocket URL. */
    signalUrl: string
    /**
     * Auth ticket used to connect to @rivalis/signal as the host.
     * Presented to the signal server, not to game-room AuthMiddleware.
     */
    ticket: string
    /**
     * Adapter overrides for testing (p2p.md §4.5 injection seam).
     * Production callers omit this; defaults are node-datachannel + SignalClient.
     */
    adapters?: Partial<RTCAdapters>
    /** RTCDataChannel label. Default: 'rivalis' */
    channelLabel?: string
    /**
     * Optional per-peerId pre-admission throttle applied before `grantAccess`.
     * Mirrors the `connectionLimiter` option on `WSTransport` but keyed by
     * the signaling `peerId` rather than a remote IP address.
     *
     * The first hop (signaling WS) is already guarded by `WSTransport`'s
     * own `ConnectionLimiter`. This option adds a second check specifically
     * on the game-host side so a peer that somehow opens many data channels
     * in parallel cannot hammer `grantAccess` without bound.
     *
     * Return `false` (or resolve to `false`) to reject the connection with
     * `CloseCode.RATE_LIMITED` before `AuthMiddleware` is invoked.
     */
    peerLimiter?: ConnectionLimiter
    /**
     * Maximum bytes buffered on a data channel before an outbound frame is
     * dropped. Uses the same default (1 MiB) as WSTransport so the two
     * transports behave identically out of the box.
     */
    maxBufferedBytes?: number
    /**
     * Invoked when an outbound frame is dropped because the data channel's
     * `bufferedAmount` exceeds `maxBufferedBytes`. Identical hook signature
     * to WSTransport's `onBackpressureDrop` (p2p.md §7).
     */
    onBackpressureDrop?: BackpressureDropFn
    /**
     * Data channel reliability expectation (p2p.md §7). In phase 1, the host
     * accepts a single reliable channel established by the connecting RTCClient
     * peer — the host side does not create the channel. This field documents the
     * intended reliability for the channel and will be used in future phases that
     * support multiple channels per peer. Default: `{ ordered: true }`.
     */
    channelReliability?: ChannelReliability
    /**
     * Topics routed over the unreliable/unordered data channel when a peer opens one
     * (p2p.md §7, task 084). Accepts a `Set<string>` of exact topic names or a
     * predicate function. Topics not matched always use the reliable channel.
     *
     * The unreliable channel must be opened by the peer (`RTCClientOptions.dualChannel`)
     * for routing to take effect. If no unreliable channel is present for a given peer,
     * all messages fall through to the reliable channel regardless of this option.
     *
     * Default: none (all topics use the reliable channel).
     */
    unreliableTopics?: ReadonlySet<string> | ((topic: string) => boolean)
}

export type { ChannelReliability }

// ── RTCTransport ──────────────────────────────────────────────────────────────

class RTCTransport extends Transport {

    private layer: TLayer<any> | null = null

    /** post-grant: actorId → open data channel */
    private readonly channels = new Map<string, RTCDataChannelLike>()

    /** peerId → actorId — needed to route PC state-change events to handleClose */
    private readonly peerToActor = new Map<string, string>()

    /** Prevents double-close when both DC.onClose and PC state-change fire */
    private readonly closedActors = new Set<string>()

    /**
     * Per-actor outbound chunk sequence number (uint16, wraps at 65535).
     * Each new multi-chunk message increments the counter for that actor.
     */
    private readonly outboundSeq = new Map<string, number>()

    /**
     * Per-actor inbound chunk reassembler.
     * Accumulates chunk fragments from a peer until the full frame is ready.
     */
    private readonly inboundReassembler = new Map<string, ChunkReassembler>()

    private readonly signalClient: ReturnType<RTCAdapters['createSignalingClient']>
    private readonly negotiator: HostNegotiator
    private readonly hostTicket: string
    private readonly peerLimiter: ConnectionLimiter | null
    private readonly maxBufferedBytes: number
    private readonly onBackpressureDrop: BackpressureDropFn | null
    /**
     * Predicate for routing outbound messages to the unreliable channel.
     * Derived from `RTCTransportOptions.unreliableTopics` at construction time.
     */
    private readonly unreliableTopicPredicate: ((topic: string) => boolean) | null
    /**
     * actorId → unreliable data channel (post-grant, when peer opened one).
     * Used to route high-rate outbound topics over the lower-latency path.
     */
    private readonly unreliableChannels = new Map<string, RTCDataChannelLike>()
    /**
     * peerId → pending unreliable channel that arrived before the reliable channel
     * completed grantAccess. Cleared in onChannelOpen once actorId is known.
     */
    private readonly pendingUnreliableByPeer = new Map<string, RTCDataChannelLike>()

    constructor(options: RTCTransportOptions) {
        super()
        this.hostTicket = options.ticket
        this.peerLimiter = options.peerLimiter ?? null
        this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
        this.onBackpressureDrop = options.onBackpressureDrop ?? null
        this.unreliableTopicPredicate = resolveTopicPredicate(options.unreliableTopics)

        const resolvedAdapters: RTCAdapters = {
            createPeerConnection: options.adapters?.createPeerConnection ?? createPeerConnection,
            createSignalingClient: options.adapters?.createSignalingClient
                ?? ((url: string) => new SignalClient(url)),
        }

        this.signalClient = resolvedAdapters.createSignalingClient(options.signalUrl)
        this.negotiator = new HostNegotiator(
            resolvedAdapters,
            this.signalClient,
            options.channelLabel,
        )
    }

    // ── Step (1): onInitialize ────────────────────────────────────────────────

    override onInitialize(layer: TLayer<any>): void {
        this.layer = layer

        // Decode signal:welcome to extract our host identity and ICE servers,
        // then hand both to HostNegotiator so it can route incoming offers.
        this.signalClient.on('signal:welcome', (payload: Uint8Array) => {
            const msg = signalCodec.decode('Welcome', payload)
            const myId = String(msg['youId'] ?? '')
            let iceServers: RTCIceServer[] = []
            try {
                iceServers = JSON.parse(String(msg['iceServers'] ?? '[]')) as RTCIceServer[]
            } catch { /* empty ice list is safe */ }

            this.negotiator.initialize(myId, iceServers, {
                onChannel:         (channel, peerId) => this.onChannelOpen(channel, peerId),
                onPeerStateChange: (peerId, state)   => this.onPeerStateChange(peerId, state),
            })
        })

        layer.registerCapabilities(this.capabilities)
        this.signalClient.connect(this.hostTicket)
    }

    // ── sockets count ─────────────────────────────────────────────────────────

    override get sockets(): number {
        return this.channels.size
    }

    // ── maxFrameBytes capability (p2p.md §7) ─────────────────────────────────

    override get maxFrameBytes(): number {
        return RTC_MAX_FRAME_BYTES
    }

    // ── Step (2-5): onChannelOpen ─────────────────────────────────────────────

    private onChannelOpen(channel: RTCDataChannelLike, peerId: string): void {
        // Unreliable secondary channel: a label ending with ':unreliable' is the
        // convention set by RTCClient when dualChannel is enabled (p2p.md §7, task 084).
        if (channel.label.endsWith(':unreliable')) {
            this.handleUnreliableChannel(channel, peerId)
            return
        }

        const layer = this.layer!
        let actorId: string | null = null
        let ticketConsumed = false
        let earlyClose = false

        // Register onClose BEFORE the first message arrives so a channel that
        // closes during the async grantAccess call is still cleaned up correctly.
        channel.onClose(() => {
            earlyClose = true
            if (actorId !== null) {
                this.triggerClose(actorId, peerId)
            }
        })

        // Step (2): first binary message is the peer's game-room auth ticket (UTF-8).
        // Steps (3)(4): subsequent messages are standard handshake frames.
        // The handler is intentionally a single persistent onMessage registration;
        // the ticketConsumed flag gates the two code paths.
        channel.onMessage((buf) => {
            // Normal post-grant path — forward to TLayer.
            // Chunk frames are reassembled before forwarding; regular frames pass through
            // with the original buffer reference so call-sites that check reference
            // equality are unaffected.
            if (actorId !== null) {
                let frameToHandle: Uint8Array | null = null
                if (isChunkFrame(buf)) {
                    // Decode to extract chunk fields, then feed the reassembler.
                    const { payload } = handshakeDecode(buf)
                    const parsed = decodeChunkPayload(payload)
                    if (parsed === null) {
                        layer.logger.warning(`rtc: malformed chunk payload for actor=${actorId}`)
                        return
                    }
                    const reassembler = this.inboundReassembler.get(actorId)
                    if (reassembler === undefined) return
                    const complete = reassembler.feed(parsed.seq, parsed.total, parsed.index, parsed.data)
                    if (complete === null) return  // waiting for remaining chunks
                    frameToHandle = complete
                } else {
                    // Regular (non-chunked) frame — pass original reference through.
                    frameToHandle = buf
                }
                layer.handleMessage(actorId, frameToHandle).catch((error: unknown) => {
                    const reason = error instanceof Error ? error.message : String(error)
                    layer.logger.error(`rtc: handleMessage rejected for actor=${actorId}: ${reason}`)
                })
                return
            }

            // Drop any second ticket message or messages arriving after early close
            if (ticketConsumed || earlyClose) return
            ticketConsumed = true

            const peerTicket = new TextDecoder().decode(buf)
            const ctx: ConnectionContext = { kind: 'webrtc', remoteId: peerId }

            // grantAccess is async; wrap the continuation to handle the early-close race.
            void (async () => {
                // Per-peerId pre-admission throttle (p2p.md §8).
                // Runs before AuthMiddleware so a hammering peer is rejected cheaply.
                if (this.peerLimiter !== null) {
                    let allowed: boolean
                    try {
                        allowed = await this.peerLimiter.check(peerId)
                    } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error)
                        layer.logger.warning(`rtc: peerLimiter.check threw for peerId=${peerId}: ${msg}`)
                        allowed = false
                    }
                    if (!allowed) {
                        layer.logger.debug(`rtc: connection rate limited for peerId=${peerId}`)
                        // Use CloseCode.RATE_LIMITED (4005) — mirrors WSTransport's pre-admission
                        // rejection code and is distinct from CloseCode.KICKED (4003).
                        const closePayload = encodeCloseFrame(CloseCode.RATE_LIMITED, KickReason.RATE_LIMITED)
                        const frame = encode(CLOSE_CONTROL_TOPIC, closePayload)
                        if (channel.isOpen) {
                            try { channel.sendBinary(frame) } catch { /* channel gone */ }
                        }
                        channel.close()
                        return
                    }
                }

                let aid: string
                try {
                    aid = await layer.grantAccess(peerTicket, ctx, this)
                } catch {
                    // Auth or room-admission failure — close without a game-level close frame
                    // (pre-join rejection; peer has not joined any room yet).
                    channel.close()
                    return
                }

                if (earlyClose) {
                    // Channel closed while grantAccess was in flight. TLayer registered the
                    // actor inside grantAccess (room.handleJoin ran); unwind it now.
                    this.triggerClose(aid, peerId)
                    return
                }

                actorId = aid
                this.channels.set(aid, channel)
                this.peerToActor.set(peerId, aid)
                this.outboundSeq.set(aid, 0)
                this.inboundReassembler.set(aid, new ChunkReassembler())

                // Wire up any unreliable channel that arrived before grantAccess completed.
                const pendingUnreliable = this.pendingUnreliableByPeer.get(peerId)
                if (pendingUnreliable !== undefined) {
                    this.pendingUnreliableByPeer.delete(peerId)
                    this.wireUnreliableChannel(pendingUnreliable, aid, layer)
                }

                // Steps (3)(4): register inbound + outbound listeners immediately so the
                // pendingEmits buffer (TLayer.ts:58-66, cap 256) drains right now rather
                // than accumulating frames sent during Room.onJoin.
                layer.on('message', aid, (_id, m) => {
                    // Route to unreliable channel when predicate matches and channel is open.
                    const unreliableCh = this.unreliableChannels.get(aid)
                    if (
                        unreliableCh !== undefined &&
                        unreliableCh.isOpen &&
                        this.unreliableTopicPredicate !== null &&
                        this.unreliableTopicPredicate(extractFrameTopic(m))
                    ) {
                        if (checkBackpressure(aid, unreliableCh.bufferedAmount, this.maxBufferedBytes, this.onBackpressureDrop, (msg) => layer.logger.warning(msg))) {
                            return
                        }
                        if (m.byteLength <= RTC_MAX_FRAME_BYTES) {
                            try { unreliableCh.sendBinary(m) } catch { /* channel gone */ }
                        } else {
                            // No chunking on unreliable channel — lost chunks can't be reassembled.
                            layer.logger.warning(
                                `rtc: unreliable frame dropped (exceeds ${RTC_MAX_FRAME_BYTES}-byte ceiling, ` +
                                `no chunking on unordered channel) for actor=${aid}`
                            )
                        }
                        return
                    }

                    if (!channel.isOpen) return
                    if (checkBackpressure(aid, channel.bufferedAmount, this.maxBufferedBytes, this.onBackpressureDrop, (msg) => layer.logger.warning(msg))) {
                        return
                    }
                    if (m.byteLength <= RTC_MAX_FRAME_BYTES) {
                        // Frame fits in a single SCTP message — send as-is.
                        try { channel.sendBinary(m) } catch { /* channel gone between check and send */ }
                        return
                    }
                    // Frame exceeds the RTC ceiling — chunk and send (p2p.md §7).
                    const seq = this.outboundSeq.get(aid) ?? 0
                    this.outboundSeq.set(aid, (seq + 1) & 0xFFFF)
                    layer.logger.debug(
                        `rtc: chunking ${m.byteLength}-byte frame for actor=${aid} ` +
                        `(RTC ceiling=${RTC_MAX_FRAME_BYTES}, seq=${seq})`
                    )
                    let chunks: Uint8Array[]
                    try {
                        chunks = chunkFrame(m, seq)
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err)
                        layer.logger.warning(`rtc: frame dropped (too large to chunk) for actor=${aid}: ${msg}`)
                        return
                    }
                    for (const chunk of chunks) {
                        if (!channel.isOpen) break
                        try { channel.sendBinary(chunk) } catch { break /* channel gone */ }
                    }
                })
                layer.on('kick', aid, (_id, m) => {
                    // §3.4: send control frame THEN close so the peer sees code+reason.
                    this.sendCloseFrame(channel, m)
                    channel.close()
                })
            })()
        })
    }

    // ── Unreliable channel helpers (p2p.md §7, task 084) ─────────────────────

    /**
     * Called when `onDataChannel` fires for a channel whose label ends with
     * ':unreliable'. Either wires it up immediately (if the reliable channel for
     * this peer already completed grantAccess) or buffers it for later.
     */
    private handleUnreliableChannel(channel: RTCDataChannelLike, peerId: string): void {
        const layer = this.layer!
        const actorId = this.peerToActor.get(peerId)
        if (actorId !== undefined) {
            // Reliable channel already granted — wire up the unreliable channel now.
            this.wireUnreliableChannel(channel, actorId, layer)
        } else {
            // Reliable channel not yet granted — buffer until actorId is known.
            this.pendingUnreliableByPeer.set(peerId, channel)
        }
    }

    /**
     * Wire up an unreliable channel to an actor: register the message handler and
     * track the channel in `unreliableChannels` for outbound routing.
     * Inbound frames arrive via the same `layer.handleMessage` path as the reliable
     * channel — the room is transparent to which channel a frame arrived on.
     */
    private wireUnreliableChannel(channel: RTCDataChannelLike, actorId: string, layer: TLayer<any>): void {
        this.unreliableChannels.set(actorId, channel)
        channel.onMessage((buf) => {
            if (!this.channels.has(actorId)) return  // actor already closed
            layer.handleMessage(actorId, buf).catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error)
                layer.logger.warning(`rtc: unreliable handleMessage rejected for actor=${actorId}: ${reason}`)
            })
        })
        channel.onClose(() => {
            this.unreliableChannels.delete(actorId)
        })
    }

    // ── Step (5): PC state-change → handleClose ───────────────────────────────

    private onPeerStateChange(peerId: string, state: string): void {
        if (state === 'disconnected' || state === 'closed' || state === 'failed') {
            this.negotiator.closePeer(peerId)
            const aid = this.peerToActor.get(peerId)
            if (aid !== undefined) {
                this.triggerClose(aid, peerId)
            }
        }
    }

    // ── Shared close helper ───────────────────────────────────────────────────

    private triggerClose(actorId: string, peerId: string): void {
        if (this.closedActors.has(actorId)) return
        this.closedActors.add(actorId)
        this.channels.delete(actorId)
        this.peerToActor.delete(peerId)
        this.outboundSeq.delete(actorId)
        this.inboundReassembler.get(actorId)?.clear()
        this.inboundReassembler.delete(actorId)
        // Clean up unreliable channel and any buffered pending channel for this peer.
        this.pendingUnreliableByPeer.delete(peerId)
        const uch = this.unreliableChannels.get(actorId)
        if (uch !== undefined) {
            this.unreliableChannels.delete(actorId)
            if (uch.isOpen) {
                try { uch.close() } catch { /* ignore */ }
            }
        }
        this.layer?.handleClose(actorId)
    }

    // ── §3.4 control frame ────────────────────────────────────────────────────

    private sendCloseFrame(channel: RTCDataChannelLike, kickPayload: Uint8Array): void {
        // kickPayload is the UTF-8 KickReason string emitted by TLayer.kick().
        const reason = new TextDecoder().decode(kickPayload)
        const closePayload = encodeCloseFrame(CloseCode.KICKED, reason)
        const frame = encode(CLOSE_CONTROL_TOPIC, closePayload)
        if (channel.isOpen) {
            try { channel.sendBinary(frame) } catch { /* channel gone */ }
        }
    }

    // ── dispose ───────────────────────────────────────────────────────────────

    override async dispose(): Promise<void> {
        const shutdownPayload = new TextEncoder().encode(KickReason.SERVER_SHUTDOWN)
        // Snapshot then clear maps before closing channels. Clearing first means that
        // when channel.close() fires the onClose handler (→ triggerClose), both the
        // closedActors guard and the already-empty maps ensure handleClose is not
        // called again from the close callback.
        const snapshot = new Map(this.channels)
        this.channels.clear()
        this.peerToActor.clear()
        this.outboundSeq.clear()
        this.inboundReassembler.forEach(r => r.clear())
        this.inboundReassembler.clear()
        // Close unreliable channels (no close frame — they carry no control frames).
        for (const uch of this.unreliableChannels.values()) {
            if (uch.isOpen) {
                try { uch.close() } catch { /* ignore */ }
            }
        }
        this.unreliableChannels.clear()
        this.pendingUnreliableByPeer.clear()
        for (const [actorId, channel] of snapshot) {
            this.closedActors.add(actorId)  // prevent triggerClose from re-firing
            this.sendCloseFrame(channel, shutdownPayload)
            channel.close()
            this.layer?.handleClose(actorId)
        }
        this.negotiator.dispose()
        this.signalClient.disconnect()
    }

}

export default RTCTransport
