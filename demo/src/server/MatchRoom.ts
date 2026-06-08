import { Actor, Room } from '@rivalis/core'
import { encode, type MatchPlayer, type MatchState } from '../fleet/protocol'
import { type ActorData } from './AuthMiddleware'

/**
 * A 2-player match room — the placement target the fleet matchmaker creates on
 * this instance. Defined only when the FleetAgent is enabled (FLEET=1): the
 * orchestrator creates one per match via `fleet/cmd` and clients connect to it
 * on this instance's endpoint. Capacity 2 (`maxActors`) makes a match a match;
 * the connection count it reports back to the agent drives the orchestrator's
 * least-loaded placement for the NEXT match.
 */
class MatchRoom extends Room<ActorData> {

    override maxActors = 2

    protected override onJoin(_actor: Actor<ActorData>): void {
        this.broadcastState()
    }

    protected override onLeave(_actor: Actor<ActorData>): void {
        this.broadcastState()
    }

    private broadcastState(): void {
        const players: MatchPlayer[] = []
        this.each((actor) => {
            if (actor.data === null) return
            players.push({ id: actor.id, name: actor.data.name })
        })
        const state: MatchState = {
            status: players.length >= 2 ? 'playing' : 'waiting',
            players
        }
        this.each((actor) => actor.send('match:state', encode(state)))
    }

}

export default MatchRoom
