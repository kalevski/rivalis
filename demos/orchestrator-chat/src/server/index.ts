import http from 'http'

import { Rivalis } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'
import ChatAuthMiddleware, { type ActorData } from './AuthMiddleware'
import ChatRoom from './ChatRoom'
import Orchestrator, { setActiveOrchestrator } from './Orchestrator'
import { ROOM_TYPE } from '../protocol'

const PORT = Number(process.env.PORT ?? 8080)

const server = http.createServer()

const rivalis = new Rivalis<ActorData>({
    transports: [
        new WSTransport({ server })
    ],
    authMiddleware: new ChatAuthMiddleware()
})

rivalis.logging.level = 'info'

const orchestrator = new Orchestrator(rivalis.rooms)
setActiveOrchestrator(orchestrator)

// Register the room class only; the orchestrator creates instances on demand.
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
