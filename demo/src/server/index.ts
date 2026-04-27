import path from 'path'
import http from 'http'
import express from 'express'

import { Rivalis, Transports } from '@rivalis/core'
import ArenaAuthMiddleware, { type ActorData } from './AuthMiddleware'
import LobbyRoom from './LobbyRoom'
import CounterRoom from './CounterRoom'
import TttRoom from './TttRoom'

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
        new Transports.WSTransport({ server })
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

console.log('rooms ready: lobby, counter, ttt')

process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    await rivalis.shutdown()
    process.exit(0)
})
