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

class ChatRoom extends Room<ActorData> {

    protected override presence = true

    protected override onCreate(): void {
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // actorCount already includes this actor — handleJoin adds it before onJoin.
        const welcome: WelcomeEvent = {
            youId: actor.id,
            room: this.id,
            occupants: this.actorCount
        }
        actor.send('welcome', encode(welcome))
    }

    protected override onLeave(): void {
        getActiveOrchestrator().releaseIfEmpty(this.id)
    }

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
