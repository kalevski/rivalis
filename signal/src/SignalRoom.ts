import { Room, Actor } from '@rivalis/core'
import { encodeWelcome, encodeHostElected, encodeHostState, decodeHostState, decodeRelayTo } from './wire/index'
import IceConfig from './IceConfig'

/**
 * Signaling room: relays SDP offers/answers and ICE candidates between peers.
 *
 * Host assignment and election (p2p.md §4.3, §12 Phase 3):
 *  - The first peer to join becomes the host (`hostId`).
 *  - When the host leaves, the oldest remaining peer (next in join order) is
 *    elected as the new host. All remaining peers receive `signal:host_gone`
 *    followed by `signal:host_elected { newHostId }`.
 *  - If no peers remain after the host leaves, only `signal:host_gone` is sent
 *    and `hostId` resets to null (the next joiner becomes host again).
 *  - Join order is tracked in `joinOrder` and is the sole source of determinism
 *    for election races. JavaScript's single-threaded event loop serialises all
 *    `onLeave` calls, so election is always consistent.
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

    /**
     * Stable insertion-order list of actor ids still in the room.
     * Used exclusively for deterministic host election (oldest-peer-first).
     */
    private joinOrder: string[] = []

    /**
     * Serialized room state pushed by the current host via `signal:host_state`
     * before it intentionally disconnects. Forwarded to the newly-elected host
     * immediately after `signal:host_elected` is broadcast. Cleared on every
     * host change so stale state from a previous epoch is never reused.
     *
     * `null` means the outgoing host did not push state (crash, unintentional
     * disconnect, or a room that does not implement `Room.serialize`).
     */
    private pendingHostState: Uint8Array | null = null

    /** ICE/TURN credential issuer. Reads from env vars by default; may be
     *  overridden in a subclass for testing or custom configuration. */
    protected iceConfig: IceConfig = IceConfig.fromEnv()

    protected override onCreate(): void {
        this.bind('signal:offer',      this.relay)
        this.bind('signal:answer',     this.relay)
        this.bind('signal:ice',        this.relay)
        this.bind('signal:host_state', this.receiveHostState)
    }

    protected override onJoin(actor: Actor<null>): void {
        this.joinOrder.push(actor.id)
        if (this.hostId === null) this.hostId = actor.id
        actor.send('signal:welcome', encodeWelcome({
            youId: actor.id,
            hostId: this.hostId,
            iceServers: this.iceConfig.issueFor(actor.id),
        }))
    }

    protected override onLeave(actor: Actor<null>): void {
        this.joinOrder = this.joinOrder.filter(id => id !== actor.id)

        if (actor.id !== this.hostId) return

        // Host has left — notify all remaining peers.
        this.broadcast('signal:host_gone', '')

        const nextHostId = this.joinOrder[0] ?? null
        this.hostId = nextHostId

        if (nextHostId !== null) {
            // Elect the oldest remaining peer and notify everyone.
            this.broadcast('signal:host_elected', encodeHostElected({ newHostId: nextHostId }))

            // Forward serialized room state to the new host if the outgoing host
            // pushed it proactively via signal:host_state (p2p.md §12 Phase 3).
            // Only the new host receives this — bystander peers do not get state.
            const state = this.pendingHostState
            if (state !== null) {
                this.getActor(nextHostId)?.send('signal:host_state', encodeHostState({ state }))
            }
        }

        // Always clear pending state on host change so a stale snapshot from a
        // previous epoch is never delivered to a future host.
        this.pendingHostState = null
    }

    private relay(actor: Actor<null>, payload: Uint8Array, topic: string): void {
        const targetId = decodeRelayTo(payload)
        this.getActor(targetId)?.send(topic, payload)
    }

    /**
     * Receives the outgoing host's serialized room state and buffers it for
     * delivery to the newly-elected host after election.
     *
     * Only the current host may push state. Frames from non-host peers are
     * silently ignored — a malicious peer cannot inject state into the handoff.
     */
    private receiveHostState(actor: Actor<null>, payload: Uint8Array): void {
        if (actor.id !== this.hostId) return
        const decoded = decodeHostState(payload)
        if (decoded !== null) {
            this.pendingHostState = decoded.state
        }
    }
}

export default SignalRoom
