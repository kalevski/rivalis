/**
 * SignalClient unit tests (p2p.md §4.2/§4.4, task 060).
 *
 * All tests run without a real WebSocket server. The underlying WSClient is
 * replaced by a mock Client injected via SignalClient's third constructor
 * parameter (the same ndc? injection pattern used by NodeDataChannelPeer).
 *
 * Covers:
 *  - connect/disconnect/send/connected delegate to the underlying client
 *  - client:connect/disconnect/kicked/error lifecycle events forwarded
 *  - all signal:* topic messages forwarded
 *  - default empty-string ticket when connect() called without args
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import { SignalClient } from '../lib/main.js'
import type { SignalTopic } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Mock Client — duck-typed to satisfy Client interface
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

class MockClient {
    private readonly map = new Map<string, Listener[]>()
    readonly sent: Array<{ topic: string; payload: Uint8Array | string | undefined }> = []
    connectedWith: string | null = null
    disconnectCalled = false
    _connected = false

    on(event: string, listener: Listener): this {
        const list = this.map.get(event) ?? []
        list.push(listener)
        this.map.set(event, list)
        return this
    }
    once(event: string, listener: Listener): this { return this.on(event, listener) }
    off(event: string, listener: Listener): this {
        const list = this.map.get(event) ?? []
        const idx = list.indexOf(listener)
        if (idx >= 0) list.splice(idx, 1)
        return this
    }

    get connected(): boolean { return this._connected }

    connect(ticket: string): void { this.connectedWith = ticket }
    disconnect(): void { this.disconnectCalled = true }
    send(topic: string, payload?: Uint8Array | string): void {
        this.sent.push({ topic, payload })
    }

    /** Trigger any registered listeners for the given event. */
    emit(event: string, ...args: unknown[]): void {
        for (const l of this.map.get(event) ?? []) l(...args)
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

function makeClient(): { sc: SignalClient; mock: MockClient } {
    const mock = new MockClient()
    const sc = new SignalClient('ws://signal:9000', {}, mock as AnyClient)
    return { sc, mock }
}

// ---------------------------------------------------------------------------
// Delegation tests
// ---------------------------------------------------------------------------

suite('SignalClient — delegation', () => {

    test('connect(ticket) delegates to underlying client', () => {
        const { sc, mock } = makeClient()
        sc.connect('room-abc:secret')
        assert.strictEqual(mock.connectedWith, 'room-abc:secret')
    })

    test('connect() without args passes empty string', () => {
        const { sc, mock } = makeClient()
        sc.connect()
        assert.strictEqual(mock.connectedWith, '')
    })

    test('disconnect() delegates to underlying client', () => {
        const { sc, mock } = makeClient()
        sc.disconnect()
        assert.ok(mock.disconnectCalled)
    })

    test('send(topic, payload) delegates to underlying client', () => {
        const { sc, mock } = makeClient()
        const payload = new Uint8Array([1, 2, 3])
        sc.send('signal:offer', payload)
        assert.strictEqual(mock.sent.length, 1)
        assert.strictEqual(mock.sent[0]!.topic, 'signal:offer')
        assert.strictEqual(mock.sent[0]!.payload, payload)
    })

    test('send(topic) without payload delegates with undefined', () => {
        const { sc, mock } = makeClient()
        sc.send('signal:ice')
        assert.strictEqual(mock.sent.length, 1)
        assert.strictEqual(mock.sent[0]!.topic, 'signal:ice')
        assert.strictEqual(mock.sent[0]!.payload, undefined)
    })

    test('connected reflects underlying client state', () => {
        const { sc, mock } = makeClient()
        assert.strictEqual(sc.connected, false)
        mock._connected = true
        assert.strictEqual(sc.connected, true)
    })

})

// ---------------------------------------------------------------------------
// Lifecycle event forwarding
// ---------------------------------------------------------------------------

suite('SignalClient — lifecycle event forwarding', () => {

    test('client:connect forwarded', () => {
        const { sc, mock } = makeClient()
        let fired = false
        sc.on('client:connect', () => { fired = true })
        mock.emit('client:connect')
        assert.ok(fired)
    })

    test('client:disconnect forwarded with payload', () => {
        const { sc, mock } = makeClient()
        const payloads: Uint8Array[] = []
        sc.on('client:disconnect', (p) => payloads.push(p))
        const reason = new Uint8Array([42])
        mock.emit('client:disconnect', reason)
        assert.strictEqual(payloads.length, 1)
        assert.strictEqual(payloads[0], reason)
    })

    test('client:kicked forwarded with code + reason', () => {
        const { sc, mock } = makeClient()
        const events: Array<{ code: number; reason: string }> = []
        sc.on('client:kicked', (info) => events.push(info))
        mock.emit('client:kicked', { code: 4003, reason: 'room_destroyed' })
        assert.strictEqual(events.length, 1)
        assert.deepStrictEqual(events[0], { code: 4003, reason: 'room_destroyed' })
    })

    test('client:error forwarded with error object', () => {
        const { sc, mock } = makeClient()
        const errors: Error[] = []
        sc.on('client:error', (e) => errors.push(e as Error))
        const err = new Error('ECONNREFUSED')
        mock.emit('client:error', err)
        assert.strictEqual(errors.length, 1)
        assert.strictEqual(errors[0], err)
    })

})

// ---------------------------------------------------------------------------
// Signal topic forwarding
// ---------------------------------------------------------------------------

const ALL_SIGNAL_TOPICS: readonly SignalTopic[] = [
    'signal:welcome',
    'signal:host_gone',
    'signal:offer',
    'signal:answer',
    'signal:ice',
]

suite('SignalClient — signal topic forwarding', () => {

    for (const topic of ALL_SIGNAL_TOPICS) {
        test(`${topic} forwarded with payload`, () => {
            const { sc, mock } = makeClient()
            const received: Uint8Array[] = []
            sc.on(topic, (p) => received.push(p as Uint8Array))
            const payload = new Uint8Array([10, 20, 30])
            mock.emit(topic, payload)
            assert.strictEqual(received.length, 1, `expected one ${topic} emission`)
            assert.strictEqual(received[0], payload)
        })
    }

    test('unknown topics are not forwarded (only SIGNAL_TOPICS are bridged)', () => {
        const { sc, mock } = makeClient()
        let fired = false
        sc.on('some:other' as SignalTopic, () => { fired = true })
        mock.emit('some:other', new Uint8Array())
        assert.strictEqual(fired, false, 'non-signal topics must not be bridged')
    })

})

// ---------------------------------------------------------------------------
// Construction / options
// ---------------------------------------------------------------------------

suite('SignalClient — construction', () => {

    test('accepts an injected underlying client (for testing)', () => {
        const mock = new MockClient()
        const sc = new SignalClient('ws://signal:9000', {}, mock as AnyClient)
        sc.connect('t')
        assert.strictEqual(mock.connectedWith, 't')
    })

    test('conforms to Client interface (connect/disconnect/send/connected present)', () => {
        const { sc } = makeClient()
        assert.strictEqual(typeof sc.connect, 'function')
        assert.strictEqual(typeof sc.disconnect, 'function')
        assert.strictEqual(typeof sc.send, 'function')
        assert.strictEqual(typeof sc.connected, 'boolean')
    })

})
