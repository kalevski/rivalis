/**
 * Instance-side fleet client (§8). Attaches a `Rivalis` instance to an
 * orchestrator over core's hardened `WSClient` (task 002, `ticketSource:
 * 'protocol'` so the agent key never lands in a URL — §13): it reports the
 * instance's rooms/connections and executes orchestrator-pushed room commands.
 *
 * Strict orchestrator-driven request/reply (task 011): the agent never pushes
 * state spontaneously. The orchestrator polls (`fleet/poll`) on its own cadence
 * and the agent answers with `fleet/state` — a full snapshot when its hash differs
 * from the poll's `knownHash`, a hash-only reply otherwise. `drain()`/`undrain()`
 * flip the agent-owned status locally and resolve when a subsequent poll echoes the
 * target status (an acknowledged confirmation, no unsolicited frame).
 *
 * The load-bearing contract (§8): **never throws into the host process from
 * network failures**. Every transport callback is wrapped, failures are logged
 * via `rivalis.logging.getLogger('fleet:agent')`, and the agent reconnects with
 * exponential backoff (0.5 s → 30 s cap, full jitter — §7). This is what forces
 * the §4 `WSClient` hardening: the unhardened client crashes the host on the
 * first `ECONNREFUSED`.
 */

import { Broadcast } from '@toolcase/base'
import type { Rivalis, Client } from '@rivalis/core'
import type { Logger } from '@toolcase/logging'

import { Snapshot, type SnapshotOptions, type StateFrame } from './Snapshot'
import {
    PROTOCOL_VERSION,
    Topics,
    WS_SUBPROTOCOL,
    encodeFrame,
    decodeFrame,
    WireVersionError,
    type HelloPayload,
    type CmdPayload,
    type AckPayload,
    type PollPayload
} from '../wire'
import type { InstanceStatus } from '../domain'
import { NOOP_LOGGER } from '../util/logger'
import { describe } from '../util/errors'
import { WSClient } from '@rivalis/node'
import { packageVersion } from '../util/packageVersion'
import { defaultScheduler } from '../util/scheduler'

/**
 * Public agent option surface (§8). Lives next to its sole consumer rather than
 * in the pure data model — it is consumer configuration, not a read-model type.
 * Re-exported from `main.ts`. Note: no `heartbeatMs` — the interval is assigned
 * by the orchestrator in `fleet/hello` (single source of truth, §7).
 */
export interface FleetAgentOptions {
    /** Orchestrator WS endpoint. */
    url: string
    /** Agent key (sent via WS subprotocol, never query string — §13). */
    key: string
    /** Public URL game clients use to connect to this instance. */
    endpointUrl: string
    /** Human-readable instance name. */
    name: string
    labels?: Record<string, string>
    capacity?: {
        maxConnections?: number | null
        maxRooms?: number | null
    }
    /** Allow orchestrator-initiated `rooms.create` (default true). */
    autoCreate?: boolean
    /** Reject `connect()` after this deadline instead of retrying forever. */
    connectTimeoutMs?: number
}

/** Reconnect backoff floor / ceiling — 0.5 s → 30 s cap, full jitter (§7). */
const DEFAULT_BACKOFF_BASE_MS = 500
const DEFAULT_BACKOFF_CAP_MS = 30_000

/** `awaitEmpty` poll cadence. */
const DEFAULT_AWAIT_EMPTY_POLL_MS = 200

/** Lifecycle status surfaced by `agent.status` (§8). Distinct from the snapshot's `active`/`draining`. */
export type AgentLifecycleStatus = 'connecting' | 'connected' | 'draining' | 'closed'

/** Opaque timer handle — `unknown` so an injected fake scheduler can return anything. */
type TimerHandle = unknown

/** Injectable timer surface so tests drive heartbeat/debounce/backoff deterministically. */
export interface AgentScheduler {
    setTimeout(fn: () => void, ms: number): TimerHandle
    clearTimeout(handle: TimerHandle): void
    setInterval(fn: () => void, ms: number): TimerHandle
    clearInterval(handle: TimerHandle): void
}

