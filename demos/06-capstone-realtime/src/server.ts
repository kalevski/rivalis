// Capstone: multiplayer lobby + match server.

import http from 'http'

import {
    Rivalis,
    Room,
    AuthMiddleware,
    TokenBucketRateLimiter,
    ConnectionLimiter,
    KickReason,
    timingSafeCompare,
    RoomManager,
} from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

const PORT = 3105
const SERVER_URL = `ws://localhost:${PORT}`

const TICKET_SECRET = 'arena'

const LOBBY_ROOM_ID = 'lobby'
const LOBBY_ROOM_TYPE = 'lobby'
const MATCH_ROOM_TYPE = 'match'

const LOBBY_TICK_MS = 3_000
const LOBBY_IDLE_KICK_MS = 45_000
const MATCH_MIN_PLAYERS = 2

const MATCH_MAX_ACTORS = 4
const MATCH_LOCK_DELAY_MS = 5_000
const MATCH_TOTAL_MS = 25_000
const MATCH_TICK_MS = 1_000

const SCORE_MAX_PER_INPUT = 10

const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/

type ActorData = { name: string }

type MatchSnapshot = {
    tick: number
    status: 'open' | 'locked' | 'over'
    scores: Record<string, number>
    leader: string | null
}

type ScoreInput = { amount?: number }

// Rooms share the manager via a module-level accessor since the Room
// constructor signature is fixed and can't take injected dependencies.
let _rooms: RoomManager<ActorData> | null = null

const setRooms = (rm: RoomManager<ActorData>): void => { _rooms = rm }

const getRooms = (): RoomManager<ActorData> => {
    if (_rooms === null) throw new Error('rooms not initialised — call setRooms() at boot')
    return _rooms
}

let matchCounter = 0
const nextMatchId = (): string => `match-${++matchCounter}`

// Ticket format: "<name>:arena|<destination>"
class ArenaAuth extends AuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const pipeIdx = ticket.lastIndexOf('|')
        if (pipeIdx === -1) {
            console.log('[auth] rejected — ticket missing "|" separator')
            return null
        }

        const credentials = ticket.slice(0, pipeIdx)
        const destination = ticket.slice(pipeIdx + 1).trim()

        const colonIdx = credentials.indexOf(':')
        if (colonIdx <= 0) {
            console.log('[auth] rejected — missing ":" in credentials')
            return null
        }

        const name = credentials.slice(0, colonIdx).trim()
        const secret = credentials.slice(colonIdx + 1)

        if (!NAME_RE.test(name)) {
            console.log(`[auth] rejected — invalid name "${name}"`)
            return null
        }

        if (!timingSafeCompare(secret, TICKET_SECRET)) {
            console.log(`[auth] rejected — wrong secret for "${name}"`)
            return null
        }

        if (destination === LOBBY_ROOM_ID) {
            console.log(`[auth] accepted  name="${name}"  → lobby`)
            return { data: { name }, roomId: LOBBY_ROOM_ID, actorId: name }
        }

        // Only route to a match room if it already exists.
        if (getRooms().get(destination) !== null) {
            console.log(`[auth] accepted  name="${name}"  → ${destination}`)
            return { data: { name }, roomId: destination, actorId: name }
        }

        console.log(`[auth] rejected — room "${destination}" does not exist`)
        return null
    }

}

const CONN_LIMIT_MAX = 5
const CONN_LIMIT_WINDOW_MS = 15_000

// Runs before auth on every incoming socket; false closes it immediately.
class SlidingWindowLimiter extends ConnectionLimiter {
    private readonly history = new Map<string, number[]>()

    override check(remoteAddress: string): boolean {
        const now = Date.now()
        const ip = remoteAddress || 'unknown'
        const timestamps = this.history.get(ip) ?? []
        const fresh = timestamps.filter(t => now - t < CONN_LIMIT_WINDOW_MS)

        if (fresh.length >= CONN_LIMIT_MAX) {
            console.log(
                `[conn-limiter] rejected ${ip} — ${fresh.length}/${CONN_LIMIT_MAX}` +
                ` connections in last ${CONN_LIMIT_WINDOW_MS / 1000}s`
            )
            this.history.set(ip, fresh)
            return false
        }

        fresh.push(now)
        this.history.set(ip, fresh)
        return true
    }
}

