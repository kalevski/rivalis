/**
 * Guided level 03 — auth, rate limiting, and kicks (server)
 *
 * New concepts in this level (builds on 01 and 02):
 *
 *   1. AuthMiddleware     — validate a ticket before the actor enters any room.
 *                          Invalid tickets are rejected at connect time with
 *                          CloseCode.INVALID_TICKET.
 *   2. TokenBucketRateLimiter — throttle actors that send too fast.
 *                          Actors exhausting the bucket are kicked with
 *                          KickReason.RATE_LIMITED.
 *   3. ConnectionLimiter  — cap how many raw TCP connections a single IP
 *                          may open in a sliding time window, before auth
 *                          runs. Over-cap sockets are closed immediately.
 *   4. Explicit kick      — the server may disconnect any actor at any time
 *                          with actor.kick(reason), passing a KickReason
 *                          string as the WebSocket close-frame payload.
 *
 * Ticket format: "<name>:<secret>"
 *   valid   → secret === "rivalis"   e.g. "Alice:rivalis"
 *   invalid → anything else          e.g. "Alice:wrongpass"
 */

import http from 'http'

import {
    Rivalis,
    Room,
    AuthMiddleware,
    TokenBucketRateLimiter,
    ConnectionLimiter,
    KickReason,
    timingSafeCompare,
} from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT = 3102
const ROOM_ID = 'lobby'
const SERVER_URL = `ws://localhost:${PORT}`

// The shared secret that must appear after the colon in the ticket.
const TICKET_SECRET = 'rivalis'

// Room cap — at most 2 actors joined at once.
const MAX_ACTORS_IN_ROOM = 2

// Connection limiter window — at most 3 raw TCP connections per IP in 10 s.
const CONN_LIMIT_MAX = 3
const CONN_LIMIT_WINDOW_MS = 10_000

// ── Actor data ────────────────────────────────────────────────────────────────
type ActorData = { name: string }

// ════════════════════════════════════════════════════════════════════════════
// 1. AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
//
// authenticate(ticket) is called once per inbound socket, before the actor
// joins any room.  Return null to reject; return { data, roomId } to accept.
//
// Ticket format: "<name>:<secret>"
//   - Split on the first colon.
//   - Compare the secret with timingSafeCompare (not ===) so timing-oracle
//     attacks cannot leak the common prefix length.
//   - Reject tickets that are missing the separator or have a blank name.

class TicketAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const sep = ticket.indexOf(':')
        if (sep <= 0) {
            console.log('[auth] rejected — ticket missing ":" separator')
            return null
        }

        const name = ticket.slice(0, sep).trim()
        const secret = ticket.slice(sep + 1)

        if (!name) {
            console.log('[auth] rejected — blank name in ticket')
            return null
        }

        // timingSafeCompare guards against timing side-channel attacks.
        if (!timingSafeCompare(secret, TICKET_SECRET)) {
            console.log(`[auth] rejected — wrong secret for name="${name}"`)
            return null
        }

        console.log(`[auth] accepted  name="${name}"`)
        return {
            data: { name },
            roomId: ROOM_ID,
            actorId: name,
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. TOKEN-BUCKET RATE LIMITER
// ════════════════════════════════════════════════════════════════════════════
//
// TokenBucketRateLimiter gives each actor an independent token bucket.
// Every inbound frame costs one token; tokens refill at `refillPerSecond`.
//
// Intentionally tight settings make flooding easy to trigger in the demo
// (burst of 4 frames, then 1 new token per second).  Production defaults
// are 30/30 — well above human-pace traffic but below DoS flooding.

const rateLimiter = new TokenBucketRateLimiter({
    capacity: 4,           // burst: up to 4 back-to-back frames allowed
    refillPerSecond: 1,    // recovery: one new token every second
})

console.log('[server] rate limiter: capacity=4, refillPerSecond=1')

// ════════════════════════════════════════════════════════════════════════════
// 3. CONNECTION LIMITER
// ════════════════════════════════════════════════════════════════════════════
//
// ConnectionLimiter.check(remoteAddress) runs before auth on every incoming
// TCP socket.  Returning false closes the socket immediately with
// CloseCode.RATE_LIMITED — auth never runs.
//
// There is no release() callback because the limiter fires pre-handshake,
// before any actor identity is known.  State is managed with timestamps so
// it naturally expires: old connection records fall out of the window.
//
// This demo limits each source IP to CONN_LIMIT_MAX connections within a
// CONN_LIMIT_WINDOW_MS sliding window.  All client connections from this
// machine share 127.0.0.1, so the overcap scenario hits this limit easily.

class SlidingWindowLimiter extends ConnectionLimiter {
    // Map from remote address to the list of recent connection timestamps.
    private readonly history = new Map<string, number[]>()

    override check(remoteAddress: string): boolean {
        const now = Date.now()
        const ip = remoteAddress || 'unknown'
        const timestamps = this.history.get(ip) ?? []

        // Drop timestamps outside the window.
        const fresh = timestamps.filter(t => now - t < CONN_LIMIT_WINDOW_MS)

        if (fresh.length >= CONN_LIMIT_MAX) {
            console.log(
                `[conn-limiter] rejected ${ip} — ${fresh.length} connections ` +
                `in last ${CONN_LIMIT_WINDOW_MS / 1000}s (max ${CONN_LIMIT_MAX})`
            )
            // Still update to the cleaned list to avoid unbounded growth.
            this.history.set(ip, fresh)
            return false
        }

        fresh.push(now)
        this.history.set(ip, fresh)
        console.log(`[conn-limiter] allowed  ${ip} — ${fresh.length}/${CONN_LIMIT_MAX} in window`)
        return true
    }
}

const connectionLimiter = new SlidingWindowLimiter()

// ════════════════════════════════════════════════════════════════════════════
// ROOM
// ════════════════════════════════════════════════════════════════════════════
//
// Room logic is minimal — one "ping" topic, one "pong" reply.
//
// maxActors = MAX_ACTORS_IN_ROOM enforces the room-level head count cap.
// This fires after auth passes; a 3rd actor is rejected with ROOM_FULL.
//
// ── 4. EXPLICIT KICK ────────────────────────────────────────────────────────
//
// Every actor is automatically kicked 8 s after joining to demonstrate
// server-initiated disconnection.  In a real app you would kick for a
// policy violation (ban, idle timeout, cheating detection, …).
//
// actor.kick(payload) sets the WebSocket close-frame reason to `payload`
// so the client can identify why it was disconnected.  KickReason exports
// the well-known reason strings.

class GateRoom extends Room<ActorData> {

    override maxActors = MAX_ACTORS_IN_ROOM

    private kickTimers = new Map<string, NodeJS.Timeout>()

    protected override onCreate(): void {
        this.bind('ping', this.onPing)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        console.log(`[room] JOIN  name="${actor.data?.name}" id=${actor.id}  total=${this.actorCount}`)

        // Schedule an explicit server-initiated kick after 8 s.
        const timer = setTimeout(() => {
            this.kickTimers.delete(actor.id)
            console.log(
                `[room] KICK  name="${actor.data?.name}" id=${actor.id}` +
                `  reason=${KickReason.RATE_LIMITED} (demo auto-kick)`
            )
            // actor.kick(reason) — reason becomes the WS close-frame payload.
            actor.kick(KickReason.RATE_LIMITED)
        }, 8_000)
        this.kickTimers.set(actor.id, timer)

        actor.send('welcome', JSON.stringify({
            message: 'Connected. Server will kick you in 8 s as a demo of actor.kick().',
        }))
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const timer = this.kickTimers.get(actor.id)
        if (timer !== undefined) {
            clearTimeout(timer)
            this.kickTimers.delete(actor.id)
        }
        console.log(`[room] LEAVE name="${actor.data?.name}" id=${actor.id}  remaining=${this.actorCount}`)
    }

    private onPing(actor: Actor<ActorData>, payload: Uint8Array): void {
        const text = new TextDecoder().decode(payload)
        console.log(`[room] PING  name="${actor.data?.name}" text="${text}"`)
        actor.send('pong', payload)
    }

}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

const server = http.createServer()

const rivalis = new Rivalis<ActorData>({
    transports: [
        // WSTransport(serverOptions, queryTicketParam, transportOptions)
        // connectionLimiter is in transportOptions (third argument).
        new WSTransport({ server }, null, { connectionLimiter }),
    ],
    authMiddleware: new TicketAuth(),
    // Passing an instance overrides the default TokenBucketRateLimiter(30/30).
    rateLimiter,
})

rivalis.logging.level = 'warn'

rivalis.rooms.define(ROOM_ID, GateRoom)
rivalis.rooms.create(ROOM_ID, ROOM_ID)
console.log(`[server] room "${ROOM_ID}" created  maxActors=${MAX_ACTORS_IN_ROOM}`)

server.listen(PORT, () => {
    console.log(`[server] listening on ${SERVER_URL}`)
    console.log('[server] ---')
    console.log('[server] policies active:')
    console.log(`[server]   AuthMiddleware          — ticket must match "<name>:rivalis"`)
    console.log(`[server]   TokenBucketRateLimiter  — capacity=4, refillPerSecond=1`)
    console.log(`[server]   ConnectionLimiter       — max ${CONN_LIMIT_MAX} connections/IP per ${CONN_LIMIT_WINDOW_MS / 1000}s`)
    console.log(`[server]   maxActors               — max ${MAX_ACTORS_IN_ROOM} actors in room`)
    console.log(`[server]   auto-kick               — every actor kicked after 8 s`)
    console.log('[server] ---')
    console.log('[server] run clients:')
    console.log('[server]   npm run client:good      -w @rivalis/guided-03-auth-and-limits')
    console.log('[server]   npm run client:bad-auth  -w @rivalis/guided-03-auth-and-limits')
    console.log('[server]   npm run client:flood     -w @rivalis/guided-03-auth-and-limits')
    console.log('[server]   npm run client:overcap   -w @rivalis/guided-03-auth-and-limits')
})
