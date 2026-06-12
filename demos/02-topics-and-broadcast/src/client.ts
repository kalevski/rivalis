/**
 * Guided level 02 — topics and broadcast (client)
 *
 * Usage:
 *   npm run client -w @rivalis/guided-02-topics-and-broadcast -- <name>
 *
 * Pass any name you like (Alice, Bob, Carol …).  If you omit it the client
 * picks "guest_<pid>" so multiple anonymous tabs don't collide.
 *
 * What happens automatically once the client connects:
 *   1. Broadcasts a "hello" chat to the whole room.
 *   2. Receives the roster (who is already here) directly from the server.
 *   3. If the roster lists any peers, sends the first one a private DM —
 *      this exercises the single-actor targeted delivery path.
 *   4. Listens for join/leave notices, chat messages, and DMs from others.
 *   5. Disconnects itself after LIFETIME_MS milliseconds.
 */

import { WSClient } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT       = 3101
const SERVER_URL = `ws://localhost:${PORT}`
const LIFETIME_MS = 15_000   // how long the client stays connected

// The actor's display name.  Taken from the command line so multiple terminals
// can connect with different identities.
const NAME = process.argv[2]?.trim() || `guest_${process.pid}`

// ── Wire-message shapes (must match server.ts) ────────────────────────────────
type ChatFrame    = { from: string; text: string }
type DmFrame      = { from: string; text: string }
type NoticeFrame  = { type: 'join' | 'leave'; id: string; name: string }
type RosterFrame  = { you: string; peers: Array<{ id: string; name: string }> }

// Peers we have learned about so far (kept for DM addressing).
const peers = new Map<string, string>()  // actorId → display name

const client = new WSClient(SERVER_URL)

// ════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

client.on('client:connect', () => {
    console.log(`[${NAME}] connected to ${SERVER_URL}`)

    // ── CONCEPT 2: broadcast ──────────────────────────────────────────────────
    //
    // Sending on the 'chat' topic causes the server to call broadcast(), which
    // fans the frame out to EVERY actor in the room — including ourselves.  We
    // will see our own greeting arrive on the 'chat' listener below.
    const greeting = `Hello from ${NAME}!`
    client.send('chat', JSON.stringify({ text: greeting }))
    console.log(`[${NAME}] sent CHAT   "${greeting}"`)
})

client.on('client:disconnect', () => {
    console.log(`[${NAME}] disconnected`)
})

// ════════════════════════════════════════════════════════════════════════════
// TOPIC LISTENERS
// ════════════════════════════════════════════════════════════════════════════

// ── 'roster': direct delivery from the server ─────────────────────────────────
//
// The server sends this only to the actor that just joined — nobody else
// receives it.  It tells us who is already in the room so we can address DMs.
client.on('roster', (payload: Uint8Array) => {
    const { you, peers: list } = JSON.parse(
        new TextDecoder().decode(payload)
    ) as RosterFrame

    const peerNames = list.map(p => p.name).join(', ') || '(none)'
    console.log(`[${NAME}] ROSTER  you=${you}  peers=[${peerNames}]`)

    list.forEach(p => peers.set(p.id, p.name))

    // ── CONCEPT 3: targeted delivery ─────────────────────────────────────────
    //
    // If there is at least one other actor in the room, send them a private DM.
    // The server will route it to that one actor; nobody else receives the frame.
    // Guarding `target !== undefined` satisfies noUncheckedIndexedAccess.
    const target = list[0]
    if (target !== undefined) {
        const text = `Hey ${target.name}, private message from ${NAME}!`
        console.log(`[${NAME}] sent DM     → ${target.name}: "${text}"`)
        client.send('dm', JSON.stringify({ to: target.id, text }))
    }
})

// ── 'notice': broadcast from server on join / leave ───────────────────────────
//
// Every actor in the room receives this, including the one that just joined
// (they get their own join notice because broadcast() reaches everyone).
client.on('notice', (payload: Uint8Array) => {
    const notice = JSON.parse(new TextDecoder().decode(payload)) as NoticeFrame
    if (notice.type === 'join') {
        peers.set(notice.id, notice.name)
        console.log(`[${NAME}] NOTICE  ** ${notice.name} joined  (id=${notice.id})`)
    } else {
        peers.delete(notice.id)
        console.log(`[${NAME}] NOTICE  ** ${notice.name} left    (id=${notice.id})`)
    }
})

// ── 'chat': broadcast message from any actor ──────────────────────────────────
//
// The server fans every chat frame to the whole room, so we see our own
// greeting come back here along with messages from all other actors.
client.on('chat', (payload: Uint8Array) => {
    const { from, text } = JSON.parse(new TextDecoder().decode(payload)) as ChatFrame
    console.log(`[${NAME}] CHAT    <${from}>: ${text}`)
})

// ── 'dm': a private message delivered to exactly this actor ───────────────────
//
// Only this actor receives 'dm' frames targeted at them.
client.on('dm', (payload: Uint8Array) => {
    const { from, text } = JSON.parse(new TextDecoder().decode(payload)) as DmFrame
    console.log(`[${NAME}] DM      [from ${from}] ${text}`)
})

// ════════════════════════════════════════════════════════════════════════════
// CONNECT + AUTO-DISCONNECT
// ════════════════════════════════════════════════════════════════════════════

// The ticket becomes the actor's name (and requested actor ID) on the server.
client.connect(NAME)

// Disconnect automatically so running three client terminals all tidy up on
// their own without needing Ctrl-C.
setTimeout(() => {
    console.log(`[${NAME}] ${LIFETIME_MS / 1000}s elapsed — disconnecting`)
    client.disconnect()
}, LIFETIME_MS)