const rateLimiter = new TokenBucketRateLimiter({
    capacity: 8,
    refillPerSecond: 2,
})

class LobbyRoom extends Room<ActorData> {

    protected override presence = true

    private readonly readySet = new Set<string>()
    private readonly idleTimers = new Map<string, NodeJS.Timeout>()
    private tickTimer: NodeJS.Timeout | null = null

    protected override onCreate(): void {
        this.bind('ready', this.onReady)
        this.bind('unready', this.onUnready)
        this.bind('chat', this.onChat)

        this.tickTimer = setInterval(() => this.onTick(), LOBBY_TICK_MS)
        console.log(`[lobby] created  tick=${LOBBY_TICK_MS}ms  idleKick=${LOBBY_IDLE_KICK_MS / 1000}s`)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[lobby] JOIN  name="${name}"  total=${this.actorCount}`)

        actor.send('welcome', JSON.stringify({
            message: `Welcome to the arena lobby, ${name}! Send "ready" to queue for a match.`,
            actorCount: this.actorCount,
        }))

        // Kick stale connections that never get matched.
        const timer = setTimeout(() => {
            this.idleTimers.delete(actor.id)
            console.log(`[lobby] IDLE KICK  name="${name}"  reason=${KickReason.RATE_LIMITED}`)
            actor.kick(KickReason.RATE_LIMITED)
        }, LOBBY_IDLE_KICK_MS)
        this.idleTimers.set(actor.id, timer)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        this.readySet.delete(actor.id)

        const timer = this.idleTimers.get(actor.id)
        if (timer !== undefined) {
            clearTimeout(timer)
            this.idleTimers.delete(actor.id)
        }

        console.log(`[lobby] LEAVE  name="${name}"  remaining=${this.actorCount}`)
    }

    protected override onDestroy(): void {
        if (this.tickTimer !== null) {
            clearInterval(this.tickTimer)
            this.tickTimer = null
        }
        for (const timer of this.idleTimers.values()) {
            clearTimeout(timer)
        }
        this.idleTimers.clear()
        console.log('[lobby] destroyed')
    }

    // When enough players are ready, create a match and notify each one.
    private onTick(): void {
        if (this.readySet.size < MATCH_MIN_PLAYERS) return

        const matchId = nextMatchId()
        getRooms().create(MATCH_ROOM_TYPE, matchId)

        const candidates = [...this.readySet].slice(0, MATCH_MAX_ACTORS)
        for (const actorId of candidates) {
            const actor = this.getActor(actorId)
            if (actor === null) {
                this.readySet.delete(actorId)
                continue
            }

            console.log(`[lobby] MATCH ASSIGNED  name="${actor.data?.name ?? actorId}"  matchId="${matchId}"`)

            actor.send('match:assigned', JSON.stringify({ matchId }))

            this.readySet.delete(actorId)

            const timer = this.idleTimers.get(actorId)
            if (timer !== undefined) {
                clearTimeout(timer)
                this.idleTimers.delete(actorId)
            }
        }
    }

    private onReady(actor: Actor<ActorData>, _payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        this.readySet.add(actor.id)
        const readyCount = this.readySet.size
        console.log(`[lobby] READY  name="${name}"  readyCount=${readyCount}`)

        actor.send('status', JSON.stringify({
            type: 'queued',
            message: `Queued. ${readyCount} player(s) ready — match starts when ${MATCH_MIN_PLAYERS} are queued.`,
        }))

        this.broadcast('lobby:event', JSON.stringify({
            type: 'player_ready',
            name,
            readyCount,
        }))
    }

    private onUnready(actor: Actor<ActorData>, _payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        this.readySet.delete(actor.id)
        console.log(`[lobby] UNREADY  name="${name}"  readyCount=${this.readySet.size}`)
        actor.send('status', JSON.stringify({ type: 'unqueued', message: 'Removed from queue.' }))
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        const text = new TextDecoder().decode(payload).trim().slice(0, 200)
        if (!text) return
        console.log(`[lobby] CHAT  from="${name}"  "${text}"`)
        this.broadcast('lobby:chat', JSON.stringify({ from: name, text }))
    }

}

// One instance per active match. Created by LobbyRoom.onTick, destroyed after
// MATCH_TOTAL_MS or when the last player leaves.
class MatchRoom extends Room<ActorData> {

    protected override presence = true

    override maxActors = MATCH_MAX_ACTORS

    private state: {
        tick: number
        scores: Record<string, number>
        status: 'open' | 'locked' | 'over'
    } = { tick: 0, scores: {}, status: 'open' }

    private tickTimer: NodeJS.Timeout | null = null
    private lockTimer: NodeJS.Timeout | null = null
    private endTimer: NodeJS.Timeout | null = null

    protected override onCreate(): void {
        this.bind('score', this.onScore)
        this.bind('chat', this.onChat)

        this.tickTimer = setInterval(() => this.onTick(), MATCH_TICK_MS)

        // Close the room to new joiners once the match locks in.
        this.lockTimer = setTimeout(() => {
            this.state.status = 'locked'
            this.joinable = false
            console.log(`[match:${this.id}] LOCKED  actors=${this.actorCount}`)
            this.broadcast('match:event', JSON.stringify({ type: 'locked', tick: this.state.tick }))
        }, MATCH_LOCK_DELAY_MS)

        this.endTimer = setTimeout(() => this.endMatch(), MATCH_TOTAL_MS)

        console.log(
            `[match:${this.id}] created  maxActors=${MATCH_MAX_ACTORS}` +
            `  locks in ${MATCH_LOCK_DELAY_MS / 1000}s` +
            `  ends in ${MATCH_TOTAL_MS / 1000}s`
        )
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        this.state.scores[actor.id] = 0
        console.log(`[match:${this.id}] JOIN  name="${name}"  total=${this.actorCount}`)

        // Late-join snapshot — actor receives current state immediately.
        actor.send('match:snapshot', JSON.stringify(this.buildSnapshot()))

        actor.send('welcome', JSON.stringify({
            message: `You are in match "${this.id}". Send score to earn points. Match ends in ~${MATCH_TOTAL_MS / 1000}s.`,
            matchId: this.id,
            maxActors: MATCH_MAX_ACTORS,
        }))
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[match:${this.id}] LEAVE  name="${name}"  remaining=${this.actorCount}`)

