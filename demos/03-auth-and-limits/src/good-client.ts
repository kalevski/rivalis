import { WSClient } from '@rivalis/node'

const PORT = 3102
const SERVER_URL = `ws://localhost:${PORT}`

const TICKET = 'Alice:rivalis'
const NAME = 'Alice'

const client = new WSClient(SERVER_URL)

client.on('client:connect', () => {
    console.log(`[${NAME}] connected`)

    // Rate limiter capacity is 4, so 3 pings at 1/s all pass.
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
