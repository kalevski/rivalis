import http from 'http'

import { Rivalis } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'
import SignalingAuthMiddleware, { type ActorData } from './AuthMiddleware'
import SignalingRoom from './SignalingRoom'
import { MAX_PEERS, SIGNALING_ROOM_ID, DEFAULT_SIGNALING_PORT } from '../constants'

const PORT = Number(process.env.PORT ?? DEFAULT_SIGNALING_PORT)

const server = http.createServer()

const rivalis = new Rivalis<ActorData>({
    transports: [
        new WSTransport({ server })
    ],
    authMiddleware: new SignalingAuthMiddleware()
})

rivalis.logging.level = 'info'

rivalis.rooms.define(SIGNALING_ROOM_ID, SignalingRoom)
rivalis.rooms.create(SIGNALING_ROOM_ID, SIGNALING_ROOM_ID)

server.listen(PORT, () => {
    console.log(`p2p signalling server listening on ws://localhost:${PORT}`)
    console.log(`peers discover each other here; chat flows directly peer-to-peer (max ${MAX_PEERS} peers)`)
    console.log('open peers with:  npm run peer -- <name> <port>')
})

process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    await rivalis.shutdown()
    process.exit(0)
})
