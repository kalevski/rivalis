import http from 'http'

import { Rivalis, Transports } from '@rivalis/core'
import ChatAuthMiddleware, { type ActorData } from './AuthMiddleware'
import ChatRoom from './ChatRoom'
import Orchestrator, { setActiveOrchestrator } from './Orchestrator'
import { ROOM_TYPE } from '../protocol'

const PORT = Number(process.env.PORT ?? 8080)

const server = http.createServer()

const rivalis = new Rivalis<ActorData>({
    transports: [
        new Transports.WSTransport({ server })
    ],
    authMiddleware: new ChatAuthMiddleware()
})

rivalis.logging.level = 'info'

// Wire up the orchestrator and make it reachable from the auth middleware and
// the rooms (both go through the module singleton — see Orchestrator.ts).
const orchestrator = new Orchestrator(rivalis.rooms)
setActiveOrchestrator(orchestrator)

// Register the room *class* only. Unlike the simple chat demo we do NOT
// `rooms.create(...)` here: the orchestrator spins instances up on demand as
// clients ask for room names, and disposes them when they empty.
rivalis.rooms.define(ROOM_TYPE, ChatRoom)

server.listen(PORT, () => {
    console.log(`orchestrator chat server listening on ws://localhost:${PORT}`)
    console.log('rooms are created on demand — open clients with:')
    console.log('  npm run client -- <name> <room>')
})

process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    await rivalis.shutdown()
    process.exit(0)
})
