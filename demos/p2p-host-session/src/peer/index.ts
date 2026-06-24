// Peer process: connects to the host over WebRTC, shows the live scoreboard, and sends up/down inputs.
// Usage:  npm run peer -- <name>   (or  NAME=alice npm run peer)

import readline from 'readline'
import { RTCClient } from '@rivalis/node'
import { encode, decode, TOPIC } from '../protocol'
import type { SnapshotPayload, PeerJoinPayload, PeerLeavePayload, SessionEndPayload } from '../protocol'
import { SIGNAL_URL, ROOM_ID } from '../constants'

const rawName = (process.argv[2] ?? process.env['NAME'] ?? '').trim()
const name = rawName || `peer-${Math.floor(Math.random() * 9000) + 1000}`
const signalUrl = process.env['SIGNAL_URL'] ?? SIGNAL_URL
const ticket = `${ROOM_ID}.${name}`

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${name} [up/down/quit]> `,
})

// Print a line above the prompt without clobbering pending input.
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

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

client.on('client:kicked', (info: { code: number; reason: string }) => {
    // A prior SESSION_END (or a shutdown/destroy reason) means a clean host exit, so exit 0.
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

// SESSION_END arrives before the close/kick so the peer can show the reason.
client.on(TOPIC.SESSION_END, (payload: Uint8Array) => {
    const { reason } = decode<SessionEndPayload>(payload)
    sessionEnded = true
    print(`\x1b[33msession ended: ${reason}\x1b[0m`)
}, null)

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

print(`connecting to ${signalUrl} as "${name}"...`)
client.connect(ticket)