/**
 * Test/advanced seams kept off the public `FleetAgentOptions` surface (§8 keeps
 * the documented constructor to `(rivalis, options)`). Mirrors the third-param
 * convention the Snapshot builder uses for its logger.
 */
export interface AgentInternals {
    createClient?: (url: string) => Client
    scheduler?: AgentScheduler
    backoff?: { baseMs?: number; capMs?: number }
    random?: () => number
    awaitEmptyPollMs?: number
    /** Wire process-signal handlers for `enableGracefulShutdown`; returns an uninstaller. */
    installSignalHandlers?: (handler: () => void) => () => void
}

/**
 * Default transport: core's hardened `WSClient`, ticket via subprotocol (§13).
 * The agent also offers the fixed {@link WS_SUBPROTOCOL} sentinel *after* the
 * ticket so the orchestrator can echo the sentinel — never the agent key — in the
 * `101` response (RFC 6455 only lets the server select an offered subprotocol).
 */
function defaultCreateClient(url: string): Client {
    return new WSClient(url, {
        ticketSource: 'protocol',
        subprotocols: [WS_SUBPROTOCOL]
    })
}

export class FleetAgent extends Broadcast {

    private readonly rivalis: Rivalis
    private readonly logger: Logger
    private readonly snapshot: Snapshot

    private readonly url: string
    private readonly key: string
    private readonly autoCreate: boolean
    private readonly maxRooms: number | null
    private readonly connectTimeoutMs: number | undefined

    private readonly client: Client
    private readonly scheduler: AgentScheduler
    private readonly random: () => number
    private readonly backoffBaseMs: number
    private readonly backoffCapMs: number
    private readonly awaitEmptyPollMs: number
    private readonly installSignalHandlers: AgentInternals['installSignalHandlers']

    private lifecycle: AgentLifecycleStatus = 'closed'
    private instanceId: string | null = null

    /** Set once `connect()`/reconnects should stop (intentional `disconnect()` or fatal error). */
    private closed = false
    /** Distinguishes an operator-driven close from a transport drop that should reconnect. */
    private intentionalClose = false

    private reconnectTimer: TimerHandle | null = null
    private connectDeadline: TimerHandle | null = null

    private reconnectAttempt = 0

    private connectResolve: (() => void) | null = null
    private connectReject: ((error: Error) => void) | null = null

    /**
     * Pending `drain()` / `undrain()` promises (task 011): each waits for a
     * `fleet/poll` echoing its target status — the orchestrator's acknowledged
     * confirmation that it recorded the agent-owned status flip. No unsolicited frame.
     */
    private pendingStatus: Array<{ target: InstanceStatus; resolve: () => void; reject: (e: Error) => void }> = []

    private uninstallSignals: (() => void) | null = null

    /**
     * Whether the room/transport listeners are currently attached (task 008). The
     * subscription lifecycle tracks the connection lifecycle: attached on construct
     * and on every `connect()`, detached on the terminal paths (`disconnect()`,
     * `failConnect()`) so a discarded/replaced agent stops reacting to room events
     * and the host can drop it (otherwise `RoomManager`'s broadcast retains it).
     */
    private listenersAttached = false

    /**
     * Drop provenance when a room is destroyed so a future id reuse is not mis-stamped
     * (§7). Room create/destroy/define no longer trigger a push — changes surface at
     * the next orchestrator poll (task 011).
     */
    private readonly onRoomDestroy = (roomId: string): void => {
        this.snapshot.forgetRoom(roomId)
    }

