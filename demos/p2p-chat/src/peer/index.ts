import readline from 'readline'

import { Clients, KickReason } from '@rivalis/core'
import Mesh from './Mesh'
import {
    encode,
    decode,
    TOPIC,
    type WelcomeEvent,
    type AnnounceCommand,
    type RosterEvent,
    type PeerInfo,
    type PeerLeaveEvent
} from '../protocol'
import {
    MAX_PEERS,
    DEFAULT_SIGNALING_URL,
    DEFAULT_PEER_HOST,
    DEFAULT_PEER_PORT
} from '../constants'

const signalingUrl = process.env.RIVALIS_URL ?? DEFAULT_SIGNALING_URL
const name = (process.argv[2] ?? process.env.NAME ?? `peer-${Math.floor(Math.random() * 9000) + 1000}`).trim()
const host = process.env.PEER_HOST ?? DEFAULT_PEER_HOST
const port = Number(process.argv[3] ?? process.env.PEER_PORT ?? DEFAULT_PEER_PORT)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
})

/** Print an incoming line above the prompt without clobbering the input. */
const print = (line: string): void => {
    process.stdout.write(`\r\x1b[K${line}\n`)
    rl.prompt(true)
}

// The mesh carries the actual chat — directly between peers, never through the
// signalling server below.
const mesh = new Mesh(
    name,
    host,
    port,
    (from, text) => print(`${from}: ${text}`),
    line => print(line)
)

// The signalling client is only used to discover peers and learn join/leave.
const client = new Clients.WSClient(signalingUrl)

let stopped = false
const shutdown = (code: number): void => {
    if (stopped) return
    stopped = true
    client.disconnect()
    mesh.stop()
    process.exit(code)
}

client.on('client:connect', () => {
    print(`connected to signalling server at ${signalingUrl} as "${name}"`)
}, null)

client.on(TOPIC.WELCOME, (payload: Uint8Array) => {
    const { youId } = decode<WelcomeEvent>(payload)
    mesh.setSelfId(youId)
    // Now that we have an id, advertise where peers should dial us directly.
    const announce: AnnounceCommand = { host, port }
    client.send(TOPIC.ANNOUNCE, encode(announce))
}, null)

client.on(TOPIC.ROSTER, (payload: Uint8Array) => {
    const { peers } = decode<RosterEvent>(payload)
    if (peers.length === 0) {
        print(`you are the first peer — waiting for others (mesh holds up to ${MAX_PEERS})`)
    } else {
        print(`peers already in the mesh: ${peers.map(peer => peer.name).join(', ')}`)
    }
    for (const peer of peers) mesh.link(peer)
}, null)

client.on(TOPIC.PEER_JOIN, (payload: Uint8Array) => {
    const peer = decode<PeerInfo>(payload)
    print(`* ${peer.name} joined`)
    mesh.link(peer)
}, null)

client.on(TOPIC.PEER_LEAVE, (payload: Uint8Array) => {
    const { id } = decode<PeerLeaveEvent>(payload)
    const who = mesh.drop(id)
    if (who !== null) print(`* ${who} left`)
}, null)

client.on('client:disconnect', (payload: Uint8Array) => {
    const reason = new TextDecoder().decode(payload)
    if (reason === KickReason.ROOM_FULL) {
        print(`room full — the mesh already has the maximum of ${MAX_PEERS} participants. Try again once someone leaves.`)
        shutdown(1)
        return
    }
    print(`disconnected from signalling${reason ? `: ${reason}` : ''}`)
    shutdown(0)
}, null)

mesh.start()
    .then(() => {
        print(`direct-link endpoint listening on ws://${host}:${port}`)
        // The ticket is just the display name — see SignalingAuthMiddleware.
        client.connect(name)
        rl.prompt()
    })
    .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`failed to start direct-link endpoint on ${host}:${port}: ${message}`)
        console.error('pick a free port:  npm run peer -- <name> <port>')
        process.exit(1)
    })

rl.on('line', line => {
    const text = line.trim()
    if (text) mesh.broadcast(text)
    rl.prompt()
})

rl.on('close', () => shutdown(0))

process.on('SIGINT', () => shutdown(0))
