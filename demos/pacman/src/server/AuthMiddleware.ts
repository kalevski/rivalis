import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { ROOM_ID } from '../protocol'

export type ActorData = {
    name: string
    color: string
}

/**
 * The ticket a client passes to `connect()` is `name|color` — its display
 * name plus the hex colour of its Pac-Man. We validate both and drop every
 * player into the single `pacman` room.
 */
class PacmanAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const parts = ticket.split('|')
        if (parts.length !== 2) return null
        const [rawName, color] = parts
        const name = (rawName ?? '').trim()
        if (!name || name.length > 20) return null
        if (!/^#[0-9a-fA-F]{6}$/.test(color ?? '')) return null
        return {
            data: { name, color: color as string },
            roomId: ROOM_ID
        }
    }

}

export default PacmanAuthMiddleware
