/**
 * Embeddable fleet orchestrator (§9) — the dogfooded control plane (§7). After the
 * task-008 decomposition this is the **facade** wiring its collaborators, each a
 * separately unit-tested concern: {@link AgentAuthenticator} (agent-key match),
 * {@link CommandEngine} (pending commands + cap + settle), {@link Poller}
 * (orchestrator-driven polling + missed-reply stale/evict, task 011),
 * {@link EventReconciler} (read-model diffs → events), {@link FleetControl}
 * (create/destroy/drain), and `transport.ts` (control-plane bootstrap). The
 * Orchestrator retains config resolution, the `FleetApi` facade, poll dispatch +
 * per-agent outstanding-request enforcement, and lifecycle (`listen`/`shutdown`).
 *
 * `listen()` is the only method that touches core / the network; constructing an
 * Orchestrator loads no core, so the control plane is exercised directly in unit
 * tests against the {@link AgentLink} seams and an injectable scheduler (§15).
 */

import type { Server } from 'node:http'

import { Broadcast } from '@toolcase/base'
import type { Logger } from '@toolcase/logging'

import { resolveConfig, enforceSecurityPolicy, type ResolvedConfig, type SecurityContext, type OrchestratorOptions } from './Config'
import { FleetState } from './FleetState'
import type { AgentLink, FleetController } from './FleetRoom'
import { AgentAuthenticator } from './AgentAuthenticator'
import { CommandEngine } from './CommandEngine'
import { Poller } from './Poller'
import { EventReconciler } from './EventReconciler'
import { FleetControl } from './FleetControl'
import { attachControlPlane, createSharedHttpServer } from './transport'
import type { RivalisLike } from './transport'
import { nodeEnv } from '../env'
import { createHttpApi } from '../routers'
import type { HttpApi } from '../routers'
import { PROTOCOL_VERSION, Topics, decodeFrame, validateSnapshot, WireVersionError } from '../wire'
import type { AckPayload, StatePayload } from '../wire'
import type { FleetEvent, FleetEventType, FleetStats, InstanceInfo, PlacementRequest, RoomInfo } from '../domain'
import { NOOP_LOGGER } from '../util/logger'
import { describe } from '../util/errors'
import { loadCore } from '../util/loadCore'
import { defaultScheduler } from '../util/scheduler'
import type { TimerScheduler } from '../util/scheduler'

export { FleetError } from '../domain'
// Snapshot field validation (§13) moved next to the SyncPayload wire type as a
// `@toolcase/node` FieldSchema (single source of truth for the caps). Re-exported
// here so the security suite — and any embedder — keeps its import path.
export { validateSnapshot } from '../wire'
// Transport bootstrap constants/helpers (§7/§13) live in `transport.ts` post-008;
// re-exported here so existing import paths (and the security suite) are unchanged.
export {
    FLEET_ROOM_TYPE,
    FLEET_ROOM_ID,
    MAX_SNAPSHOT_BYTES,
    WS_SUBPROTOCOL,
    HEADERS_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS,
    selectSubprotocol,
    controlPlaneRateLimiterOptions
} from './transport'

/** Minimal timer surface (timeouts only); tests inject a virtual-time fake (§15). */
export type OrchestratorScheduler = TimerScheduler

/** Test/advanced seams kept off the public option surface (§9). */
export interface OrchestratorInternals {
    scheduler?: OrchestratorScheduler
    /** Wall clock for `lastSyncAt`; default `Date.now`. */
    now?: () => number
    logger?: Logger
    /** `NODE_ENV` override for the §13 production refuse-to-start rules; default sourced from `src/env.ts`. */
    env?: string
}

/** Read-model + control surface exposed as `orchestrator.fleet` (§9). */
export interface FleetApi {
    readonly stats: FleetStats
    readonly instances: InstanceInfo[]
    readonly rooms: RoomInfo[]
    getInstance(id: string): InstanceInfo | null
    getRoom(roomId: string): RoomInfo | null
    findRooms(filter?: { type?: string; instanceId?: string; labels?: Record<string, string> }): RoomInfo[]
    createRoom(request: { type: string; roomId?: string; placement?: PlacementRequest }): Promise<RoomInfo>
    destroyRoom(roomId: string): Promise<void>
    drainInstance(instanceId: string): Promise<void>
    undrainInstance(instanceId: string): Promise<void>
}

export class Orchestrator extends Broadcast implements FleetController {

