import { AuthMiddleware as BaseAuthMiddleware } from '@rivalis/core'

export type ActorData = {
    name: string
    color: string
}

class ArenaAuthMiddleware extends BaseAuthMiddleware {

    private readonly ROOM_ID = 'arena'

    override async validateTicket(ticket: string): Promise<boolean> {
        const parts = ticket.split('|')
        if (parts.length !== 2) return false
        const [name, color] = parts
        if (!name || name.length > 20) return false
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) return false
        return true
    }

    override async extractPayload(ticket: string): Promise<ActorData> {
        const [name, color] = ticket.split('|')
        return { name, color }
    }

    override async getRoomId(_ticket: string): Promise<string> {
        return this.ROOM_ID
    }

}

export default ArenaAuthMiddleware
