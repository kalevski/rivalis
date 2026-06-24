import http from 'http'

import { Rivalis } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'
import ChatAuthMiddleware, { type ActorData } from './AuthMiddleware'
import ChatRoom from './ChatRoom'
import { ROOM_ID } from '../protocol'

const PORT = Number(process.env.PORT ?? 8080)

const server = http.createServer()

const rivalis = new Rivalis<ActorData>({
    transports: [
        new WSTransport({ server })
    ],
    authMiddleware: new ChatAuthMiddleware()
})

rivalis.logging.level = 'info'

rivalis.rooms.define(ROOM_ID, ChatRoom)
rivalis.rooms.create(ROOM_ID, ROOM_ID)

server.listen(PORT, () => {
    console.log(`chat server listening on ws://localhost:${PORT}`)
    console.log('open clients with:  npm run client -- <name>')
})

process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    await rivalis.shutdown()
    process.exit(0)
})