        // Auto-dispose when the last player leaves before the match ends.
        if (this.actorCount === 0 && this.state.status !== 'over') {
            console.log(`[match:${this.id}] empty — auto-disposing`)
            try {
                getRooms().destroy(this.id)
            } catch {
                // Already destroyed.
            }
        }
    }

    protected override onDestroy(): void {
        this.clearTimers()
        console.log(`[match:${this.id}] destroyed`)
    }

    private onTick(): void {
        this.state.tick += 1

        const snap = this.buildSnapshot()
        const leaderLabel = snap.leader !== null ? `  leader="${snap.leader}"` : ''
        console.log(
            `[match:${this.id}] TICK  #${String(this.state.tick).padStart(3, '0')}` +
            `  actors=${this.actorCount}  status=${this.state.status}` +
            leaderLabel
        )

        if (this.actorCount > 0) {
            this.broadcast('match:snapshot', JSON.stringify(snap))
        }
    }

    private endMatch(): void {
        if (this.state.status === 'over') return
        this.state.status = 'over'

        const sorted = Object.entries(this.state.scores).sort((a, b) => b[1] - a[1])
        const topEntry = sorted[0]
        const winner = topEntry !== undefined ? topEntry[0] : null

        console.log(
            `[match:${this.id}] MATCH OVER  winner="${winner ?? 'none'}"` +
            `  tick=${this.state.tick}  actors=${this.actorCount}`
        )

        this.broadcast('match:over', JSON.stringify({
            winner,
            scores: { ...this.state.scores },
            tick: this.state.tick,
        }))

        // Destroying the room kicks remaining actors with ROOM_DESTROYED.
        console.log(`[match:${this.id}] destroying  actors receive "${KickReason.ROOM_DESTROYED}"`)
        try {
            getRooms().destroy(this.id)
        } catch {
            // Already destroyed.
        }
    }

    // Scores are authoritative: the client sends an intent, the server clamps it.
    private onScore(actor: Actor<ActorData>, payload: Uint8Array): void {
        if (this.state.status !== 'locked') {
            actor.send('status', JSON.stringify({ message: 'Match has not started yet — wait for "locked" event.' }))
            return
        }

        let amount = 1
        try {
            const input = JSON.parse(new TextDecoder().decode(payload)) as ScoreInput
            if (typeof input.amount === 'number') {
                amount = Math.max(1, Math.min(SCORE_MAX_PER_INPUT, Math.round(input.amount)))
            }
        } catch {
            // Malformed payload — keep default amount of 1.
        }

        const current = this.state.scores[actor.id] ?? 0
        this.state.scores[actor.id] = current + amount
        const total = current + amount
        const name = actor.data?.name ?? actor.id

        console.log(`[match:${this.id}] SCORE  name="${name}"  +${amount}  total=${total}`)

        actor.send('score:ack', JSON.stringify({ added: amount, total }))
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        const text = new TextDecoder().decode(payload).trim().slice(0, 200)
        if (!text) return
        this.broadcast('match:chat', JSON.stringify({ from: name, text }))
    }

    private buildSnapshot(): MatchSnapshot {
        const sorted = Object.entries(this.state.scores).sort((a, b) => b[1] - a[1])
        const topEntry = sorted[0]
        return {
            tick: this.state.tick,
            status: this.state.status,
            scores: { ...this.state.scores },
            leader: topEntry !== undefined ? topEntry[0] : null,
        }
    }

    private clearTimers(): void {
        if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null }
        if (this.lockTimer !== null) { clearTimeout(this.lockTimer); this.lockTimer = null }
        if (this.endTimer !== null) { clearTimeout(this.endTimer); this.endTimer = null }
    }

}

