import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    type LobbyChatCommand,
    type LobbyChatEvent,
    type LobbyState
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

const HISTORY_LIMIT = 50

/**
 * Plain chat lobby. Demonstrates the opt-in `presence` feature: setting
 * `presence = true` makes Room auto-broadcast `__presence:join` and
 * `__presence:leave` so the client can keep an online list without any
 * server-side wiring beyond the topic name.
 */
class LobbyRoom extends Room<ActorData> {

    protected override presence = true

    private history: LobbyChatEvent[] = []

    protected override onCreate(): void {
        this.bind('chat', this.onChat)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // WSTransport registers the per-actor message listener after grantAccess
        // returns. Defer the initial state send so it isn't lost.
        setImmediate(() => {
            const state: LobbyState = { youId: actor.id, history: this.history }
            actor.send('lobby:state', encode(state))
        })
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const command = decode<LobbyChatCommand>(payload)
        const text = command.text?.trim().slice(0, 200)
        if (!text) return

        const data = actor.data as ActorData
        const event: LobbyChatEvent = {
            from: actor.id,
            name: data.name,
            color: data.color,
            text,
            t: Date.now()
        }
        this.history.push(event)
        if (this.history.length > HISTORY_LIMIT) this.history.shift()
        this.broadcast('chat', encode(event))
    }

}

export default LobbyRoom
