import { Room, Actor } from '@rivalis/core'
import { encode, decode, TOPIC } from '../protocol'
import type { ChatMessage, ChatBroadcast, ChatJoin, ChatLeave, ChatRoster } from '../protocol'

export type ActorData = { name: string }

// Star-topology chat room: each peer is an actor, the host relays messages between them.
class ChatRoom extends Room<ActorData> {

    protected override onCreate(): void {
        this.bind(TOPIC.MESSAGE, this.onMessage)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const { name } = actor.data

        const peers: string[] = []
        this.each(other => {
            if (other.id !== actor.id) peers.push(other.data.name)
        })
        const roster: ChatRoster = { peers }
        actor.send(TOPIC.ROSTER, encode(roster))

        const join: ChatJoin = { name }
        this.each(other => {
            if (other.id !== actor.id) other.send(TOPIC.JOIN, encode(join))
        })

        console.log(`[room] + ${name}  (${this.actorCount} connected)`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const { name } = actor.data
        // actor is no longer in the room, so this reaches only remaining peers.
        const leave: ChatLeave = { name }
        this.broadcast(TOPIC.LEAVE, encode(leave))
        console.log(`[room] - ${name}  (${this.actorCount} remaining)`)
    }

    private onMessage(actor: Actor<ActorData>, payload: Uint8Array): void {
        const { text } = decode<ChatMessage>(payload)
        if (!text || typeof text !== 'string') return
        const msg: ChatBroadcast = { name: actor.data.name, text }
        this.each(other => {
            if (other.id !== actor.id) other.send(TOPIC.BROADCAST, encode(msg))
        })
    }
}

export default ChatRoom
