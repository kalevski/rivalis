// Guided level 05 — RoomManager (client). Usage: ts-node src/client.ts [name] [room]

import readline from 'readline'

import { WSClient } from '@rivalis/node'

const PORT = 3104
const SERVER_URL = `ws://localhost:${PORT}`

const NAME = process.argv[2]?.trim() || `guest-${Math.floor(Math.random() * 9000) + 1000}`
const ROOM = process.argv[3]?.trim() || 'lobby'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (payload: Uint8Array): string => new TextDecoder().decode(payload)

const client = new WSClient(SERVER_URL)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

// Print a line above the current prompt without clobbering typed input.
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

client.on('client:connect', () => {
    print(`connected to ${SERVER_URL} as "${NAME}", requesting room "${ROOM}"...`)
    print('type a message and press Enter to echo it, or Ctrl-C to disconnect')
    rl.prompt()
}, null)

client.on('welcome', (payload: Uint8Array) => {
    print(`* ${decode(payload)}`)
}, null)

client.on('echo', (payload: Uint8Array) => {
    print(decode(payload))
}, null)

client.on('__presence:join', (payload: Uint8Array) => {
    const { data } = JSON.parse(decode(payload)) as { id: string; data: { name: string } }
    print(`* ${data.name} joined the room`)
}, null)

client.on('__presence:leave', (payload: Uint8Array) => {
    const { data } = JSON.parse(decode(payload)) as { id: string; data: { name: string } }
    print(`* ${data.name} left the room`)
}, null)

client.on('client:disconnect', (payload: Uint8Array) => {
    const reason = decode(payload)
    if (reason) {
        print(`disconnected: ${reason}`)
    } else {
        print('disconnected')
    }
    rl.close()
    process.exit(0)
}, null)

client.on('client:error', (err: Error) => {
    print(`error: ${err.message}`)
}, null)

rl.on('line', (line) => {
    const text = line.trim()
    if (text) {
        client.send('echo', encode(text))
    }
    rl.prompt()
})

rl.on('close', () => {
    client.disconnect()
    process.exit(0)
})

// Ticket is "<name>|<room>".
client.connect(`${NAME}|${ROOM}`)
