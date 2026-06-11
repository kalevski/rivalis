/**
 * @rivalis/p2p demo — signal server + P2P game host.
 *
 * Runs two Rivalis instances in one process:
 *
 *   · Signal server — @rivalis/signal's SignalRoom behind a custom auth that
 *     accepts game tickets (`<roomId>|<name>|<color>`) so the browser RTCClient
 *     can send the same ticket to both the signal server and the game host
 *     (the §4.2 first-binary-message ticket protocol).
 *
 *   · Game host — Rivalis + RTCTransport connecting to the signal server above.
 *     Uses the unchanged TttRoom from demo/src/server, proving that room logic
 *     requires zero changes when swapping the transport from WS to RTC.
 *
 * Browser clients: use RTCClient from @rivalis/browser pointed at the signal
 * server (ws://localhost:9000). The ticket format is `ttt|<name>|<color>`,
 * identical to the WS demo. The useRoomRTC hook (p2p/useRoomRTC.ts) is a
 * drop-in replacement for useRoom that wires up RTCClient instead of WSClient.
 *
 * Run:  npm run p2p -w @rivalis/demo   (from repo root)
 *       npm run p2p                     (from demo/)
 */

import { Rivalis, AuthMiddleware, TokenBucketRateLimiter } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { WSTransport, RTCTransport } from '@rivalis/node'
import { SignalRoom } from '@rivalis/signal'
import ArenaAuthMiddleware, { type ActorData } from '../server/AuthMiddleware'
import TttRoom from '../server/TttRoom'
import { SIGNAL_PORT, SIGNAL_ROOM_ID, HOST_SIGNAL_TICKET } from './protocol'

/**
 * Signal auth that accepts game tickets in `<roomId>|<name>|<color>` format.
 *
 * The signal server only needs the room ID to route the peer to the right
 * SignalRoom. Name and color validation is delegated to ArenaAuthMiddleware
 * on the game-host side (the ticket is forwarded verbatim as the first binary
 * message on the data channel — §4.2 ticket protocol).
 *
 * This is intentionally permissive for the demo. A production deployment would
 * use a signed token or a shared secret to prevent unauthorised access to the
 * signal room.
 */
class DemoP2PSignalAuth extends AuthMiddleware<null> {
    override async authenticate(ticket: string): Promise<AuthResult<null> | null> {
        // Ticket format: `<roomId>|<name>|<color>`; extract roomId only.
        const sep = ticket.indexOf('|')
        if (sep <= 0) return null
        const roomId = ticket.slice(0, sep)
        if (!roomId) return null
        return { data: null, roomId }
    }
}

async function main(): Promise<void> {
    // ---- 1. Signal server ---------------------------------------------------
    // A bare Rivalis + WSTransport with DemoP2PSignalAuth + SignalRoom.
    // Mirrors the shape of SignalServer (signal/src/SignalServer.ts) but with
    // the custom auth so peers can send the same game ticket to both the signal
    // server and the game host.

    const signalTransport = new WSTransport(
        { port: SIGNAL_PORT },
        null,
        { ticketSource: 'protocol' },
    )

    const signalRivalis = new Rivalis<null>({
        transports: [signalTransport],
        authMiddleware: new DemoP2PSignalAuth(),
        rateLimiter: new TokenBucketRateLimiter({}),
    })

    signalRivalis.rooms.define('signal', SignalRoom)
    signalRivalis.rooms.create('signal', SIGNAL_ROOM_ID)

    console.log(`signal → ws://localhost:${SIGNAL_PORT}  (signal room: "${SIGNAL_ROOM_ID}")`)

    // ---- 2. Game host -------------------------------------------------------
    // Rivalis + RTCTransport connected to the signal server above.
    // TttRoom is unchanged — identical to the WS demo's demo/src/server/TttRoom.ts.

    const rivalis = new Rivalis<ActorData>({
        transports: [
            new RTCTransport({
                signalUrl: `ws://localhost:${SIGNAL_PORT}`,
                ticket: HOST_SIGNAL_TICKET,
            }),
        ],
        authMiddleware: new ArenaAuthMiddleware(),
    })

    rivalis.logging.level = 'info'

    rivalis.rooms.define('ttt', TttRoom)
    rivalis.rooms.create('ttt', SIGNAL_ROOM_ID)

    console.log(`host  → RTCTransport connected to signal room "${SIGNAL_ROOM_ID}"`)
    console.log(`game  → ttt room ready (unchanged TttRoom over WebRTC)`)
    console.log()
    console.log('browser client:')
    console.log(`  import { RTCClient } from '@rivalis/browser'`)
    console.log(`  const client = new RTCClient('ws://localhost:${SIGNAL_PORT}')`)
    console.log(`  client.connect('ttt|<name>|<color>')`)
    console.log()
    console.log('  — or swap useRoom → useRoomRTC in TicTacToe.tsx (see p2p/useRoomRTC.ts)')
    console.log('  (Ctrl-C to stop)')

    // ---- Graceful shutdown --------------------------------------------------
    process.on('SIGINT', async () => {
        console.log('\nshutting down...')
        await rivalis.shutdown()
        await signalRivalis.shutdown()
        process.exit(0)
    })
}

main().catch((error) => {
    console.error('p2p demo failed:', error)
    process.exit(1)
})