    readonly fleet: FleetApi

    private readonly config: ResolvedConfig
    private readonly state: FleetState
    private readonly now: () => number
    private logger: Logger
    /** `fleet:http` logger; NOOP until `listen()` loads core's logging factory. */
    private httpLogger: Logger
    /** Fastify-based REST /v1 surface over the same `node:http` server (§10, task 006). */
    private readonly httpApi: HttpApi

    // Injected collaborators (§15) — each a separately unit-tested concern.
    private readonly auth: AgentAuthenticator
    private readonly commands: CommandEngine
    private readonly poller: Poller
    private readonly reconciler: EventReconciler
    private readonly control: FleetControl

    /** Live agent links keyed by connection-scoped instance id. */
    private readonly links = new Map<string, AgentLink>()

    private rivalis: RivalisLike | null = null
    private httpServer: Server | null = null
    private listening = false
    private transportAttached = false

    constructor(options: OrchestratorOptions, internals: OrchestratorInternals = {}) {
        super()
        this.config = resolveConfig(options)
        const scheduler: OrchestratorScheduler = internals.scheduler ?? defaultScheduler
        this.now = internals.now ?? Date.now
        this.logger = internals.logger ?? NOOP_LOGGER
        this.httpLogger = this.logger
        // §13 credential policy: throws here (never at runtime) on a weak or
        // audience-crossing key set in production; warns otherwise. `NODE_ENV` comes
        // from the `internals.env` test seam, else `src/env.ts` (the only env home).
        const resolvedNodeEnv = internals.env ?? nodeEnv()
        const securityContext: SecurityContext = { logger: this.logger }
        if (resolvedNodeEnv != null) {
            securityContext.env = resolvedNodeEnv
        }
        enforceSecurityPolicy(this.config, securityContext)
        this.state = new FleetState({ logger: this.logger })

        // Wire the collaborators — none touch core/network; the command engine releases
        // reservations through the read model, liveness reports back via callbacks.
        this.auth = new AgentAuthenticator(this.config.agentKeys)
        this.commands = new CommandEngine(scheduler, this.state, this.config.commandTimeoutMs)
        // Orchestrator-driven polling (task 011): poll every heartbeatMs; 2 consecutive
        // missed replies → stale (excluded from placement), 3 → evict — reproducing the
        // old 2×/3× heartbeat timing, now on missed poll replies rather than silence.
        this.poller = new Poller(scheduler, this.config.heartbeatMs, {
            sendPoll: (id, reqId, forceFull) => this.sendPoll(id, reqId, forceFull),
            onStale: (id) => this.onStale(id),
            onEvict: (id) => this.onEvict(id)
        })
        this.reconciler = new EventReconciler(this.state, (event, data) => this.emitEvent(event, data))
        this.control = new FleetControl(this.state, this.commands, (id) => this.links.get(id))

        const self = this
        this.fleet = {
            get stats() { return self.state.stats },
            get instances() { return self.state.instances },
            get rooms() { return self.state.rooms },
            getInstance: (id) => self.state.getInstance(id),
            getRoom: (id) => self.state.getRoom(id),
            findRooms: (filter) => self.state.findRooms(filter ?? {}),
            createRoom: (request) => self.control.createRoom(request),
            destroyRoom: (roomId) => self.control.destroyRoom(roomId),
            drainInstance: (instanceId) => self.control.drainInstance(instanceId),
            undrainInstance: (instanceId) => self.control.undrainInstance(instanceId)
        }

        // REST /v1 surface (§10) — Fastify over the SAME `node:http` server the WS
        // transport uses. The `serverFactory` runs synchronously here, creating the
        // shared server (with the §13 slowloris timeouts) and capturing it on
        // `this.httpServer`; `listen()` attaches the WS transport and binds the port.
        this.httpApi = createHttpApi(
            {
                config: this.config,
                fleet: this.fleet,
                isReady: () => this.ready,
                subscribe: (listener) => this.subscribeFleetEvents(listener),
                getLogger: () => this.httpLogger,
                now: this.now
            },
            {
                serverFactory: (handler) => {
                    const server = createSharedHttpServer(handler)
                    this.httpServer = server
                    return server
                }
            }
        )
    }

