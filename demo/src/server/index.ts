import path from 'path'
import http from 'http'
import express from 'express'

import { Rivalis, Transports } from '@rivalis/core'
import ArenaAuthMiddleware from './AuthMiddleware'
import ArenaRoom from './ArenaRoom'

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

const rivalis = new Rivalis({
    transports: [
        new Transports.WSTransport({ server })
    ],
    authMiddleware: new ArenaAuthMiddleware()
})

rivalis.logging.level = 'info'

rivalis.rooms.define('arena', ArenaRoom)
rivalis.rooms.create('arena', 'arena')

console.log(`arena room ready (id="arena")`)
