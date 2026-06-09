import { Room, Actor } from '@rivalis/core'
import { encodeWelcome, decodeRelayTo } from './wire/index'
import IceConfig from './IceConfig'

/**
 * Signaling room: relays SDP offers/answers and ICE candidates between peers.
 * The first peer to join becomes the host; subsequent peers are told who the
 * host is so they know which actor to address their offer to.
 *
 * All relay topics carry a binary frame whose first field is `to` (the target
 * actorId). `relay` decodes that field and uses `Room.getActor` (§3.7) for
 * O(1) targeted delivery — no `each` iteration per signal.
 *
 * Actor data is `null` — signaling carries no per-actor payload beyond the
 * actor id, which is always available as `actor.id`.
 */
class SignalRoom extends Room<null> {
    protected override presence = true
    protected override unknownTopicPolicy = 'drop' as const

    private hostId: string | null = null

    /** ICE/TURN credential issuer. Reads from env vars by default; may be
     *  overridden in a subclass for testing or custom configuration. */
    protected iceConfig: IceConfig = IceConfig.fromEnv()

    protected override onCreate(): void {
        this.bind('signal:offer',  this.relay)
        this.bind('signal:answer', this.relay)
        this.bind('signal:ice',    this.relay)
    }

    protected override onJoin(actor: Actor<null>): void {
        if (this.hostId === null) this.hostId = actor.id
        actor.send('signal:welcome', encodeWelcome({
            youId: actor.id,
            hostId: this.hostId,
            iceServers: this.iceConfig.issueFor(actor.id),
        }))
    }

    protected override onLeave(actor: Actor<null>): void {
        if (actor.id === this.hostId) {
            this.hostId = null
            this.broadcast('signal:host_gone', '')
        }
    }

    private relay(actor: Actor<null>, payload: Uint8Array, topic: string): void {
        const targetId = decodeRelayTo(payload)
        this.getActor(targetId)?.send(topic, payload)
    }
}

export default SignalRoom
