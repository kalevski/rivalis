/**
 * CI-optional coturn TURN relay test (p2p.md §10, task 077).
 *
 * Verifies that WebRTC data channels can be established through a TURN relay by
 * forcing iceTransportPolicy:'relay' on every PeerConnection. With relay-only
 * transport, any successful connection proves the TURN server is reached — direct
 * or host-reflexive candidates are explicitly disabled.
 *
 * The test shares the same InProcessSignalBus + TttRoom setup as rtc-loopback.test.mts
 * but replaces:
 *   1. iceServers in the welcome payload — includes the coturn TURN URL + ephemeral creds
 *   2. createPeerConnection adapters — wrap NodeDataChannelPeer with iceTransportPolicy:'relay'
 *
 * Required environment variables (absent → suite is skipped):
 *   COTURN_HOST          hostname or IP of the coturn TURN server  (e.g. "127.0.0.1")
 *   COTURN_TURN_SECRET   static-auth-secret matching coturn's config
 *
 * Optional environment variables:
 *   COTURN_PORT          TURN port (default: 3478)
 *
 * Without node-datachannel the suite is also skipped.
 *
 * Running locally with a coturn Docker container:
 *
 *   docker run -d --rm --network host --name rivalis-coturn \
 *     coturn/coturn \
 *       --use-auth-secret \
 *       --static-auth-secret=test-secret \
 *       --realm=test.local \
 *       --no-tls \
 *       --no-dtls \
 *       --min-port=49152 --max-port=65535
 *
 *   COTURN_HOST=127.0.0.1 COTURN_TURN_SECRET=test-secret \
 *     npm test -w @rivalis/node
 *
 * In CI, add a coturn service container with the same flags and set the two env vars
 * in the job environment before running the test suite.
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
import { Rivalis, AuthMiddleware, Room } from '@rivalis/core'
import type { AuthResult, Actor } from '@rivalis/core'
import { createCodec, FieldType } from '@rivalis/handshake'
import { RTCTransport, RTCClient, NodeDataChannelPeer } from '../lib/main.js'
import type { RTCAdapters } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Availability guards
// ---------------------------------------------------------------------------

const req = createRequire(import.meta.url)
let ndcAvailable = false
try {
    req('node-datachannel')
    ndcAvailable = true
} catch {
    // native binary not present
}

const COTURN_HOST = process.env['COTURN_HOST'] ?? ''
const COTURN_PORT = parseInt(process.env['COTURN_PORT'] ?? '3478', 10)
const COTURN_TURN_SECRET = process.env['COTURN_TURN_SECRET'] ?? ''

const SKIP_REASON: string | undefined =
    !ndcAvailable ? 'node-datachannel not installed — skipping TURN relay test'
    : !COTURN_HOST ? 'COTURN_HOST env var not set — CI-optional TURN test skipped'
    : !COTURN_TURN_SECRET ? 'COTURN_TURN_SECRET env var not set — CI-optional TURN test skipped'
    : undefined

// ---------------------------------------------------------------------------
// Ephemeral TURN credential minting (mirrors IceConfig.issueFor in @rivalis/signal)
//
// coturn static-auth-secret / REST scheme:
//   username   = "<unixExpiry>:<peerId>"
//   credential = base64(HMAC_SHA1(static-auth-secret, username))
//
// coturn verifies the HMAC and rejects creds whose unixExpiry is in the past.
// ---------------------------------------------------------------------------

function mintTurnCred(
    secret: string,
    peerId: string,
    ttlSeconds = 86400,
): { username: string; credential: string } {
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds
    const username = `${expiry}:${peerId}`
    const credential = createHmac('sha1', secret).update(username).digest('base64')
    return { username, credential }
}

// ---------------------------------------------------------------------------
// Signal wire codecs — same schemas as NegotiationCore (different namespace)
// ---------------------------------------------------------------------------

const F = FieldType

const welcomeCodec = createCodec({
    namespace: '@rivalis/node/turn-relay-test-welcome',
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
    namespace: '@rivalis/node/turn-relay-test-routing',
    major: 1,
    schema: {
        Routed: [
            { key: 'to', type: F.STRING, rule: 'optional' },  // tag 1
        ],
    },
})

// ---------------------------------------------------------------------------
// InProcessSignalBus — same shape as in rtc-loopback.test.mts but accepts
// a pre-serialised iceServers JSON string to include in signal:welcome.
// ---------------------------------------------------------------------------

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
        const wrap = (...args: unknown[]) => { this.off(event, wrap); listener(...args) }
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
        for (const l of this.listeners.get(topic) ?? []) l(payload)
    }
}

class InProcessSignalBus {
    private readonly clients = new Map<InProcessSignalClient, string>()
    private readonly byId = new Map<string, InProcessSignalClient>()
    private hostId: string | null = null
    private nextPeerIndex = 1

    constructor(private readonly iceServersJson: string = '[]') {}

    createClient(): InProcessSignalClient {
        return new InProcessSignalClient(this)
    }

    join(client: InProcessSignalClient, _ticket: string): void {
        const isFirst = this.clients.size === 0
        const id = isFirst ? 'host' : `peer-${this.nextPeerIndex++}`
        if (isFirst) this.hostId = id

        this.clients.set(client, id)
        this.byId.set(id, client)

        client._receive('signal:welcome', welcomeCodec.encode('Welcome', {
            youId: id,
            hostId: this.hostId!,
            iceServers: this.iceServersJson,
        }))
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
            // Unroutable — silently drop (mirrors unknownTopicPolicy='drop')
        }
    }
}

// ---------------------------------------------------------------------------
// TttRoom — identical to rtc-loopback.test.mts (UNCHANGED game logic)
// ---------------------------------------------------------------------------

type ActorData = { name: string; color: string }
type TttCell = 'X' | 'O' | null
type TttPlayer = { id: string; name: string; color: string; symbol: 'X' | 'O' }
type TttStatus = 'waiting' | 'playing' | 'finished'
type TttOutcome = 'X' | 'O' | 'draw' | null
type TttPlaceCommand = { index: number }
type TttState = {
    youId: string
    youSymbol: 'X' | 'O' | null
    board: TttCell[]
    turn: 'X' | 'O' | null
    status: TttStatus
    winner: TttOutcome
    players: TttPlayer[]
}

const _enc = new TextEncoder()
const _dec = new TextDecoder()
const tttEncode = <T>(value: T): Uint8Array => _enc.encode(JSON.stringify(value))
const tttDecode = <T>(payload: Uint8Array): T => JSON.parse(_dec.decode(payload)) as T

const WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
]

class TttRoom extends Room<ActorData> {
    override maxActors = 2
    private board: TttCell[] = Array(9).fill(null)
    private turn: 'X' | 'O' | null = null
    private status: TttStatus = 'waiting'
    private winner: TttOutcome = null
    private players: TttPlayer[] = []

    protected override onCreate(): void {
        this.bind('place', this.onPlace)
        this.bind('reset', this.onReset)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const data = actor.data as ActorData
        const symbol: 'X' | 'O' = this.players.length === 0 ? 'X' : 'O'
        this.players.push({ id: actor.id, name: data.name, color: data.color, symbol })
        if (this.players.length === 2) this.startGame()
        this.sendStateTo(actor)
        this.broadcastState()
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        this.players = this.players.filter(p => p.id !== actor.id)
        this.resetBoard()
        this.status = 'waiting'
        this.turn = null
        this.winner = null
        this.joinable = true
        this.broadcastState()
    }

    private onPlace(actor: Actor<ActorData>, payload: Uint8Array): void {
        if (this.status !== 'playing') return
        const cmd = tttDecode<TttPlaceCommand>(payload)
        const player = this.players.find(p => p.id === actor.id)
        if (!player || player.symbol !== this.turn) return
        const index = cmd.index | 0
        if (index < 0 || index >= 9 || this.board[index] !== null) return
        this.board[index] = player.symbol
        const outcome = this.evaluate()
        if (outcome !== null) {
            this.status = 'finished'; this.winner = outcome; this.turn = null; this.joinable = true
        } else {
            this.turn = this.turn === 'X' ? 'O' : 'X'
        }
        this.broadcastState()
    }

    private onReset(actor: Actor<ActorData>): void {
        if (this.status !== 'finished') return
        if (!this.players.some(p => p.id === actor.id)) return
        this.startGame()
        this.broadcastState()
    }

    private startGame(): void {
        this.resetBoard(); this.status = 'playing'; this.turn = 'X'; this.winner = null; this.joinable = false
    }
    private resetBoard(): void { this.board = Array(9).fill(null) }

    private evaluate(): TttOutcome {
        for (const [a, b, c] of WIN_LINES) {
            const v = this.board[a]
            if (v !== null && v === this.board[b] && v === this.board[c]) return v
        }
        return this.board.every(c => c !== null) ? 'draw' : null
    }

    private snapshotFor(actorId: string | null): TttState {
        const me = actorId === null ? null : this.players.find(p => p.id === actorId) ?? null
        return {
            youId: actorId ?? '', youSymbol: me?.symbol ?? null,
            board: this.board.slice(), turn: this.turn,
            status: this.status, winner: this.winner, players: this.players.slice(),
        }
    }

    private sendStateTo(actor: Actor<ActorData>): void {
        actor.send('ttt:state', tttEncode(this.snapshotFor(actor.id)))
    }
    private broadcastState(): void {
        this.each(actor => actor.send('ttt:state', tttEncode(this.snapshotFor(actor.id))))
    }
}

class LoopbackAuthMiddleware extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const parts = ticket.split('|')
        if (parts.length !== 3) return null
        const [roomId, name, color] = parts
        if (!roomId || !name || !color) return null
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null
        return { data: { name, color }, roomId }
    }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

function waitFor(condition: () => boolean, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now()
        const tick = setInterval(() => {
            if (condition()) {
                clearInterval(tick); resolve()
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(tick)
                reject(new Error(`waitFor timed out after ${timeoutMs} ms`))
            }
        }, 100)
    })
}

// ---------------------------------------------------------------------------
// Relay-forcing loopback environment
//
// Identical to makeLoopbackEnv() in rtc-loopback.test.mts except:
//   - InProcessSignalBus carries real TURN iceServers in signal:welcome
//   - createPeerConnection wraps NodeDataChannelPeer with iceTransportPolicy:'relay'
//     so only relay candidates are gathered — a successful connection proves TURN
// ---------------------------------------------------------------------------

function makeRelayEnv(iceServersJson: string) {
    const bus = new InProcessSignalBus(iceServersJson)

    function relayAdapters(): RTCAdapters {
        return {
            // Inject iceTransportPolicy:'relay' — forces all traffic through TURN
            createPeerConnection: (cfg) => new NodeDataChannelPeer({
                ...cfg,
                iceTransportPolicy: 'relay',
            }),
            createSignalingClient: () =>
                bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
        }
    }

    const transport = new RTCTransport({
        signalUrl: 'loopback',
        ticket: 'host-signal-ticket',
        adapters: relayAdapters(),
    })

    const rivalis = new Rivalis<ActorData>({
        transports: [transport],
        authMiddleware: new LoopbackAuthMiddleware(),
    })
    rivalis.rooms.define('ttt', TttRoom)
    rivalis.rooms.create('ttt', 'ttt')

    return { rivalis, relayAdapters }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('RTCTransport↔RTCClient TURN relay (p2p.md §10, task 077)', { skip: SKIP_REASON }, () => {

    // Build the TURN ICE servers JSON once for the suite.
    // Each peer gets its own ephemeral credentials.
    const turnUrl = `turn:${COTURN_HOST}:${COTURN_PORT}`
    const hostCred  = mintTurnCred(COTURN_TURN_SECRET, 'relay-host')
    const peerCred  = mintTurnCred(COTURN_TURN_SECRET, 'relay-peer')
    // Both adapters on each side will use one set of creds (the bus broadcasts the same
    // iceServers to both the host and the peer via signal:welcome — creds are short-lived
    // so reusing is safe for this test's lifetime).
    const iceServersJson = JSON.stringify([
        {
            urls: turnUrl,
            username: hostCred.username,
            credential: hostCred.credential,
        },
        {
            urls: turnUrl,
            username: peerCred.username,
            credential: peerCred.credential,
        },
    ])

    // ── Test 1: relay-only connection ────────────────────────────────────────
    //
    // With iceTransportPolicy:'relay' set on every PeerConnection, ICE will
    // gather ONLY relay candidates. If this test reaches client:connect and
    // receives ttt:state, the data channel was established exclusively through
    // the coturn TURN relay — no direct or host-reflexive path was used.
    //
    test('relay-only peer receives ttt:state over TURN relay', { timeout: 30000 }, async () => {
        const { rivalis, relayAdapters } = makeRelayEnv(iceServersJson)

        const connected = defer<void>()
        const receivedStates: TttState[] = []

        const client = new RTCClient<string>('loopback', {
            adapters: relayAdapters(),
        })

        client.on('client:connect', () => connected.resolve())
        client.on('ttt:state', (payload: Uint8Array) => {
            receivedStates.push(tttDecode<TttState>(payload))
        })

        client.connect('ttt|Alice|#ff0000')

        // A 30 s wait is intentional: relay candidate gathering and DTLS can be
        // slow on a real coturn instance. If this times out, coturn is unreachable
        // or the credentials are invalid — the test failure is the signal.
        await connected.promise

        // Receiving ttt:state proves the data channel carries game frames via TURN
        await waitFor(() => receivedStates.length >= 1, 28000)

        const first = receivedStates[0]!
        assert.strictEqual(first.status, 'waiting',
            'Initial state must be "waiting" (1 player, game not yet started)')
        assert.strictEqual(first.players.length, 1,
            'First ttt:state must show exactly 1 player (Alice)')
        assert.strictEqual(first.players[0]!.name, 'Alice',
            'Player name must match the ticket')
        assert.strictEqual(first.youSymbol, 'X',
            'First player gets symbol X')

        client.disconnect()
        await new Promise(r => setTimeout(r, 150))
        await rivalis.shutdown()
    })

    // ── Test 2: two relay-only peers exchange game state ─────────────────────
    //
    // Both clients connect exclusively through the TURN relay. After both join,
    // TttRoom starts the game and broadcasts to both. Asserts that the relay path
    // carries broadcast frames to two independent connections simultaneously.
    //
    test('two relay-only peers exchange ttt:state broadcasts via TURN', { timeout: 45000 }, async () => {
        const { rivalis, relayAdapters } = makeRelayEnv(iceServersJson)

        const connA = defer<void>()
        const connB = defer<void>()
        const statesA: TttState[] = []
        const statesB: TttState[] = []

        const clientA = new RTCClient<string>('loopback', { adapters: relayAdapters() })
        clientA.on('client:connect', () => connA.resolve())
        clientA.on('ttt:state', (p: Uint8Array) => statesA.push(tttDecode<TttState>(p)))

        const clientB = new RTCClient<string>('loopback', { adapters: relayAdapters() })
        clientB.on('client:connect', () => connB.resolve())
        clientB.on('ttt:state', (p: Uint8Array) => statesB.push(tttDecode<TttState>(p)))

        clientA.connect('ttt|Alice|#ff0000')
        await connA.promise
        await waitFor(() => statesA.length >= 1, 28000)

        clientB.connect('ttt|Bob|#0000ff')
        await connB.promise

        await waitFor(() =>
            statesA.some(s => s.status === 'playing') &&
            statesB.some(s => s.status === 'playing'),
            28000,
        )

        const latestA = statesA.filter(s => s.status === 'playing')[0]!
        assert.strictEqual(latestA.status, 'playing', 'Alice must see status=playing')
        assert.strictEqual(latestA.players.length, 2, 'Alice must see 2 players')
        assert.strictEqual(latestA.youSymbol, 'X', 'Alice gets symbol X')

        const latestB = statesB.filter(s => s.status === 'playing')[0]!
        assert.strictEqual(latestB.status, 'playing', 'Bob must see status=playing')
        assert.strictEqual(latestB.players.length, 2, 'Bob must see 2 players')
        assert.strictEqual(latestB.youSymbol, 'O', 'Bob gets symbol O')

        clientA.disconnect()
        clientB.disconnect()
        await new Promise(r => setTimeout(r, 150))
        await rivalis.shutdown()
    })

})
