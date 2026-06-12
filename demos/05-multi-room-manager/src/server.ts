/**
 * Guided level 05 — RoomManager: create, route, list, dispose
 *
 * New concepts in this level (builds on 01–04):
 *
 *   1. rooms.define(key, RoomClass)
 *          Register a room *type* without creating any instance. Many room
 *          instances can share one type; what changes between instances is
 *          only the id and runtime state, not the behaviour class.
 *
 *   2. rooms.create(type, id)
 *          Spin up one room instance on demand. The id is the logical name
 *          clients use to find each other. Must be called before TLayer tries
 *          to route an actor in — that is why it lives in the auth middleware.
 *
 *   3. rooms.get(id)
 *          Look up a live room by id. Returns null when no room with that id
 *          exists. Used for idempotent "ensure" logic: skip creation when the
 *          room is already alive.
 *
 *   4. rooms.destroy(id)
 *          Dispose a room that is no longer needed. All remaining actors are
 *          kicked, onDestroy() runs, and the id is freed from the registry.
 *          Auto-dispose when the last actor leaves keeps the server lean.
 *
 *   5. rooms.count / rooms.keys()
 *          Inspect the live room set at any time — useful for health checks,
 *          routing decisions, and operator dashboards.
 *
 *   6. rooms.on('create', …) / rooms.on('destroy', …)
 *          RoomManager is a Broadcast emitter. Subscribe to lifecycle events
 *          without polling. 'create' passes (roomId, roomType);
 *          'destroy' passes (roomId).
 *
 * Ticket format: "<name>|<room>"
 *
 * Run the server:
 *   npm run start -w @rivalis/guided-05-multi-room-manager
 *
 * Connect clients in separate terminals (each command is one client):
 *   npm run client -w @rivalis/guided-05-multi-room-manager -- Alice lobby
 *   npm run client -w @rivalis/guided-05-multi-room-manager -- Bob  arena
 *   npm run client -w @rivalis/guided-05-multi-room-manager -- Carol lobby
 */

import http from 'http'

import { Rivalis, Room, AuthMiddleware, RoomManager } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT = 3104
const SERVER_URL = `ws://localhost:${PORT}`

/**
 * The single room type registered with `rooms.define`. Every room the server
 * spins up is an instance of EchoRoom; what varies is only the room id (the
 * name the client requested). A real application would define multiple types
 * (e.g. 'lobby', 'match', 'spectator') and call rooms.create with the right
 * key for each context.
 */
const ROOM_TYPE = 'echo'

/** Validation patterns for ticket fields. */
const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/

// ── Actor data ────────────────────────────────────────────────────────────────
type ActorData = { name: string }

// ════════════════════════════════════════════════════════════════════════════
// MODULE SINGLETON — shared RoomManager reference
// ════════════════════════════════════════════════════════════════════════════
//
// The Room constructor signature is fixed by the framework, so EchoRoom cannot
// receive the RoomManager through its constructor. Both EchoRoom.onLeave and
// RoomAuth.authenticate need it, so we wire the reference once at boot via
// setRooms() and let both consumers read it via getRooms(). This is the same
// pattern used by the orchestrator-chat demo.

let _rooms: RoomManager<ActorData> | null = null

const setRooms = (rm: RoomManager<ActorData>): void => { _rooms = rm }

const getRooms = (): RoomManager<ActorData> => {
    if (_rooms === null) throw new Error('rooms not initialised — call setRooms() at boot')
    return _rooms
}

// ════════════════════════════════════════════════════════════════════════════
// ROOM
// ════════════════════════════════════════════════════════════════════════════
//
// EchoRoom is intentionally minimal — the lesson is the manager, not the room
// contents. It echoes every inbound message back to its sender and announces
// joins / leaves to everyone already in the room via the built-in presence
// system. When the last actor leaves it disposes itself through the manager.

class EchoRoom extends Room<ActorData> {

    // presence = true makes the framework auto-broadcast __presence:join and
    // __presence:leave on each join/leave, giving free join/leave notifications
    // to all actors already in the room (see level 01–03 for details).
    protected override presence = true

    protected override onCreate(): void {
        // ── CONCEPT 1 (room side) ─────────────────────────────────────────────
        // onCreate runs once when rooms.create() instantiates this class. Bind
        // topic handlers here; the room is ready to accept actors after this.
        this.bind('echo', this.onEcho)
        console.log(`[room:${this.id}] created  type="${this.type}"`)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[room:${this.id}] JOIN  name="${name}"  occupants=${this.actorCount}`)
        // Send a welcome frame directly to the joining actor so the client
        // can confirm which room the server routed it into.
        actor.send('welcome', `joined room "${this.id}" — ${this.actorCount} here`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[room:${this.id}] LEAVE  name="${name}"  remaining=${this.actorCount}`)

