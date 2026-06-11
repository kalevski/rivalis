import { Room, Actor } from '@rivalis/core'
import { encode, decode, TOPIC } from '../protocol'
import type { InputPayload, SnapshotPayload, PeerJoinPayload, PeerLeavePayload } from '../protocol'
import { TICK_MS } from '../constants'

export type ActorData = { name: string }

/**
 * Authoritative world room.
 *
 * The host (RTCTransport) is not an actor — it is the authority. Every
 * RTCClient peer joins as an actor with a name extracted from its ticket.
 *
 * State model:
 *   - Each peer has an integer score stored in `scores` (actorId → number).
 *   - Scores are mutated only by the host in response to validated `INPUT`
 *     messages — peers never write state directly.
 *   - A fixed tick loop (TICK_MS interval) broadcasts the full snapshot to
 *     all connected peers so every peer's view converges.
 *
 * Late-join: `onJoin` immediately sends the current snapshot to the newcomer
 * before the next tick fires, so late joiners get the current state at once.
 *
 * Host departure: the host process sends `SESSION_END` via `broadcast` before
 * calling `rivalis.shutdown()`.  Shutdown then kicks all actors
 * (ROOM_DESTROYED) and sends close frames (SERVER_SHUTDOWN) over WebRTC, so
 * peers receive the SESSION_END message first, followed by `client:kicked`.
 */
class WorldRoom extends Room<ActorData> {

    private tick = 0
    private readonly scores = new Map<string, number>()
    private tickTimer: NodeJS.Timeout | null = null

    protected override onCreate(): void {
        this.bind(TOPIC.INPUT, this.onInput)
        this.tickTimer = setInterval(() => this.runTick(), TICK_MS)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const { name } = actor.data!
        this.scores.set(actor.id, 0)

        // Send the current snapshot so the newcomer is up-to-date immediately,
        // without waiting for the next tick.
        actor.send(TOPIC.SNAPSHOT, encode(this.buildSnapshot()))

        // Announce the newcomer to all peers (broadcast includes the newcomer
        // because actor is already in the actors map at this point).
        const join: PeerJoinPayload = { id: actor.id, name }
        this.broadcast(TOPIC.PEER_JOIN, encode(join))

        console.log(`[world] + ${name} (id=${actor.id})  [${this.actorCount} peer(s) connected]`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const { name } = actor.data!
        this.scores.delete(actor.id)

        // actor has already been removed from the actors map before onLeave is
        // called, so this broadcast reaches only the remaining peers.
        const leave: PeerLeavePayload = { id: actor.id, name }
        this.broadcast(TOPIC.PEER_LEAVE, encode(leave))

        console.log(`[world] - ${name}  [${this.actorCount} peer(s) remaining]`)
    }

    protected override onDestroy(): void {
        if (this.tickTimer !== null) {
            clearInterval(this.tickTimer)
            this.tickTimer = null
        }
        this.scores.clear()
        console.log('[world] room destroyed')
    }

    private onInput(actor: Actor<ActorData>, payload: Uint8Array): void {
        const msg = decode<InputPayload>(payload)
        if (msg.action !== 'up' && msg.action !== 'down') return
        const current = this.scores.get(actor.id) ?? 0
        this.scores.set(actor.id, msg.action === 'up' ? current + 1 : current - 1)
    }

    private runTick(): void {
        this.tick += 1
        if (this.actorCount > 0) {
            this.broadcast(TOPIC.SNAPSHOT, encode(this.buildSnapshot()))
        }
        if (this.tick % 10 === 0) {
            console.log(`[world] tick=${this.tick}  peers=${this.actorCount}`)
        }
    }

    private buildSnapshot(): SnapshotPayload {
        const peers: SnapshotPayload['peers'] = []
        this.each(actor => {
            peers.push({
                id: actor.id,
                name: actor.data!.name,
                score: this.scores.get(actor.id) ?? 0,
            })
        })
        return { tick: this.tick, peers }
    }
}

export default WorldRoom
