import { Actor, Room } from '@rivalis/core'

class FirstRoom extends Room {

    protected override onCreate(): void {
        this.bind('my_message', this.onMessage, this)
    }

    protected override onJoin(actor: Actor): void {
        
    }

    protected override onLeave(actor: Actor): void {
        
    }

    protected override onDestroy(): void {
        
    }

    private onMessage(actor: Actor, payload: Uint8Array, topic: string) {
        let message = Buffer.from(payload).toString('utf-8')
        console.log('topic', topic, message)
    }

}

export default FirstRoom