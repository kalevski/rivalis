import { AuthMiddleware as BaseAuthMiddleware } from '@rivalis/core'
import { ROOMS, type RoomId } from '../protocol'

export type ActorData = {
    name: string
    color: string
}

const ROOM_SET = new Set<string>(ROOMS)

class ArenaAuthMiddleware extends BaseAuthMiddleware<ActorData> {

    override async validateTicket(ticket: string): Promise<boolean> {
        const parts = ticket.split('|')
        if (parts.length !== 3) return false
        const [roomId, name, color] = parts
        if (!ROOM_SET.has(roomId ?? '')) return false
        if (!name || name.length > 20) return false
        if (!/^#[0-9a-fA-F]{6}$/.test(color ?? '')) return false
        return true
    }

    override async extractPayload(ticket: string): Promise<ActorData> {
        const [, name, color] = ticket.split('|')
        return { name: name as string, color: color as string }
    }

    override async getRoomId(ticket: string): Promise<string> {
        const [roomId] = ticket.split('|')
        return roomId as RoomId
    }

}

export default ArenaAuthMiddleware
