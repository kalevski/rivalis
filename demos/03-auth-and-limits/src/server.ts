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

const PORT = 3102
const ROOM_ID = 'lobby'
const SERVER_URL = `ws://localhost:${PORT}`

const TICKET_SECRET = 'rivalis'
const MAX_ACTORS_IN_ROOM = 2
const CONN_LIMIT_MAX = 3
const CONN_LIMIT_WINDOW_MS = 10_000

type ActorData = { name: string }

// Ticket format: "<name>:<secret>". Return null to reject, AuthResult to accept.
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

const rateLimiter = new TokenBucketRateLimiter({
    capacity: 4,
    refillPerSecond: 1,
})

console.log('[server] rate limiter: capacity=4, refillPerSecond=1')

// Runs before auth on every incoming socket; returning false closes it immediately.
class SlidingWindowLimiter extends ConnectionLimiter {
    private readonly history = new Map<string, number[]>()

    override check(remoteAddress: string): boolean {
        const now = Date.now()
        const ip = remoteAddress || 'unknown'
        const timestamps = this.history.get(ip) ?? []

        const fresh = timestamps.filter(t => now - t < CONN_LIMIT_WINDOW_MS)

        if (fresh.length >= CONN_LIMIT_MAX) {
            console.log(
                `[conn-limiter] rejected ${ip} — ${fresh.length} connections ` +
                `in last ${CONN_LIMIT_WINDOW_MS / 1000}s (max ${CONN_LIMIT_MAX})`
            )
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

class GateRoom extends Room<ActorData> {

    override maxActors = MAX_ACTORS_IN_ROOM

    private kickTimers = new Map<string, NodeJS.Timeout>()

    protected override onCreate(): void {
        this.bind('ping', this.onPing)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        console.log(`[room] JOIN  name="${actor.data?.name}" id=${actor.id}  total=${this.actorCount}`)

        const timer = setTimeout(() => {
            this.kickTimers.delete(actor.id)
            console.log(
                `[room] KICK  name="${actor.data?.name}" id=${actor.id}` +
                `  reason=${KickReason.RATE_LIMITED} (demo auto-kick)`
            )
            // reason becomes the WS close-frame payload.
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

const server = http.createServer()

const rivalis = new Rivalis<ActorData>({
    transports: [
        new WSTransport({ server }, null, { connectionLimiter }),
    ],
    authMiddleware: new TicketAuth(),
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
