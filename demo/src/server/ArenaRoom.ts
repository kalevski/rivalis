import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    WORLD,
    type Player,
    type MoveCommand,
    type ChatCommand,
    type StateSnapshot,
    type PlayerJoinEvent,
    type PlayerLeaveEvent,
    type PlayerMoveEvent,
    type ChatEvent
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

const CHAT_HISTORY_LIMIT = 50

class ArenaRoom extends Room {

    private players = new Map<string, Player>()
    private chatHistory: ChatEvent[] = []

    protected override onCreate(): void {
        this.bind('move', this.onMove)
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor): void {
        const data = actor.data as ActorData
        const player: Player = {
            id: actor.id,
            name: data.name,
            color: data.color,
            x: Math.floor(Math.random() * WORLD.width),
            y: Math.floor(Math.random() * WORLD.height)
        }
        this.players.set(actor.id, player)

        // WSTransport registers the per-actor message listener *after*
        // grantAccess() returns, but onJoin runs *inside* grantAccess.
        // Sending synchronously here would be lost — defer to next macrotask.
        setImmediate(() => {
            const snapshot: StateSnapshot = {
                youId: actor.id,
                players: Array.from(this.players.values())
            }
            actor.send('state', encode(snapshot))
            for (const message of this.chatHistory) {
                actor.send('chat', encode(message))
            }
            const event: PlayerJoinEvent = player
            this.broadcastExcept(actor.id, 'player:join', encode(event))
        })
    }

    protected override onLeave(actor: Actor): void {
        if (!this.players.delete(actor.id)) return
        const event: PlayerLeaveEvent = { id: actor.id }
        this.broadcast('player:leave', encode(event))
    }

    private onMove(actor: Actor, payload: Uint8Array): void {
        const command = decode<MoveCommand>(payload)
        const player = this.players.get(actor.id)
        if (!player) return

        player.x = clamp(command.x, 0, WORLD.width)
        player.y = clamp(command.y, 0, WORLD.height)

        const event: PlayerMoveEvent = { id: actor.id, x: player.x, y: player.y }
        this.broadcast('player:move', encode(event))
    }

    private onChat(actor: Actor, payload: Uint8Array): void {
        const command = decode<ChatCommand>(payload)
        const text = command.text?.trim().slice(0, 200)
        if (!text) return

        const player = this.players.get(actor.id)
        if (!player) return

        const event: ChatEvent = {
            from: actor.id,
            name: player.name,
            color: player.color,
            text,
            t: Date.now()
        }
        this.chatHistory.push(event)
        if (this.chatHistory.length > CHAT_HISTORY_LIMIT) this.chatHistory.shift()
        this.broadcast('chat', encode(event))
    }

    private broadcastExcept(actorId: string, topic: string, payload: Uint8Array): void {
        this.each(actor => {
            if (actor.id !== actorId) actor.send(topic, payload)
        })
    }

}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

export default ArenaRoom
