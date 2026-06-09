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
 */

import { Transport, KickReason } from '@rivalis/core'
import type { TLayer, ConnectionContext } from '@rivalis/core'
import {
    encode,
    CloseCode,
    CLOSE_CONTROL_TOPIC,
    encodeCloseFrame,
    createCodec,
    FieldType,
} from '@rivalis/handshake'
import { createPeerConnection } from './peer/RTCPeer'
import type { RTCDataChannelLike } from './peer/RTCPeer'
import { HostNegotiator } from './peer/NegotiationCore'
import type { RTCAdapters } from './peer/NegotiationCore'
import SignalClient from './SignalClient'

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
}

// ── RTCTransport ──────────────────────────────────────────────────────────────

class RTCTransport extends Transport {

    private layer: TLayer<any> | null = null

    /** post-grant: actorId → open data channel */
    private readonly channels = new Map<string, RTCDataChannelLike>()

    /** peerId → actorId — needed to route PC state-change events to handleClose */
    private readonly peerToActor = new Map<string, string>()

    /** Prevents double-close when both DC.onClose and PC state-change fire */
    private readonly closedActors = new Set<string>()

    private readonly signalClient: ReturnType<RTCAdapters['createSignalingClient']>
    private readonly negotiator: HostNegotiator
    private readonly hostTicket: string

    constructor(options: RTCTransportOptions) {
        super()
        this.hostTicket = options.ticket

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

        this.signalClient.connect(this.hostTicket)
    }

    // ── sockets count ─────────────────────────────────────────────────────────

    override get sockets(): number {
        return this.channels.size
    }

    // ── Step (2-5): onChannelOpen ─────────────────────────────────────────────

    private onChannelOpen(channel: RTCDataChannelLike, peerId: string): void {
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
            // Normal post-grant path — forward to TLayer
            if (actorId !== null) {
                layer.handleMessage(actorId, buf).catch((error: unknown) => {
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
                let aid: string
                try {
                    aid = await layer.grantAccess(peerTicket, ctx)
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

                // Steps (3)(4): register inbound + outbound listeners immediately so the
                // pendingEmits buffer (TLayer.ts:58-66, cap 256) drains right now rather
                // than accumulating frames sent during Room.onJoin.
                layer.on('message', aid, (_id, m) => {
                    if (channel.isOpen) {
                        try { channel.sendBinary(m) } catch { /* channel gone between check and send */ }
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
