import { AuthMiddleware as BaseAuthMiddleware, type AuthResult } from '@rivalis/core'
import { ROOMS, type RoomId } from '../protocol'

export type ActorData = {
    name: string
    color: string
}

const ROOM_SET = new Set<string>(ROOMS)

class ArenaAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const parts = ticket.split('|')
        if (parts.length !== 3) return null
        const [roomId, name, color] = parts
        if (!ROOM_SET.has(roomId ?? '')) return null
        if (!name || name.length > 20) return null
        if (!/^#[0-9a-fA-F]{6}$/.test(color ?? '')) return null
        return {
            data: { name: name as string, color: color as string },
            roomId: roomId as RoomId
        }
    }

}

export default ArenaAuthMiddleware
