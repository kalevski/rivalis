/**
 * Guided level 01 — hello-room
 *
 * The absolute minimum Rivalis program:
 *   1. Boot a Rivalis server with a WebSocket transport.
 *   2. Define one Room and create one instance of it.
 *   3. Connect one client actor using a ticket.
 *   4. Client sends a "greeting" message; server echoes it back.
 *   5. Exchange completes, everything shuts down cleanly.
 *
 * Read top-to-bottom — every section is labelled with the Rivalis
 * concept it demonstrates.
 */

import http from 'http'

// ── Core abstractions (framework-agnostic, isomorphic) ───────────────────────
// Rivalis    — the server root: owns transports, the room registry, and auth.
// Room       — an abstract space actors join; you subclass it to add behaviour.
// Actor      — one connected client inside a room.
// AuthMiddleware — validates the per-connection ticket before any room is entered.
import { Rivalis, Room, AuthMiddleware } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'

// ── Node.js transport and client ─────────────────────────────────────────────
// WSTransport wraps the `ws` library: it handles the WebSocket upgrade,
// per-frame encoding/decoding, and plugs sockets into Rivalis's TLayer.
// WSClient is its counterpart on the client side (in the browser you'd use
// the browser package's WSClient instead).
import { WSTransport, WSClient } from '@rivalis/node'

// ── Constants ────────────────────────────────────────────────────────────────
const PORT = 3100            // TCP port the demo listens on
const ROOM_ID = 'lobby'      // logical room name (auth routes clients here)
const TOPIC = 'greeting'     // the single message topic used in this demo
const SERVER_URL = `ws://localhost:${PORT}`

// ════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
//
// Every inbound socket must pass through an AuthMiddleware before it joins a
// room.  authenticate(ticket) receives the raw ticket string the client passed
// to connect() and must return:
//   - null                   → reject the connection
//   - { data, roomId }       → accept, stamp the actor with `data`, route to
//                              the named room
//
// For this example we accept any non-empty ticket and place the actor into
// the one room we have.  The `data` field (actor metadata) is null because we
// don't need per-actor state in a hello-world.

class HelloAuth extends AuthMiddleware {
    override async authenticate(ticket: string): Promise<AuthResult | null> {
        if (!ticket.trim()) {
            return null  // reject blank tickets
        }
        return {
            data: null,   // no per-actor metadata needed here
            roomId: ROOM_ID,
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ROOM
// ════════════════════════════════════════════════════════════════════════════
//
// A Room subclass defines the behaviour of one logical space.  Lifecycle
// hooks let you react to creation, actors joining/leaving, and destruction.
// bind() maps an inbound topic string to a handler method.

class HelloRoom extends Room {

    // onCreate() is called once when the room is first instantiated.
    // This is where you register topic listeners with bind().
    protected override onCreate(): void {
        // bind(topic, handler) — when any actor sends a frame on `topic`,
        // call `handler(actor, payload, topic)`.  The handler is bound to
        // `this` automatically.
        this.bind(TOPIC, this.onGreeting)
    }

    // onJoin(actor) fires each time a new actor enters the room.
    protected override onJoin(actor: Actor): void {
        console.log(`[server] actor joined   id=${actor.id}`)
    }

    // onLeave(actor) fires when an actor disconnects or is kicked.
    protected override onLeave(actor: Actor): void {
        console.log(`[server] actor left     id=${actor.id}`)
    }

    // Topic handler: receives the sending actor plus the raw payload bytes.
    // actor.send() delivers a frame directly back to that one actor.
    private onGreeting(actor: Actor, payload: Uint8Array): void {
        const text = new TextDecoder().decode(payload)
        console.log(`[server] received  "${text}" from id=${actor.id}`)

        // Echo the payload straight back on the same topic.
        actor.send(TOPIC, payload)
        console.log(`[server] echoed    "${text}" back to id=${actor.id}`)
    }

}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

    // ── Server setup ─────────────────────────────────────────────────────────
    //
    // Rivalis attaches to a plain Node http.Server.  This lets you share the
    // same port with an HTTP framework (Express, Fastify, …) when needed.
    const server = http.createServer()

    const rivalis = new Rivalis({
        // transports: the wire protocols Rivalis accepts.
        // WSTransport({ server }) hooks into the server's 'upgrade' event and
        // takes over WebSocket connections.
        transports: [new WSTransport({ server })],

        // authMiddleware: called once per socket, before the actor enters any
        // room.  Return null to reject; return { data, roomId } to accept.
        authMiddleware: new HelloAuth(),
    })

    // Optional: raise the log level so you can see Rivalis's own messages.
    rivalis.logging.level = 'info'

    // ── Room registry ─────────────────────────────────────────────────────────
    //
    // rooms.define(key, RoomClass) — register the class; no instance yet.
    // rooms.create(key, id)        — instantiate the room with a chosen id.
    //   The id is what clients are routed to via AuthMiddleware.roomId.
    rivalis.rooms.define(ROOM_ID, HelloRoom)
    rivalis.rooms.create(ROOM_ID, ROOM_ID)
    console.log(`[server] room "${ROOM_ID}" created`)

    // Start listening.  Wrapped in a Promise so we can await it cleanly.
    await new Promise<void>(resolve => server.listen(PORT, resolve))
    console.log(`[server] listening on ${SERVER_URL}`)

    // ── Client ────────────────────────────────────────────────────────────────
    //
    // WSClient(url) is the Node.js counterpart to the browser WebSocket
    // client.  It speaks the same Rivalis wire protocol and fires topic events
    // just like the Room does on the server.

    const client = new WSClient(SERVER_URL)

    // 'client:connect' fires once the WebSocket handshake succeeds and the
    // actor has been admitted to its room.
    client.on('client:connect', () => {
        console.log('[client] connected')

        // client.send(topic, payload) — payload is a string or Uint8Array.
        const message = 'Hello, Rivalis!'
        console.log(`[client] sending   "${message}" on topic "${TOPIC}"`)
        client.send(TOPIC, message)
    })

    // Topic listeners work exactly like the server's bind(): when the server
    // sends a frame on TOPIC, this callback fires with the raw bytes.
    client.on(TOPIC, (payload: Uint8Array) => {
        const echo = new TextDecoder().decode(payload)
        console.log(`[client] received  "${echo}" ← exchange complete`)

        // We got our echo — disconnect and let the server clean up.
        client.disconnect()
    })

    // 'client:disconnect' fires after the socket closes (clean or otherwise).
    client.on('client:disconnect', async () => {
        console.log('[client] disconnected — shutting down')

        // rivalis.shutdown() gracefully destroys all rooms and disposes
        // every transport.  Always await it so in-flight callbacks finish.
        await rivalis.shutdown()
        server.close()
    })

    // connect(ticket) initiates the WebSocket upgrade.  The ticket is forwarded
    // to HelloAuth.authenticate(), which accepts any non-empty string.
    client.connect('hello-actor')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
