import readline from 'readline'

import { Clients } from '@rivalis/core'
import {
    encode,
    decode,
    type ChatCommand,
    type ChatEvent,
    type WelcomeEvent,
    type PresenceEvent
} from '../protocol'

const URL = process.env.RIVALIS_URL ?? 'ws://localhost:8080'
const name = (process.argv[2] ?? process.env.NAME ?? `guest-${Math.floor(Math.random() * 9000) + 1000}`).trim()

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
})

/** Print an incoming line above the prompt without clobbering the input. */
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

// The Node WebSocket client ships inside `@rivalis/core` as `Clients.WSClient`.
const client = new Clients.WSClient(URL)

let youId = ''

client.on('client:connect', () => {
    print(`connected to ${URL} as "${name}"`)
}, null)

client.on('welcome', (payload: Uint8Array) => {
    youId = decode<WelcomeEvent>(payload).youId
}, null)

client.on('chat', (payload: Uint8Array) => {
    const event = decode<ChatEvent>(payload)
    if (event.from === youId) return // skip our own echo
    print(`${event.name}: ${event.text}`)
}, null)

client.on('__presence:join', (payload: Uint8Array) => {
    const event = decode<PresenceEvent>(payload)
    if (event.id === youId) return // skip our own join
    print(`* ${event.data.name} joined`)
}, null)

client.on('__presence:leave', (payload: Uint8Array) => {
    const event = decode<PresenceEvent>(payload)
    print(`* ${event.data.name} left`)
}, null)

client.on('client:disconnect', (payload: Uint8Array) => {
    const reason = new TextDecoder().decode(payload)
    print(`disconnected${reason ? `: ${reason}` : ''}`)
    process.exit(0)
}, null)

// The ticket is just the display name — see ChatAuthMiddleware.
client.connect(name)
rl.prompt()

rl.on('line', (line) => {
    const text = line.trim()
    if (text) {
        const command: ChatCommand = { text }
        client.send('chat', encode(command))
    }
    rl.prompt()
})

rl.on('close', () => {
    client.disconnect()
    process.exit(0)
})