    /**
     * Bridge every {@link FleetEventType} broadcast (§9) into one SSE listener as a
     * {@link FleetEvent} `{ type, data }`; returns an unsubscribe (called on stream close, §10).
     */
    private subscribeFleetEvents(listener: (event: FleetEvent) => void): () => void {
        const types: FleetEventType[] = [
            'instance:join', 'instance:leave', 'instance:stale', 'room:create', 'room:destroy', 'sync'
        ]
        const handlers = types.map((type) => {
            const handler = (data: unknown): void => listener({ type, data })
            this.on(type, handler)
            return { type, handler }
        })
        return () => {
            for (const { type, handler } of handlers) {
                this.off(type, handler)
            }
        }
    }

    /** True once HTTP is listening and the WS transport is attached (drives `/readyz`, task 010). */
    get ready(): boolean {
        return this.listening && this.transportAttached
    }

    // ---- Lifecycle ----

    /** Start the HTTP/WS server, attach the internal Rivalis room, begin accepting agents (§9). */
    async listen(): Promise<void> {
        if (this.listening) {
            return
        }
        const core = loadCore()
        // The shared `node:http` server was created by the Fastify `serverFactory` in
        // the constructor (§10), with the §13 slowloris timeouts already set.
        const httpServer = this.httpServer
        if (httpServer === null) {
            throw new Error('orchestrator: http server was not created by the REST layer')
        }

        const rivalis = attachControlPlane(core, httpServer, { authenticator: this.auth, controller: this, logger: this.logger })
        this.rivalis = rivalis
        this.logger = rivalis.logging.getLogger('fleet')
        this.httpLogger = rivalis.logging.getLogger('fleet:http')
        this.transportAttached = true

        // Boot Fastify and bind the shared server (§10); a bind failure rejects here.
        await this.httpApi.listen({ host: this.config.host, port: this.config.port })
        this.listening = true
        this.logger.info(
            `orchestrator listening host=(${this.config.host}) port=(${this.config.port}) ` +
            `api=(${this.config.api ? '/v1' : 'off'}) heartbeat=(${this.config.heartbeatMs}ms)`
        )
    }

    /** Gracefully stop: reject in-flight commands, destroy rooms, dispose transport, close HTTP (§9). */
    async shutdown(): Promise<void> {
        // End open SSE streams first so `server.close()` can actually drain (§10).
        this.httpApi.shutdown()
        for (const instanceId of [...this.links.keys()]) {
            this.teardownInstance(instanceId, 'orchestrator shutdown')
        }
        if (this.rivalis !== null) {
            try {
                await this.rivalis.shutdown()
            } catch (error) {
                this.logger.warning(`rivalis shutdown error: ${describe(error)}`)
            }
            this.rivalis = null
        }
        // Close Fastify + the shared server (§10); SSE streams were drained above so it finishes.
        await this.httpApi.close()
        this.httpServer = null
        this.transportAttached = false
        this.listening = false
    }

    // ---- FleetController — driven by the FleetRoom (agent transport, §7) ----

    /** @internal Agent joined: assign id, send `fleet/hello`, start polling (§7, task 011). */
    handleAgentJoin(link: AgentLink): void {
        // Guarded: this runs inside core's room dispatch and the first `link.send`
        // (hello) / poll can throw (core `Room.send`, encode) — a throw must not
        // propagate back into core (§14).
        this.guard(`agent join instance=${link.instanceId}`, () => {
            this.links.set(link.instanceId, link)
            link.send(Topics.hello, {
                instanceId: link.instanceId,
                protocolVersion: PROTOCOL_VERSION,
                heartbeatMs: this.config.heartbeatMs
            })
            // hello is followed by the first poll (§7): the poller sends it immediately
            // (with knownHash:null → a forced full reply) and then polls every heartbeatMs.
            this.poller.start(link.instanceId)
            this.logger.info(`agent joined instance=${link.instanceId}`)
        })
    }

    /** @internal Agent socket closed: evict instantly, rejecting any in-flight commands (§7). */
    handleAgentLeave(instanceId: string): void {
        this.guard(`agent leave instance=${instanceId}`, () => {
            this.teardownInstance(instanceId, 'socket close')
        })
    }

