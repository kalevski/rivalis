import path from 'path'
import http from 'http'
import express from 'express'

import { Rivalis } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'
import PacmanAuthMiddleware, { type ActorData } from './AuthMiddleware'
import PacmanRoom from './PacmanRoom'
import { ROOM_ID } from '../protocol'

const PORT = Number(process.env.PORT ?? 2335)
const BUILD_DIR = path.join(process.cwd(), './build')

const app = express()
const server = http.createServer(app)

app.use('/', express.static(BUILD_DIR))

const rivalis = new Rivalis<ActorData>({
    transports: [
        new WSTransport({ server })
    ],
    authMiddleware: new PacmanAuthMiddleware(),
    // A real-time game produces bursts of input frames, so opt out of the default rate limiter.
    rateLimiter: null
})

rivalis.logging.level = 'info'

rivalis.rooms.define(ROOM_ID, PacmanRoom)
rivalis.rooms.create(ROOM_ID, ROOM_ID)

server.listen(PORT, '0.0.0.0', () => {
    console.log(`pacman server`)
    console.log(`  http → http://localhost:${PORT}   (serves built client from ./build)`)
    console.log(`  vite → http://localhost:5173       (dev client)`)
    console.log(`  ws   → ws://localhost:${PORT}`)
    console.log('open two browser tabs and race for pellets!')
})

process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    await rivalis.shutdown()
    process.exit(0)
})
