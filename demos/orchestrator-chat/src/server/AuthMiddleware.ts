import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { parseTicket } from '../protocol'
import { getActiveOrchestrator } from './Orchestrator'

export type ActorData = {
    name: string
}

class ChatAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const parsed = parseTicket(ticket)
        if (parsed === null) {
            return null
        }
        // The room must exist before grantAccess routes the actor in.
        getActiveOrchestrator().ensureRoom(parsed.room)
        return {
            data: { name: parsed.name },
            roomId: parsed.room
        }
    }

}

export default ChatAuthMiddleware
