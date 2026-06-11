/**
 * Minimal signal server for the p2p-host-chat demo.
 *
 * Reuses @rivalis/signal's SignalRoom (SDP/ICE relay + host election) wrapped
 * in a bare Rivalis + WSTransport instance with a demo-grade auth middleware:
 *
 *   Ticket format: "<roomId>:<name>"
 *     roomId — must equal ROOM_ID ('chat') to join the right room.
 *     name   — any non-empty string; not validated (demo only, not production).
 *
 * The host process MUST connect before any peer processes so it is the first
 * actor in SignalRoom and is elected the WebRTC negotiation host.
 *
 * ICE: defaults to Google's public STUN for convenience. Override by setting
 * ICE_STUN_URLS=stun:… in the environment before starting the signal server.
 * For offline use, start with RIVALIS_STUN_DEV=true and add DevStunResponder.
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

// ── SignalRoom subclass: default STUN for local dev ───────────────────────────

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
    // ticketSource:'protocol' is required: SignalClient sends the auth ticket
    // in the Sec-WebSocket-Protocol header, not a URL query string.
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
