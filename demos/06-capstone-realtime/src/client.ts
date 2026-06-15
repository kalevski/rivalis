/**
 * Guided level 06 — Capstone client
 *
 * Drives the full lifecycle automatically so you can observe every feature
 * in the server log without manual input:
 *
 *   Phase 1  LOBBY
 *     • Connect with ticket "<name>:arena|lobby"
 *     • Wait 2 s, then send "ready" to queue for a match
 *     • Chat every 8 s while waiting
 *     • On "match:assigned": disconnect from lobby and move to Phase 2
 *
 *   Phase 2  MATCH
 *     • Connect with ticket "<name>:arena|match-N"
 *     • Receive late-join snapshot immediately (level 04)
 *     • Send a chat greeting after 1 s
 *     • Send score inputs every 3 s during the match (level 04 authoritative input)
 *     • Receive "match:over" broadcast when match ends
 *     • Disconnect and exit when kicked (KickReason.ROOM_DESTROYED)
 *
 * Usage:
 *   ts-node src/client.ts [name]
 *
 *   name  — display name (default: random "player-NNNN")
 *
 * Pre-packaged scripts (run from repo root):
 *   npm run client -w @rivalis/guided-06-capstone-realtime -- Alice
 *   npm run client -w @rivalis/guided-06-capstone-realtime -- Bob
 *   npm run client -w @rivalis/guided-06-capstone-realtime -- Carol
 *
 * You need at least 2 clients connected concurrently to trigger matchmaking.
 */

import { WSClient } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────

const PORT = 3105
const SERVER_URL = `ws://localhost:${PORT}`
const SECRET = 'arena'

// ── CLI args ──────────────────────────────────────────────────────────────────

const NAME = process.argv[2]?.trim() || `player-${Math.floor(Math.random() * 9000) + 1000}`

// ── Helpers ───────────────────────────────────────────────────────────────────

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Pending timer handles; cleared on phase transitions and disconnect. */
const timers: NodeJS.Timeout[] = []

function clearAllTimers(): void {
    for (const t of timers) {
        clearTimeout(t)
        clearInterval(t)
    }
    timers.length = 0
}

