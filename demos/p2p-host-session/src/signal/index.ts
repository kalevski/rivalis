/**
 * Signal server for the p2p-host-session demo.
 *
 * Reuses @rivalis/signal's SignalRoom (SDP/ICE relay + host election) wrapped
 * in a Rivalis + WSTransport instance with a demo-grade auth middleware.
 *
 *   Ticket format: "<roomId>:<name>"
 *     roomId — must equal ROOM_ID ('world').
 *     name   — any non-empty string (not validated; demo only).
 *
 * The host process MUST connect before any peer processes so it is the first
 * actor in SignalRoom and is elected the WebRTC negotiation host.
 *
 * ICE: defaults to Google's public STUN.  Override via ICE_STUN_URLS env var.
 */

import http from 'node:http'
import { Rivalis, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'
import { SignalRoom, IceConfig } from '@rivalis/signal'
import { SIGNAL_PORT, ROOM_ID } from '../constants'

// ── Demo auth ─────────────────────────────────────────────────────────────────

class DemoSignalAuth extends AuthMiddleware<null> {
    override async authenticate(ticket: string): Promise<AuthResult<null> | null> {
        const sep = ticket.indexOf(':')
        if (sep <= 0) return null
        const roomId = ticket.slice(0, sep)
        const name = ticket.slice(sep + 1).trim()
        if (roomId !== ROOM_ID || !name) return null
        return { data: null, roomId }
    }
}

// ── SignalRoom: configure STUN for local dev ──────────────────────────────────

class DemoSignalRoom extends SignalRoom {
    protected override iceConfig = new IceConfig({
        turnUrls: [],
        secret: '',
        stunUrls: (process.env['ICE_STUN_URLS'] ?? 'stun:stun.l.google.com:19302')
            .split(',').map(s => s.trim()).filter(Boolean),
    })
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const PORT = Number(process.env['PORT'] ?? SIGNAL_PORT)
const server = http.createServer()

const rivalis = new Rivalis<null>({
    transports: [new WSTransport({ server }, null, { ticketSource: 'protocol' })],
    authMiddleware: new DemoSignalAuth(),
})

rivalis.rooms.define(ROOM_ID, DemoSignalRoom)
rivalis.rooms.create(ROOM_ID, ROOM_ID)

server.listen(PORT, () => {
    console.log(`signal server  ws://localhost:${PORT}`)
    console.log(`room: "${ROOM_ID}"  |  ticket format: "${ROOM_ID}:<name>"`)
    console.log()
    console.log(`start host first:  npm run host`)
    console.log(`then peers:        npm run peer -- <name>`)
})

process.on('SIGINT', async () => {
    await rivalis.shutdown()
    process.exit(0)
})
