/**
 * RTCTransport↔RTCClient loopback integration test — werift backend (p2p.md §12, task 088).
 *
 * Mirrors rtc-loopback.test.mts but uses the werift dev/CI fallback backend
 * (RIVALIS_WEBRTC_BACKEND=werift) instead of node-datachannel. Proves that:
 *   - WeriftPeer satisfies the RTCPeerLike interface end-to-end.
 *   - The game (TttRoom) is completely unchanged — same logic, same protocol.
 *   - A zero-native-build dev path works: werift is pure TypeScript; no C++ toolchain needed.
 *
 * Guard: if werift is not installed (npm install --omit=optional), the suite is
 * automatically skipped — it does not fail CI that lacks the optional dep.
 *
 * Signal layer: an InProcessSignalBus routes signal:offer/answer/ice in-process,
 * eliminating the need for a real @rivalis/signal server (same approach as the
 * node-datachannel loopback test).
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Rivalis, AuthMiddleware, Room } from '@rivalis/core'
import type { AuthResult, Actor } from '@rivalis/core'
import { createCodec, FieldType } from '@rivalis/handshake'
import { RTCTransport, RTCClient, WeriftPeer } from '../lib/main.js'
import type { RTCAdapters } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Availability guard — skip the suite if werift is not installed
// ---------------------------------------------------------------------------

const req = createRequire(import.meta.url)
let weriftAvailable = false
try {
    req('werift')
    weriftAvailable = true
} catch {
    // werift optional dep not installed — skip rather than fail
}

const SKIP_REASON = weriftAvailable ? undefined : 'werift not installed — skipping werift loopback (npm install werift to run)'

// ---------------------------------------------------------------------------
// Signal wire codecs for the in-process relay
// (Identical schema to rtc-loopback.test.mts — copied for self-containment)
// ---------------------------------------------------------------------------

const F = FieldType

const welcomeCodec = createCodec({
    namespace: '@rivalis/node/werift-loopback-test-welcome',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: F.STRING, rule: 'optional' },
            { key: 'hostId',     type: F.STRING, rule: 'optional' },
            { key: 'iceServers', type: F.STRING, rule: 'optional' },
        ],
    },
})

const routingCodec = createCodec({
    namespace: '@rivalis/node/werift-loopback-test-routing',
    major: 1,
    schema: {
        Routed: [
            { key: 'to', type: F.STRING, rule: 'optional' },
        ],
    },
})

// ---------------------------------------------------------------------------
// InProcessSignalBus (identical to rtc-loopback.test.mts)
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
            // drop unroutable frames
        }
    }
}

// ---------------------------------------------------------------------------
// TttRoom — UNCHANGED from demo/src/server/TttRoom.ts (same as loopback test)
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
        this.players = this.players.filter((p) => p.id !== actor.id)
        this.resetBoard()
        this.status = 'waiting'
        this.turn = null
        this.winner = null
        this.joinable = true
        this.broadcastState()
    }

    private onPlace(actor: Actor<ActorData>, payload: Uint8Array): void {
        if (this.status !== 'playing') return
        const command = tttDecode<TttPlaceCommand>(payload)
        const player = this.players.find((p) => p.id === actor.id)
        if (!player || player.symbol !== this.turn) return
        const index = command.index | 0
        if (index < 0 || index >= 9 || this.board[index] !== null) return
        this.board[index] = player.symbol
        const outcome = this.evaluate()
        if (outcome !== null) {
            this.status = 'finished'
            this.winner = outcome
            this.turn = null
            this.joinable = true
        } else {
            this.turn = this.turn === 'X' ? 'O' : 'X'
        }
        this.broadcastState()
    }

    private onReset(actor: Actor<ActorData>): void {
        if (this.status !== 'finished') return
        if (!this.players.some((p) => p.id === actor.id)) return
        this.startGame()
        this.broadcastState()
    }

    private startGame(): void {
        this.resetBoard()
        this.status = 'playing'
        this.turn = 'X'
        this.winner = null
        this.joinable = false
    }

    private resetBoard(): void { this.board = Array(9).fill(null) }

    private evaluate(): TttOutcome {
        for (const [a, b, c] of WIN_LINES) {
            const v = this.board[a]
            if (v !== null && v === this.board[b] && v === this.board[c]) return v
        }
        return this.board.every((c) => c !== null) ? 'draw' : null
    }

    private snapshotFor(actorId: string | null): TttState {
        const me = actorId === null ? null : this.players.find((p) => p.id === actorId) ?? null
        return {
            youId: actorId ?? '',
            youSymbol: me?.symbol ?? null,
            board: this.board.slice(),
            turn: this.turn,
            status: this.status,
            winner: this.winner,
            players: this.players.slice(),
        }
    }

    private sendStateTo(actor: Actor<ActorData>): void {
        actor.send('ttt:state', tttEncode(this.snapshotFor(actor.id)))
    }

    private broadcastState(): void {
        this.each((actor) => {
            actor.send('ttt:state', tttEncode(this.snapshotFor(actor.id)))
        })
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
// Helpers
// ---------------------------------------------------------------------------

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

function waitFor(condition: () => boolean, timeoutMs = 12000): Promise<void> {
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
        }, 50)
    })
}

// ---------------------------------------------------------------------------
// Loopback environment factory — uses WeriftPeer adapters
// ---------------------------------------------------------------------------

function makeWeriftLoopbackEnv() {
    const bus = new InProcessSignalBus()

    function makeAdapters(): RTCAdapters {
        return {
            createPeerConnection: (cfg) => new WeriftPeer(cfg),
            createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
        }
    }

    const transport = new RTCTransport({
        signalUrl: 'loopback',
        ticket: 'host-signal-ticket',
        adapters: makeAdapters(),
    })

    const rivalis = new Rivalis<ActorData>({
        transports: [transport],
        authMiddleware: new LoopbackAuthMiddleware(),
    })
    rivalis.rooms.define('ttt', TttRoom)
    rivalis.rooms.create('ttt', 'ttt')

    return { rivalis, peerAdapters: makeAdapters }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('RTCTransport↔RTCClient loopback — werift backend (p2p.md §12, task 088)', { skip: SKIP_REASON }, () => {

    // ── Test 1: pendingEmits flush ───────────────────────────────────────────
    // Same §4.2 ordering proof as the node-datachannel loopback test, now via werift.
    // grantAccess triggers Room.onJoin → actor.send('ttt:state') before RTCTransport
    // registers its 'message' listener. TLayer buffers in pendingEmits and flushes
    // when the listener is registered in the same microtask after grant.
    //
    test('pendingEmits flush: onJoin ttt:state arrives after client:connect (werift)', async () => {
        const { rivalis, peerAdapters } = makeWeriftLoopbackEnv()

        const connected = defer<void>()
        const receivedStates: TttState[] = []

        const client = new RTCClient<string>('loopback', { adapters: peerAdapters() })
        client.on('client:connect', () => connected.resolve())
        client.on('ttt:state', (payload: Uint8Array) => {
            receivedStates.push(tttDecode<TttState>(payload))
        })

        client.connect('ttt|Alice|#ff0000')
        await connected.promise

        await waitFor(() => receivedStates.length >= 1)

        const first = receivedStates[0]!
        assert.strictEqual(first.status, 'waiting')
        assert.strictEqual(first.players.length, 1)
        assert.strictEqual(first.players[0]!.name, 'Alice')
        assert.strictEqual(first.youSymbol, 'X')

        client.disconnect()
        await new Promise(r => setTimeout(r, 150))
        await rivalis.shutdown()
    })

    // ── Test 2: Two-peer full loopback ───────────────────────────────────────
    // Both peers connect via real werift data channels. After both join,
    // TttRoom starts the game and broadcasts to both — proving end-to-end delivery.
    //
    test('two peers exchange ttt:state broadcasts over werift data channels', async () => {
        const { rivalis, peerAdapters } = makeWeriftLoopbackEnv()

        const connA = defer<void>()
        const connB = defer<void>()
        const statesA: TttState[] = []
        const statesB: TttState[] = []

        const clientA = new RTCClient<string>('loopback', { adapters: peerAdapters() })
        clientA.on('client:connect', () => connA.resolve())
        clientA.on('ttt:state', (p: Uint8Array) => statesA.push(tttDecode<TttState>(p)))

        const clientB = new RTCClient<string>('loopback', { adapters: peerAdapters() })
        clientB.on('client:connect', () => connB.resolve())
        clientB.on('ttt:state', (p: Uint8Array) => statesB.push(tttDecode<TttState>(p)))

        clientA.connect('ttt|Alice|#ff0000')
        await connA.promise
        await waitFor(() => statesA.length >= 1)
        assert.strictEqual(statesA[0]!.status, 'waiting')

        clientB.connect('ttt|Bob|#0000ff')
        await connB.promise

        await waitFor(() =>
            statesA.some(s => s.status === 'playing') &&
            statesB.some(s => s.status === 'playing'),
        )

        const latestA = statesA.filter(s => s.status === 'playing')[0]!
        assert.strictEqual(latestA.status, 'playing')
        assert.strictEqual(latestA.players.length, 2)
        assert.strictEqual(latestA.youSymbol, 'X')

        const latestB = statesB.filter(s => s.status === 'playing')[0]!
        assert.strictEqual(latestB.status, 'playing')
        assert.strictEqual(latestB.players.length, 2)
        assert.strictEqual(latestB.youSymbol, 'O')

        const aliceInBob = latestB.players.find(p => p.name === 'Alice')
        const bobInAlice = latestA.players.find(p => p.name === 'Bob')
        assert.ok(aliceInBob, 'Bob must see Alice in the players list')
        assert.ok(bobInAlice, 'Alice must see Bob in the players list')

        clientA.disconnect()
        clientB.disconnect()
        await new Promise(r => setTimeout(r, 200))
        await rivalis.shutdown()
    })

    // ── Test 3: Game move broadcast ──────────────────────────────────────────
    // After both peers are playing, Alice places at index 0. Both receive the
    // updated board — proving round-trip game traffic over werift data channels.
    //
    test('game move is broadcast to both peers over werift data channels', async () => {
        const { rivalis, peerAdapters } = makeWeriftLoopbackEnv()

        const connA = defer<void>()
        const connB = defer<void>()
        const statesA: TttState[] = []
        const statesB: TttState[] = []

        const clientA = new RTCClient<string>('loopback', { adapters: peerAdapters() })
        clientA.on('client:connect', () => connA.resolve())
        clientA.on('ttt:state', (p: Uint8Array) => statesA.push(tttDecode<TttState>(p)))

        const clientB = new RTCClient<string>('loopback', { adapters: peerAdapters() })
        clientB.on('client:connect', () => connB.resolve())
        clientB.on('ttt:state', (p: Uint8Array) => statesB.push(tttDecode<TttState>(p)))

        clientA.connect('ttt|Alice|#ff0000')
        await connA.promise
        clientB.connect('ttt|Bob|#0000ff')
        await connB.promise

        await waitFor(() =>
            statesA.some(s => s.status === 'playing') &&
            statesB.some(s => s.status === 'playing'),
        )

        const countA = statesA.length
        const countB = statesB.length
        clientA.send('place', tttEncode<TttPlaceCommand>({ index: 0 }))

        await waitFor(() =>
            statesA.length > countA && statesB.length > countB,
        )

        const afterMoveA = statesA[statesA.length - 1]!
        assert.strictEqual(afterMoveA.board[0], 'X')
        assert.strictEqual(afterMoveA.turn, 'O')

        const afterMoveB = statesB[statesB.length - 1]!
        assert.strictEqual(afterMoveB.board[0], 'X')
        assert.strictEqual(afterMoveB.turn, 'O')

        clientA.disconnect()
        clientB.disconnect()
        await new Promise(r => setTimeout(r, 200))
        await rivalis.shutdown()
    })

})
