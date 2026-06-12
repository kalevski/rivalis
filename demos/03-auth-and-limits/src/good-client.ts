/**
 * Guided level 03 — good client
 *
 * Connects with a valid ticket ("Alice:rivalis"), sends a handful of
 * ping frames at a reasonable pace, and stays connected until the server
 * kicks it (after 8 s) or until it receives a disconnect event.
 *
 * Usage:
 *   npm run client:good -w @rivalis/guided-03-auth-and-limits
 */

import { WSClient } from '@rivalis/node'

const PORT = 3102
const SERVER_URL = `ws://localhost:${PORT}`

// Valid ticket — name:secret where secret === "rivalis"
const TICKET = 'Alice:rivalis'
const NAME = 'Alice'

const client = new WSClient(SERVER_URL)

client.on('client:connect', () => {
    console.log(`[${NAME}] connected`)

    // Send 3 pings at a comfortable pace (1 per second).
    // The rate limiter capacity is 4, so these all pass.
    let count = 0
    const interval = setInterval(() => {
        count += 1
        const msg = `ping-${count}`
        console.log(`[${NAME}] → ping  "${msg}"`)
        client.send('ping', msg)
        if (count >= 3) {
            clearInterval(interval)
        }
    }, 1000)
})

client.on('welcome', (payload: Uint8Array) => {
    const { message } = JSON.parse(new TextDecoder().decode(payload)) as { message: string }
    console.log(`[${NAME}] server says: "${message}"`)
})

client.on('pong', (payload: Uint8Array) => {
    const text = new TextDecoder().decode(payload)
    console.log(`[${NAME}] ← pong "${text}"`)
})

client.on('client:disconnect', () => {
    console.log(`[${NAME}] disconnected (server kicked or connection closed)`)
})

client.connect(TICKET)
