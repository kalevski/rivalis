import http from 'http'

import { Rivalis, Room, AuthMiddleware } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport, WSClient } from '@rivalis/node'

const PORT = 3100
const ROOM_ID = 'lobby'
const TOPIC = 'greeting'
const SERVER_URL = `ws://localhost:${PORT}`

class HelloAuth extends AuthMiddleware {
    override async authenticate(ticket: string): Promise<AuthResult<Record<string, unknown>> | null> {
        if (!ticket.trim()) {
            return null
        }
        return {
            data: null,
            roomId: ROOM_ID,
        }
    }
}

class HelloRoom extends Room {

    protected override onCreate(): void {
        this.bind(TOPIC, this.onGreeting)
    }

    protected override onJoin(actor: Actor): void {
        console.log(`[server] actor joined   id=${actor.id}`)
    }

    protected override onLeave(actor: Actor): void {
        console.log(`[server] actor left     id=${actor.id}`)
    }

    private onGreeting(actor: Actor, payload: Uint8Array): void {
        const text = new TextDecoder().decode(payload)
        console.log(`[server] received  "${text}" from id=${actor.id}`)

        actor.send(TOPIC, payload)
        console.log(`[server] echoed    "${text}" back to id=${actor.id}`)
    }

}

async function main(): Promise<void> {

    // Rivalis attaches to a plain Node http.Server so you can share the port with an HTTP framework.
    const server = http.createServer()

    const rivalis = new Rivalis({
        transports: [new WSTransport({ server })],
        authMiddleware: new HelloAuth(),
    })

    rivalis.logging.level = 'info'

    rivalis.rooms.define(ROOM_ID, HelloRoom)
    rivalis.rooms.create(ROOM_ID, ROOM_ID)
    console.log(`[server] room "${ROOM_ID}" created`)

    await new Promise<void>(resolve => server.listen(PORT, resolve))
    console.log(`[server] listening on ${SERVER_URL}`)

    const client = new WSClient(SERVER_URL)

    client.on('client:connect', () => {
        console.log('[client] connected')

        const message = 'Hello, Rivalis!'
        console.log(`[client] sending   "${message}" on topic "${TOPIC}"`)
        client.send(TOPIC, message)
    })

    client.on(TOPIC, (payload: Uint8Array) => {
        const echo = new TextDecoder().decode(payload)
        console.log(`[client] received  "${echo}" ← exchange complete`)

        client.disconnect()
    })

    client.on('client:disconnect', async () => {
        console.log('[client] disconnected — shutting down')

        await rivalis.shutdown()
        server.close()
    })

    // The ticket is forwarded to HelloAuth.authenticate(), which accepts any non-empty string.
    client.connect('hello-actor')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
