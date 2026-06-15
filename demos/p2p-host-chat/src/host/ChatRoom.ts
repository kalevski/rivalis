import { Room, Actor } from '@rivalis/core'
import { encode, decode, TOPIC } from '../protocol'
import type { ChatMessage, ChatBroadcast, ChatJoin, ChatLeave, ChatRoster } from '../protocol'

export type ActorData = { name: string }

/**
 * Star-topology chat room.
 *
 * Each RTCClient peer is an actor; the host (RTCTransport) is not an actor.
 * The room:
 *   - sends the newcomer a roster of already-connected peers on join,
 *   - announces the newcomer to the existing peers,
 *   - relays/broadcasts every chat message to all OTHER peers,
 *   - announces departures on leave.
 */
class ChatRoom extends Room<ActorData> {

    protected override onCreate(): void {
        this.bind(TOPIC.MESSAGE, this.onMessage)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const { name } = actor.data

        // Collect current roster (actor is already in the map at this point).
        const peers: string[] = []
        this.each(other => {
            if (other.id !== actor.id) peers.push(other.data.name)
        })
        const roster: ChatRoster = { peers }
        actor.send(TOPIC.ROSTER, encode(roster))

        // Announce the newcomer to existing peers.
        const join: ChatJoin = { name }
        this.each(other => {
            if (other.id !== actor.id) other.send(TOPIC.JOIN, encode(join))
        })

        console.log(`[room] + ${name}  (${this.actorCount} connected)`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const { name } = actor.data
        // actor is no longer in the room; broadcast reaches only remaining peers.
        const leave: ChatLeave = { name }
        this.broadcast(TOPIC.LEAVE, encode(leave))
        console.log(`[room] - ${name}  (${this.actorCount} remaining)`)
    }

    private onMessage(actor: Actor<ActorData>, payload: Uint8Array): void {
        const { text } = decode<ChatMessage>(payload)
        if (!text || typeof text !== 'string') return
        const msg: ChatBroadcast = { name: actor.data.name, text }
        // Relay to everyone except the sender.
        this.each(other => {
            if (other.id !== actor.id) other.send(TOPIC.BROADCAST, encode(msg))
        })
    }
}

export default ChatRoom
