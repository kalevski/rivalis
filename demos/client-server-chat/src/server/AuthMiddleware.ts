import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { ROOM_ID } from '../protocol'

export type ActorData = {
    name: string
}

// The ticket is just the client's display name.
class ChatAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name || name.length > 20) return null
        return {
            data: { name },
            roomId: ROOM_ID
        }
    }

}

export default ChatAuthMiddleware
