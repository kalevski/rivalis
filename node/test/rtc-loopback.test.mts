/**
 * RTCTransport↔RTCClient loopback integration test (p2p.md §10, §4.2, task 068).
 *
 * Two peers in one process over node-datachannel (no NAT) running an unchanged
 * TttRoom. Asserts:
 *   - Real WebRTC data channels carry game frames end-to-end.
 *   - The onJoin-send-before-listener path is covered: TttRoom.onJoin calls
 *     actor.send('ttt:state') before RTCTransport registers its 'message'
 *     listener. TLayer buffers those sends in pendingEmits (§4.2, capped at 256)
 *     and flushes them the moment the listener is registered — so the client
 *     receives the initial state even though it was enqueued before the listener
 *     existed. This is the §4.2 pendingEmits flush proof.
 *   - After both players join, both peers see the updated broadcast.
 *
 * The TttRoom in this file is intentionally identical to
 * demo/src/server/TttRoom.ts — only import paths differ; game logic is
 * UNCHANGED. This is the key test proving "same game logic over WebRTC."
 *
 * Signal layer: an InProcessSignalBus routes signal:offer/answer/ice messages
 * in-process, eliminating the need for a real @rivalis/signal server. The bus
 * uses createCodec (§3.5) to decode the `to` field (tag 1) from each routed
 * payload and forwards verbatim — the same relay @rivalis/signal.SignalRoom does.
 *
 * Availability guard: if node-datachannel is not installed (e.g. in CI without
 * native deps) the suite is automatically skipped via { skip: ... }.
 */

import { test, suite } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Rivalis, AuthMiddleware, Room } from '@rivalis/core'
import type { AuthResult, Actor } from '@rivalis/core'
import { createCodec, FieldType } from '@rivalis/handshake'
import { RTCTransport, RTCClient, NodeDataChannelPeer } from '../lib/main.js'
import type { RTCAdapters } from '../lib/main.js'

// ---------------------------------------------------------------------------
// Availability guard — skip the suite if node-datachannel is not installed
// ---------------------------------------------------------------------------

const req = createRequire(import.meta.url)
let ndcAvailable = false
try {
    req('node-datachannel')
    ndcAvailable = true
} catch {
    // native binary not present — skip rather than fail
}

const SKIP_REASON = ndcAvailable ? undefined : 'node-datachannel not installed — skipping loopback'

// ---------------------------------------------------------------------------
// Signal wire codecs for the in-process relay
//
// Both use major:1 — identical to NegotiationCore's SIGNAL_WIRE_MAJOR=1 and
// RTCTransport's internal codec. The namespace is a serializer scope key only;
// it has no effect on the wire format, so frames encoded here are decoded
// correctly by NegotiationCore/RTCTransport and vice-versa.
// ---------------------------------------------------------------------------

const F = FieldType

/**
 * Encodes signal:welcome frames sent by InProcessSignalBus to each client.
 * Schema mirrors NegotiationCore.codec.Welcome (same field order + types).
 */
const welcomeCodec = createCodec({
    namespace: '@rivalis/node/loopback-test-welcome',
    major: 1,
    schema: {
        Welcome: [
            { key: 'youId',      type: F.STRING, rule: 'optional' },  // tag 1
            { key: 'hostId',     type: F.STRING, rule: 'optional' },  // tag 2
            { key: 'iceServers', type: F.STRING, rule: 'optional' },  // tag 3
        ],
    },
})

/**
 * Decodes the `to` field (tag 1) from signal:offer, signal:answer, and
 * signal:ice frames so the bus can route each message to the right client.
 * Tags 2+ in those messages are silently ignored — protobuf-style schema
 * evolution is backward-compatible in this direction.
 */
const routingCodec = createCodec({
    namespace: '@rivalis/node/loopback-test-routing',
    major: 1,
    schema: {
        Routed: [
            { key: 'to', type: F.STRING, rule: 'optional' },  // tag 1 — all routed msgs
        ],
    },
})