    constructor(rivalis: Rivalis, options: FleetAgentOptions, internals: AgentInternals = {}) {
        super()
        this.rivalis = rivalis
        this.logger = rivalis.logging?.getLogger?.('fleet:agent') ?? NOOP_LOGGER

        // Snapshot construction feature-detects the §4 core APIs and throws an
        // actionable, version-naming error at startup if they are absent. Build the
        // options without `undefined` keys (exactOptionalPropertyTypes) so the
        // Snapshot builder's own defaults apply. `agentVersion` is resolved from the
        // installed package manifest (task 009) — one helper shared with the CLI's
        // `--version`, so the reported version never drifts from `package.json` (§6).
        const snapshotOptions: SnapshotOptions = {
            name: options.name,
            endpointUrl: options.endpointUrl,
            agentVersion: packageVersion()
        }
        if (options.labels !== undefined) { snapshotOptions.labels = options.labels }
        if (options.capacity !== undefined) { snapshotOptions.capacity = options.capacity }
        if (options.autoCreate !== undefined) { snapshotOptions.autoCreate = options.autoCreate }
        this.snapshot = new Snapshot(rivalis, snapshotOptions, this.logger)

        this.url = options.url
        this.key = options.key
        this.autoCreate = options.autoCreate ?? true
        this.maxRooms = options.capacity?.maxRooms ?? null
        this.connectTimeoutMs = options.connectTimeoutMs

        this.scheduler = internals.scheduler ?? defaultScheduler
        this.random = internals.random ?? Math.random
        this.backoffBaseMs = internals.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS
        this.backoffCapMs = internals.backoff?.capMs ?? DEFAULT_BACKOFF_CAP_MS
        this.awaitEmptyPollMs = internals.awaitEmptyPollMs ?? DEFAULT_AWAIT_EMPTY_POLL_MS
        this.installSignalHandlers = internals.installSignalHandlers

        this.client = (internals.createClient ?? defaultCreateClient)(this.url)
        this.attachListeners()
    }

    /** Lifecycle status (§8): `'connecting' | 'connected' | 'draining' | 'closed'`. */
    get status(): AgentLifecycleStatus {
        return this.lifecycle
    }

    /** Stable per-process id (§6), constant across reconnects. */
    get processUid(): string {
        return this.snapshot.processUid
    }

    /**
     * Connect to the orchestrator; resolves on the first `fleet/hello`. Default:
     * retries forever (backoff per §7) — the promise stays pending while the
     * orchestrator is unreachable. With `connectTimeoutMs` set, rejects after the
     * deadline and transitions to `'closed'` with no background retry loop (§8).
     */
    connect(): Promise<void> {
        if (this.lifecycle === 'connected' || this.lifecycle === 'draining') {
            return Promise.resolve()
        }
        if (this.connectResolve !== null) {
            // A connect() is already in flight — return its outcome via a thin
            // adapter rather than starting a second connection.
            return new Promise<void>((resolve, reject) => {
                const prevResolve = this.connectResolve!
                const prevReject = this.connectReject!
                this.connectResolve = () => { prevResolve(); resolve() }
                this.connectReject = (e) => { prevReject(e); reject(e) }
            })
        }

        this.closed = false
        this.intentionalClose = false
        this.lifecycle = 'connecting'
        this.reconnectAttempt = 0
        // Re-attach listeners detached by a prior terminal close — the agent is
        // reusable after `disconnect()` (this resets `closed`), so the subscription
        // lifecycle follows the connection lifecycle (task 008). Idempotent: a no-op
        // on the first connect after construction (constructor already attached).
        this.attachListeners()

        return new Promise<void>((resolve, reject) => {
            this.connectResolve = resolve
            this.connectReject = reject
            if (this.connectTimeoutMs !== undefined) {
                this.connectDeadline = this.scheduler.setTimeout(
                    () => this.failConnect(new Error('fleet:agent connect timeout exceeded')),
                    this.connectTimeoutMs
                )
            }
            this.openConnection()
        })
    }

    /**
     * Mark this instance draining (§7, task 011): flips the agent-owned status
     * immediately (so the next `fleet/state` reply carries it) and resolves only when
     * a subsequent `fleet/poll` echoes `status: 'draining'` — the orchestrator's
     * acknowledged confirmation that it recorded the flip. No unsolicited frame.
     */
    drain(): Promise<void> {
        return this.requestStatus('draining')
    }

