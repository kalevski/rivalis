/**
 * WS+RTC multi-transport integration test (p2p.md §10, §3.6, task 079).
 *
 * One Rivalis instance with [WSTransport, RTCTransport]; a WS client and an
 * RTC peer join the same room and observe each other's presence and broadcasts.
 * Proves §3.6: actors admitted by different transports share one room space,
 * one actorCount, and one broadcast surface.
 *
 * Signal layer: InProcessSignalBus (same pattern as rtc-loopback.test.mts)
 * — no real @rivalis/signal server needed for the RTC leg.
 *
 * Availability guard: suite is skipped if node-datachannel native binary
 * is absent (e.g. CI without native deps).
 */

import { suite, test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'
import { Rivalis, Room, Actor, AuthMiddleware } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/core/transports/ws'
import { createCodec, FieldType, encode as hsEncode, decode as hsDecode } from '@rivalis/handshake'
import { WebSocket } from 'ws'
import { RTCTransport, RTCClient, NodeDataChannelPeer } from '../lib/main.js'
import type { RTCAdapters } from '../lib/main.js'

// ── Availability guard ────────────────────────────────────────────────────────

const req = createRequire(import.meta.url)
let ndcAvailable = false
try {
    req('node-datachannel')
    ndcAvailable = true
} catch {
    // native binary not present — suite will be skipped
}

const SKIP_REASON = ndcAvailable
    ? undefined
    : 'node-datachannel not installed — skipping WS+RTC multi-transport'

// ── InProcessSignalBus ────────────────────────────────────────────────────────
//
// Identical to rtc-loopback.test.mts — routes signal:offer/answer/ice in-process
// so no real @rivalis/signal server is needed.

const F = FieldType

const welcomeCodec = createCodec({
    namespace: '@rivalis/node/ws-rtc-multi-transport-welcome',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'hostId',     type: F.STRING, rule: 'optional' },  // tag 2
            { key: 'iceServers', type: F.STRING, rule: 'optional' },  // tag 3
        ],
    },
})

const routingCodec = createCodec({
    namespace: '@rivalis/node/ws-rtc-multi-transport-routing',
    major: 1,
    schema: {
        Routed: [
            { key: 'to', type: F.STRING, rule: 'optional' },  // tag 1
        ],
    },
})

type Listener = (...args: unknown[]) => void

class InProcessSignalClient {
    private readonly listeners = new Map<string, Listener[]>()
    private _connected = false

    constructor(private readonly bus: InProcessSignalBus) {}

    on(event: string, listener: Listener): this {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
        return this
    }

    once(event: string, listener: Listener): this {
        const wrap = (...args: unknown[]) => {
            this.off(event, wrap)
            listener(...args)
        }
        return this.on(event, wrap)
    }

    off(event: string, listener: Listener): this {
        const list = this.listeners.get(event) ?? []
        this.listeners.set(event, list.filter(l => l !== listener))
        return this
    }

    get connected(): boolean { return this._connected }

    connect(ticket: string): void {
        this._connected = true
        this.bus.join(this, ticket)
    }

    disconnect(): void {
        this._connected = false
        this.bus.leave(this)
    }

    send(topic: string, payload: Uint8Array | string): void {
        const bytes = payload instanceof Uint8Array
            ? payload
            : new TextEncoder().encode(payload)
        this.bus.route(topic, bytes)
    }

    _receive(topic: string, payload: Uint8Array): void {
        for (const l of this.listeners.get(topic) ?? []) {
            l(payload)
        }
    }
}

class InProcessSignalBus {
    private readonly clients = new Map<InProcessSignalClient, string>()
    private readonly byId = new Map<string, InProcessSignalClient>()
    private hostId: string | null = null
    private nextPeerIndex = 1

    createClient(): InProcessSignalClient {
        return new InProcessSignalClient(this)
    }

