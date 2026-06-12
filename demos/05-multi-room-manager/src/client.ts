/**
 * Guided level 05 — RoomManager (client)
 *
 * Usage:
 *   ts-node src/client.ts [name] [room]
 *
 *   name  — display name (default: a random "guest-NNNN")
 *   room  — target room id (default: "lobby")
 *
 * Pre-packaged script (run from repo root):
 *   npm run client -w @rivalis/guided-05-multi-room-manager -- Alice lobby
 *   npm run client -w @rivalis/guided-05-multi-room-manager -- Bob   arena
 *
 * What to observe:
 *
 *   1. First client into a room → server logs "[manager] CREATED …".
 *   2. Subsequent clients with the same room name join the existing room.
 *   3. Each joining client receives a "welcome" frame with the room id.
 *   4. Other clients in the same room receive __presence:join / __presence:leave.
 *   5. Last client to leave → server logs "[manager] DESTROYED …".
 *   6. Two clients in different rooms never receive each other's echo frames.
 *
 * This client connects, sends a few echo messages, then disconnects.
 * Run it several times concurrently (different names / rooms) to see the
 * full lifecycle play out in the server terminal.
 */

import readline from 'readline'

import { WSClient } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT = 3104
const SERVER_URL = `ws://localhost:${PORT}`

// ── CLI args ──────────────────────────────────────────────────────────────────
const NAME = process.argv[2]?.trim() || `guest-${Math.floor(Math.random() * 9000) + 1000}`
const ROOM = process.argv[3]?.trim() || 'lobby'

// ── Wire helpers ──────────────────────────────────────────────────────────────
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (payload: Uint8Array): string => new TextDecoder().decode(payload)

// ── Client ────────────────────────────────────────────────────────────────────
const client = new WSClient(SERVER_URL)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

/** Print a line above the current prompt without clobbering typed input. */
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

client.on('client:connect', () => {
    print(`connected to ${SERVER_URL} as "${NAME}", requesting room "${ROOM}"...`)
    print('type a message and press Enter to echo it, or Ctrl-C to disconnect')
    rl.prompt()
}, null)

// 'welcome' is sent by EchoRoom.onJoin — confirms which room we landed in.
client.on('welcome', (payload: Uint8Array) => {
    print(`* ${decode(payload)}`)
}, null)

// 'echo' is the round-trip reply from EchoRoom.onEcho.
client.on('echo', (payload: Uint8Array) => {
    print(decode(payload))
}, null)

// __presence:join and __presence:leave are emitted automatically by the room
// (presence = true) whenever another actor joins or leaves.
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

// ── Readline ──────────────────────────────────────────────────────────────────
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

// Connect — ticket is "<name>|<room>".
client.connect(`${NAME}|${ROOM}`)