    /** Reverse of `drain()` — restore the instance to `active`; resolves on the poll echo (§7). */
    undrain(): Promise<void> {
        return this.requestStatus('active')
    }

    /** Resolve once every local room is empty (zero connections), or reject on `timeoutMs` (§8). */
    awaitEmpty({ timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
        const empty = (): boolean => {
            for (const id of this.rivalis.rooms.keys()) {
                const room = this.rivalis.rooms.get(id)
                if (room !== null && room.actorCount > 0) {
                    return false
                }
            }
            return true
        }
        if (empty()) {
            return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
            let poll: TimerHandle | null = null
            let deadline: TimerHandle | null = null
            const cleanup = (): void => {
                if (poll !== null) { this.scheduler.clearInterval(poll); poll = null }
                if (deadline !== null) { this.scheduler.clearTimeout(deadline); deadline = null }
            }
            poll = this.scheduler.setInterval(() => {
                if (empty()) { cleanup(); resolve() }
            }, this.awaitEmptyPollMs)
            if (timeoutMs !== undefined) {
                deadline = this.scheduler.setTimeout(() => {
                    cleanup()
                    reject(new Error('fleet:agent awaitEmpty timeout exceeded'))
                }, timeoutMs)
            }
        })
    }

    /** Detach cleanly: stop all timers, close the transport, no further reconnects (§8). */
    async disconnect(): Promise<void> {
        this.intentionalClose = true
        this.closed = true
        this.clearAllTimers()
        this.rejectPendingStatus(new Error('fleet:agent disconnected'))
        try {
            this.client.disconnect()
        } catch (error) {
            this.logger.warning(`fleet:agent transport disconnect error: ${describe(error)}`)
        }
        this.detachListeners()
        this.lifecycle = 'closed'
        if (this.connectReject !== null) {
            const reject = this.connectReject
            this.connectResolve = null
            this.connectReject = null
            reject(new Error('fleet:agent disconnected before connect resolved'))
        }
        this.emit('disconnect', Buffer.from('closed'))
    }

    /**
     * Wire `SIGTERM`/`SIGINT` to the graceful sequence (§8):
     * drain → awaitEmpty → disconnect → `rivalis.shutdown()`.
     */
    enableGracefulShutdown({ emptyTimeoutMs = 60_000 }: { emptyTimeoutMs?: number } = {}): void {
        // A second call would otherwise overwrite `uninstallSignals` and leak the
        // first handler pair — uninstall any previous pair first (task 008).
        if (this.uninstallSignals !== null) {
            this.uninstallSignals()
            this.uninstallSignals = null
        }
        const handler = (): void => { void this.gracefulShutdown(emptyTimeoutMs) }
        if (this.installSignalHandlers !== undefined) {
            this.uninstallSignals = this.installSignalHandlers(handler)
            return
        }
        process.once('SIGTERM', handler)
        process.once('SIGINT', handler)
        this.uninstallSignals = () => {
            process.removeListener('SIGTERM', handler)
            process.removeListener('SIGINT', handler)
        }
    }

    private async gracefulShutdown(emptyTimeoutMs: number): Promise<void> {
        try { await this.drain() } catch (error) { this.logger.warning(`fleet:agent graceful drain failed: ${describe(error)}`) }
        try { await this.awaitEmpty({ timeoutMs: emptyTimeoutMs }) } catch (error) { this.logger.warning(`fleet:agent graceful awaitEmpty: ${describe(error)}`) }
        try { await this.disconnect() } catch (error) { this.logger.warning(`fleet:agent graceful disconnect failed: ${describe(error)}`) }
        try { await this.rivalis.shutdown() } catch (error) { this.logger.warning(`fleet:agent graceful rivalis.shutdown failed: ${describe(error)}`) }
    }

