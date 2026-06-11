import type Actor from './Actor'
import type Room from './Room'

export type ConnectionContext = {
    /** Which transport admitted this connection ('ws' | 'webrtc' | custom). */
    kind: string
    /** Transport-native peer/remote id (WS: remoteAddress; RTC: signaling peerId). */
    remoteId?: string
    /** Opaque, transport-specific extras (origin header, ICE candidate type, …). */
    meta?: Record<string, unknown>
}

/**
 * Capability descriptor for a transport (p2p.md §7, §12 Phase 4).
 *
 * A `Room` can read this via `this.transportCapabilities` to adapt outbound
 * framing to the transport's actual limits and delivery semantics — for example,
 * splitting an arena snapshot when `maxFrameBytes` is small, or switching to
 * application-level sequencing when `ordered` is false.
 *
 * - `ordered` — frames are guaranteed to arrive in send order (TCP-backed WS: true;
 *   RTC primary channel `{ ordered:true }`: true).
 * - `reliable` — every sent frame is eventually delivered (no drops, no silent
 *   truncation). TCP-backed WS: true; RTC primary channel (no maxRetransmits): true.
 * - `maxFrameBytes` — hard ceiling on a single frame in bytes; `null` means no
 *   transport-layer limit. WS returns its configured `maxPayload`; RTC returns 16 KiB.
 */
export type TransportCapability = {
    ordered: boolean
    reliable: boolean
    maxFrameBytes: number | null
}

export type TopicListener<TActorData = Record<string, unknown>> = (
    actor: Actor<TActorData>,
    payload: Uint8Array,
    topic: string
) => void

export type ForEachFn<TActorData = Record<string, unknown>> = (actor: Actor<TActorData>) => void

export type GetRoomFn<TActorData = Record<string, unknown>> = (roomId: string) => Room<TActorData> | null

export type EventType = 'message' | 'kick'

export type EventFn = (actorId: string, message: Uint8Array) => void
