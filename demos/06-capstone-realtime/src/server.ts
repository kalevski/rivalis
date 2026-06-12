/**
 * Guided level 06 — Capstone: multiplayer lobby + match server
 *
 * This file combines every capability introduced across levels 01–05 into
 * one cohesive real-time application: a lobby where players queue for
 * matches, a match server with authoritative state, and the full complement
 * of auth, rate limiting, room management, and server-initiated kicks.
 *
 * ── Feature map ──────────────────────────────────────────────────────────────
 *
 *   Level 01  Room, Actor, presence, bind, send, onJoin / onLeave / onDestroy
 *   Level 02  broadcast, direct actor.send, named topics
 *   Level 03  AuthMiddleware + timingSafeCompare, TokenBucketRateLimiter,
 *             ConnectionLimiter, maxActors, joinable, actor.kick(reason)
 *   Level 04  Server tick loop, authoritative state, TLayer broadcast,
 *             late-join snapshot
 *   Level 05  RoomManager.define / create / get / destroy / keys / count,
 *             on('create') / on('destroy'), auto-dispose on empty
 *
 * ── Application overview ─────────────────────────────────────────────────────
 *
 *   Ticket format: "<name>:arena|<destination>"
 *     name        — alphanumeric display name, max 20 chars
 *     secret      — must equal the string "arena"
 *     destination — "lobby"  → shared waiting room
 *                   "match-N" → a specific live match room
 *
 *   LobbyRoom  (type "lobby", single instance created at boot)
 *     • presence = true: free __presence:join / __presence:leave notifications
 *     • "ready" topic: enqueue for matchmaking
 *     • "unready" topic: dequeue
 *     • "chat" topic: relay text to all lobby actors
 *     • Matchmaking tick every 3 s: when ≥ 2 ready players exist, create a
 *       MatchRoom and notify each ready player via actor.send("match:assigned")
 *     • Idle kick after 45 s: players who never get matched are removed
 *
 *   MatchRoom  (type "match", instances created on demand by the lobby)
 *     • maxActors = 4 (room-level head count cap)
 *     • joinable = false after 5 s (locks out late arrivals mid-match)
 *     • Server tick every 1 s: broadcast authoritative score snapshot to all
 *     • "score" topic: actor increments their score (authoritative on server)
 *     • "chat" topic: relay text inside the match
 *     • After 25 s total: broadcast "match:over" result then destroy room
 *       (handleDestroy kicks all remaining actors with ROOM_DESTROYED)
 *     • Auto-dispose: if all players leave early, onLeave destroys the room
 *
 *   RoomManager lifecycle events are logged so you can watch create / destroy
 *   as lobby creates matches and matches end.
 *
 * ── How to run ───────────────────────────────────────────────────────────────
 *
 *   Start the server:
 *     npm run start -w @rivalis/guided-06-capstone-realtime
 *
 *   Connect clients in separate terminals (need at least 2 to trigger a match):
 *     npm run client -w @rivalis/guided-06-capstone-realtime -- Alice
 *     npm run client -w @rivalis/guided-06-capstone-realtime -- Bob
 *     npm run client -w @rivalis/guided-06-capstone-realtime -- Carol
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
    RoomManager,
} from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────

const PORT = 3105
const SERVER_URL = `ws://localhost:${PORT}`

/** Shared secret embedded in every ticket. */
const TICKET_SECRET = 'arena'

/** Room IDs / types. */
const LOBBY_ROOM_ID = 'lobby'
const LOBBY_ROOM_TYPE = 'lobby'
const MATCH_ROOM_TYPE = 'match'

/** How often the lobby polls for enough ready players (ms). */
const LOBBY_TICK_MS = 3_000

/** Kick a lobby player if they haven't been matched after this long (ms). */
const LOBBY_IDLE_KICK_MS = 45_000

/** Minimum number of ready players to create a match. */
const MATCH_MIN_PLAYERS = 2

/** Maximum actors per match room (level 03: maxActors). */
const MATCH_MAX_ACTORS = 4

/** After creation, the match room closes to new joiners after this many ms (level 03: joinable). */
const MATCH_LOCK_DELAY_MS = 5_000

/** Total match lifetime in ms (lock delay + active play time). */
const MATCH_TOTAL_MS = 25_000

/** Tick interval for the match game loop (ms). */
const MATCH_TICK_MS = 1_000

/** Max points a single "score" input can claim (authoritative clamping). */
const SCORE_MAX_PER_INPUT = 10

/** Allowed chars in a player name. */
const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/

// ── Actor data ────────────────────────────────────────────────────────────────

