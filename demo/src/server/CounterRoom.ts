import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    type CounterChangeCommand,
    type CounterStateEvent
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

/**
 * Server-authoritative shared counter. Anyone can `inc` / `dec`; the server
 * mutates the integer and broadcasts the new value with the actor name
 * that caused the change. Demonstrates the broadcast/state pattern without
 * any per-actor state.
 */
class CounterRoom extends Room<ActorData> {

    private value: number = 0

    protected override onCreate(): void {
        this.bind('change', this.onChange)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const state: CounterStateEvent = { value: this.value, by: null }
        actor.send('counter:state', encode(state))
    }

    private onChange(actor: Actor<ActorData>, payload: Uint8Array): void {
        const command = decode<CounterChangeCommand>(payload)
        const delta = Math.trunc(command.delta)
        if (delta !== 1 && delta !== -1) return

        this.value += delta
        const data = actor.data as ActorData
        const event: CounterStateEvent = { value: this.value, by: data.name }
        this.broadcast('counter:state', encode(event))
    }

}

export default CounterRoom