    join(client: InProcessSignalClient, _ticket: string): void {
        const isFirst = this.clients.size === 0
        const id = isFirst ? 'host' : `peer-${this.nextPeerIndex++}`
        if (isFirst) this.hostId = id

        this.clients.set(client, id)
        this.byId.set(id, client)

        const welcomePayload = welcomeCodec.encode('Welcome', {
            youId: id,
            hostId: this.hostId!,
            iceServers: '[]',
        })
        client._receive('signal:welcome', welcomePayload)
    }

    leave(client: InProcessSignalClient): void {
        const id = this.clients.get(client)
        if (id !== undefined) {
            this.clients.delete(client)
            this.byId.delete(id)
        }
    }

    route(topic: string, payload: Uint8Array): void {
        try {
            const msg = routingCodec.decode('Routed', payload)
            const toId = String(msg['to'] ?? '')
            this.byId.get(toId)?._receive(topic, payload)
        } catch {
            // Unroutable frame — silently drop (mirrors unknownTopicPolicy='drop')
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now()
        const tick = setInterval(() => {
            if (condition()) {
                clearInterval(tick)
                resolve()
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(tick)
                reject(new Error(`waitFor timed out after ${timeoutMs} ms`))
            }
        }, 30)
    })
}

// ── Domain ────────────────────────────────────────────────────────────────────

type ActorData = { name: string }

/**
 * Echo room: broadcasts every inbound message back to all actors so that
 * cross-transport delivery can be verified from both directions.
 */
class EchoRoom extends Room<ActorData> {
    protected override onMessage(_actor: Actor<ActorData>, topic: string, payload: Uint8Array): void {
        this.broadcast(topic, payload)
    }
}

/**
 * Auth: accepts tickets in the form "<roomId>|<name>" and routes the actor
 * to the named room. Both the WS client and the RTC peer use this format.
 */
class MultiTransportAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const [roomId, name] = ticket.split('|')
        if (!roomId || !name) return null
        return { data: { name }, roomId }
    }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

