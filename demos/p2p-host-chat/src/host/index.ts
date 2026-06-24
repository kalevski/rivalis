// Host process: connects to the signal server first (becoming the WebRTC host) and runs ChatRoom.

import { Rivalis, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { RTCTransport } from '@rivalis/node'
import { SIGNAL_URL, HOST_SIGNAL_TICKET, ROOM_ID } from '../constants'
import ChatRoom from './ChatRoom'
import type { ActorData } from './ChatRoom'

class ChatAuthMiddleware extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const sep = ticket.indexOf('.')
        if (sep <= 0) return null
        const roomId = ticket.slice(0, sep)
        const name = ticket.slice(sep + 1).trim()
        if (roomId !== ROOM_ID || !name || name.length > 24) return null
        return { data: { name }, roomId }
    }
}

const signalUrl = process.env['SIGNAL_URL'] ?? SIGNAL_URL

const rivalis = new Rivalis<ActorData>({
    transports: [
        new RTCTransport({
            signalUrl,
            ticket: HOST_SIGNAL_TICKET,
        }),
    ],
    authMiddleware: new ChatAuthMiddleware(),
})

rivalis.rooms.define(ROOM_ID, ChatRoom)
rivalis.rooms.create(ROOM_ID, ROOM_ID)

rivalis.logging.level = 'info'

console.log(`host  connecting to signal server at ${signalUrl}`)
console.log(`      game room "${ROOM_ID}" ready — waiting for peers`)
console.log()
console.log(`start peers with:  npm run peer -- <name>`)

process.on('SIGINT', async () => {
    console.log('\nshutting down host...')
    await rivalis.shutdown()
    process.exit(0)
})
