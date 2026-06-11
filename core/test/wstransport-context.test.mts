import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { Rivalis, Room, AuthMiddleware, Transports, Clients } from '../lib/main.js'
import type { ConnectionContext, AuthResult } from '../lib/main.js'

const { WSTransport } = Transports
const { WSClient } = Clients

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, () => {
            const address = srv.address()
            const port = typeof address === 'object' && address !== null ? address.port : 0
            srv.close(() => resolve(port))
        })
    })
}

function waitForEvent(emitter: any, event: string, timeoutMs = 2000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs)
        timer.unref?.()
        emitter.once(event, (...args: unknown[]) => {
            clearTimeout(timer)
            resolve(args)
        })
    })
}

class TestRoom extends Room {}

// ---- AC1: WSTransport passes a WS ConnectionContext to authenticate --------

test('WSTransport passes { kind:"ws", remoteId, meta } to grantAccess', async () => {
    const port = await getFreePort()
    let capturedContext: ConnectionContext | undefined

    class ContextCapturingAuth extends AuthMiddleware {
        async authenticate(
            ticket: string,
            context?: ConnectionContext
        ): Promise<AuthResult<null> | null> {
            if (ticket !== 'good') return null
            capturedContext = context
            return { data: null, roomId: 'room-1' }
        }
    }

    const rivalis = new Rivalis({
        transports: [new WSTransport({ port }, null, { ticketSource: 'protocol' })],
        authMiddleware: new ContextCapturingAuth()
    })
    rivalis.rooms.define('test', TestRoom)
    rivalis.rooms.create('test', 'room-1')

    const client = new WSClient(`ws://127.0.0.1:${port}`, { ticketSource: 'protocol' })
    client.on('client:error', () => {})

    const connected = waitForEvent(client, 'client:connect')
    client.connect('good')
    await connected

    client.disconnect()
    await rivalis.shutdown()

    assert.ok(capturedContext !== undefined, 'context must be passed to authenticate')
    assert.equal(capturedContext!.kind, 'ws', 'context.kind must be "ws"')
    assert.equal(typeof capturedContext!.remoteId, 'string', 'context.remoteId must be a string')
    assert.ok('origin' in (capturedContext!.meta ?? {}), 'context.meta must contain origin key')
})