suite('WS+RTC multi-transport integration (p2p.md §10, §3.6)', { skip: SKIP_REASON }, () => {

    // ── Test 1: WS client and RTC peer coexist in one room ───────────────────
    //
    // Boots Rivalis with [WSTransport, RTCTransport]. Connects a native WebSocket
    // client through WSTransport and an RTCClient through RTCTransport. Verifies
    // both actors land in the same room (actorCount=2) via the shared TLayer.
    //
    test('WS client and RTC peer coexist in the same room (actorCount=2)', async (t) => {
        const port = await getFreePort()
        const bus = new InProcessSignalBus()

        const hostAdapters: RTCAdapters = {
            createPeerConnection: (cfg) => new NodeDataChannelPeer(cfg),
            createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
        }

        const rivalis = new Rivalis<ActorData>({
            transports: [
                new WSTransport({ port }, null, { ticketSource: 'protocol' }),
                new RTCTransport({ signalUrl: 'loopback', ticket: 'host-signal-ticket', adapters: hostAdapters }),
            ],
            authMiddleware: new MultiTransportAuth(),
        })
        rivalis.rooms.define('echo', EchoRoom)
        rivalis.rooms.create('echo', 'shared-room')

        let wsClient!: WebSocket
        let rtcClient!: RTCClient<string>

        t.after(async () => {
            wsClient?.close()
            rtcClient?.disconnect()
            await new Promise(r => setTimeout(r, 150))
            await rivalis.shutdown()
        })

        // Connect WS client (ticket in Sec-WebSocket-Protocol header)
        wsClient = await new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['shared-room|alice'])
            ws.on('open', () => resolve(ws))
            ws.on('error', reject)
        })

        // Connect RTC peer
        const rtcConnected = new Promise<void>((resolve) => {
            rtcClient = new RTCClient<string>('loopback', {
                adapters: {
                    createPeerConnection: (cfg) => new NodeDataChannelPeer(cfg),
                    createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
                },
            })
            rtcClient.on('client:connect', () => resolve())
            rtcClient.connect('shared-room|bob')
        })
        await rtcConnected

        const room = rivalis.rooms.get('shared-room')
        assert.ok(room !== null, 'shared room must exist')
        await waitFor(() => room!.actorCount === 2, 8000)
        assert.strictEqual(room!.actorCount, 2, 'WS client and RTC peer must both occupy the shared room')
    })

    // ── Test 2: Cross-transport broadcast delivery ────────────────────────────
    //
    // WS client sends a message; RTC peer must receive it via the shared TLayer.
    // RTC peer sends a message; WS client must receive it via the shared TLayer.
    // Both directions go through EchoRoom.broadcast() which fans out across all
    // actors regardless of which transport admitted them.
    //
    test('cross-transport broadcasts delivered in both directions', async (t) => {
        const port = await getFreePort()
        const bus = new InProcessSignalBus()

        const hostAdapters: RTCAdapters = {
            createPeerConnection: (cfg) => new NodeDataChannelPeer(cfg),
            createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
        }

        const rivalis = new Rivalis<ActorData>({
            transports: [
                new WSTransport({ port }, null, { ticketSource: 'protocol' }),
                new RTCTransport({ signalUrl: 'loopback', ticket: 'host-signal-ticket', adapters: hostAdapters }),
            ],
            authMiddleware: new MultiTransportAuth(),
        })
        rivalis.rooms.define('echo', EchoRoom)
        rivalis.rooms.create('echo', 'shared-room')

        let wsClient!: WebSocket
        let rtcClient!: RTCClient<string>

        t.after(async () => {
            wsClient?.close()
            rtcClient?.disconnect()
            await new Promise(r => setTimeout(r, 150))
            await rivalis.shutdown()
        })

        const wsMessages: Array<{ topic: string; payload: Uint8Array }> = []
        const rtcMessages: Array<{ topic: string; payload: Uint8Array }> = []

        // Connect WS client
        wsClient = await new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['shared-room|alice'])
            ws.on('open', () => resolve(ws))
            ws.on('error', reject)
        })
        wsClient.on('message', (data) => {
            try {
                const { topic, payload } = hsDecode(new Uint8Array(data as Buffer))
                wsMessages.push({ topic, payload })
            } catch { /* ignore non-handshake frames */ }
        })

        // Connect RTC peer
        const rtcConnected = new Promise<void>((resolve) => {
            rtcClient = new RTCClient<string>('loopback', {
                adapters: {
                    createPeerConnection: (cfg) => new NodeDataChannelPeer(cfg),
                    createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
                },
            })
            rtcClient.on('client:connect', () => resolve())
            rtcClient.on('chat', (payload: Uint8Array) => {
                rtcMessages.push({ topic: 'chat', payload })
            })
            rtcClient.connect('shared-room|bob')
        })
        await rtcConnected

        // Wait until both actors are in the room before sending
        const room = rivalis.rooms.get('shared-room')
        assert.ok(room !== null, 'shared room must exist')
        await waitFor(() => room!.actorCount === 2, 8000)

        // ── Direction A: RTC peer → WS client ────────────────────────────────
        const rtcPayload = new TextEncoder().encode('hello-from-rtc')
        rtcClient.send('chat', rtcPayload)

        await waitFor(
            () => wsMessages.some(m => m.topic === 'chat' &&
                new TextDecoder().decode(m.payload) === 'hello-from-rtc'),
            8000,
        )
        const wsGotRtc = wsMessages.some(m => m.topic === 'chat' &&
            new TextDecoder().decode(m.payload) === 'hello-from-rtc')
        assert.ok(wsGotRtc, 'WS client must receive the RTC peer broadcast via the shared TLayer')

        // ── Direction B: WS client → RTC peer ────────────────────────────────
        const wsPayload = new TextEncoder().encode('hello-from-ws')
        wsClient.send(hsEncode('chat', wsPayload))

        await waitFor(
            () => rtcMessages.some(m => m.topic === 'chat' &&
                new TextDecoder().decode(m.payload) === 'hello-from-ws'),
            8000,
        )
        const rtcGotWs = rtcMessages.some(m => m.topic === 'chat' &&
            new TextDecoder().decode(m.payload) === 'hello-from-ws')
        assert.ok(rtcGotWs, 'RTC peer must receive the WS client broadcast via the shared TLayer')
    })

})
