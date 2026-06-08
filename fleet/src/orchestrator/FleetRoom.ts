/**
 * Internal Rivalis Room (type `@rivalis/fleet`) that hosts connected agents as
 * actors — the orchestrator dogfoods Rivalis for agent transport (§7). Each
 * agent socket is an actor in this single room; the room binds the agent → orch
 * reply topics (`fleet/state`, `fleet/ack`) and forwards every frame, join, and
 * leave to the {@link FleetController} (the Orchestrator).
 *
 * `unknownTopicPolicy = 'kick'` (task 011): under strict orchestrator-driven
 * request/reply, every agent frame must be a reply to an outstanding request — an
 * unbound topic is an unsolicited frame and the agent is kicked. This supersedes
 * the pre-011 `'drop'` forward-compat stance (a major bump now guards
 * compatibility, §7). A frame on a *bound* reply topic still flows to the
 * controller, which checks the correlation id and kicks if it matches no
 * outstanding request.
 *
 * The class is produced by a **factory** rather than declared statically so that
 * `@rivalis/core` is required lazily (the orchestrator loads core inside
 * `listen()`; importing `@rivalis/fleet` must not eagerly drag core's ESM build
 * in — mirrors `FleetAgent`'s lazy `loadCore`). The factory closes over the
 * controller, so the room needs no per-instance wiring after construction.
 */

import { Topics, encodeFrame } from '../wire'

/**
 * A connected agent as seen by the control plane — an abstraction over the
 * core `Actor`. The orchestrator never touches `Actor`/`Room` directly; it sends
 * JSON frames and closes wedged sockets through this seam, which also makes the
 * control plane unit-testable without a live WebSocket (§15).
 */
export interface AgentLink {
    /** Connection-scoped instance id — the actor id assigned by core (§6). */
    readonly instanceId: string
    /** Send a topic frame to this agent; payloads are binary-encoded (§7, task 005). */
    send(topic: string, payload: unknown): void
    /** Kick the agent's socket (used to evict a wedged-but-connected instance, §7). */
    close(): void
}

/** What the FleetRoom forwards into the Orchestrator. Implemented by the Orchestrator. */
export interface FleetController {
    handleAgentJoin(link: AgentLink): void
    handleAgentLeave(instanceId: string): void
    handleAgentMessage(instanceId: string, topic: string, payload: Uint8Array): void
}

type CoreModule = typeof import('@rivalis/core')
/** Loose constructor type for the produced class — see the typing note below. */
type FleetRoomConstructor = new (roomId: string, manager: unknown, transportLayer: unknown, type: string) => unknown
/** What the FleetRoom touches on each actor — the rest of `Actor` is irrelevant here. */
type ActorLike = { id: string }

/** Agent → orch reply topics — bound on the room (§7, task 011). */
const AGENT_TOPICS = [Topics.state, Topics.ack] as const

/**
 * Build the FleetRoom class bound to `controller`, extending the lazily-loaded
 * core `Room`.
 *
 * Typing note: core's `Room`/`Actor` are generic over the per-actor data type and
 * core's `RoomManager`/`TLayer` are not part of its public type surface, so the
 * generic construct-signature of `typeof Room` does not unify cleanly with a
 * concrete subclass here. This bridge only needs the runtime contract — a `Room`
 * subclass with `bind`/`send`/`kick` and the `onCreate`/`onJoin`/`onLeave` hooks —
 * so the base is treated structurally and the produced class is handed to
 * `rooms.define` (which validates `prototype instanceof Room` at runtime).
 */
export function createFleetRoomClass(core: CoreModule, controller: FleetController): FleetRoomConstructor {
    const Base = core.Room as unknown as { new (...args: unknown[]): object }

    class FleetRoom extends Base {

        // Strict request/reply (task 011): an unbound topic is an unsolicited frame
        // → kick. Supersedes the pre-011 'drop' forward-compat stance (§7).
        protected unknownTopicPolicy: 'drop' | 'kick' = 'kick'

        protected onCreate(): void {
            const room = this as unknown as RoomRuntime
            for (const topic of AGENT_TOPICS) {
                room.bind(topic, (actor: ActorLike, payload: Uint8Array) => {
                    // payload is the raw inbound frame body; decoded by the controller.
                    controller.handleAgentMessage(actor.id, topic, payload)
                })
            }
        }

        protected onJoin(actor: ActorLike): void {
            controller.handleAgentJoin(this.linkFor(actor))
        }

        protected onLeave(actor: ActorLike): void {
            controller.handleAgentLeave(actor.id)
        }

        /** Wrap an actor as an {@link AgentLink}; `send`/`kick` are core `Room` methods. */
        private linkFor(actor: ActorLike): AgentLink {
            const room = this as unknown as RoomRuntime
            return {
                instanceId: actor.id,
                send: (topic, payload) => {
                    // Binary wire (§7, task 005): encode the topic payload to a
                    // versioned protobuf frame. core's `Room.send` passes a
                    // `Uint8Array` through untouched (handshake framing is opaque).
                    room.send(actor, topic, encodeFrame(topic, payload))
                },
                close: () => {
                    room.kick(actor)
                }
            }
        }
    }

    return FleetRoom as unknown as FleetRoomConstructor
}

/** Runtime view of the core `Room` methods this bridge calls. */
interface RoomRuntime {
    bind(topic: string, listener: (actor: ActorLike, payload: Uint8Array, topic: string) => void): void
    send(actor: ActorLike, topic: string, payload: Uint8Array | string): void
    kick(actor: ActorLike, payload?: Uint8Array | string): void
}
