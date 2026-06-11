/**
 * Peer process for the p2p-host-chat demo.
 *
 * Uses RTCClient to establish a WebRTC DataChannel to the host via the
 * signal server, then exchanges chat messages directly with the host over
 * that channel. The signal server sees zero game traffic after the channel
 * opens (p2p.md §4.1).
 *
 * Ticket: "<roomId>:<name>" (e.g. "chat:alice") — the same string is used
 * for signal server auth (roomId routing) and game room auth (name extraction).
 *
 * Usage:  npm run peer -- <name>
 *         NAME=alice npm run peer
 */

import readline from 'readline'
import { RTCClient } from '@rivalis/node'
import { encode, decode, TOPIC } from '../protocol'
import type { ChatBroadcast, ChatRoster, ChatJoin, ChatLeave } from '../protocol'
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
    prompt: `${name}> `,
})

/** Print a status/incoming line above the prompt without clobbering input. */
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

// ── Client ────────────────────────────────────────────────────────────────────

const client = new RTCClient(signalUrl)

let stopped = false
const shutdown = (code = 0): void => {
    if (stopped) return
    stopped = true
    client.disconnect()
    rl.close()
    process.exit(code)
}

client.on('client:connect', () => {
    print(`connected to host as "${name}"`)
    print('type a message and press Enter to send it to all peers')
    rl.prompt()
}, null)

client.on('client:disconnect', (_payload: Uint8Array) => {
    print('disconnected from host')
    shutdown(0)
}, null)

client.on('client:kicked', (info: { code: number; reason: string }) => {
    print(`kicked by host: ${info.reason} (code ${info.code})`)
    shutdown(1)
}, null)

client.on('client:error', (error: Error) => {
    print(`error: ${error.message}`)
}, null)

client.on(TOPIC.ROSTER, (payload: Uint8Array) => {
    const { peers } = decode<ChatRoster>(payload)
    if (peers.length === 0) {
        print('you are the first peer — no others connected yet')
    } else {
        print(`already connected: ${peers.join(', ')}`)
    }
}, null)

client.on(TOPIC.JOIN, (payload: Uint8Array) => {
    const { name: who } = decode<ChatJoin>(payload)
    print(`* ${who} joined`)
}, null)

client.on(TOPIC.LEAVE, (payload: Uint8Array) => {
    const { name: who } = decode<ChatLeave>(payload)
    print(`* ${who} left`)
}, null)

client.on(TOPIC.BROADCAST, (payload: Uint8Array) => {
    const { name: from, text } = decode<ChatBroadcast>(payload)
    print(`${from}: ${text}`)
}, null)

// ── Input loop ────────────────────────────────────────────────────────────────

rl.on('line', (line: string) => {
    const text = line.trim()
    if (text) {
        if (client.connected) {
            client.send(TOPIC.MESSAGE, encode({ text }))
        } else {
            print('(not connected yet — please wait)')
        }
    }
    rl.prompt()
})

rl.on('close', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

// ── Connect ───────────────────────────────────────────────────────────────────

print(`connecting to signal server at ${signalUrl}...`)
client.connect(ticket)
