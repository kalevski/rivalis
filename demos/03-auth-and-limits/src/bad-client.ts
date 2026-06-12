/**
 * Guided level 03 — bad clients (three rejection scenarios)
 *
 * Pass one of the three scenario names as the first CLI argument:
 *
 *   bad-auth   — connects with a wrong secret; AuthMiddleware rejects it.
 *   flood      — connects with a valid ticket, then sends messages as fast as
 *                possible; the TokenBucketRateLimiter kicks it.
 *   overcap    — opens 4 connections from the same IP in rapid succession;
 *                the SlidingWindowLimiter (ConnectionLimiter) rejects the
 *                4th before auth even runs, and maxActors caps the room at 2.
 *
 * Usage (from the repo root):
 *   npm run client:bad-auth  -w @rivalis/guided-03-auth-and-limits
 *   npm run client:flood     -w @rivalis/guided-03-auth-and-limits
 *   npm run client:overcap   -w @rivalis/guided-03-auth-and-limits
 */

import { WSClient } from '@rivalis/node'

const PORT = 3102
const SERVER_URL = `ws://localhost:${PORT}`

type Scenario = 'bad-auth' | 'flood' | 'overcap'

const scenario = (process.argv[2] ?? 'bad-auth') as Scenario

switch (scenario) {
    case 'bad-auth':
        runBadAuth()
        break
    case 'flood':
        runFlood()
        break
    case 'overcap':
        runOvercap()
        break
    default:
        console.error(`Unknown scenario "${scenario}". Use: bad-auth | flood | overcap`)
        process.exit(1)
}

// ════════════════════════════════════════════════════════════════════════════
// Scenario A — bad auth
// ════════════════════════════════════════════════════════════════════════════
//
// The ticket secret is wrong ("wrongpass" instead of "rivalis").
// AuthMiddleware.authenticate() returns null, so the transport closes the
// socket with CloseCode.INVALID_TICKET before the actor ever touches a room.

function runBadAuth(): void {
    const NAME = 'BadActor'
    const TICKET = `${NAME}:wrongpass`   // wrong secret — auth will reject this

    console.log(`[${NAME}] connecting with invalid ticket "${TICKET}"`)
    const client = new WSClient(SERVER_URL)

    client.on('client:connect', () => {
        // Should never reach here — server closes the socket before ack.
        console.log(`[${NAME}] connected (unexpected!)`)
    })

    client.on('client:disconnect', () => {
        console.log(`[${NAME}] disconnected — server rejected the ticket (as expected)`)
    })

    client.connect(TICKET)
}

// ════════════════════════════════════════════════════════════════════════════
// Scenario B — message flood (rate limiter)
// ════════════════════════════════════════════════════════════════════════════
//
// Connects with a valid ticket, then immediately blasts 20 frames with no
// delay.  The TokenBucketRateLimiter has capacity=4, so the first 4 frames
// pass; the 5th exhausts the bucket and the actor is kicked with
// KickReason.RATE_LIMITED.

function runFlood(): void {
    const NAME = 'Flooder'
    const TICKET = `${NAME}:rivalis`   // valid ticket so auth passes

    console.log(`[${NAME}] connecting with valid ticket, will flood 20 pings immediately`)
    const client = new WSClient(SERVER_URL)

    client.on('client:connect', () => {
        console.log(`[${NAME}] connected — flooding 20 pings with no delay ...`)
        for (let i = 1; i <= 20; i++) {
            client.send('ping', `flood-${i}`)
        }
        console.log(`[${NAME}] all 20 pings sent — expect a rate-limited kick`)
    })

    client.on('pong', (payload: Uint8Array) => {
        const text = new TextDecoder().decode(payload)
        console.log(`[${NAME}] ← pong "${text}" (bucket still had tokens)`)
    })

    client.on('client:disconnect', () => {
        console.log(`[${NAME}] disconnected — kicked by rate limiter (as expected)`)
    })

    client.connect(TICKET)
}

// ════════════════════════════════════════════════════════════════════════════
// Scenario C — connection over-cap
// ════════════════════════════════════════════════════════════════════════════
//
// Opens 4 connections from the same IP (127.0.0.1) in rapid succession.
//
// The SlidingWindowLimiter (ConnectionLimiter) allows the first 3 sockets
// within its 10-second window, and rejects the 4th BEFORE auth runs.
//
// Of the 3 admitted sockets, the first 2 pass auth and join the room.
// The 3rd passes auth but the room rejects it with ROOM_FULL (maxActors=2).
//
// This demonstrates two independent caps working at different layers:
//   - ConnectionLimiter at the transport layer (raw socket count per IP/window)
//   - room.maxActors    at the room layer      (concurrent joined actors)

function runOvercap(): void {
    const names = ['Cap1', 'Cap2', 'Cap3', 'Cap4']

    console.log('[overcap] opening 4 connections quickly from the same IP ...')
    console.log('[overcap] expected: Cap1+Cap2 join room; Cap3 rejected (room_full); Cap4 rejected (conn-limiter)')

    for (const name of names) {
        const ticket = `${name}:rivalis`
        const client = new WSClient(SERVER_URL)

        client.on('client:connect', () => {
            console.log(`[${name}] connected — inside the room`)
        })

        client.on('welcome', (payload: Uint8Array) => {
            const { message } = JSON.parse(new TextDecoder().decode(payload)) as { message: string }
            console.log(`[${name}] server says: "${message}"`)
        })

        client.on('client:disconnect', () => {
            console.log(`[${name}] disconnected`)
        })

        // Stagger very slightly so the server admits them in order.
        const delay = names.indexOf(name) * 50
        setTimeout(() => client.connect(ticket), delay)
    }
}