        // ── CONCEPT 4: auto-dispose when empty ────────────────────────────────
        //
        // handleLeave removes the actor from this.actors *before* calling
        // onLeave, so actorCount already reflects the departure. If this was
        // the last actor we call rooms.destroy() to free the slot immediately.
        // The server never accumulates idle empty rooms.
        if (this.actorCount === 0) {
            getRooms().destroy(this.id)
        }
    }

    protected override onDestroy(): void {
        console.log(`[room:${this.id}] destroyed`)
    }

    private onEcho(actor: Actor<ActorData>, payload: Uint8Array): void {
        const text = new TextDecoder().decode(payload).trim().slice(0, 500)
        if (!text) return
        const name = actor.data?.name ?? actor.id
        // Echo back to the sender with attribution.
        actor.send('echo', `[${this.id}] ${name}: ${text}`)
    }

}

// ════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
//
// Ticket format: "<name>|<room>" — e.g. "Alice|lobby".
//
// Authentication happens *before* the actor is routed into any room. That
// means room creation must also happen here: TLayer's grantAccess rejects
// the join if the target room does not yet exist when the actor arrives.

class RoomAuth extends AuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        // Parse and validate the ticket.
        const sep = ticket.indexOf('|')
        if (sep === -1) return null
        const name = ticket.slice(0, sep).trim()
        const roomId = ticket.slice(sep + 1).trim()
        if (!NAME_RE.test(name) || !ROOM_RE.test(roomId)) return null

        // ── CONCEPT 2 + 3: create on demand, idempotent ───────────────────────
        //
        // rooms.get(id) returns the live room or null — O(1) map lookup. We
        // only call rooms.create() when the room is not already alive, making
        // the operation safe to call on every incoming connection.
        const rm = getRooms()
        if (rm.get(roomId) === null) {
            rm.create(ROOM_TYPE, roomId)
        }

        return {
            data: { name },
            roomId,
        }
    }

}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const server = http.createServer()

    const rivalis = new Rivalis<ActorData>({
        transports: [new WSTransport({ server })],
        authMiddleware: new RoomAuth(),
        rateLimiter: null,
    })

    // Keep internal Rivalis logs quiet so the manager lifecycle lines stand out.
    rivalis.logging.level = 'warn'

    // ── CONCEPT 1: register the room type ─────────────────────────────────────
    //
    // define() stores the class in a map keyed by ROOM_TYPE. No instance is
    // created yet — the server starts with zero live rooms. The orchestrator
    // (auth middleware, in this demo) spins instances up on demand via create().
    rivalis.rooms.define(ROOM_TYPE, EchoRoom)

    // ── CONCEPT 6: subscribe to lifecycle events ───────────────────────────────
    //
    // RoomManager extends Broadcast (@toolcase/base), so it fires named events
    // just like Node's EventEmitter. Subscribe before any connection arrives so
    // no events are missed.
    //
    // 'create'  → (roomId: string, roomType: string)
    // 'destroy' → (roomId: string)
    //
    // rooms.count and rooms.keys() are sampled *after* the event — 'create'
    // fires after the room is inserted, 'destroy' fires after it is removed.
    rivalis.rooms.on('create', (roomId: string, roomType: string) => {
        // ── CONCEPT 5: enumerate active rooms ─────────────────────────────────
        const active = [...rivalis.rooms.keys()]
        console.log(
            `[manager] CREATED  id="${roomId}"  type="${roomType}"` +
            `  total=${rivalis.rooms.count}  active=[${active.join(', ')}]`
        )
    })

    rivalis.rooms.on('destroy', (roomId: string) => {
        const active = [...rivalis.rooms.keys()]
        console.log(
            `[manager] DESTROYED  id="${roomId}"` +
            `  total=${rivalis.rooms.count}  active=[${active.join(', ')}]`
        )
    })

    // Wire the singleton so RoomAuth and EchoRoom.onLeave can reach the manager.
    setRooms(rivalis.rooms)

    await new Promise<void>(resolve => server.listen(PORT, resolve))

    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)`)
    console.log('[server] no rooms exist yet — they are created on first join')
    console.log('[server] ---')
    console.log('[server] connect clients in separate terminals:')
    console.log('[server]   npm run client -w @rivalis/guided-05-multi-room-manager -- Alice lobby')
    console.log('[server]   npm run client -w @rivalis/guided-05-multi-room-manager -- Bob   arena')
    console.log('[server]   npm run client -w @rivalis/guided-05-multi-room-manager -- Carol lobby')
    console.log('[server] When the last actor in a room leaves the room is auto-disposed.')

    process.on('SIGINT', async () => {
        console.log('\n[server] shutting down...')
        await rivalis.shutdown()
        server.close(() => process.exit(0))
    })
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
