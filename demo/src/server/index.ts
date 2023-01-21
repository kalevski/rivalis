import process from 'process'
import path from 'path'
import http from 'http'
import express from 'express'

import { Rivalis, Transports } from '@rivalis/core'
import MyAuthMiddleware from './MyAuthMiddleware'
import FirstRoom from './FirstRoom'


const BUILD_DIR = path.join(process.cwd(), './build')

const application = express()
const server = http.createServer(application)

application.use('/', express.static(BUILD_DIR))

application.get('/', (_, response) => {
    let clientFile = path.join(BUILD_DIR, './client.html')
    response.sendFile(clientFile)
})

server.listen(2334, '0.0.0.0', () => {
    console.log('server started: http://localhost:2334')
})


const rivalis = new Rivalis({
    transports: [
        new Transports.WSTransport({
            server: server
        })
    ],
    authMiddleware: new MyAuthMiddleware()
})

rivalis.logging.level = 'debug'

rivalis.rooms.define('first_room', FirstRoom)
rivalis.rooms.create('first_room', 'my_first_room')