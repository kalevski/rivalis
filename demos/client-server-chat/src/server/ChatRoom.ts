import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    type ChatCommand,
    type ChatEvent,
    type WelcomeEvent
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

/**
 * A single chat room. Every connected client lands here.
 *
 * - `presence = true` makes Room auto-broadcast `__presence:join` /
 *   `__presence:leave`, which gives us join/leave notifications for free.
 * - inbound `chat` frames are re-broadcast to everyone (including the
 *   sender — the client filters its own echo using the id from `welcome`).
 */
class ChatRoom extends Room<ActorData> {

    protected override presence = true

    protected override onCreate(): void {
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // Tell the new client its own actor id so it can ignore its own
        // broadcast echo and its own join notification.
        const welcome: WelcomeEvent = { youId: actor.id }
        actor.send('welcome', encode(welcome))
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