    // -----------------------------------------------------------------------
    // Transport wiring
    // -----------------------------------------------------------------------

    /**
     * Attach the room-provenance and transport listeners (task 008). Idempotent —
     * re-`connect()` after a `disconnect()` calls this again but it no-ops while
     * already attached, so listeners are never doubled.
     */
    private attachListeners(): void {
        if (this.listenersAttached) {
            return
        }
        this.wireClient()
        this.subscribeRooms()
        this.listenersAttached = true
    }

    /**
     * Detach every listener on the terminal paths (task 008): the rooms broadcast
     * stops retaining this agent (no more `forgetRoom` on room destroy) and the
     * transport handlers are removed. Without this a discarded agent leaks — the
     * `RoomManager` broadcast keeps it alive for the host process's lifetime.
     */
    private detachListeners(): void {
        if (!this.listenersAttached) {
            return
        }
        this.unsubscribeRooms()
        try {
            this.client.removeAllListeners()
        } catch (error) {
            this.logger.warning(`fleet:agent transport removeAllListeners error: ${describe(error)}`)
        }
        this.listenersAttached = false
    }

    private wireClient(): void {
        // Registered once; the client instance is reused across reconnects, so
        // these survive a transport drop. Every handler is guarded — a throw here
        // would violate the §8 "never throws into the host" contract.
        this.client.on('client:connect', () => this.guard('transport open', () => this.onTransportOpen()))
        this.client.on('client:disconnect', (reason: Uint8Array) => this.guard('transport close', () => this.onTransportClose(reason)))
        this.client.on('client:error', (error: Error) => this.guard('transport error', () => this.onTransportError(error)))
        this.client.on(Topics.hello, (payload: unknown) => this.guard('hello', () => this.onHello(payload)))
        this.client.on(Topics.poll, (payload: unknown) => this.guard('poll', () => this.onPoll(payload)))
        this.client.on(Topics.cmd, (payload: unknown) => this.guard('cmd', () => this.onCmd(payload)))
    }

    private subscribeRooms(): void {
        // Only destroy is observed — to clean up provenance. Create/destroy/define no
        // longer push a sync; changes surface at the next orchestrator poll (task 011).
        this.rivalis.rooms.on('destroy', this.onRoomDestroy)
    }

    private unsubscribeRooms(): void {
        this.rivalis.rooms.off('destroy', this.onRoomDestroy)
    }

    private openConnection(): void {
        if (this.closed) {
            return
        }
        try {
            this.client.connect(this.key)
        } catch (error) {
            // Defensive: the hardened client should never throw, but if a custom
            // transport does, treat it as a failed attempt and schedule a retry.
            this.logger.warning(`fleet:agent connect attempt threw: ${describe(error)}`)
            this.scheduleReconnect()
        }
    }

    private onTransportOpen(): void {
        // Socket is OPEN; the orchestrator now sends `fleet/hello`. Nothing to do
        // until then — `connect()` resolves on hello, not on socket open.
        this.logger.debug?.('fleet:agent transport open — awaiting fleet/hello')
    }

    private onTransportClose(reason: Uint8Array): void {
        if (this.closed || this.intentionalClose) {
            return
        }
        // Reject any commands/status promises that depend on a live link, then
        // reconnect — the snapshot model needs no session resumption (§7).
        this.rejectPendingStatus(new Error('fleet:agent connection lost'))
        this.lifecycle = 'connecting'
        this.emit('disconnect', reason)
        this.scheduleReconnect()
    }

    private onTransportError(error: Error): void {
        // Surface only — `client:error` is followed by `client:disconnect`, which
        // drives the reconnect. The point of this listener is that an unhandled
        // 'error' on the ws socket would otherwise crash the host (§4, §8).
        this.logger.warning(`fleet:agent transport error: ${describe(error)}`)
        this.emit('error', error)
    }