    /**
     * @internal Inbound agent frame (task 011). Every agent frame must be a reply to
     * an outstanding orchestrator request — `fleet/state` to a `fleet/poll`,
     * `fleet/ack` to a `fleet/cmd`. A well-formed frame whose correlation id matches
     * no outstanding request (spontaneous, duplicate, or post-settle) is an
     * unsolicited frame → kick. A malformed / version-incompatible frame is logged
     * and dropped (the lockstep-mismatch path is evicted by missed polls, §7/§8).
     */
    handleAgentMessage(instanceId: string, topic: string, payload: Uint8Array | string): void {
        // Guarded: this runs inside core's room message dispatch, and the read-model
        // application path (`applySnapshot` / `reconcile`) or a `kick`'s `link.send`
        // could throw — a throw must be logged and contained, never propagated into
        // core or crash the process (§14). The connection survives unless an
        // enforcement violation explicitly kicks it.
        this.guard(`agent message instance=${instanceId} topic=${topic}`, () => {
            if (!this.links.has(instanceId)) {
                return
            }
            switch (topic) {
                case Topics.state: {
                    const decoded = this.decode<StatePayload>(instanceId, Topics.state, payload)
                    if (decoded !== null) { this.handleState(instanceId, decoded) }
                    return
                }
                case Topics.ack: {
                    const decoded = this.decode<AckPayload>(instanceId, Topics.ack, payload)
                    if (decoded !== null) { this.handleAck(instanceId, decoded) }
                    return
                }
                default:
                    // Only reply topics are bound on the FleetRoom; any other topic reaching
                    // here is unsolicited (an unbound topic is kicked by core's policy first).
                    this.kick(instanceId, `unexpected topic on the control plane`)
            }
        })
    }

    // ---- Poll dispatch + reply ingestion (§7, task 011) ----

    /** Build and send a `fleet/poll`: knownHash drives dedup, status echoes for drain confirmation. */
    private sendPoll(instanceId: string, reqId: string, forceFull: boolean): void {
        // Guarded: this runs on the Poller's raw timer; core `Room.send` throws on a
        // bad actor state and `encodeFrame` on a serializer error — a throw here would
        // escape the `setTimeout` as an `uncaughtException` and crash the orchestrator
        // (§14). The Poller already recorded the outstanding `reqId`, so a swallowed
        // send just becomes a missed reply (stale→evict), exactly the wedged-agent path.
        this.guard(`poll instance=${instanceId}`, () => {
            const link = this.links.get(instanceId)
            if (link === undefined) {
                return
            }
            // forceFull (or no prior state) ⇒ knownHash:null → a full reply; otherwise the
            // agent replies hash-only when nothing changed. status echoes the last recorded
            // value so the agent's drain()/undrain() resolves on the matching poll (§7).
            const knownHash = forceFull ? null : this.state.lastHashOf(instanceId)
            const status = this.state.getInstance(instanceId)?.status ?? 'active'
            link.send(Topics.poll, { reqId, knownHash, status })
        })
    }

    /**
     * Ingest a `fleet/state` poll reply (task 011). The reply must match the
     * outstanding poll's `reqId` (consumed via the poller); an unmatched reply is
     * unsolicited → kick. A full reply is bounds-checked (§13) and applied; a
     * hash-only reply just refreshes liveness (the snapshot is unchanged).
     */
    private handleState(instanceId: string, state: StatePayload): void {
        if (!this.poller.reply(instanceId, state.reqId)) {
            this.kick(instanceId, 'unsolicited or duplicate fleet/state (no matching outstanding poll)')
            return
        }
        // A valid poll reply proves liveness — clear any stale mark.
        this.state.setStale(instanceId, false)
        if (!state.full) {
            // Hash-only: nothing changed since the poll's knownHash; just bump lastSyncAt.
            this.state.touch(instanceId, this.now())
            return
        }
        // Agent data is authenticated, not trusted (§13): bounds-check the security-
        // sensitive fields first; a failing snapshot is dropped and the last good state
        // holds (the next poll recovers it). The reply was still valid, so liveness stands.
        const reason = validateSnapshot(state)
        if (reason !== null) {
            this.logger.warning(`rejected snapshot from instance=${instanceId}: ${reason} (§13)`)
            return
        }
        if (this.state.applySnapshot(instanceId, state, this.now())) {
            this.reconciler.reconcile()
        }
    }

    private handleAck(instanceId: string, ack: AckPayload): void {
        if (!this.commands.ack(instanceId, ack)) {
            // No matching pending command (unknown / duplicate / post-timeout) — an
            // unsolicited frame under strict request/reply → kick (task 011). Never
            // echo the ack payload in the log.
            this.kick(instanceId, 'ack for unknown or already-settled command')
        }
    }

