import type { FleetApi } from '@rivalis/fleet'
import type { PlacementRequest, RoomInfo } from '@rivalis/fleet'

import { MATCH_ROOM_TYPE } from './protocol'

export interface QueuedPlayer {
    name: string
    /** Optional region preference → becomes a placement label pin. */
    region?: string
}

export interface MatchAssignment {
    room: RoomInfo
    players: QueuedPlayer[]
}

/**
 * A toy matchmaker built ON TOP of the fleet API (matchmaking logic itself is a
 * non-goal of the fleet — §3). It batches queued players into pairs and asks the
 * orchestrator to place a match room "somewhere sensible": by default
 * least-loaded across the active instances, or pinned to a region's instances
 * when the players asked for one. The orchestrator picks the instance, creates
 * the room there, and returns the endpoint clients should connect to.
 */
export class Matchmaker {

    private readonly queue: QueuedPlayer[] = []

    constructor(private readonly fleet: FleetApi) {}

    enqueue(...players: QueuedPlayer[]): void {
        this.queue.push(...players)
    }

    get waiting(): number {
        return this.queue.length
    }

    /**
     * Pop pairs off the queue and place a match room for each. `strategy`
     * defaults to least-loaded; pass a region to pin matches to that region's
     * instances. Returns where each pair landed (room id + instance endpoint).
     */
    async formMatches(): Promise<MatchAssignment[]> {
        const assignments: MatchAssignment[] = []
        while (this.queue.length >= 2) {
            const players = [this.queue.shift()!, this.queue.shift()!]
            const placement: PlacementRequest = {}
            // If both players asked for the same region, pin the match there.
            const region = players[0].region
            if (region !== undefined && players.every((p) => p.region === region)) {
                placement.labels = { region }
            }
            const room = await this.fleet.createRoom({ type: MATCH_ROOM_TYPE, placement })
            assignments.push({ room, players })
        }
        return assignments
    }

}
