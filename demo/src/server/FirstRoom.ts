import { Actor, Room } from '@rivalis/core'
import serializer from '../serializer'

class FirstRoom extends Room {

    protected override onCreate(): void {
        this.bind(Room.Any, this.onMessage, this)
    }

    protected override onJoin(actor: Actor): void {
        
    }

    protected override onLeave(actor: Actor): void {
        
    }

    protected override onDestroy(): void {
        
    }

    private onMessage(actor: Actor, payload: Uint8Array, topic: string) {
        console.log('topic', topic, payload)
    }

}

export default FirstRoom