    /**
     * Kick an agent that broke the request/reply contract (task 011): tear it down
     * (rejecting in-flight commands, removing it from the read model) and close the
     * socket so it reconnects fresh. The log line names the cause and the instance —
     * never the offending payload's contents (§13).
     */
    private kick(instanceId: string, reason: string): void {
        const link = this.links.get(instanceId)
        this.logger.warning(`kicking instance=${instanceId}: ${reason} (request/reply enforcement, §7)`)
        this.teardownInstance(instanceId, 'protocol violation')
        // Close the still-open socket; the resulting onLeave re-enters
        // teardownInstance, which no-ops (already removed).
        link?.close()
    }

    // ---- Liveness callbacks (read-model + events); timers owned by the Poller ----

    private onStale(instanceId: string): void {
        // Guarded: runs on the Poller's raw timer (§14) — a throw must not escape it.
        this.guard(`stale instance=${instanceId}`, () => {
            this.state.setStale(instanceId, true)
            this.logger.warning(`instance=${instanceId} stale (2 missed poll replies) — excluded from placement`)
            const info = this.state.getInstance(instanceId)
            if (info !== null) {
                this.emitEvent('instance:stale', info)
            }
        })
    }

    private onEvict(instanceId: string): void {
        // Guarded: runs on the Poller's raw timer (§14) — a teardown/close throw must
        // not escape it as an uncaughtException.
        this.guard(`evict instance=${instanceId}`, () => {
            const link = this.links.get(instanceId)
            this.logger.warning(`evicting wedged instance=${instanceId} (3 missed poll replies)`)
            this.teardownInstance(instanceId, 'liveness eviction')
            // Kick the still-open socket so it reconnects fresh; the resulting onLeave
            // re-enters teardownInstance, which no-ops (already removed).
            link?.close()
        })
    }

    /**
     * Remove an instance from every table, reject its in-flight commands immediately
     * with `INSTANCE_DISCONNECTED` (§7), and reconcile (its rooms → `room:destroy`, `sync`).
     */
    private teardownInstance(instanceId: string, reason: string): void {
        if (!this.links.has(instanceId) && !this.poller.has(instanceId)) {
            return
        }
        this.links.delete(instanceId)
        this.poller.forget(instanceId)
        this.commands.rejectAll(instanceId, reason)
        const removed = this.state.removeInstance(instanceId)
        if (removed !== null) {
            this.reconciler.instanceRemoved(removed)
        }
        this.reconciler.reconcile()
    }

    // ---- Internals ----

    /**
     * Decode a binary agent frame for `topic` (§7). Returns `null` on any failure —
     * never throws into the host (§8): a protocol-incompatible frame (e.g. a legacy
     * JSON agent against this v2 orchestrator) or a malformed/truncated one is logged
     * and dropped, and the read model keeps its last good state.
     */
    private decode<T>(instanceId: string, topic: string, payload: Uint8Array | string): T | null {
        const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload
        try {
            return decodeFrame(topic, bytes) as T
        } catch (error) {
            if (error instanceof WireVersionError) {
                this.logger.warning(
                    `dropped protocol-incompatible frame from instance=${instanceId} topic=${topic} ` +
                    `(peer major=${error.theirVersion}, orchestrator=${PROTOCOL_VERSION}) — agents and ` +
                    `orchestrator must run the same @rivalis/fleet major (§7)`
                )
            } else {
                this.logger.warning(`failed to decode agent frame topic=${topic} from instance=${instanceId}: ${describe(error)}`)
            }
            return null
        }
    }

    private emitEvent(event: FleetEventType, data: unknown): void {
        try {
            this.emit(event, data)
        } catch (error) {
            this.logger.error(`listener for ${event} threw: ${describe(error)}`)
        }
    }

    /**
     * Run a timer- / transport- / core-dispatch-driven callback, swallowing and
     * logging any throw so it never escapes into a raw `setTimeout` (an
     * `uncaughtException` that would crash the whole control plane) or back into
     * core's room dispatch (§14 failure modes). Mirrors the agent's host-safety
     * `guard` (§8): the orchestrator is the single point of coordination, so one
     * unhandled throw on a poll tick, a snapshot application, or a liveness deadline
     * must degrade to a logged failure on one instance, never an orchestrator-wide
     * outage. Never rethrows.
     */
    private guard(label: string, fn: () => void): void {
        try {
            fn()
        } catch (error) {
            this.logger.error(`orchestrator ${label} handler error: ${describe(error)}`)
        }
    }
}
