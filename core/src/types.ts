import type Actor from './Actor'
import type Room from './Room'

export type TopicListener<TActorData = Record<string, unknown>> = (
    actor: Actor<TActorData>,
    payload: Uint8Array,
    topic: string
) => void

export type ForEachFn<TActorData = Record<string, unknown>> = (actor: Actor<TActorData>) => void

export type GetRoomFn<TActorData = Record<string, unknown>> = (roomId: string) => Room<TActorData> | null

export type EventType = 'message' | 'kick'

export type EventFn = (actorId: string, message: Uint8Array) => void
