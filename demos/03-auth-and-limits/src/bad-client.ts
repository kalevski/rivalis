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

// Wrong secret — AuthMiddleware rejects with CloseCode.INVALID_TICKET before any room.
function runBadAuth(): void {
    const NAME = 'BadActor'
    const TICKET = `${NAME}:wrongpass`

    console.log(`[${NAME}] connecting with invalid ticket "${TICKET}"`)
    const client = new WSClient(SERVER_URL)

    client.on('client:connect', () => {
        console.log(`[${NAME}] connected (unexpected!)`)
    })

    client.on('client:disconnect', () => {
        console.log(`[${NAME}] disconnected — server rejected the ticket (as expected)`)
    })

    client.connect(TICKET)
}

// Valid ticket, then floods frames. First 4 pass; the 5th exhausts the bucket and gets kicked.
function runFlood(): void {
    const NAME = 'Flooder'
    const TICKET = `${NAME}:rivalis`

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

// Opens 4 connections from one IP: conn-limiter allows 3, room.maxActors=2 caps joins.
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
