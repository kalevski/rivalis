import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { Rivalis, Room, AuthMiddleware, CloseCode } from '@rivalis/core'
import { WSTransport, WSClient } from '../lib/main.js'

// ---- helpers ---------------------------------------------------------------

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

function waitForEvent(client: any, event: string, timeoutMs = 2000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs)
        timer.unref?.()
        client.once(event, (...args: unknown[]) => {
            clearTimeout(timer)
            resolve(args)
        })
    })
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
    })
}

class TestRoom extends Room {}

// Accepts ticket === 'good', routes it into room 'room-1'. Everything else
// is rejected (returns null → INVALID_TICKET close).
class ProtocolAuth extends AuthMiddleware {
    async authenticate(ticket: string): Promise<{ data: null; roomId: string } | null> {
        if (ticket === 'good') {
            return { data: null, roomId: 'room-1' }
        }
        return null
    }
}

// ---- AC1: failed connect must not crash the process ------------------------

test('connecting to a closed port emits client:error and does not crash', async () => {
    const port = await getFreePort()   // free port, nothing listening on it
    const client = new WSClient(`ws://127.0.0.1:${port}`)

    // The regression: without an 'error' listener on the underlying ws
    // socket, this connect would throw an unhandled 'error' and crash node.
    const errored = waitForEvent(client, 'client:error', 3000)
    client.on('client:disconnect', () => {})
    client.connect('whatever')

    const [error] = await errored
    assert.ok(error instanceof Error, 'client:error should carry the underlying Error')
    assert.equal(client.connected, false)

    client.disconnect()
})

// ---- AC2: connected is readyState-based ------------------------------------

test('connected is false until OPEN and false after close', async () => {
    const port = await getFreePort()
    const rivalis = new Rivalis({
        transports: [new WSTransport({ port }, null, { ticketSource: 'protocol' })],
        authMiddleware: new ProtocolAuth()
    })
    rivalis.rooms.define('test', TestRoom)
    rivalis.rooms.create('test', 'room-1')

    const client = new WSClient(`ws://127.0.0.1:${port}`, { ticketSource: 'protocol' })
    client.on('client:error', () => {})

    // before connect: no socket → false
    assert.equal(client.connected, false)

    const connected = waitForEvent(client, 'client:connect')
    client.connect('good')

    // synchronously after connect() the socket is CONNECTING, not OPEN
    assert.equal(client.connected, false, 'connected must be false while CONNECTING')

    await connected
    assert.equal(client.connected, true, 'connected must be true once OPEN')

    const disconnected = waitForEvent(client, 'client:disconnect')
    client.disconnect()
    await disconnected
    assert.equal(client.connected, false, 'connected must be false after close')

    await rivalis.shutdown()
})

// ---- AC3: send before open is a no-op, never throws ------------------------

test('send before open rejects/no-ops with a warning and does not throw', () => {
    const client = new WSClient('ws://127.0.0.1:1')
    client.on('client:error', () => {})

    // never connected → connected is false → send must not throw
    assert.doesNotThrow(() => client.send('topic', 'payload'))

    // also during CONNECTING (socket created, not yet OPEN)
    client.connect('whatever')
    assert.equal(client.connected, false)
    assert.doesNotThrow(() => client.send('topic', 'payload'))

    client.disconnect()
})

// ---- AC4: authenticate against ticketSource: 'protocol' --------------------

