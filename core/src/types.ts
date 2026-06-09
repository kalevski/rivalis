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

export type TopicListener<TActorData = Record<string, unknown>> = (
    actor: Actor<TActorData>,
    payload: Uint8Array,
    topic: string
) => void

export type ForEachFn<TActorData = Record<string, unknown>> = (actor: Actor<TActorData>) => void

export type GetRoomFn<TActorData = Record<string, unknown>> = (roomId: string) => Room<TActorData> | null

export type EventType = 'message' | 'kick'

export type EventFn = (actorId: string, message: Uint8Array) => void
