/**
 * Host process for the p2p-host-session demo.
 *
 * Creates an authoritative Rivalis game server over RTCTransport (WebRTC).
 *
 *   1. Connects to the signal server as the first actor → elected WebRTC host.
 *   2. Accepts peer connections via WebRTC DataChannels (HostNegotiator).
 *   3. Runs WorldRoom: holds scores for all peers, ticks every TICK_MS, and
 *      broadcasts the full authoritative snapshot to every peer after each tick.
 *   4. On SIGINT: sends SESSION_END to all peers, then calls rivalis.shutdown().
 *      Shutdown destroys the room (kicking actors with ROOM_DESTROYED) and
 *      disposes the transport (sending SERVER_SHUTDOWN close frames).
 *      Peers receive SESSION_END first, then client:kicked, then client:disconnect.
 *
 * Auth: the peer's ticket ("<roomId>:<name>") arrives as the first binary
 * message on each DataChannel (RTCTransport §4.2).  WorldAuthMiddleware
 * extracts the name and routes the actor into the "world" room.
 *
 * Start order: signal server → host → peers.
 */

import { Rivalis, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { RTCTransport } from '@rivalis/node'
import { SIGNAL_URL, HOST_SIGNAL_TICKET, ROOM_ID } from '../constants'
import { TOPIC, encode } from '../protocol'
import type { SessionEndPayload } from '../protocol'
import WorldRoom from './WorldRoom'
import type { ActorData } from './WorldRoom'

// ── Auth ──────────────────────────────────────────────────────────────────────

class WorldAuthMiddleware extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        // Ticket format: "<roomId>:<name>"
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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
    console.log('\nhost shutting down — notifying all peers...')

    // Broadcast SESSION_END so peers receive a clean reason before the
    // close frames arrive.  This reaches all currently-open DataChannels
    // because the room and transport are still live at this point.
    const room = rivalis.rooms.get(ROOM_ID)
    if (room !== null) {
        const msg: SessionEndPayload = { reason: 'host is shutting down' }
        room.broadcast(TOPIC.SESSION_END, encode(msg))
    }

    // shutdown() destroys all rooms (kicks actors with ROOM_DESTROYED) and
    // disposes the RTCTransport (sends SERVER_SHUTDOWN close frames over each
    // DataChannel before closing it).  Peers will receive client:kicked with
    // reason "server_shutdown" shortly after the SESSION_END message above.
    await rivalis.shutdown()
    process.exit(0)
})
