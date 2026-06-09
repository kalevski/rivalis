/**
 * Client contract-conformance suite (p2p.md §10, task 044).
 *
 * Parameterised over every Client implementation. Asserts that the
 * `connected` / `connect` / `disconnect` / `send` surface and the full
 * `ClientEvent` taxonomy work identically across all clients.
 *
 * Phase 0 harnesses (both run from this file):
 *   - Node WSClient  — core/src/clients/WSClient.ts  (imported via lib/wsclient.js)
 *   - Browser WSClient — browser/src/WSClient.ts     (imported via ../../browser/lib/main.js)
 *
 * ── Initially-red test ────────────────────────────────────────────────────────
 * S3 (`connected` is false during CONNECTING) FAILS for Browser WSClient (F3):
 *   - Node WSClient:    `connected = ws.readyState === OPEN`  → false ✓
 *   - Browser WSClient: `connected = this.ws !== null`        → true  ✗
 * This divergence is the F3 spec; S3 turns green once §3.2 conformance lands
 * (browser WSClient's `connected` getter must become readyState-based).
 *
 * ── Browser harness ───────────────────────────────────────────────────────────
 * The browser WSClient is designed for the browser environment and accesses
 * `window.TextEncoder`, `window.TextDecoder`, `window.URL`, and
 * `window.WebSocket` at module-evaluation time. We polyfill `global.window`
 * with Node.js built-ins + the `ws` library's WebSocket **before** the
 * dynamic import so the module body evaluates against valid globals.
 *
 * The browser suite is skipped when browser/lib/main.js has not been built
 * yet. Run `npm run build -w @rivalis/browser` (or the root `npm run build`)
 * to enable it.
 */

import { suite, test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { WebSocket } from 'ws'

// ── browser-globals polyfill ─────────────────────────────────────────────────
// Must be set synchronously BEFORE any module body that accesses window.* is
// evaluated. Dynamic imports that follow inherit this global state.
;(global as any).window = {
    TextEncoder,
    TextDecoder,
    URL,
    WebSocket,   // ws.WebSocket: supports onopen/onclose/onerror/onmessage props + binaryType
}

// ── static imports (core + node WSClient) ────────────────────────────────────
import { Rivalis, Room, Actor, AuthMiddleware, Client, CloseCode } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'
import { WSTransport } from '../lib/ws.js'
import { WSClient as NodeWSClient } from '../lib/wsclient.js'

// ── dynamic import of browser WSClient ───────────────────────────────────────
// Dynamic so the module body runs after global.window is set above.
// Wrapped in try/catch so the node-only suite still runs when browser has
// not been built yet (e.g. when running core tests in isolation).
let BrowserWSClient: (new (url: string, options?: Record<string, unknown>) => Client) | null = null
try {
    const browserLib = await import('../../browser/lib/main.js')
    BrowserWSClient = browserLib.WSClient as typeof BrowserWSClient
} catch {
    process.emitWarning(
        'browser/lib/main.js not found — Browser WSClient conformance suite skipped.\n' +
        'Run `npm run build -w @rivalis/browser` or `npm run build` from the repo root to enable it.'
    )
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, () => {
            const addr = srv.address()
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0
            srv.close(() => resolve(port))
        })
    })
}

function waitForEvent(emitter: Client, event: string, timeoutMs = 2000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`timed out waiting for '${event}'`)),
            timeoutMs
        )
        t.unref?.()
        emitter.once(event as any, (...args: unknown[]) => {
            clearTimeout(t)
            resolve(args)
        })
    })
}

// ── server-side fixtures ──────────────────────────────────────────────────────

/**
 * Accepts ticket 'good' → room 'conformance'. Rejects everything else
 * (server closes with CloseCode.INVALID_TICKET, 4001).
 */
class ConformanceAuth extends AuthMiddleware<null> {
    override async authenticate(ticket: string): Promise<AuthResult<null> | null> {
        if (ticket === 'good') {
            return { data: null, roomId: 'conformance' }
        }
        return null
    }
}

/**
 * Room used for message-delivery and round-trip tests.
 *
 * onJoin: sends `server:welcome` with payload `[1]` to the joining actor.
 * bind('echo'): echoes the payload back on topic 'echo'.
 */
class EchoRoom extends Room<null> {
    protected override onCreate(): void {
        this.bind('echo', (actor: Actor<null>, payload: Uint8Array) => {
            actor.send('echo', payload)
        })
    }
    protected override onJoin(actor: Actor<null>): void {
        actor.send('server:welcome', new Uint8Array([1]))
    }
}

// ── factory type ──────────────────────────────────────────────────────────────

