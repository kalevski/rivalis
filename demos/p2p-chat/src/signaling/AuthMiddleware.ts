import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { SIGNALING_ROOM_ID } from '../constants'

export type ActorData = {
    name: string
}

/**
 * The ticket a peer passes to `connect()` is simply its display name. We
 * validate it and route every peer into the single signalling room, whose
 * `maxActors` cap is what enforces the 10-participant limit.
 */
class SignalingAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name || name.length > 20) return null
        return {
            data: { name },
            roomId: SIGNALING_ROOM_ID
        }
    }

}

export default SignalingAuthMiddleware
