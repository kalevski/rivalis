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

// Rendezvous room: peers find each other here, but chat never passes through it.
class SignalingRoom extends Room<ActorData> {

    override maxActors: number = MAX_PEERS

    private peers: Map<string, PeerInfo> = new Map()

    protected override onCreate(): void {
        this.bind(TOPIC.ANNOUNCE, this.onAnnounce)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // Tell the newcomer its own id; it echoes this in every hello so peers can agree on who dials.
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

        // Send the newcomer the existing roster (excludes itself — not registered yet).
        const roster: RosterEvent = { peers: [...this.peers.values()] }
        actor.send(TOPIC.ROSTER, encode(roster))

        this.peers.set(actor.id, info)
        this.each(other => {
            if (other.id === actor.id) return
            other.send(TOPIC.PEER_JOIN, encode(info))
        })

        this.logger?.info(`peer announced id=${actor.id} name="${name}" at ${host}:${port} (${this.peers.size}/${MAX_PEERS})`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        // Joined but never announced — nobody was told about it.
        if (!this.peers.delete(actor.id)) {
            return
        }
        const event: PeerLeaveEvent = { id: actor.id }
        this.broadcast(TOPIC.PEER_LEAVE, encode(event))
        this.logger?.info(`peer left id=${actor.id} (${this.peers.size}/${MAX_PEERS})`)
    }

}

export default SignalingRoom
