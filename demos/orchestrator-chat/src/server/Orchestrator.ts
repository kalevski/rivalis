import type { Rivalis } from '@rivalis/core'
import { ROOM_TYPE } from '../protocol'
import type { ActorData } from './AuthMiddleware'

/**
 * `RoomManager` is not exported from `@rivalis/core`, but `rivalis.rooms` is
 * public — so we name its type structurally off the `Rivalis` instance type.
 * This gives us `get` / `create` / `destroy` / `keys` / `count` without
 * reaching for a non-exported symbol.
 */
type RoomRegistry = Rivalis<ActorData>['rooms']

/**
 * Owns the lifecycle of chat rooms.
 *
 * Unlike the simple chat demo — which pre-creates one hard-coded room at boot
 * — nothing is created up front here. The orchestrator reacts to demand:
 *
 *  - `ensureRoom` spins a room up the first time someone references its name
 *    (called from `ChatAuthMiddleware` *before* the actor is routed in, because
 *    `grantAccess` requires the target room to already exist).
 *  - `releaseIfEmpty` tears a room down the moment its last actor leaves
 *    (called from `ChatRoom.onLeave`), so the server never holds idle rooms.
 *
 * Messages are scoped per room automatically: each `ChatRoom` only broadcasts
 * to its own actors, so two clients in different rooms never see each other.
 */
class Orchestrator {

    private rooms: RoomRegistry

    constructor(rooms: RoomRegistry) {
        this.rooms = rooms
    }

    /** Names of every room currently alive. */
    get activeRooms(): string[] {
        return [...this.rooms.keys()]
    }

    /**
     * Create the room on first reference. Idempotent: repeat joiners of an
     * existing room are a no-op, so it is safe to call on every connection.
     */
    ensureRoom(room: string): void {
        if (this.rooms.get(room) !== null) {
            return
        }
        this.rooms.create(ROOM_TYPE, room)
        console.log(`[orchestrator] spun up room "${room}" — active: [${this.activeRooms.join(', ')}]`)
    }

    /**
     * Dispose the room once it has no actors left. Re-checks `actorCount`
     * defensively so a room that filled back up between the leave and this
     * call is never destroyed out from under its occupants.
     */
    releaseIfEmpty(room: string): void {
        const instance = this.rooms.get(room)
        if (instance === null || instance.actorCount > 0) {
            return
        }
        this.rooms.destroy(room)
        console.log(`[orchestrator] disposed empty room "${room}" — active: [${this.activeRooms.join(', ')}]`)
    }

}

/**
 * The `Room` constructor signature is fixed by the framework, so a `ChatRoom`
 * cannot be handed the orchestrator directly. Both `ChatRoom` and
 * `ChatAuthMiddleware` reach the single live instance through this module
 * singleton, which `server/index.ts` wires up at boot.
 */
let active: Orchestrator | null = null

export const setActiveOrchestrator = (orchestrator: Orchestrator): void => {
    active = orchestrator
}

export const getActiveOrchestrator = (): Orchestrator => {
    if (active === null) {
        throw new Error('orchestrator not initialised — call setActiveOrchestrator() at boot')
    }
    return active
}

export default Orchestrator