type ActorData = { name: string }

// ── Wire types ────────────────────────────────────────────────────────────────

type MatchSnapshot = {
    tick: number
    status: 'open' | 'locked' | 'over'
    scores: Record<string, number>
    leader: string | null
}

type ScoreInput = { amount?: number }

// ════════════════════════════════════════════════════════════════════════════
// MODULE SINGLETON — shared RoomManager reference
// (same pattern as level 05: the Room constructor signature is fixed, so
// rooms / sub-rooms share the manager via a module-level accessor rather than
// constructor injection)
// ════════════════════════════════════════════════════════════════════════════

let _rooms: RoomManager<ActorData> | null = null

const setRooms = (rm: RoomManager<ActorData>): void => { _rooms = rm }

const getRooms = (): RoomManager<ActorData> => {
    if (_rooms === null) throw new Error('rooms not initialised — call setRooms() at boot')
    return _rooms
}

// ── Match ID counter ──────────────────────────────────────────────────────────

let matchCounter = 0
const nextMatchId = (): string => `match-${++matchCounter}`

// ════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE  (level 03)
// ════════════════════════════════════════════════════════════════════════════
//
// Ticket format: "<name>:arena|<destination>"
//
// The pipe separates credentials from the routing destination so auth and
// routing are parsed in a single pass. timingSafeCompare guards against
// timing-oracle attacks on the shared secret (level 03).

class ArenaAuth extends AuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        // Split on the last "|" to get credentials vs destination.
        const pipeIdx = ticket.lastIndexOf('|')
        if (pipeIdx === -1) {
            console.log('[auth] rejected — ticket missing "|" separator')
            return null
        }

        const credentials = ticket.slice(0, pipeIdx)
        const destination = ticket.slice(pipeIdx + 1).trim()

        // Parse "<name>:<secret>" from the credential half.
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

        // level 03: constant-time comparison prevents timing side-channels.
        if (!timingSafeCompare(secret, TICKET_SECRET)) {
            console.log(`[auth] rejected — wrong secret for "${name}"`)
            return null
        }

        // Route to lobby unconditionally.
        if (destination === LOBBY_ROOM_ID) {
            console.log(`[auth] accepted  name="${name}"  → lobby`)
            return { data: { name }, roomId: LOBBY_ROOM_ID, actorId: name }
        }

        // Route to a match room only if it already exists (level 05: rooms.get).
        if (getRooms().get(destination) !== null) {
            console.log(`[auth] accepted  name="${name}"  → ${destination}`)
            return { data: { name }, roomId: destination, actorId: name }
        }

        console.log(`[auth] rejected — room "${destination}" does not exist`)
        return null
    }

}

// ════════════════════════════════════════════════════════════════════════════
// CONNECTION LIMITER  (level 03)
// ════════════════════════════════════════════════════════════════════════════
//
// Runs before auth on every incoming TCP socket. Returning false closes the
// socket immediately without running AuthMiddleware.

const CONN_LIMIT_MAX = 5
const CONN_LIMIT_WINDOW_MS = 15_000

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

// ════════════════════════════════════════════════════════════════════════════
// RATE LIMITER  (level 03)
// ════════════════════════════════════════════════════════════════════════════
//
// Each actor gets an independent token bucket. Exhausting it triggers a kick
// with KickReason.RATE_LIMITED. Capacity=8 / refillPerSecond=2 is generous
// enough for normal play but tight enough to catch message floods.

const rateLimiter = new TokenBucketRateLimiter({
    capacity: 8,
    refillPerSecond: 2,
})

// ════════════════════════════════════════════════════════════════════════════
// LOBBY ROOM  (levels 01, 02, 03, 05)
// ════════════════════════════════════════════════════════════════════════════
//
// The single shared waiting room. Players arrive, declare readiness, and the
// server's matchmaking tick pairs them into MatchRooms.

class LobbyRoom extends Room<ActorData> {

    // level 01: auto-broadcast __presence:join / __presence:leave
    protected override presence = true

    // Tracks which actor IDs have declared readiness.
    private readonly readySet = new Set<string>()

    // Per-actor idle kick timers (level 03: server-initiated kick).
    private readonly idleTimers = new Map<string, NodeJS.Timeout>()

