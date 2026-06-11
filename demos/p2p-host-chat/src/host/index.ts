/**
 * Host process for the p2p-host-chat demo.
 *
 * Creates a Rivalis game server over RTCTransport (WebRTC). The host:
 *   1. Connects to the signal server as the first actor, which makes it the
 *      WebRTC negotiation host in SignalRoom (p2p.md §4.3).
 *   2. Accepts peer connections via WebRTC DataChannels (HostNegotiator).
 *   3. Runs a ChatRoom that relays messages to all connected peers.
 *
 * Auth: the peer's ticket ("chat:<name>") is the first binary message on the
 * DataChannel (RTCTransport §4.2). ChatAuthMiddleware extracts the name and
 * routes the actor into the "chat" room.
 *
 * Start order: signal server → host → peers.
 */

import { Rivalis, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { RTCTransport } from '@rivalis/node'
import { SIGNAL_URL, HOST_SIGNAL_TICKET, ROOM_ID } from '../constants'
import ChatRoom from './ChatRoom'
import type { ActorData } from './ChatRoom'

// ── Auth ──────────────────────────────────────────────────────────────────────

class ChatAuthMiddleware extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        // Ticket format (same as signal auth): "<roomId>:<name>"
        const sep = ticket.indexOf(':')
        if (sep <= 0) return null
        const roomId = ticket.slice(0, sep)
        const name = ticket.slice(sep + 1).trim()
        if (roomId !== ROOM_ID || !name || name.length > 24) return null
        return { data: { name }, roomId }
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

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