// ---------------------------------------------------------------------------
// InProcessSignalBus — in-process @rivalis/signal relay for loopback tests
//
// Mimics the essential behaviour of SignalRoom (§4.3):
//   - First client to connect() becomes the host (youId === hostId in welcome).
//   - Subsequent clients are peers; their welcome carries the host's id.
//   - send(topic, payload) on any client routes the message to the peer whose
//     id appears in the payload's `to` field (tag 1), verbatim.
//
// No real WebSocket transport is needed — the signal leg is entirely in-process.
// ---------------------------------------------------------------------------

/** Duck-typed event map used by InProcessSignalClient. */
type Listener = (...args: unknown[]) => void

class InProcessSignalClient {
    private readonly listeners = new Map<string, Listener[]>()
    private _connected = false

    constructor(private readonly bus: InProcessSignalBus) {}

    /** Called by RTCTransport/PeerNegotiator to wire up event handlers. */
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

    /** Called when RTCTransport/PeerNegotiator registers with the signal server. */
    connect(ticket: string): void {
        this._connected = true
        this.bus.join(this, ticket)
    }

    disconnect(): void {
        this._connected = false
        this.bus.leave(this)
    }

    /** Called by RTCTransport/PeerNegotiator to relay a signal message. */
    send(topic: string, payload: Uint8Array | string): void {
        const bytes = payload instanceof Uint8Array
            ? payload
            : new TextEncoder().encode(payload)
        this.bus.route(topic, bytes)
    }

    /** Called by the bus to deliver an incoming signal message to this client. */
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

    /** Create a new signal client bound to this bus. Pass to createSignalingClient factory. */
    createClient(): InProcessSignalClient {
        return new InProcessSignalClient(this)
    }

