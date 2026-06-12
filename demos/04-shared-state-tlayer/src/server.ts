/**
 * Guided level 04 — authoritative shared state with TLayer (server)
 *
 * New concepts in this level (builds on 01–03):
 *
 *   1. Server tick loop   — the Room drives all state advances from a fixed
 *                           setInterval started in onCreate().  The server clock
 *                           runs regardless of whether any actor is connected;
 *                           actors observe it, they do not drive it.
 *
 *   2. TLayer delivery    — Room.broadcast() / Room.send() are thin wrappers
 *                           around TLayer.send(actorId, …).  TLayer encodes
 *                           each frame with @rivalis/handshake and forwards it
 *                           to the transport that owns that actor's socket.
 *                           The room never touches the wire directly.
 *
 *   3. Authoritative state — the server owns SharedState.  Clients submit
 *                           *inputs* (increment / reset); the server applies
 *                           them and includes the result in the next snapshot
 *                           broadcast.  Clients never write state directly.
 *
 *   4. Late-join snapshot  — a client that connects mid-session receives the
 *                           current state immediately in onJoin() so it is
 *                           never cold-started with a stale view.
 *
 * Ticket format: "<name>" (any non-empty string)
 *
 * Run the server:
 *   npm run start -w @rivalis/guided-04-shared-state-tlayer
 *
 * Then connect one or more clients in separate terminals:
 *   npm run client:watch  -w @rivalis/guided-04-shared-state-tlayer
 *   npm run client:mutate -w @rivalis/guided-04-shared-state-tlayer
 */

import http from 'http'

import { Rivalis, Room, AuthMiddleware } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT = 3103
const ROOM_ID = 'state-room'
const SERVER_URL = `ws://localhost:${PORT}`

// Tick interval in milliseconds.  The server advances state and broadcasts a
// snapshot to all connected actors on every tick.
const TICK_RATE_MS = 1_000

// ── Actor data ────────────────────────────────────────────────────────────────
type ActorData = { name: string }

// ── Wire types ────────────────────────────────────────────────────────────────

/** Server → client: broadcast on every tick and sent on join. */
type SnapshotFrame = {
    tick: number
    counter: number
    lastMutatedBy: string | null
}

/** Client → server: add `amount` to the shared counter. */
type IncrementInput = { amount: number }

// ════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
//
// Any non-empty ticket is accepted and treated as the actor's display name.
// The name is also requested as the actor ID (see level 02 for details).

class NameAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name) {
            return null
        }
        return {
            data: { name },
            roomId: ROOM_ID,
            actorId: name,
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED STATE
// ════════════════════════════════════════════════════════════════════════════
//
// SharedState is the single source of truth for the room.  It lives entirely
// on the server; clients never hold an authoritative copy — only the latest
// snapshot they received.
//
//   tick           — monotonically incremented once per server tick.  Clients
//                    can use this to detect missed snapshots or to measure
//                    how many ticks have passed since they last connected.
//
//   counter        — a mutable shared value any actor can increment or reset.
//
//   lastMutatedBy  — the name of the most recent actor that changed counter,
//                    or null when the counter has never been touched.

type SharedState = {
    tick: number
    counter: number
    lastMutatedBy: string | null
}

// ════════════════════════════════════════════════════════════════════════════
// ROOM
// ════════════════════════════════════════════════════════════════════════════

class StateRoom extends Room<ActorData> {

    // Server-authoritative state — only this Room reads or writes it.
    private state: SharedState = { tick: 0, counter: 0, lastMutatedBy: null }

    private tickTimer: NodeJS.Timeout | null = null

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    protected override onCreate(): void {
        // Register inbound topic handlers (see level 02 for bind() details).
        this.bind('increment', this.onIncrement)
        this.bind('reset', this.onReset)

        // ── CONCEPT 1: server tick loop ────────────────────────────────────────
        //
        // The interval fires at TICK_RATE_MS regardless of actor presence.
        // The server clock is independent of connections; actors observe it.
        // onDestroy() clears the timer to avoid leaking after room teardown.
        this.tickTimer = setInterval(() => this.onTick(), TICK_RATE_MS)
        console.log(`[room] created  tick=${TICK_RATE_MS}ms`)
    }

    // ── CONCEPT 4: late-join snapshot ─────────────────────────────────────────
    //
    // onJoin fires after the actor is fully registered in the room (see Room.ts
    // handleJoin).  Sending the snapshot here ensures the new actor sees the
    // current state instantly rather than waiting up to TICK_RATE_MS for the
    // next broadcast.
    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(
            `[room] JOIN  name="${name}"` +
            `  tick=${this.state.tick}  counter=${this.state.counter}` +
            `  total=${this.actorCount}`
        )
        // Send the current snapshot directly to the joining actor via TLayer.
        // Room.send(actor, topic, payload) → TLayer.send(actorId, topic, payload)
        // → encoded frame lands on the actor's WebSocket.
        actor.send('snapshot', JSON.stringify(this.buildSnapshot()))
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[room] LEAVE  name="${name}"  remaining=${this.actorCount}`)
    }

    protected override onDestroy(): void {
        if (this.tickTimer !== null) {
            clearInterval(this.tickTimer)
            this.tickTimer = null
        }
        console.log('[room] destroyed — tick loop stopped')
    }

    // ── Tick ──────────────────────────────────────────────────────────────────

    // ── CONCEPT 2: TLayer delivery via broadcast ───────────────────────────────
    //
    // broadcast(topic, payload) iterates every joined actor and calls
    // TLayer.send(actorId, topic, bytes) for each one.  TLayer encodes the frame
    // (topic-length prefix + topic bytes + payload bytes) and hands it to the
    // transport that owns the actor's socket.  The Room never touches the socket.
    private onTick(): void {
        this.state.tick += 1
        const snap = this.buildSnapshot()

        console.log(
            `[tick] #${String(this.state.tick).padStart(4, '0')}` +
            `  counter=${this.state.counter}` +
            `  lastMutatedBy=${this.state.lastMutatedBy ?? '(none)'}` +
            `  actors=${this.actorCount}`
        )

        if (this.actorCount > 0) {
            this.broadcast('snapshot', JSON.stringify(snap))
        }
    }

    // ── Input handlers ────────────────────────────────────────────────────────

    // ── CONCEPT 3: authoritative state mutation via inputs ─────────────────────
    //
    // The client sends an *input* — an intent to change the state.  The server
    // decides whether and how to apply it.  Here the amount is clamped to ±100
    // to prevent unreasonably large jumps in a single frame.
    //
    // The mutation is applied immediately, but the client does NOT receive a
    // targeted acknowledgement.  The change will appear in the next tick's
    // broadcast snapshot, which every connected actor (including the sender)
    // will receive.  This keeps the state flow unidirectional:
    //
    //   client input → server applies → tick broadcast → all clients
    private onIncrement(actor: Actor<ActorData>, payload: Uint8Array): void {
        const { amount } = JSON.parse(new TextDecoder().decode(payload)) as IncrementInput
        const clamped = Math.max(-100, Math.min(100, Math.round(amount)))
        const name = actor.data?.name ?? actor.id

        this.state.counter += clamped
        this.state.lastMutatedBy = name

        console.log(
            `[room] INCREMENT  from="${name}"` +
            `  amount=${clamped >= 0 ? '+' : ''}${clamped}` +
            `  counter=${this.state.counter}`
        )
    }

    private onReset(actor: Actor<ActorData>, _payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        const before = this.state.counter

        this.state.counter = 0
        this.state.lastMutatedBy = name

        console.log(`[room] RESET  from="${name}"  before=${before}  after=0`)
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private buildSnapshot(): SnapshotFrame {
        return {
            tick: this.state.tick,
            counter: this.state.counter,
            lastMutatedBy: this.state.lastMutatedBy,
        }
    }

}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const server = http.createServer()

    // ── Config / TLayer wiring ─────────────────────────────────────────────────
    //
    // Rivalis accepts a ConfigOptions object.  Internally it constructs a Config
    // instance (which validates and normalises the options) and a TLayer instance
    // (the transport layer).  TLayer wires every Transport to the Room registry:
    //
    //   Transport (ws socket) ──► TLayer ──► Room.handleMessage / handleJoin / handleLeave
    //                                  ◄────────── Room.broadcast / Room.send
    //
    // Passing rateLimiter: null opts out of the default TokenBucketRateLimiter so
    // the demo is not accidentally rate-limited during rapid testing.
    const rivalis = new Rivalis<ActorData>({
        transports: [new WSTransport({ server })],
        authMiddleware: new NameAuth(),
        rateLimiter: null,
    })

    rivalis.logging.level = 'warn'

    rivalis.rooms.define(ROOM_ID, StateRoom)
    rivalis.rooms.create(ROOM_ID, ROOM_ID)

    await new Promise<void>(resolve => server.listen(PORT, resolve))

    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)`)
    console.log(`[server] room "${ROOM_ID}" ready  tickRate=${TICK_RATE_MS}ms`)
    console.log('[server] ---')
    console.log('[server] run clients in separate terminals:')
    console.log('[server]   npm run client:watch  -w @rivalis/guided-04-shared-state-tlayer')
    console.log('[server]   npm run client:mutate -w @rivalis/guided-04-shared-state-tlayer')
    console.log('[server]   or supply a custom name / mode:')
    console.log('[server]   ts-node src/client.ts Alice watch')
    console.log('[server]   ts-node src/client.ts Bob   mutate')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
