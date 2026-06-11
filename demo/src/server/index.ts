import path from 'path'
import http from 'http'
import express from 'express'

import { Rivalis } from '@rivalis/core'
import { WSTransport } from '@rivalis/core/transports/ws'
import { FleetAgent, type FleetAgentOptions } from '@rivalis/fleet'
import ArenaAuthMiddleware, { type ActorData } from './AuthMiddleware'
import LobbyRoom from './LobbyRoom'
import CounterRoom from './CounterRoom'
import TttRoom from './TttRoom'
import ArenaRoom from './ArenaRoom'
import MatchRoom from './MatchRoom'
import { MATCH_ROOM_TYPE, ORCH_URL, AGENT_KEY } from '../fleet/protocol'

const PORT = 2334
const BUILD_DIR = path.join(process.cwd(), './build')

const app = express()
const server = http.createServer(app)

app.use('/', express.static(BUILD_DIR))

server.listen(PORT, '0.0.0.0', () => {
    console.log(`http  → http://localhost:${PORT}  (serves built client from ./build)`)
    console.log(`vite  → http://localhost:5173      (dev client)`)
    console.log(`ws    → ws://localhost:${PORT}`)
})

const rivalis = new Rivalis<ActorData>({
    transports: [
        new WSTransport({ server })
    ],
    authMiddleware: new ArenaAuthMiddleware()
})

rivalis.logging.level = 'info'

rivalis.rooms.define('lobby', LobbyRoom)
rivalis.rooms.create('lobby', 'lobby')

rivalis.rooms.define('counter', CounterRoom)
rivalis.rooms.create('counter', 'counter')

rivalis.rooms.define('ttt', TttRoom)
rivalis.rooms.create('ttt', 'ttt')

rivalis.rooms.define('arena', ArenaRoom)
rivalis.rooms.create('arena', 'arena')

console.log('rooms ready: lobby, counter, ttt, arena')

// Optional fleet membership: when FLEET is set this server attaches a FleetAgent
// and self-registers with the orchestrator (demo/src/fleet) as a game instance,
// so the orchestrator can discover it, read its load, and place `match` rooms on
// it. Disabled by default — the server runs standalone without it.
const fleetAgent = startFleetAgent()

process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    if (fleetAgent !== null) {
        await fleetAgent.disconnect().catch(() => {})
    }
    await rivalis.shutdown()
    process.exit(0)
})

function startFleetAgent(): FleetAgent | null {
    if (!process.env.FLEET) {
        return null
    }
    // The orchestrator can only place a room type the instance defines (fleet
    // placement filter), so register the match room before connecting.
    rivalis.rooms.define(MATCH_ROOM_TYPE, MatchRoom)

    const name = process.env.FLEET_INSTANCE_NAME ?? 'demo'
    const options: FleetAgentOptions = {
        url: process.env.FLEET_ORCH_URL ?? ORCH_URL,
        key: process.env.FLEET_AGENT_KEY ?? AGENT_KEY,
        endpointUrl: `ws://localhost:${PORT}`,
        name
    }
    if (process.env.FLEET_REGION !== undefined) {
        options.labels = { region: process.env.FLEET_REGION }
    }

    // FleetAgent reads `rivalis.rooms` generically; the actor-data generic is
    // irrelevant to it, so the cast past Rivalis's invariant TActorData is safe.
    const agent = new FleetAgent(rivalis as unknown as Rivalis, options)
    agent.connect()
        .then(() => console.log(`fleet  → registered with orchestrator at ${options.url} as "${name}"`))
        .catch((error) => console.error('fleet  → agent connect failed:', error))

    return agent
}