/** Print a labelled log line. */
function log(phase: string, ...parts: string[]): void {
    console.log(`[${NAME}:${phase}]`, ...parts)
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2 — MATCH
// ════════════════════════════════════════════════════════════════════════════
//
// Creates a fresh WSClient for the match room and drives the game loop until
// the server kicks us (match over or room destroyed).

function joinMatch(matchId: string): void {
    log('match', `connecting to "${matchId}"...`)

    const client = new WSClient(SERVER_URL)

    // ── Connect ───────────────────────────────────────────────────────────────

    client.on('client:connect', () => {
        log('match', `connected to match "${matchId}"`)

        // Say hello once the match starts.
        timers.push(setTimeout(() => {
            client.send('chat', encode('Ready to play!'))
        }, 1_000))

        // Send score inputs every 3 s — amount varies per client for diversity.
        const amount = Math.floor(Math.random() * SCORE_MAX_PER_INPUT) + 1
        timers.push(setInterval(() => {
            log('match', `→ score +${amount}`)
            client.send('score', encode(JSON.stringify({ amount })))
        }, 3_000))
    }, null)

    // ── Match events ──────────────────────────────────────────────────────────

    client.on('welcome', (payload: Uint8Array) => {
        type Welcome = { message: string; matchId: string; maxActors: number }
        const data = JSON.parse(decode(payload)) as Welcome
        log('match', `* ${data.message}`)
    }, null)

    // level 04: late-join snapshot — server sends current state on join.
    client.on('match:snapshot', (payload: Uint8Array) => {
        type Snapshot = { tick: number; status: string; scores: Record<string, number>; leader: string | null }
        const snap = JSON.parse(decode(payload)) as Snapshot
        const myScore = snap.scores[NAME] ?? 0
        const topThree = Object.entries(snap.scores)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([n, s]) => `${n}:${s}`)
            .join(' ')
        log('match', `snapshot  tick=${snap.tick}  status=${snap.status}  mine=${myScore}  top=[${topThree}]`)
    }, null)

    client.on('match:event', (payload: Uint8Array) => {
        type MatchEvent = { type: string; tick?: number }
        const ev = JSON.parse(decode(payload)) as MatchEvent
        log('match', `event: ${ev.type}${ev.tick !== undefined ? `  tick=${ev.tick}` : ''}`)
    }, null)

    client.on('score:ack', (payload: Uint8Array) => {
        type ScoreAck = { added: number; total: number }
        const ack = JSON.parse(decode(payload)) as ScoreAck
        log('match', `score ack  +${ack.added}  total=${ack.total}`)
    }, null)

    client.on('match:over', (payload: Uint8Array) => {
        type MatchOver = { winner: string | null; scores: Record<string, number>; tick: number }
        const result = JSON.parse(decode(payload)) as MatchOver
        const won = result.winner === NAME
        log('match', `MATCH OVER  winner="${result.winner ?? 'none'}"  ${won ? '*** YOU WIN! ***' : 'good game'}`)
        const scoreList = Object.entries(result.scores)
            .sort((a, b) => b[1] - a[1])
            .map(([n, s]) => `${n}:${s}`)
            .join('  ')
        log('match', `final scores: ${scoreList}`)
    }, null)

    client.on('match:chat', (payload: Uint8Array) => {
        type Chat = { from: string; text: string }
        const msg = JSON.parse(decode(payload)) as Chat
        log('match', `<${msg.from}> ${msg.text}`)
    }, null)

    // level 01: presence events from other actors joining / leaving.
    client.on('__presence:join', (payload: Uint8Array) => {
        type Presence = { id: string; data: { name: string } }
        const p = JSON.parse(decode(payload)) as Presence
        if (p.data.name !== NAME) {
            log('match', `* ${p.data.name} joined the match`)
        }
    }, null)

    client.on('__presence:leave', (payload: Uint8Array) => {
        type Presence = { id: string; data: { name: string } }
        const p = JSON.parse(decode(payload)) as Presence
        if (p.data.name !== NAME) {
            log('match', `* ${p.data.name} left the match`)
        }
    }, null)

    // ── Disconnect / error ────────────────────────────────────────────────────

    client.on('client:disconnect', (payload: Uint8Array) => {
        clearAllTimers()
        const reason = decode(payload)
        if (reason) {
            log('match', `disconnected: ${reason}`)
        } else {
            log('match', 'disconnected')
        }
        process.exit(0)
    }, null)

    client.on('client:error', (err: Error) => {
        log('match', `error: ${err.message}`)
    }, null)

    // Connect to the match room — ticket: "<name>:arena|match-N"
    client.connect(`${NAME}:${SECRET}|${matchId}`)
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 1 — LOBBY
// ════════════════════════════════════════════════════════════════════════════

const SCORE_MAX_PER_INPUT = 10

/** Holds the match ID once assigned, so we can reconnect after lobby disconnects. */
let assignedMatchId: string | null = null

const lobbyClient = new WSClient(SERVER_URL)

// ── Connect ───────────────────────────────────────────────────────────────────

lobbyClient.on('client:connect', () => {
    log('lobby', 'connected')

    // Queue for a match after a short delay (gives us time to see the welcome).
    timers.push(setTimeout(() => {
        log('lobby', '→ ready')
        lobbyClient.send('ready', encode('{}'))
    }, 2_000))

    // Send chat messages periodically while waiting.
    const chatLines = ['Anyone else here?', 'Waiting for a match...', 'Let\'s go!']
    let chatIdx = 0
    timers.push(setInterval(() => {
        const line = chatLines[chatIdx % chatLines.length] ?? 'Hello!'
        chatIdx += 1
        log('lobby', `→ chat "${line}"`)
        lobbyClient.send('chat', encode(line))
    }, 8_000))
}, null)

// ── Lobby events ──────────────────────────────────────────────────────────────

lobbyClient.on('welcome', (payload: Uint8Array) => {
    type Welcome = { message: string; actorCount: number }
    const data = JSON.parse(decode(payload)) as Welcome
    log('lobby', `* ${data.message}  (${data.actorCount} in lobby)`)
}, null)

lobbyClient.on('status', (payload: Uint8Array) => {
    type Status = { type: string; message: string }
    const data = JSON.parse(decode(payload)) as Status
    log('lobby', `status [${data.type}]: ${data.message}`)
}, null)

lobbyClient.on('lobby:event', (payload: Uint8Array) => {
    type LobbyEvent = { type: string; name: string; readyCount: number }
    const ev = JSON.parse(decode(payload)) as LobbyEvent
    if (ev.type === 'player_ready') {
        log('lobby', `${ev.name} is ready  (${ev.readyCount} ready total)`)
    }
}, null)

lobbyClient.on('lobby:chat', (payload: Uint8Array) => {
    type Chat = { from: string; text: string }
    const msg = JSON.parse(decode(payload)) as Chat
    log('lobby', `<${msg.from}> ${msg.text}`)
}, null)

// level 01: presence events for other players entering / leaving the lobby.
lobbyClient.on('__presence:join', (payload: Uint8Array) => {
    type Presence = { id: string; data: { name: string } }
    const p = JSON.parse(decode(payload)) as Presence
    if (p.data.name !== NAME) {
        log('lobby', `* ${p.data.name} entered the lobby`)
    }
}, null)

lobbyClient.on('__presence:leave', (payload: Uint8Array) => {
    type Presence = { id: string; data: { name: string } }
    const p = JSON.parse(decode(payload)) as Presence
    if (p.data.name !== NAME) {
        log('lobby', `* ${p.data.name} left the lobby`)
    }
}, null)

// When the server sends a match assignment, save the match ID and disconnect.
lobbyClient.on('match:assigned', (payload: Uint8Array) => {
    type Assigned = { matchId: string }
    const data = JSON.parse(decode(payload)) as Assigned
    assignedMatchId = data.matchId
    log('lobby', `match assigned: "${assignedMatchId}" — disconnecting lobby`)
    clearAllTimers()
    lobbyClient.disconnect()
}, null)

// ── Disconnect / error ────────────────────────────────────────────────────────

lobbyClient.on('client:disconnect', (payload: Uint8Array) => {
    const reason = decode(payload)

    if (assignedMatchId !== null) {
        // Transition to the match phase after a brief pause.
        log('lobby', `disconnected — joining match "${assignedMatchId}" in 500ms`)
        setTimeout(() => {
            if (assignedMatchId !== null) {
                joinMatch(assignedMatchId)
            }
        }, 500)
        return
    }

    if (reason) {
        log('lobby', `disconnected: ${reason}`)
    } else {
        log('lobby', 'disconnected')
    }
    process.exit(0)
}, null)

lobbyClient.on('client:error', (err: Error) => {
    log('lobby', `error: ${err.message}`)
}, null)

// ── Connect to lobby — ticket: "<name>:arena|lobby" ───────────────────────────

lobbyClient.connect(`${NAME}:${SECRET}|lobby`)
