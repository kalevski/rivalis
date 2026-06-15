import { Actor, Room } from '@rivalis/core'
import { MAX_PEERS } from '../constants'
import {
    encode,
    decode,
    TOPIC,
    type AnnounceCommand,
    type PeerInfo,
    type WelcomeEvent,
    type RosterEvent,
    type PeerLeaveEvent
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

/**
 * The rendezvous room. Its only job is to let peers find each other; chat
 * never passes through here. Everything about the mesh's direct links is
 * negotiated peer-to-peer once discovery is done.
 *
 * The 10-participant cap is enforced with Rivalis' built-in `maxActors`: the
 * framework's `TLayer.grantAccess` rejects the 11th join with reason
 * `room_full` *before* the actor ever enters the room, so the limit is a real
 * framework guarantee, not something this demo polices by hand.
 */
class SignalingRoom extends Room<ActorData> {

    override maxActors: number = MAX_PEERS

    /** Announced peers, keyed by signalling actor id. */
    private peers: Map<string, PeerInfo> = new Map()

    protected override onCreate(): void {
        this.bind(TOPIC.ANNOUNCE, this.onAnnounce)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // Tell the newcomer its own id; it echoes this back inside every
        // direct-link hello so peers can apply a stable dial ordering.
        const welcome: WelcomeEvent = { youId: actor.id }
        actor.send(TOPIC.WELCOME, encode(welcome))
    }

    private onAnnounce(actor: Actor<ActorData>, payload: Uint8Array): void {
        const command = decode<AnnounceCommand>(payload)
        const host = String(command.host ?? '').trim()
        const port = Number(command.port)
        if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
            return
        }

        const { name } = actor.data as ActorData
        const info: PeerInfo = { id: actor.id, name, host, port }

        // 1. Hand the newcomer the peers already in the mesh (excludes itself —
        //    it is not in `this.peers` yet).
        const roster: RosterEvent = { peers: [...this.peers.values()] }
        actor.send(TOPIC.ROSTER, encode(roster))

        // 2. Register it, then announce it to everyone else.
        this.peers.set(actor.id, info)
        this.each(other => {
            if (other.id === actor.id) return
            other.send(TOPIC.PEER_JOIN, encode(info))
        })

        this.logger?.info(`peer announced id=${actor.id} name="${name}" at ${host}:${port} (${this.peers.size}/${MAX_PEERS})`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        if (!this.peers.delete(actor.id)) {
            // Joined but never finished announcing — nobody was told about it.
            return
        }
        const event: PeerLeaveEvent = { id: actor.id }
        this.broadcast(TOPIC.PEER_LEAVE, encode(event))
        this.logger?.info(`peer left id=${actor.id} (${this.peers.size}/${MAX_PEERS})`)
    }

}

export default SignalingRoom
