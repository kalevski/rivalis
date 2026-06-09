import { Room, Actor } from '@rivalis/core'
import { encodeWelcome, decodeRelayTo } from './wire/index'

type PeerData = Record<string, unknown>

/**
 * Signaling room: relays SDP offers/answers and ICE candidates between peers.
 * The first peer to join becomes the host; subsequent peers are told who the
 * host is so they know which actor to address their offer to.
 *
 * All relay topics carry a binary frame whose first field is `to` (the target
 * actorId). `relay` decodes that field and uses `Room.getActor` (§3.7) for
 * O(1) targeted delivery — no `each` iteration per signal.
 */
class SignalRoom extends Room<PeerData> {
    protected override presence = true
    protected override unknownTopicPolicy = 'drop' as const

    private hostId: string | null = null

    protected override onCreate(): void {
        this.bind('signal:offer',  this.relay)
        this.bind('signal:answer', this.relay)
        this.bind('signal:ice',    this.relay)
    }

    protected override onJoin(actor: Actor<PeerData>): void {
        if (this.hostId === null) this.hostId = actor.id
        actor.send('signal:welcome', encodeWelcome({
            youId: actor.id,
            hostId: this.hostId,
            iceServers: '[]',   // IceConfig (TURN creds) deferred to Phase 1
        }))
    }

    protected override onLeave(actor: Actor<PeerData>): void {
        if (actor.id === this.hostId) {
            this.hostId = null
            this.broadcast('signal:host_gone', '')
        }
    }

    private relay(actor: Actor<PeerData>, payload: Uint8Array, topic: string): void {
        const targetId = decodeRelayTo(payload)
        this.getActor(targetId)?.send(topic, payload)
    }
}

export default SignalRoom
