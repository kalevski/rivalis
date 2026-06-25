import { WSClient } from '@rivalis/node'

const PORT = 3103
const SERVER_URL = `ws://localhost:${PORT}`

const NAME = process.argv[2]?.trim() || 'Observer'
const MODE = process.argv[3] === 'mutate' ? 'mutate' : 'watch'

type SnapshotFrame = {
    tick: number
    counter: number
    lastMutatedBy: string | null
}

const client = new WSClient(SERVER_URL)

let snapshotCount = 0

const timers: NodeJS.Timeout[] = []

client.on('client:connect', () => {
    console.log(`[${NAME}] connected  mode=${MODE}`)
    console.log(`[${NAME}] waiting for snapshot from server...`)

    if (MODE === 'mutate') {
        const incrementTimer = setInterval(() => {
            console.log(`[${NAME}] → increment  amount=+5`)
            client.send('increment', JSON.stringify({ amount: 5 }))
        }, 3_000)

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

client.connect(NAME)
