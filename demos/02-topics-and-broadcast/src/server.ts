/**
 * Guided level 02 — topics and broadcast (server)
 *
 * New concepts in this level (builds on 01-hello-room):
 *
 *   1. Named topic subscription  — bind() a handler for each inbound topic.
 *   2. Broadcast                 — broadcast() fans a frame out to EVERY actor.
 *   3. Direct (targeted) send    — actor.send() / room.send() reaches ONE actor.
 *   4. Join / leave lifecycle    — onJoin / onLeave react to actors entering or
 *                                  leaving the room.
 *
 * Run this server first, then connect clients with:
 *   npm run client -w @rivalis/guided-02-topics-and-broadcast -- Alice
 */

import http from 'http'

// Same core imports as level 01.  Actor is only needed as a type here.
import { Rivalis, Room, AuthMiddleware } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT      = 3101
const ROOM_ID   = 'lobby'
const SERVER_URL = `ws://localhost:${PORT}`

// ── Actor data ────────────────────────────────────────────────────────────────
//
// By giving Room a type parameter we get typed actor.data throughout the Room.
// The auth middleware stamps this onto every actor that joins.
type ActorData = { name: string }

// ── Wire-message shapes ───────────────────────────────────────────────────────
//
// All payloads in this demo are JSON strings.  Keeping the shapes explicit
// makes it easier to follow the data flow without opening the client file.

/** Server → all:  a chat message from one actor fanned out to the room. */
type ChatFrame = { from: string; text: string }

/** Client → server:  a private message intended for a single actor. */
type DmRequest = { to: string; text: string }

/** Server → target:  a private message delivered to exactly one actor. */
type DmFrame = { from: string; text: string }

/** Server → all:  room event (actor joined or left). */
type NoticeFrame = { type: 'join' | 'leave'; id: string; name: string }

/** Server → joining actor only:  who is already in the room. */
type RosterFrame = { you: string; peers: Array<{ id: string; name: string }> }

// ════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
//
// The ticket is the actor's chosen display name.  We use it as both the
// actor's data payload (for readable log lines) and as the requested
// actor ID (so logs show "Alice" instead of a UUID).
//
// If two clients connect with the same name, the second gets a random UUID
// as its actor ID — the requested ID is only honored when it is not taken.

class BroadcastAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name) {
            return null  // reject blank tickets
        }
        return {
            data: { name },
            roomId: ROOM_ID,
            actorId: name,  // request name-as-id for readable demo output
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ROOM
// ════════════════════════════════════════════════════════════════════════════

class BroadcastRoom extends Room<ActorData> {

    // ── Topic registration ────────────────────────────────────────────────────
    //
    // onCreate() is the right place to call bind().  Calling bind() outside of
    // onCreate() (e.g. in a constructor) runs before the base class has finished
    // initialising and will not work.
    protected override onCreate(): void {
        this.bind('chat', this.onChat)  // any actor sends text → broadcast to all
        this.bind('dm',   this.onDm)   // actor sends { to, text } → single actor
    }

    // ── Join / leave lifecycle ────────────────────────────────────────────────
    //
    // onJoin fires after the actor has been added to the room's actor map, so
    // actorCount already includes the newcomer and broadcast() reaches them.

    protected override onJoin(actor: Actor<ActorData>): void {
        const { id } = actor
        const name   = actor.data?.name ?? id

        console.log(`[server] JOIN   ${name}  (id=${id})  total=${this.actorCount}`)

        // ── CONCEPT 3: direct send ────────────────────────────────────────────
        //
        // Send the joining actor their own ID plus a list of who is already
        // here.  actor.send() delivers the frame to exactly this one actor.
        // No other actors receive the roster frame.
        const peers: RosterFrame['peers'] = []
        this.each(a => {
            if (a.id !== id) {
                peers.push({ id: a.id, name: a.data?.name ?? a.id })
            }
        })
        actor.send('roster', JSON.stringify({ you: id, peers } as RosterFrame))
        console.log(`[server] ROSTER → ${name}  peers=[${peers.map(p => p.name).join(', ') || '(none)'}]`)

        // ── CONCEPT 2: broadcast ──────────────────────────────────────────────
        //
        // Announce the join to EVERY actor in the room (including the one that
        // just joined — they receive their own join notice).
        this.broadcast('notice', JSON.stringify({ type: 'join', id, name } as NoticeFrame))
    }

    // onLeave fires after the actor has been removed from the room's actor map,
    // so actorCount no longer includes the leaver and broadcast() skips them.
    protected override onLeave(actor: Actor<ActorData>): void {
        const { id } = actor
        const name   = actor.data?.name ?? id

        console.log(`[server] LEAVE  ${name}  (id=${id})  remaining=${this.actorCount}`)

        // Broadcast the leave notice to the actors still in the room.
        this.broadcast('notice', JSON.stringify({ type: 'leave', id, name } as NoticeFrame))
    }

    // ── Topic handlers ────────────────────────────────────────────────────────

    // 'chat': an actor sends a text message.  The server fans it to all actors
    // (including the sender) via broadcast().
    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const { text } = JSON.parse(new TextDecoder().decode(payload)) as { text: string }
        const from      = actor.data?.name ?? actor.id

        console.log(`[server] CHAT   <${from}>: ${text}`)

        // ── CONCEPT 2: broadcast ──────────────────────────────────────────────
        // broadcast(topic, payload) iterates all actors and sends to each one.
        this.broadcast('chat', JSON.stringify({ from, text } as ChatFrame))
    }

    // 'dm': an actor sends a private message to a specific peer by actor ID.
    // Only the target receives the delivery frame.
    private onDm(sender: Actor<ActorData>, payload: Uint8Array): void {
        const { to, text } = JSON.parse(new TextDecoder().decode(payload)) as DmRequest
        const from          = sender.data?.name ?? sender.id

        // ── CONCEPT 3: direct send ────────────────────────────────────────────
        //
        // getActor(id) is a protected Room method that looks up any joined actor
        // by their ID.  Returns null when no such actor is currently in the room.
        const target = this.getActor(to)
        if (target === null) {
            console.log(`[server] DM     from=${from} to=${to} — target not found, dropping`)
            return
        }

        const targetName = target.data?.name ?? target.id
        console.log(`[server] DM     <${from}> → <${targetName}>: ${text}`)

        // actor.send() / room.send(actor, …) delivers to exactly one actor.
        target.send('dm', JSON.stringify({ from, text } as DmFrame))
    }

}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const server  = http.createServer()
    const rivalis = new Rivalis({
        transports:     [new WSTransport({ server })],
        authMiddleware: new BroadcastAuth(),
    })

    // Suppress framework-level info noise; our console.log lines tell the story.
    rivalis.logging.level = 'warn'

    rivalis.rooms.define(ROOM_ID, BroadcastRoom)
    rivalis.rooms.create(ROOM_ID, ROOM_ID)
    console.log(`[server] room "${ROOM_ID}" ready`)

    await new Promise<void>(resolve => server.listen(PORT, resolve))
    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)\n`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