/** A function that creates a fresh Client pointed at the given WebSocket URL. */
type ClientFactory = (url: string) => Client

// ── parameterised conformance suite ──────────────────────────────────────────

function runConformanceSuite(suiteName: string, makeClient: ClientFactory): void {
    suite(suiteName, () => {

        // ── S1: surface ────────────────────────────────────────────────────────
        //
        // Every Client exposes connected / connect / disconnect / send and
        // inherits on / once / off from Broadcast.

        test('S1 — surface: connected, connect, disconnect, send, on, once, off exist', () => {
            const c = makeClient('ws://127.0.0.1:9') // unreachable; we never connect
            assert.strictEqual(typeof c.connected, 'boolean', 'connected must be a boolean getter')
            assert.strictEqual(typeof c.connect, 'function', 'connect must be a function')
            assert.strictEqual(typeof c.disconnect, 'function', 'disconnect must be a function')
            assert.strictEqual(typeof c.send, 'function', 'send must be a function')
            assert.strictEqual(typeof c.on, 'function', 'on must be a function (from Broadcast)')
            assert.strictEqual(typeof c.once, 'function', 'once must be a function (from Broadcast)')
            assert.strictEqual(typeof c.off, 'function', 'off must be a function (from Broadcast)')
        })

        test('S2 — surface: instanceof Client is true', () => {
            const c = makeClient('ws://127.0.0.1:9')
            assert.ok(c instanceof Client, 'client must be an instance of the Client base class')
        })

        // ── S3: connected semantics (CONNECTING state) — initially red for browser WSClient
        //
        // A conforming Client is NOT "connected" until the transport handshake
        // succeeds and client:connect fires. connected must be false immediately
        // after connect() is called but before the server acknowledges.
        //
        // Node WSClient:    connected = ws.readyState === OPEN → false ✓
        // Browser WSClient: connected = this.ws !== null        → true  ✗  (F3 spec)
        //
        // This test is the specification for the §3.2 fix: the browser client's
        // `connected` getter must become readyState-based to match the node client.

        test('S3 — semantics: connected is false immediately after connect() (during CONNECTING)', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})
            c.on('client:disconnect' as any, () => {})

            c.connect('good')
            // Synchronously after connect() — socket is in CONNECTING state.
            // A conforming Client must report false until client:connect fires.
            assert.strictEqual(
                c.connected, false,
                'connected must be false while the socket is still in CONNECTING state'
            )

            // Allow the connection to settle before teardown.
            await waitForEvent(c, 'client:connect')
            c.disconnect()
            await waitForEvent(c, 'client:disconnect')
            await rivalis.shutdown()
        })

        // ── S4 – S7: connect / disconnect lifecycle ────────────────────────────

        test('S4 — semantics: connect() causes client:connect to fire', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})
            c.on('client:disconnect' as any, () => {})

            const connected = waitForEvent(c, 'client:connect')
            c.connect('good')
            await connected // must resolve without timing out

            c.disconnect()
            await waitForEvent(c, 'client:disconnect')
            await rivalis.shutdown()
        })

        test('S5 — semantics: connected is true after client:connect fires', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})
            c.on('client:disconnect' as any, () => {})

            const connected = waitForEvent(c, 'client:connect')
            c.connect('good')
            await connected
            assert.strictEqual(c.connected, true, 'connected must be true after client:connect fires')

            c.disconnect()
            await waitForEvent(c, 'client:disconnect')
            await rivalis.shutdown()
        })

        test('S6 — semantics: disconnect() causes client:disconnect to fire', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})

            const connected = waitForEvent(c, 'client:connect')
            c.connect('good')
            await connected

            const disconnected = waitForEvent(c, 'client:disconnect')
            c.disconnect()
            await disconnected // must resolve without timing out

            await rivalis.shutdown()
        })

        test('S7 — semantics: connected is false when client:disconnect fires (and after)', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})

            const connected = waitForEvent(c, 'client:connect')
            c.connect('good')
            await connected

            let connectedInsideListener = true
            c.once('client:disconnect' as any, () => {
                connectedInsideListener = c.connected
            })
            const disconnected = waitForEvent(c, 'client:disconnect')
            c.disconnect()
            await disconnected

            assert.strictEqual(
                connectedInsideListener, false,
                'connected must be false at the moment client:disconnect fires'
            )
            assert.strictEqual(c.connected, false, 'connected must be false after disconnect')

            await rivalis.shutdown()
        })

        // ── S8: send guards ────────────────────────────────────────────────────

        test('S8 — semantics: send() before connect() does not throw', () => {
            const c = makeClient('ws://127.0.0.1:9')
            // Documented no-op with a warning — must never throw.
            assert.doesNotThrow(() => c.send('any:topic', 'payload'))
            assert.doesNotThrow(() => c.send('any:topic', new Uint8Array([1, 2, 3])))
        })

        // ── S9: message delivery ───────────────────────────────────────────────
        //
        // EchoRoom.onJoin sends server:welcome ([1]) to every joining actor.
        // The client must surface incoming frames as events keyed by topic.

        test('S9 — semantics: server-sent message arrives on the correct topic as Uint8Array', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})
            c.on('client:disconnect' as any, () => {})

            // Register the topic listener BEFORE connect so we don't race
            // with the server:welcome message sent in onJoin.
            const welcome = waitForEvent(c, 'server:welcome')
            c.connect('good')
            const [payload] = await welcome

            assert.ok(
                payload instanceof Uint8Array,
                'message payload must be delivered as a Uint8Array'
            )
            assert.deepStrictEqual(
                payload, new Uint8Array([1]),
                'message payload must match what the server sent'
            )

            c.disconnect()
            await waitForEvent(c, 'client:disconnect')
            await rivalis.shutdown()
        })

        // ── S10 – S11: kick semantics ──────────────────────────────────────────
        //
        // When the server rejects or terminates a connection with a 4xxx close
        // code, a conforming Client must emit client:kicked with a typed
        // { code: number; reason: string } payload, followed by client:disconnect.
        //
        // We trigger a kick by connecting with an invalid ticket — the server
        // closes with CloseCode.INVALID_TICKET (4001).

        test('S10 — semantics: 4xxx server close emits client:kicked { code, reason }', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})
            c.on('client:disconnect' as any, () => {})

            const kicked = waitForEvent(c, 'client:kicked', 3000)
            c.connect('bad-ticket')
            const [info] = await kicked as [{ code: number; reason: string }]

            assert.strictEqual(
                info.code, CloseCode.INVALID_TICKET,
                'client:kicked must carry the 4xxx close code from the server'
            )
            assert.strictEqual(
                typeof info.reason, 'string',
                'client:kicked reason must be a decoded string'
            )

            c.disconnect()
            await rivalis.shutdown()
        })

        test('S11 — semantics: client:kicked fires before client:disconnect on server kick', async () => {
            const port = await getFreePort()
            const rivalis = new Rivalis<null>({
                transports: [new WSTransport({ port })],
                authMiddleware: new ConformanceAuth()
            })
            rivalis.rooms.define('echo', EchoRoom)
            rivalis.rooms.create('echo', 'conformance')

            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:error' as any, () => {})

            const events: string[] = []
            c.on('client:kicked' as any, () => events.push('kicked'))
            c.on('client:disconnect' as any, () => events.push('disconnect'))

            const disconnected = waitForEvent(c, 'client:disconnect', 3000)
            c.connect('bad-ticket')
            await disconnected

            assert.ok(events.includes('kicked'), 'client:kicked must fire on a 4xxx close')
            assert.ok(events.includes('disconnect'), 'client:disconnect must follow client:kicked')
            assert.ok(
                events.indexOf('kicked') < events.indexOf('disconnect'),
                'client:kicked must fire before client:disconnect'
            )

            c.disconnect()
            await rivalis.shutdown()
        })

        // ── S12: client:error ──────────────────────────────────────────────────
        //
        // Connecting to a port with no listener (ECONNREFUSED) must surface an
        // Error via client:error. The process must not crash (no unhandled
        // 'error' event on the underlying socket).

        test('S12 — semantics: connection refused emits client:error with an Error (no crash)', async () => {
            const port = await getFreePort() // nothing listening on this port
            const c = makeClient(`ws://127.0.0.1:${port}`)
            c.on('client:disconnect' as any, () => {})

            const errored = waitForEvent(c, 'client:error', 3000)
            c.connect('whatever')
            const [error] = await errored

            assert.ok(error instanceof Error, 'client:error must carry an Error instance')
            assert.strictEqual(c.connected, false, 'connected must be false after a failed connect')
        })

    })
}

// ── run the suite for each client ─────────────────────────────────────────────

// Node WSClient — reconnect is handled by the caller; client itself does not reconnect.
runConformanceSuite(
    'Node WSClient conformance',
    (url: string) => new NodeWSClient(url)
)

// Browser WSClient — pass `reconnect: false` so the client does not schedule
// reconnect attempts that would interfere with test teardown / assertions.
if (BrowserWSClient !== null) {
    const BrowserClass = BrowserWSClient
    runConformanceSuite(
        'Browser WSClient conformance',
        (url: string) => new BrowserClass(url, { reconnect: false })
    )
}
