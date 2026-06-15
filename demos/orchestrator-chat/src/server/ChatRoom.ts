import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    type ChatCommand,
    type ChatEvent,
    type WelcomeEvent
} from '../protocol'
import type { ActorData } from './AuthMiddleware'
import { getActiveOrchestrator } from './Orchestrator'

/**
 * One chat room instance, created on demand by the orchestrator. Its `id` is
 * the user-chosen room name. Because `broadcast` only ever reaches the actors
 * in *this* room, messages are naturally scoped: two clients in different
 * rooms never see each other's chat, while two in the same room do.
 *
 * - `presence = true` makes Room auto-broadcast `__presence:join` /
 *   `__presence:leave`, giving join/leave notifications for free.
 * - when the last actor leaves, the room hands itself back to the orchestrator
 *   for disposal (see `onLeave`).
 */
class ChatRoom extends Room<ActorData> {

    protected override presence = true

    protected override onCreate(): void {
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // Tell the new client its own actor id (so it can ignore its own echo)
        // and confirm which room it landed in. `actorCount` already includes
        // this actor — handleJoin adds it before onJoin runs.
        const welcome: WelcomeEvent = {
            youId: actor.id,
            room: this.id,
            occupants: this.actorCount
        }
        actor.send('welcome', encode(welcome))
    }

    protected override onLeave(): void {
        // The leaver has already been removed, so `actorCount` reflects who is
        // left. Ask the orchestrator to dispose this room if it just emptied.
        // The Room constructor is framework-fixed, so we reach the shared
        // orchestrator through its module singleton rather than an injected
        // reference.
        getActiveOrchestrator().releaseIfEmpty(this.id)
    }

    /** Only expose the display name in presence events, not internal data. */
    protected override presencePayload(actor: Actor<ActorData>): unknown {
        const data = actor.data as ActorData
        return { id: actor.id, data: { name: data.name } }
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const command = decode<ChatCommand>(payload)
        const text = command.text?.trim().slice(0, 500)
        if (!text) return

        const data = actor.data as ActorData
        const event: ChatEvent = {
            from: actor.id,
            name: data.name,
            text
        }
        this.broadcast('chat', encode(event))
    }

}

export default ChatRoom