    private scheduleReconnect(): void {
        if (this.closed || this.intentionalClose || this.reconnectTimer !== null) {
            return
        }
        const delay = this.backoffDelay()
        this.reconnectAttempt += 1
        this.reconnectTimer = this.scheduler.setTimeout(() => {
            this.reconnectTimer = null
            this.openConnection()
        }, delay)
    }

    /** Full-jitter exponential backoff: random in `[0, min(cap, base·2^attempt)]` (§7). */
    private backoffDelay(): number {
        const ceiling = Math.min(this.backoffCapMs, this.backoffBaseMs * Math.pow(2, this.reconnectAttempt))
        return Math.floor(this.random() * ceiling)
    }

    // -----------------------------------------------------------------------
    // Protocol handlers (orch → agent)
    // -----------------------------------------------------------------------

    private onHello(raw: unknown): void {
        let hello: HelloPayload
        try {
            hello = decodeFrame(Topics.hello, toBytes(raw)) as HelloPayload
        } catch (error) {
            if (error instanceof WireVersionError) {
                // Wire-format major mismatch (incl. a legacy JSON orchestrator,
                // whose `{` first byte reads as major 123): fail loudly at connect,
                // exactly as the semantic major-mismatch path below (§7).
                this.logger.error(error.message)
                this.emit('error', error)
                this.failConnect(error)
                return
            }
            // Malformed/truncated hello: log + drop, never throw (§8). The
            // orchestrator only sends hello once, so connect stays pending and the
            // backoff loop retries — the documented steady-state behavior.
            this.logger.warning(`fleet:agent failed to decode fleet/hello: ${describe(error)}`)
            return
        }
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
            const error = new Error(
                `fleet protocol major mismatch: orchestrator=${hello.protocolVersion}, ` +
                `agent=${PROTOCOL_VERSION} — upgrade so both speak the same major (§7)`
            )
            this.logger.error(error.message)
            this.emit('error', error)
            this.failConnect(error)
            return
        }

        this.instanceId = hello.instanceId
        this.reconnectAttempt = 0
        this.clearReconnect()
        this.clearConnectDeadline()

        // New connection → fresh instanceId, so the orchestrator holds no prior hash.
        // Reset the per-connection seq; the orchestrator drives reporting from here
        // by polling (its first poll carries knownHash:null → a full reply, §7).
        this.snapshot.resetConnection()
        this.lifecycle = this.snapshot.status === 'draining' ? 'draining' : 'connected'

