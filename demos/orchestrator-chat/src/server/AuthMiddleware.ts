import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { parseTicket } from '../protocol'
import { getActiveOrchestrator } from './Orchestrator'

export type ActorData = {
    name: string
}

/**
 * The ticket a client passes to `connect()` is `"<name>|<room>"`. We validate
 * it, then ask the orchestrator to spin the requested room up *before*
 * returning its id — `TLayer.grantAccess` rejects the join if the room does
 * not yet exist, so room creation has to happen here, in the auth step.
 */
class ChatAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const parsed = parseTicket(ticket)
        if (parsed === null) {
            return null
        }
        getActiveOrchestrator().ensureRoom(parsed.room)
        return {
            data: { name: parsed.name },
            roomId: parsed.room
        }
    }

}

export default ChatAuthMiddleware
