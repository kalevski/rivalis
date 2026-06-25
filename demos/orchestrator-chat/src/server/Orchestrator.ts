import type { Rivalis } from '@rivalis/core'
import { ROOM_TYPE } from '../protocol'
import type { ActorData } from './AuthMiddleware'

// RoomManager isn't exported, so name its type structurally off `rivalis.rooms`.
type RoomRegistry = Rivalis<ActorData>['rooms']

// Creates rooms on demand and disposes them once empty.
class Orchestrator {

    private rooms: RoomRegistry

    constructor(rooms: RoomRegistry) {
        this.rooms = rooms
    }

    get activeRooms(): string[] {
        return [...this.rooms.keys()]
    }

    // Idempotent, so it is safe to call on every connection.
    ensureRoom(room: string): void {
        if (this.rooms.get(room) !== null) {
            return
        }
        this.rooms.create(ROOM_TYPE, room)
        console.log(`[orchestrator] spun up room "${room}" — active: [${this.activeRooms.join(', ')}]`)
    }

    releaseIfEmpty(room: string): void {
        const instance = this.rooms.get(room)
        if (instance === null || instance.actorCount > 0) {
            return
        }
        this.rooms.destroy(room)
        console.log(`[orchestrator] disposed empty room "${room}" — active: [${this.activeRooms.join(', ')}]`)
    }

}

// The Room constructor is framework-fixed, so rooms reach the orchestrator
// through this module singleton rather than an injected reference.
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