        if (this.connectResolve !== null) {
            const resolve = this.connectResolve
            this.connectResolve = null
            this.connectReject = null
            resolve()
        }
        this.emit('connect', { instanceId: this.instanceId, processUid: this.snapshot.processUid })
    }

    /**
     * Answer an orchestrator `fleet/poll` with a `fleet/state` reply (§7, task 011):
     * full snapshot when our hash differs from the poll's `knownHash`, hash-only
     * otherwise. A poll echoing a pending `drain()`/`undrain()` target status also
     * resolves that promise (the acknowledged confirmation, no unsolicited frame).
     */
    private onPoll(raw: unknown): void {
        const poll = this.decodeInbound<PollPayload>(Topics.poll, raw)
        if (poll === null) {
            return
        }
        // Resolve drain()/undrain() when the orchestrator echoes the recorded status.
        this.resolveStatusOnEcho(poll.status)
        if (this.client.connected) {
            this.sendState(this.snapshot.pollReply(poll.reqId, poll.knownHash))
        }
    }

    private onCmd(raw: unknown): void {
        const cmd = this.decodeInbound<CmdPayload>(Topics.cmd, raw)
        if (cmd === null) {
            return
        }
        this.emit('command', cmd)
        switch (cmd.op) {
            case 'create': return this.execCreate(cmd)
            case 'destroy': return this.execDestroy(cmd)
            case 'drain': return this.execStatusCmd(cmd, 'draining')
            case 'undrain': return this.execStatusCmd(cmd, 'active')
            default:
                this.sendAck({ cmdId: cmd.cmdId, ok: false, error: `unknown op: ${String((cmd as { op?: unknown }).op)}` })
        }
    }

    private execCreate(cmd: CmdPayload): void {
        if (!this.autoCreate) {
            // Authoritative agent-side guard — placement should never target an
            // autoCreate:false instance, but the snapshot is the source of truth (§8).
            this.sendAck({ cmdId: cmd.cmdId, ok: false, error: 'autoCreate is disabled on this instance' })
            return
        }
        if (typeof cmd.roomType !== 'string') {
            this.sendAck({ cmdId: cmd.cmdId, ok: false, error: 'create requires roomType' })
            return
        }
        if (this.maxRooms !== null && this.rivalis.rooms.count >= this.maxRooms) {
            this.sendAck({ cmdId: cmd.cmdId, ok: false, error: `capacity exhausted: maxRooms=${this.maxRooms}` })
            return
        }
        if (typeof cmd.roomId === 'string' && this.rivalis.rooms.get(cmd.roomId) !== null) {
            // Defense in depth (task 003): the id already exists on this instance, so
            // `rooms.create` would throw "is taken". Signal it explicitly so the
            // orchestrator surfaces 409 ROOM_EXISTS (the §10 retry contract), not a
            // generic 502 COMMAND_FAILED. Placement's id reservation normally prevents
            // a create ever reaching here for an existing id.
            this.sendAck({ cmdId: cmd.cmdId, ok: false, exists: true, error: 'room id already exists' })
            return
        }
        try {
            const room = this.rivalis.rooms.create(cmd.roomType, cmd.roomId ?? null)
            // Stamp provenance so this room reports origin:'fleet' in snapshots (§7).
            this.snapshot.markFleetOrigin(room.id)
            this.sendAck({ cmdId: cmd.cmdId, ok: true, room: { id: room.id, type: room.type } })
        } catch (error) {
            this.sendAck({ cmdId: cmd.cmdId, ok: false, error: describe(error) })
        }
    }

    private execDestroy(cmd: CmdPayload): void {
        if (typeof cmd.roomId !== 'string') {
            this.sendAck({ cmdId: cmd.cmdId, ok: false, error: 'destroy requires roomId' })
            return
        }
        if (this.rivalis.rooms.get(cmd.roomId) === null) {
            // Idempotent destroy: the desired end state already holds (§7).
            this.sendAck({ cmdId: cmd.cmdId, ok: true, alreadyGone: true })
            return
        }
        try {
            this.rivalis.rooms.destroy(cmd.roomId)
            this.snapshot.forgetRoom(cmd.roomId)
            this.sendAck({ cmdId: cmd.cmdId, ok: true })
        } catch (error) {
            this.sendAck({ cmdId: cmd.cmdId, ok: false, error: describe(error) })
        }
    }

    private execStatusCmd(cmd: CmdPayload, status: InstanceStatus): void {
        // Orchestrator-initiated drain/undrain: the agent owns status — flip it and
        // ack; the new value rides in the next poll reply (task 011). No push (§7).
        this.snapshot.setStatus(status)
        this.lifecycle = status === 'draining' ? 'draining' : 'connected'
        this.sendAck({ cmdId: cmd.cmdId, ok: true })
    }

    // -----------------------------------------------------------------------
    // Outbound (agent → orch) — replies only (task 011)
    // -----------------------------------------------------------------------

    private requestStatus(target: InstanceStatus): Promise<void> {
        // Agent owns status — flip locally now so the next poll reply carries it
        // (the flip changes the snapshot hash, so the reply is full). Resolve only
        // when a poll echoes `target` — the orchestrator recorded it (§7, task 011).
        this.snapshot.setStatus(target)
        this.lifecycle = target === 'draining' ? 'draining' : 'connected'
        return new Promise<void>((resolve, reject) => {
            this.pendingStatus.push({ target, resolve, reject })
        })
    }

    /** Resolve every pending drain()/undrain() whose target matches the poll-echoed status. */
    private resolveStatusOnEcho(echoed: InstanceStatus): void {
        if (this.pendingStatus.length === 0) {
            return
        }
        const remaining: typeof this.pendingStatus = []
        for (const pending of this.pendingStatus) {
            if (pending.target === echoed) {
                pending.resolve()
            } else {
                remaining.push(pending)
            }
        }
        this.pendingStatus = remaining
    }

    private sendState(frame: StateFrame): void {
        this.send(Topics.state, frame.payload)
    }

    private sendAck(ack: AckPayload): void {
        this.send(Topics.ack, ack)
    }

    private send(topic: string, payload: unknown): void {
        try {
            this.client.send(topic, encodeFrame(topic, payload))
        } catch (error) {
            this.logger.warning(`fleet:agent send failed topic=${topic}: ${describe(error)}`)
        }
    }

    // -----------------------------------------------------------------------
    // Teardown helpers
    // -----------------------------------------------------------------------

    /** Fatal connect failure (timeout or protocol mismatch): reject, close, stop retrying (§8). */
    private failConnect(error: Error): void {
        this.closed = true
        this.intentionalClose = true
        this.clearAllTimers()
        this.rejectPendingStatus(error)
        try {
            this.client.disconnect()
        } catch (disconnectError) {
            this.logger.warning(`fleet:agent disconnect during failConnect: ${describe(disconnectError)}`)
        }
        this.detachListeners()
        this.lifecycle = 'closed'
        if (this.connectReject !== null) {
            const reject = this.connectReject
            this.connectResolve = null
            this.connectReject = null
            reject(error)
        }
    }

    private rejectPendingStatus(error: Error): void {
        const pending = this.pendingStatus
        this.pendingStatus = []
        for (const entry of pending) {
            entry.reject(error)
        }
    }

    private clearReconnect(): void {
        if (this.reconnectTimer !== null) {
            this.scheduler.clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private clearConnectDeadline(): void {
        if (this.connectDeadline !== null) {
            this.scheduler.clearTimeout(this.connectDeadline)
            this.connectDeadline = null
        }
    }

    private clearAllTimers(): void {
        this.clearReconnect()
        this.clearConnectDeadline()
        if (this.uninstallSignals !== null) {
            this.uninstallSignals()
            this.uninstallSignals = null
        }
    }

    /** Run a transport/timer callback, swallowing+logging any throw (§8 host-safety contract). */
    private guard(label: string, fn: () => void): void {
        try {
            fn()
        } catch (error) {
            this.logger.error(`fleet:agent ${label} handler error: ${describe(error)}`)
            this.emit('error', error instanceof Error ? error : new Error(describe(error)))
        }
    }

    /**
     * Decode an inbound binary frame for a non-hello topic (§7, task 005). Logs +
     * returns `null` on any failure — never throws into the host (§8). A
     * protocol-incompatible frame is logged as a version mismatch; a
     * malformed/truncated frame is logged and dropped. (`fleet/hello` handles a
     * version mismatch itself — a loud connect failure — so it does not use this.)
     */
    private decodeInbound<T>(topic: string, raw: unknown): T | null {
        try {
            return decodeFrame(topic, toBytes(raw)) as T
        } catch (error) {
            if (error instanceof WireVersionError) {
                this.logger.warning(`fleet:agent dropped protocol-incompatible ${topic} frame (peer major=${error.theirVersion}, agent=${PROTOCOL_VERSION})`)
            } else {
                this.logger.warning(`fleet:agent failed to decode ${topic}: ${describe(error)}`)
            }
            return null
        }
    }
}

/** Normalize a re-emitted transport payload to bytes for the wire decoder. */
function toBytes(raw: unknown): Uint8Array {
    if (raw instanceof Uint8Array) {
        return raw
    }
    if (typeof raw === 'string') {
        return Buffer.from(raw, 'utf-8')
    }
    // Defensive: an unexpected payload type decodes to an empty (→ malformed) frame.
    return new Uint8Array(0)
}