    // level 04 pattern: server tick loop independent of actor count.
    private tickTimer: NodeJS.Timeout | null = null

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    protected override onCreate(): void {
        // level 01: bind inbound topic handlers.
        this.bind('ready', this.onReady)
        this.bind('unready', this.onUnready)
        this.bind('chat', this.onChat)

        // level 04: tick runs regardless of whether any actor is connected.
        this.tickTimer = setInterval(() => this.onTick(), LOBBY_TICK_MS)
        console.log(`[lobby] created  tick=${LOBBY_TICK_MS}ms  idleKick=${LOBBY_IDLE_KICK_MS / 1000}s`)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[lobby] JOIN  name="${name}"  total=${this.actorCount}`)

        // level 02: direct message to the joining actor.
        actor.send('welcome', JSON.stringify({
            message: `Welcome to the arena lobby, ${name}! Send "ready" to queue for a match.`,
            actorCount: this.actorCount,
        }))

        // level 03: schedule an idle kick so stale connections don't linger.
        // KickReason.RATE_LIMITED is repurposed here as the close-frame payload
        // (same pattern as level 03's demo auto-kick) so the client can identify
        // why it was disconnected without a custom close-code.
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

    // ── Matchmaking tick ──────────────────────────────────────────────────────
    //
    // Called every LOBBY_TICK_MS. When enough players are ready, create a
    // MatchRoom (level 05: rooms.create) and notify each player directly
    // (level 02: actor.send) so they can reconnect with a match ticket.

    private onTick(): void {
        if (this.readySet.size < MATCH_MIN_PLAYERS) return

        // level 05: create a new match room on demand.
        const matchId = nextMatchId()
        getRooms().create(MATCH_ROOM_TYPE, matchId)

        // Notify up to MATCH_MAX_ACTORS ready players and remove them from the queue.
        const candidates = [...this.readySet].slice(0, MATCH_MAX_ACTORS)
        for (const actorId of candidates) {
            const actor = this.getActor(actorId)
            if (actor === null) {
                this.readySet.delete(actorId)
                continue
            }

            console.log(`[lobby] MATCH ASSIGNED  name="${actor.data?.name ?? actorId}"  matchId="${matchId}"`)

            // level 02: direct send to each matched player.
            actor.send('match:assigned', JSON.stringify({ matchId }))

            this.readySet.delete(actorId)

            // Cancel the idle timer — they got a match.
            const timer = this.idleTimers.get(actorId)
            if (timer !== undefined) {
                clearTimeout(timer)
                this.idleTimers.delete(actorId)
            }
        }
    }

    // ── Topic handlers ────────────────────────────────────────────────────────

    private onReady(actor: Actor<ActorData>, _payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        this.readySet.add(actor.id)
        const readyCount = this.readySet.size
        console.log(`[lobby] READY  name="${name}"  readyCount=${readyCount}`)

        // level 02: reply directly to the actor.
        actor.send('status', JSON.stringify({
            type: 'queued',
            message: `Queued. ${readyCount} player(s) ready — match starts when ${MATCH_MIN_PLAYERS} are queued.`,
        }))

        // level 02: broadcast the ready event to everyone else in the lobby.
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
        // level 02: broadcast to all actors in the room.
        this.broadcast('lobby:chat', JSON.stringify({ from: name, text }))
    }

}

// ════════════════════════════════════════════════════════════════════════════
// MATCH ROOM  (levels 02, 03, 04, 05)
// ════════════════════════════════════════════════════════════════════════════
//
// One instance per active match. Created by LobbyRoom.onTick, destroyed after
// MATCH_TOTAL_MS or when the last player leaves.

class MatchRoom extends Room<ActorData> {

    // level 01: auto-broadcast presence events.
    protected override presence = true

    // level 03: cap the head count per match.
    override maxActors = MATCH_MAX_ACTORS

    // level 04: server-authoritative shared state.
    private state: {
        tick: number
        scores: Record<string, number>
        status: 'open' | 'locked' | 'over'
    } = { tick: 0, scores: {}, status: 'open' }

    private tickTimer: NodeJS.Timeout | null = null
    private lockTimer: NodeJS.Timeout | null = null
    private endTimer: NodeJS.Timeout | null = null

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    protected override onCreate(): void {
        // level 01: bind inbound topic handlers.
        this.bind('score', this.onScore)
        this.bind('chat', this.onChat)

        // level 04: server tick — runs from creation regardless of actor count.
        this.tickTimer = setInterval(() => this.onTick(), MATCH_TICK_MS)

        // level 03: close the room to new joiners once the match locks in.
        this.lockTimer = setTimeout(() => {
            this.state.status = 'locked'
            this.joinable = false
            console.log(`[match:${this.id}] LOCKED  actors=${this.actorCount}`)
            // level 02: broadcast the lock event to everyone in the match.
            this.broadcast('match:event', JSON.stringify({ type: 'locked', tick: this.state.tick }))
        }, MATCH_LOCK_DELAY_MS)

        // Schedule the end of the match.
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

        // level 04: late-join snapshot — actor receives current state immediately.
        actor.send('match:snapshot', JSON.stringify(this.buildSnapshot()))

        // level 02: welcome message with match context.
        actor.send('welcome', JSON.stringify({
            message: `You are in match "${this.id}". Send score to earn points. Match ends in ~${MATCH_TOTAL_MS / 1000}s.`,
            matchId: this.id,
            maxActors: MATCH_MAX_ACTORS,
        }))
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[match:${this.id}] LEAVE  name="${name}"  remaining=${this.actorCount}`)

