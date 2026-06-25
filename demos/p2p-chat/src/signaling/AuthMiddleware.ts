import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { SIGNALING_ROOM_ID } from '../constants'

export type ActorData = {
    name: string
}

// The ticket is just the peer's display name; every peer is routed into the one signalling room.
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
