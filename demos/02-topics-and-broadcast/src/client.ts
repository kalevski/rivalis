import { WSClient } from '@rivalis/node'

const PORT       = 3101
const SERVER_URL = `ws://localhost:${PORT}`
const LIFETIME_MS = 15_000

const NAME = process.argv[2]?.trim() || `guest_${process.pid}`

type ChatFrame    = { from: string; text: string }
type DmFrame      = { from: string; text: string }
type NoticeFrame  = { type: 'join' | 'leave'; id: string; name: string }
type RosterFrame  = { you: string; peers: Array<{ id: string; name: string }> }

const peers = new Map<string, string>()  // actorId → display name

const client = new WSClient(SERVER_URL)

client.on('client:connect', () => {
    console.log(`[${NAME}] connected to ${SERVER_URL}`)

    const greeting = `Hello from ${NAME}!`
    client.send('chat', JSON.stringify({ text: greeting }))
    console.log(`[${NAME}] sent CHAT   "${greeting}"`)
})

client.on('client:disconnect', () => {
    console.log(`[${NAME}] disconnected`)
})

// The server sends 'roster' only to the actor that just joined.
client.on('roster', (payload: Uint8Array) => {
    const { you, peers: list } = JSON.parse(
        new TextDecoder().decode(payload)
    ) as RosterFrame

    const peerNames = list.map(p => p.name).join(', ') || '(none)'
    console.log(`[${NAME}] ROSTER  you=${you}  peers=[${peerNames}]`)

    list.forEach(p => peers.set(p.id, p.name))

    // If anyone else is here, DM the first peer to exercise targeted delivery.
    const target = list[0]
    if (target !== undefined) {
        const text = `Hey ${target.name}, private message from ${NAME}!`
        console.log(`[${NAME}] sent DM     → ${target.name}: "${text}"`)
        client.send('dm', JSON.stringify({ to: target.id, text }))
    }
})

client.on('notice', (payload: Uint8Array) => {
    const notice = JSON.parse(new TextDecoder().decode(payload)) as NoticeFrame
    if (notice.type === 'join') {
        peers.set(notice.id, notice.name)
        console.log(`[${NAME}] NOTICE  ** ${notice.name} joined  (id=${notice.id})`)
    } else {
        peers.delete(notice.id)
        console.log(`[${NAME}] NOTICE  ** ${notice.name} left    (id=${notice.id})`)
    }
})

client.on('chat', (payload: Uint8Array) => {
    const { from, text } = JSON.parse(new TextDecoder().decode(payload)) as ChatFrame
    console.log(`[${NAME}] CHAT    <${from}>: ${text}`)
})

client.on('dm', (payload: Uint8Array) => {
    const { from, text } = JSON.parse(new TextDecoder().decode(payload)) as DmFrame
    console.log(`[${NAME}] DM      [from ${from}] ${text}`)
})

// The ticket becomes the actor's name (and requested actor ID) on the server.
client.connect(NAME)

setTimeout(() => {
    console.log(`[${NAME}] ${LIFETIME_MS / 1000}s elapsed — disconnecting`)
    client.disconnect()
}, LIFETIME_MS)
