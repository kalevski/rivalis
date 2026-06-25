// Capstone client: queues in the lobby, then plays the assigned match.

import { WSClient } from '@rivalis/node'

const PORT = 3105
const SERVER_URL = `ws://localhost:${PORT}`
const SECRET = 'arena'

const NAME = process.argv[2]?.trim() || `player-${Math.floor(Math.random() * 9000) + 1000}`

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

// Pending timer handles; cleared on phase transitions and disconnect.
const timers: NodeJS.Timeout[] = []

function clearAllTimers(): void {
    for (const t of timers) {
        clearTimeout(t)
        clearInterval(t)
    }
    timers.length = 0
}

function log(phase: string, ...parts: string[]): void {
    console.log(`[${NAME}:${phase}]`, ...parts)
}

// Phase 2 — connect to the assigned match and play until kicked.
function joinMatch(matchId: string): void {
    log('match', `connecting to "${matchId}"...`)

    const client = new WSClient(SERVER_URL)

    client.on('client:connect', () => {
        log('match', `connected to match "${matchId}"`)

        timers.push(setTimeout(() => {
            client.send('chat', encode('Ready to play!'))
        }, 1_000))

        // Score amount varies per client for diversity.
        const amount = Math.floor(Math.random() * SCORE_MAX_PER_INPUT) + 1
        timers.push(setInterval(() => {
            log('match', `→ score +${amount}`)
            client.send('score', encode(JSON.stringify({ amount })))
        }, 3_000))
    }, null)

    client.on('welcome', (payload: Uint8Array) => {
        type Welcome = { message: string; matchId: string; maxActors: number }
        const data = JSON.parse(decode(payload)) as Welcome
        log('match', `* ${data.message}`)
    }, null)

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

    client.connect(`${NAME}:${SECRET}|${matchId}`)
}

// Phase 1 — lobby.

const SCORE_MAX_PER_INPUT = 10

let assignedMatchId: string | null = null

const lobbyClient = new WSClient(SERVER_URL)

lobbyClient.on('client:connect', () => {
    log('lobby', 'connected')

    timers.push(setTimeout(() => {
        log('lobby', '→ ready')
        lobbyClient.send('ready', encode('{}'))
    }, 2_000))

    const chatLines = ['Anyone else here?', 'Waiting for a match...', 'Let\'s go!']
    let chatIdx = 0
    timers.push(setInterval(() => {
        const line = chatLines[chatIdx % chatLines.length] ?? 'Hello!'
        chatIdx += 1
        log('lobby', `→ chat "${line}"`)
        lobbyClient.send('chat', encode(line))
    }, 8_000))
}, null)

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

lobbyClient.on('match:assigned', (payload: Uint8Array) => {
    type Assigned = { matchId: string }
    const data = JSON.parse(decode(payload)) as Assigned
    assignedMatchId = data.matchId
    log('lobby', `match assigned: "${assignedMatchId}" — disconnecting lobby`)
    clearAllTimers()
    lobbyClient.disconnect()
}, null)

lobbyClient.on('client:disconnect', (payload: Uint8Array) => {
    const reason = decode(payload)

    if (assignedMatchId !== null) {
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

lobbyClient.connect(`${NAME}:${SECRET}|lobby`)