test('client authenticates against a WSTransport with ticketSource: protocol', async () => {
    const port = await getFreePort()
    const rivalis = new Rivalis({
        transports: [new WSTransport({ port }, null, { ticketSource: 'protocol' })],
        authMiddleware: new ProtocolAuth()
    })
    rivalis.rooms.define('test', TestRoom)
    rivalis.rooms.create('test', 'room-1')

    // valid ticket via subprotocol → connects and stays open
    const good = new WSClient(`ws://127.0.0.1:${port}`, { ticketSource: 'protocol' })
    good.on('client:error', () => {})
    let goodClosed = false
    good.on('client:disconnect', () => { goodClosed = true })

    await (async () => {
        const connected = waitForEvent(good, 'client:connect')
        good.connect('good')
        await connected
    })()

    await delay(150)   // give the server a tick to reject if auth had failed
    assert.equal(good.connected, true, 'valid protocol ticket keeps the socket open')
    assert.equal(goodClosed, false, 'valid protocol ticket must not be closed by the server')

    // invalid ticket via subprotocol → server reads it and rejects
    const bad = new WSClient(`ws://127.0.0.1:${port}`, { ticketSource: 'protocol' })
    bad.on('client:error', () => {})
    const badClosed = waitForEvent(bad, 'client:disconnect', 3000)
    bad.connect('nope')
    await badClosed
    assert.equal(bad.connected, false, 'invalid protocol ticket must be rejected')

    good.disconnect()
    bad.disconnect()
    await rivalis.shutdown()
})

// ---- subprotocols option: ticket stays first, extras are offered ------------

test('subprotocols are offered alongside the ticket, with the ticket first', async () => {
    const SENTINEL = 'x-sentinel.v1'
    const port = await getFreePort()
    const transport = new WSTransport({ port }, null, { ticketSource: 'protocol' })
    const rivalis = new Rivalis({ transports: [transport], authMiddleware: new ProtocolAuth() })
    rivalis.rooms.define('test', TestRoom)
    rivalis.rooms.create('test', 'room-1')

    // Server prefers the sentinel when offered (the §13 fleet recipe). RFC 6455
    // only lets the server pick an offered subprotocol, so a sentinel echo proves
    // the client actually offered it.
    const wss = (transport as unknown as { ws?: { options?: { handleProtocols?: unknown } } }).ws
    wss!.options!.handleProtocols = (protocols: Set<string>) => protocols.has(SENTINEL) ? SENTINEL : ([...protocols][0] ?? false)

    // Ticket 'good' first, sentinel appended. If the option offered the sentinel
    // FIRST, WSTransport would read it as the ticket and ProtocolAuth would reject —
    // so a successful connect proves the ticket remains the first offer.
    const client = new WSClient(`ws://127.0.0.1:${port}`, { ticketSource: 'protocol', subprotocols: [SENTINEL] })
    client.on('client:error', () => {})
    let closed = false
    client.on('client:disconnect', () => { closed = true })

    const connected = waitForEvent(client, 'client:connect')
    client.connect('good')
    await connected

    await delay(150)   // give the server a tick to reject if the ticket had been wrong
    assert.equal(client.connected, true, 'ticket stays first → auth passes → socket stays open')
    assert.equal(closed, false, 'a valid ticket-first offer is not closed by the server')
    const ws = (client as unknown as { ws: { protocol: string } }).ws
    assert.equal(ws.protocol, SENTINEL, 'server echoed the appended sentinel → the client offered it')

    client.disconnect()
    await rivalis.shutdown()
})

// ---- AC5: client:kicked fires for 4xxx close codes -------------------------

test('client:kicked is emitted with code and reason when server closes with 4xxx', async () => {
    const port = await getFreePort()
    const rivalis = new Rivalis({
        transports: [new WSTransport({ port }, null, { ticketSource: 'protocol' })],
        authMiddleware: new ProtocolAuth()
    })
    rivalis.rooms.define('test', TestRoom)
    rivalis.rooms.create('test', 'room-1')

    // An invalid ticket causes the server to close with CloseCode.INVALID_TICKET (4001).
    const client = new WSClient(`ws://127.0.0.1:${port}`, { ticketSource: 'protocol' })
    client.on('client:error', () => {})
    client.on('client:disconnect', () => {})

    const kicked = waitForEvent(client, 'client:kicked', 3000)
    client.connect('bad-ticket')
    const [info] = await kicked as [{ code: number; reason: string }]

    assert.equal(info.code, CloseCode.INVALID_TICKET, 'kicked event carries the 4xxx close code')
    assert.equal(typeof info.reason, 'string', 'kicked event reason is a decoded string')

    client.disconnect()
    await rivalis.shutdown()
})