    /** Called when a client's connect(ticket) fires. Assigns an id and sends signal:welcome. */
    join(client: InProcessSignalClient, _ticket: string): void {
        const isFirst = this.clients.size === 0
        const id = isFirst ? 'host' : `peer-${this.nextPeerIndex++}`
        if (isFirst) this.hostId = id

        this.clients.set(client, id)
        this.byId.set(id, client)

        // signal:welcome — same schema as NegotiationCore.codec.Welcome
        const welcomePayload = welcomeCodec.encode('Welcome', {
            youId: id,
            hostId: this.hostId!,
            iceServers: '[]',  // no TURN needed for loopback
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

    /**
     * Route a signal:offer, signal:answer, or signal:ice message.
     * Decodes the `to` field (tag 1) from the payload and forwards the message
     * verbatim to the matching client — identical to SignalRoom.relay (§4.3).
     */
    route(topic: string, payload: Uint8Array): void {
        try {
            const msg = routingCodec.decode('Routed', payload)
            const toId = String(msg['to'] ?? '')
            this.byId.get(toId)?._receive(topic, payload)
        } catch {
            // Unroutable or malformed frame — silently drop (mirrors unknownTopicPolicy='drop')
        }
    }
}

// ---------------------------------------------------------------------------
// TttRoom — UNCHANGED from demo/src/server/TttRoom.ts
//
// Only the import paths differ (no relative ../../demo; types are inlined
// below). The game logic is byte-for-byte identical — the whole point of
// this test is to prove it works over WebRTC without any modifications.
// ---------------------------------------------------------------------------

// Inline equivalents of demo/src/protocol.ts (encode/decode + TttRoom types)
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

// UNCHANGED game logic — identical to demo/src/server/TttRoom.ts
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

        if (this.players.length === 2) {
            this.startGame()
        }

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
        if (!player) return
        if (player.symbol !== this.turn) return

        const index = command.index | 0
        if (index < 0 || index >= 9) return
        if (this.board[index] !== null) return

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

    private resetBoard(): void {
        this.board = Array(9).fill(null)
    }

    private evaluate(): TttOutcome {
        for (const [a, b, c] of WIN_LINES) {
            const v = this.board[a]
            if (v !== null && v === this.board[b] && v === this.board[c]) {
                return v
            }
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

// ---------------------------------------------------------------------------
// LoopbackAuthMiddleware
//
// Accepts the same ticket format as demo/src/server/AuthMiddleware.ts:
//   "<roomId>|<name>|<color>"
// The roomId in the ticket determines which room instance the player joins
// (room instance is created with the same id, see test setup).
// ---------------------------------------------------------------------------

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

/** Resolves/rejects a promise from the outside. */
function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

/** Poll until `condition()` returns true or `timeoutMs` elapses. */
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

// ---------------------------------------------------------------------------
// Shared loopback setup factory
// ---------------------------------------------------------------------------

/**
 * Spin up a complete in-process loopback environment:
 *   - One Rivalis host with RTCTransport + TttRoom
 *   - One InProcessSignalBus wiring host and peers
 *   - Adapter factories using real node-datachannel PeerConnections
 *
 * The caller connects RTCClients using `bus.createClient()` as the
 * createSignalingClient factory.
 */
function makeLoopbackEnv() {
    const bus = new InProcessSignalBus()

    // Host adapter: real node-datachannel PCs, in-process signal client
    const hostAdapters: RTCAdapters = {
        createPeerConnection: (cfg) => new NodeDataChannelPeer(cfg),
        createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
    }

    const transport = new RTCTransport({
        signalUrl: 'loopback',          // URL ignored — bus never dials
        ticket: 'host-signal-ticket',   // ticket ignored — bus has no auth
        adapters: hostAdapters,
    })

    const rivalis = new Rivalis<ActorData>({
        transports: [transport],
        authMiddleware: new LoopbackAuthMiddleware(),
    })
    rivalis.rooms.define('ttt', TttRoom)
    // Create room instance with id='ttt' so the ticket roomId matches
    rivalis.rooms.create('ttt', 'ttt')

    /** Create a peer adapter using the shared bus. */
    function peerAdapters(): RTCAdapters {
        return {
            createPeerConnection: (cfg) => new NodeDataChannelPeer(cfg),
            createSignalingClient: () => bus.createClient() as unknown as ReturnType<RTCAdapters['createSignalingClient']>,
        }
    }

    return { rivalis, peerAdapters }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('RTCTransport↔RTCClient loopback (p2p.md §10, §4.2)', { skip: SKIP_REASON }, () => {

    // ── Test 1: pendingEmits flush — onJoin-send-before-listener ─────────────
    //
    // The critical §4.2 ordering: grantAccess triggers Room.onJoin which calls
    // actor.send('ttt:state') BEFORE RTCTransport has registered its 'message'
    // listener. TLayer's pendingEmits buffer (TLayer.ts:58-66, cap 256) captures
    // the send. RTCTransport registers the listener in the same microtask after
    // grantAccess resolves, causing an immediate flush. The client must therefore
    // receive 'ttt:state' without any explicit trigger after 'client:connect'.
    //
    test('pendingEmits flush: onJoin ttt:state arrives without explicit trigger after client:connect', async () => {
        const { rivalis, peerAdapters } = makeLoopbackEnv()

        const connected = defer<void>()
        const receivedStates: TttState[] = []

        const client = new RTCClient<string>('loopback', {
            adapters: peerAdapters(),
        })

        client.on('client:connect', () => connected.resolve())
        client.on('ttt:state', (payload: Uint8Array) => {
            receivedStates.push(tttDecode<TttState>(payload))
        })

        client.connect('ttt|Alice|#ff0000')

        // Wait for the data channel to open
        await connected.promise

        // The onJoin handler in TttRoom sends ttt:state BEFORE the 'message'
        // listener is registered. By the time we receive 'client:connect',
        // the pendingEmits flush has already (or is about to) deliver the state.
        await waitFor(() => receivedStates.length >= 1, 8000)

        const first = receivedStates[0]!
        assert.strictEqual(first.status, 'waiting',
            'Initial state must be "waiting" (1 player, game not started yet)')
        assert.strictEqual(first.players.length, 1,
            'First ttt:state must show exactly 1 player (Alice)')
        assert.strictEqual(first.players[0]!.name, 'Alice',
            'Player name must match the ticket')
        assert.strictEqual(first.youSymbol, 'X',
            'First player gets symbol X')

        // Cleanup: disconnect client first, then shut down the Rivalis host
        // (shutdown destroys rooms, kicks any remaining actors, disposes transports)
        client.disconnect()
        await new Promise(r => setTimeout(r, 100))
        await rivalis.shutdown()
    })

    // ── Test 2: Two-peer full loopback — state exchange ──────────────────────
    //
    // Both clients connect over real WebRTC data channels. After both join:
    //   - TttRoom.onJoin detects 2 players and calls startGame() (status='playing')
    //   - broadcastState() sends updated state to BOTH actors
    //   - Both RTCClients must receive the playing state
    //
    // Also verifies the pendingEmits buffer for the SECOND player: their onJoin
    // sends happen before their listener is registered, yet they still arrive.
    //
    test('two peers exchange ttt:state broadcasts over real data channels', async () => {
        const { rivalis, peerAdapters } = makeLoopbackEnv()

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

        // Connect first peer
        clientA.connect('ttt|Alice|#ff0000')
        await connA.promise

        // Client A must receive the initial state from onJoin (pendingEmits flush)
        await waitFor(() => statesA.length >= 1, 8000)
        assert.strictEqual(statesA[0]!.status, 'waiting',
            'Alice must see status=waiting after joining alone')

        // Connect second peer
        clientB.connect('ttt|Bob|#0000ff')
        await connB.promise

        // After Bob joins, TttRoom.onJoin calls startGame() → broadcastState().
        // Both clients must receive the updated state showing status='playing'.
        await waitFor(() =>
            statesA.some(s => s.status === 'playing') &&
            statesB.some(s => s.status === 'playing'),
            8000,
        )

        // Assertions for Alice
        const latestA = statesA.filter(s => s.status === 'playing')[0]!
        assert.strictEqual(latestA.status, 'playing',
            'Alice must see status=playing after Bob joins')
        assert.strictEqual(latestA.players.length, 2,
            'Alice must see 2 players in the playing state')
        assert.strictEqual(latestA.youSymbol, 'X',
            'Alice (first joiner) must have symbol X')

        // Assertions for Bob
        const latestB = statesB.filter(s => s.status === 'playing')[0]!
        assert.strictEqual(latestB.status, 'playing',
            'Bob must see status=playing after joining')
        assert.strictEqual(latestB.players.length, 2,
            'Bob must see 2 players in the playing state')
        assert.strictEqual(latestB.youSymbol, 'O',
            'Bob (second joiner) must have symbol O')

        // The game is symmetric: each player sees the other in the players list
        const aliceInBob = latestB.players.find(p => p.name === 'Alice')
        const bobInAlice = latestA.players.find(p => p.name === 'Bob')
        assert.ok(aliceInBob, 'Bob must see Alice in the players list')
        assert.ok(bobInAlice, 'Alice must see Bob in the players list')

        // Cleanup
        clientA.disconnect()
        clientB.disconnect()
        await new Promise(r => setTimeout(r, 150))
        await rivalis.shutdown()
    })

    // ── Test 3: Game move broadcast ──────────────────────────────────────────
    //
    // After the game starts, Alice places a piece at index 0. Both clients
    // must receive the updated board state via the RTC data channel.
    //
    test('game move is broadcast to both peers over real data channels', async () => {
        const { rivalis, peerAdapters } = makeLoopbackEnv()

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

        // Wait until both see status=playing
        await waitFor(() =>
            statesA.some(s => s.status === 'playing') &&
            statesB.some(s => s.status === 'playing'),
            8000,
        )

        // Alice places at index 0 (she has symbol X, it is her turn)
        const countA = statesA.length
        const countB = statesB.length
        clientA.send('place', tttEncode<TttPlaceCommand>({ index: 0 }))

        // Both clients must receive a state update reflecting the move
        await waitFor(() =>
            statesA.length > countA && statesB.length > countB,
            8000,
        )

        // Verify board updated on Alice's side
        const afterMoveA = statesA[statesA.length - 1]!
        assert.strictEqual(afterMoveA.board[0], 'X',
            "Alice's board must show X at index 0 after her move")
        assert.strictEqual(afterMoveA.turn, 'O',
            "After Alice's move, turn must switch to O (Bob)")

        // Verify board updated on Bob's side
        const afterMoveB = statesB[statesB.length - 1]!
        assert.strictEqual(afterMoveB.board[0], 'X',
            "Bob's board must show X at index 0 after Alice's move")
        assert.strictEqual(afterMoveB.turn, 'O',
            "Bob's view must also show turn=O after Alice moves")

        // Cleanup
        clientA.disconnect()
        clientB.disconnect()
        await new Promise(r => setTimeout(r, 150))
        await rivalis.shutdown()
    })

})
