// Host process: connects to the signal server first (becoming the WebRTC host) and runs WorldRoom.

import { Rivalis, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { RTCTransport } from '@rivalis/node'
import { SIGNAL_URL, HOST_SIGNAL_TICKET, ROOM_ID } from '../constants'
import { TOPIC, encode } from '../protocol'
import type { SessionEndPayload } from '../protocol'
import WorldRoom from './WorldRoom'
import type { ActorData } from './WorldRoom'

class WorldAuthMiddleware extends AuthMiddleware<ActorData> {
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
    authMiddleware: new WorldAuthMiddleware(),
})

rivalis.rooms.define(ROOM_ID, WorldRoom)
rivalis.rooms.create(ROOM_ID, ROOM_ID)

rivalis.logging.level = 'info'

console.log(`host  connecting to signal server at ${signalUrl}`)
console.log(`      authoritative world room "${ROOM_ID}" is ready`)
console.log()
console.log(`start peers with:  npm run peer -- <name>`)
console.log()

process.on('SIGINT', async () => {
    console.log('\nhost shutting down — notifying all peers...')

    // Broadcast SESSION_END while the room and transport are still live, so peers get a clean reason.
    const room = rivalis.rooms.get(ROOM_ID)
    if (room !== null) {
        const msg: SessionEndPayload = { reason: 'host is shutting down' }
        room.broadcast(TOPIC.SESSION_END, encode(msg))
    }

    await rivalis.shutdown()
    process.exit(0)
})
