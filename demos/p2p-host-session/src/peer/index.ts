/**
 * Peer process for the p2p-host-session demo.
 *
 * Uses RTCClient to establish a WebRTC DataChannel to the host via the
 * signal server.  Once connected the peer:
 *
 *   - Receives periodic snapshots from the host and displays a live scoreboard.
 *   - Receives join/leave notifications from the host.
 *   - Sends INPUT commands ("up" or "down") to increment or decrement its own
 *     score.  Only the host applies these — peers cannot mutate state directly.
 *   - Handles host departure: the host sends SESSION_END before shutting down,
 *     so the peer sees the reason.  Shortly after, `client:kicked` arrives with
 *     SERVER_SHUTDOWN and the peer exits cleanly.
 *
 * Usage:  npm run peer -- <name>
 *         NAME=alice npm run peer
 */

import readline from 'readline'
import { RTCClient } from '@rivalis/node'
import { encode, decode, TOPIC } from '../protocol'
import type { SnapshotPayload, PeerJoinPayload, PeerLeavePayload, SessionEndPayload } from '../protocol'
import { SIGNAL_URL, ROOM_ID } from '../constants'

// ── Config ────────────────────────────────────────────────────────────────────

const rawName = (process.argv[2] ?? process.env['NAME'] ?? '').trim()
const name = rawName || `peer-${Math.floor(Math.random() * 9000) + 1000}`
const signalUrl = process.env['SIGNAL_URL'] ?? SIGNAL_URL
const ticket = `${ROOM_ID}:${name}`

// ── UI helpers ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${name} [up/down/quit]> `,
})

/** Print a line above the current prompt without clobbering pending input. */
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

// ── Client ────────────────────────────────────────────────────────────────────

const client = new RTCClient(signalUrl)

let stopped = false
let sessionEnded = false  // set when SESSION_END arrives before the close frame

const shutdown = (code = 0): void => {
    if (stopped) return
    stopped = true
    client.disconnect()
    rl.close()
    process.exit(code)
}

client.on('client:connect', () => {
    print(`connected to host as "${name}"`)
    print('commands: up (score +1)  down (score -1)  quit')
    rl.prompt()
}, null)

client.on('client:disconnect', (_payload: Uint8Array) => {
    print('disconnected from host')
    shutdown(0)
}, null)

/**
 * client:kicked fires when the host sends a §3.4 control frame before closing
 * the DataChannel.  Reasons you may see:
 *
 *   server_shutdown — RTCTransport.dispose() on a normal host exit.
 *   room_destroyed  — rivalis.shutdown() destroyed the room (via handleDestroy).
 *   rate_limited    — the peer sent too many frames too quickly.
 *   invalid_ticket  — the ticket was rejected by WorldAuthMiddleware.
 *
 * When SESSION_END was already received we know it was a clean host shutdown,
 * so we exit with code 0 rather than 1.
 */
client.on('client:kicked', (info: { code: number; reason: string }) => {
    const isCleanShutdown =
        sessionEnded ||
        info.reason === 'server_shutdown' ||
        info.reason === 'room_destroyed'
    if (isCleanShutdown) {
        print(`host ended the session (${info.reason})`)
        shutdown(0)
    } else {
        print(`kicked by host: ${info.reason} (code ${info.code})`)
        shutdown(1)
    }
}, null)

client.on('client:error', (error: Error) => {
    print(`error: ${error.message}`)
}, null)

// ── Game messages ─────────────────────────────────────────────────────────────

client.on(TOPIC.SNAPSHOT, (payload: Uint8Array) => {
    const snap = decode<SnapshotPayload>(payload)
    const sorted = snap.peers.slice().sort((a, b) => b.score - a.score)
    const board = sorted
        .map((p, i) => `  ${i + 1}. ${p.name === name ? '\x1b[1m' : ''}${p.name}: ${p.score}${p.name === name ? '\x1b[0m' : ''}`)
        .join('\n')
    print(`── tick ${snap.tick} ─────────────────\n${board}`)
}, null)

client.on(TOPIC.PEER_JOIN, (payload: Uint8Array) => {
    const { name: who } = decode<PeerJoinPayload>(payload)
    print(`* ${who} joined the session`)
}, null)

client.on(TOPIC.PEER_LEAVE, (payload: Uint8Array) => {
    const { name: who } = decode<PeerLeavePayload>(payload)
    print(`* ${who} left the session`)
}, null)

/**
 * SESSION_END is sent by the host process immediately before shutdown.
 * It arrives before the DataChannel close/kick so the peer sees the reason.
 * The connection still closes normally after this — shutdown() exits cleanly.
 */
client.on(TOPIC.SESSION_END, (payload: Uint8Array) => {
    const { reason } = decode<SessionEndPayload>(payload)
    sessionEnded = true
    print(`\x1b[33msession ended: ${reason}\x1b[0m`)
}, null)

// ── Input loop ────────────────────────────────────────────────────────────────

rl.on('line', (line: string) => {
    const cmd = line.trim().toLowerCase()
    if (cmd === 'quit') {
        shutdown(0)
        return
    }
    if (!client.connected) {
        print('(not connected yet — please wait)')
        rl.prompt()
        return
    }
    if (cmd === 'up') {
        client.send(TOPIC.INPUT, encode({ action: 'up' }))
    } else if (cmd === 'down') {
        client.send(TOPIC.INPUT, encode({ action: 'down' }))
    } else if (cmd) {
        print('unknown command — use: up, down, quit')
    }
    rl.prompt()
})

rl.on('close', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

// ── Connect ───────────────────────────────────────────────────────────────────

print(`connecting to ${signalUrl} as "${name}"...`)
client.connect(ticket)
