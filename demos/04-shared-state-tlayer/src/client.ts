/**
 * Guided level 04 — authoritative shared state (client)
 *
 * Usage:
 *   ts-node src/client.ts [name] [mode]
 *
 *   name  — display name used as the auth ticket (default: "Observer")
 *   mode  — "watch"  : connect and log every incoming snapshot (default)
 *            "mutate": also send increment inputs every 3 s and a reset at 12 s
 *
 * Pre-packaged scripts (run from repo root):
 *   npm run client:watch  -w @rivalis/guided-04-shared-state-tlayer
 *   npm run client:mutate -w @rivalis/guided-04-shared-state-tlayer
 *
 * This client demonstrates what a connected actor observes:
 *
 *   1. It receives a snapshot immediately on connect (the late-join snapshot
 *      sent by the server's onJoin() handler) — no tick wait required.
 *
 *   2. It receives a snapshot on every server tick, so the counter is always
 *      up to date even when this client makes no inputs.
 *
 *   3. In "mutate" mode it submits increment / reset inputs and watches the
 *      effect appear in subsequent tick snapshots.
 */

import { WSClient } from '@rivalis/node'

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT = 3103
const SERVER_URL = `ws://localhost:${PORT}`

// ── CLI args ──────────────────────────────────────────────────────────────────
const NAME = process.argv[2]?.trim() || 'Observer'
const MODE = process.argv[3] === 'mutate' ? 'mutate' : 'watch'

// ── Wire type (mirrors server definition) ────────────────────────────────────
type SnapshotFrame = {
    tick: number
    counter: number
    lastMutatedBy: string | null
}

// ── Client ────────────────────────────────────────────────────────────────────

const client = new WSClient(SERVER_URL)

// Track how many snapshots we've received so we can label the first one.
let snapshotCount = 0

// Timers created in mutate mode — cleared on disconnect.
const timers: NodeJS.Timeout[] = []

client.on('client:connect', () => {
    console.log(`[${NAME}] connected  mode=${MODE}`)
    console.log(`[${NAME}] waiting for snapshot from server...`)

    if (MODE === 'mutate') {
        // Send an increment of +5 every 3 seconds starting at 3 s.
        const incrementTimer = setInterval(() => {
            console.log(`[${NAME}] → increment  amount=+5`)
            client.send('increment', JSON.stringify({ amount: 5 }))
        }, 3_000)

        // Send a reset once at 12 s, then disconnect.
        const resetTimer = setTimeout(() => {
            console.log(`[${NAME}] → reset`)
            client.send('reset', '')

            // Give the server one tick to broadcast the reset, then exit.
            const exitTimer = setTimeout(() => {
                console.log(`[${NAME}] done — disconnecting`)
                client.disconnect()
            }, 1_500)
            timers.push(exitTimer)
        }, 12_000)

        timers.push(incrementTimer, resetTimer)
    }
})

// ── Snapshot handler ──────────────────────────────────────────────────────────
//
// Every server tick broadcasts a snapshot to all connected actors.  The first
// snapshot this client receives is the late-join snapshot sent by onJoin()
// before the next tick fires — so the client is always immediately in sync.
client.on('snapshot', (payload: Uint8Array) => {
    const snap = JSON.parse(new TextDecoder().decode(payload)) as SnapshotFrame
    snapshotCount += 1

    const label = snapshotCount === 1 ? ' ← late-join snapshot' : ''
    console.log(
        `[${NAME}] snapshot` +
        `  tick=${snap.tick}` +
        `  counter=${snap.counter}` +
        `  by=${snap.lastMutatedBy ?? '(none)'}` +
        label
    )
})

client.on('client:disconnect', () => {
    for (const t of timers) {
        clearTimeout(t as NodeJS.Timeout)
        clearInterval(t as NodeJS.Timeout)
    }
    console.log(`[${NAME}] disconnected`)
})

client.on('client:error', (err: Error) => {
    console.error(`[${NAME}] error: ${err.message}`)
})

// Connect — the ticket is just the actor's name.
client.connect(NAME)