        // level 05: auto-dispose when the last player leaves before the match ends.
        if (this.actorCount === 0 && this.state.status !== 'over') {
            console.log(`[match:${this.id}] empty — auto-disposing`)
            try {
                getRooms().destroy(this.id)
            } catch {
                // Already destroyed — safe to ignore.
            }
        }
    }

    protected override onDestroy(): void {
        this.clearTimers()
        console.log(`[match:${this.id}] destroyed`)
    }

    // ── Game tick  (level 04) ─────────────────────────────────────────────────
    //
    // The tick clock is authoritative. Clients observe snapshots; they never
    // push state directly. The TLayer broadcast here is the same mechanism
    // explored in level 04.

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
            // level 04: TLayer broadcast to every joined actor.
            this.broadcast('match:snapshot', JSON.stringify(snap))
        }
    }

    // ── Match end  (level 03: server-initiated kick) ──────────────────────────

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

        // level 02: broadcast the final result to all connected actors.
        this.broadcast('match:over', JSON.stringify({
            winner,
            scores: { ...this.state.scores },
            tick: this.state.tick,
        }))

        // level 03: destroy the room — handleDestroy kicks remaining actors.
        // Each actor's client:disconnect event will carry KickReason.ROOM_DESTROYED
        // as the close-frame reason, which the client can inspect to distinguish a
        // deliberate end-of-match from a network drop.
        console.log(`[match:${this.id}] destroying  actors receive "${KickReason.ROOM_DESTROYED}"`)
        try {
            getRooms().destroy(this.id)
        } catch {
            // Already destroyed — safe to ignore.
        }
    }

    // ── Topic handlers ────────────────────────────────────────────────────────

    // level 04: authoritative state mutation — the client sends an intent, the
    // server decides how to apply it. The change appears in the next snapshot.
    private onScore(actor: Actor<ActorData>, payload: Uint8Array): void {
        if (this.state.status !== 'locked') {
            // Only count scores during the active (locked) phase.
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
            // Malformed payload — use default amount of 1.
        }

        const current = this.state.scores[actor.id] ?? 0
        this.state.scores[actor.id] = current + amount
        const total = current + amount
        const name = actor.data?.name ?? actor.id

        console.log(`[match:${this.id}] SCORE  name="${name}"  +${amount}  total=${total}`)

        // level 02: direct acknowledgement to the scoring actor.
        actor.send('score:ack', JSON.stringify({ added: amount, total }))
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        const text = new TextDecoder().decode(payload).trim().slice(0, 200)
        if (!text) return
        // level 02: broadcast within the match room.
        this.broadcast('match:chat', JSON.stringify({ from: name, text }))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const server = http.createServer()
    const connectionLimiter = new SlidingWindowLimiter()

    const rivalis = new Rivalis<ActorData>({
        transports: [
            // level 03: pass the connection limiter in the transport options.
            new WSTransport({ server }, null, { connectionLimiter }),
        ],
        authMiddleware: new ArenaAuth(),
        rateLimiter,
    })

    // Keep the internal Rivalis log quiet so our demo lines stand out.
    rivalis.logging.level = 'warn'

    // ── level 05: register room types ─────────────────────────────────────────
    //
    // define() registers a class without creating any instance. Instances
    // are created later via create() — the lobby at boot, matches on demand.
    rivalis.rooms.define(LOBBY_ROOM_TYPE, LobbyRoom)
    rivalis.rooms.define(MATCH_ROOM_TYPE, MatchRoom)

    // ── level 05: subscribe to room lifecycle events ───────────────────────────

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

    // Wire the singleton so ArenaAuth and MatchRoom.onLeave can reach the manager.
    setRooms(rivalis.rooms)

    // ── level 05: create the lobby at boot ────────────────────────────────────
    //
    // Unlike match rooms (which are created on demand), the lobby is permanent
    // and must exist before the first client connects. All other room types are
    // created dynamically.
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