async function main(): Promise<void> {
    const server = http.createServer()
    const connectionLimiter = new SlidingWindowLimiter()

    const rivalis = new Rivalis<ActorData>({
        transports: [
            new WSTransport({ server }, null, { connectionLimiter }),
        ],
        authMiddleware: new ArenaAuth(),
        rateLimiter,
    })

    rivalis.logging.level = 'warning'

    // define() registers a class; instances are created later via create().
    rivalis.rooms.define(LOBBY_ROOM_TYPE, LobbyRoom)
    rivalis.rooms.define(MATCH_ROOM_TYPE, MatchRoom)

    rivalis.rooms.on('create', (roomId: string, roomType: string) => {
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

    setRooms(rivalis.rooms)

    // The lobby is permanent and must exist before the first client connects.
    rivalis.rooms.create(LOBBY_ROOM_TYPE, LOBBY_ROOM_ID)

    await new Promise<void>(resolve => server.listen(PORT, resolve))

    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)`)
    console.log('[server] ---')
    console.log('[server] Capabilities active:')
    console.log(`[server]   AuthMiddleware          — ticket must match "<name>:arena|<dest>"`)
    console.log(`[server]   TokenBucketRateLimiter  — capacity=${8}, refillPerSecond=${2}`)
    console.log(`[server]   ConnectionLimiter       — max ${CONN_LIMIT_MAX} connections/IP per ${CONN_LIMIT_WINDOW_MS / 1000}s`)
    console.log(`[server]   LobbyRoom               — matchmaking tick every ${LOBBY_TICK_MS / 1000}s, idle kick at ${LOBBY_IDLE_KICK_MS / 1000}s`)
    console.log(`[server]   MatchRoom               — maxActors=${MATCH_MAX_ACTORS}, locks at ${MATCH_LOCK_DELAY_MS / 1000}s, ends at ${MATCH_TOTAL_MS / 1000}s`)
    console.log('[server] ---')
    console.log('[server] Connect at least 2 clients to trigger a match:')
    console.log('[server]   npm run client -w @rivalis/guided-06-capstone-realtime -- Alice')
    console.log('[server]   npm run client -w @rivalis/guided-06-capstone-realtime -- Bob')

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
