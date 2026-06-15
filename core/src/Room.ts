import type { Logger } from '@toolcase/logging'
import Actor from './Actor'
import KickReason from './KickReason'
import type RoomManager from './RoomManager'
import type TLayer from './TLayer'
import type { ForEachFn, TopicListener, TransportCapability } from './types'

const PRESENCE_JOIN_TOPIC = '__presence:join'
const PRESENCE_LEAVE_TOPIC = '__presence:leave'

/**
 * Topics starting with this prefix are reserved for framework-internal
 * events (currently `__presence:join` / `__presence:leave`). User code
 * cannot `bind` / `unbind` them — see `Room.bind`.
 */
const RESERVED_TOPIC_PREFIX = '__'

const textEncoder = new TextEncoder()

/**
 * The single magic topic name used internally for the wildcard fallback.
 * Userland goes through `bindAny` / `unbindAny` rather than addressing
 * this string directly.
 */
const WILDCARD_TOPIC = '*'

/**
 * Decides how a `Room` reacts to an inbound frame whose topic matches
 * neither a `bind`-registered listener nor the `bindAny` wildcard.
 *
 * - `'kick'` (default, back-compat) — disconnect the actor with
 *   `invalid_message`. Right for strict version-locked clients.
 * - `'drop'` — silently ignore the frame. Right when client / server
 *   may be at slightly different versions and forward-compat matters.
 */
export type UnknownTopicPolicy = 'drop' | 'kick'

abstract class Room<TActorData = Record<string, unknown>> {

    readonly id: string

    /**
     * The definition key this room was created from (the first argument
     * to `rooms.define` / `rooms.create`). Stamped by `RoomManager.create`
     * and passed through the constructor, so it is available even for
     * rooms that existed before an observer attached — `@rivalis/fleet`'s
     * `FleetAgent` relies on this to report room types in its snapshots.
     */
    readonly type: string

    /**
     * Opt-in: when `true`, the room auto-broadcasts `__presence:join`
     * and `__presence:leave` whenever an actor joins or leaves. The
     * payload is JSON of whatever `presencePayload(actor)` returns
     * (default `{ id, data }`). Subclasses enable with
     * `protected override presence = true`.
     */
    protected presence: boolean = false

    /**
     * What to do when an inbound frame arrives on an unbound topic.
     * Override per-room with `protected override unknownTopicPolicy = 'drop'`
     * for graceful client / server version skew handling.
     */
    protected unknownTopicPolicy: UnknownTopicPolicy = 'kick'

    /**
     * Maximum number of joined actors. `null` means unlimited. When
     * reached, `TLayer.grantAccess` rejects new joins with reason
     * `room_full`.
     */
    maxActors: number | null = null

    /**
     * Whether new actors may join. Set to `false` to temporarily
     * refuse joins (e.g. game in progress). Rejection reason is
     * `room_not_joinable`.
     */
    joinable: boolean = true

    /**
     * Opt-in lifecycle: when `true`, the room schedules its own destruction
     * (via `RoomManager.destroy`) as soon as the last actor leaves and
     * `actorCount` returns to zero. Useful for ephemeral per-match /
     * per-lobby rooms created with server-generated ids, which would
     * otherwise linger in `RoomManager.rooms` forever unless app code
     * remembers to `destroy()` them — an unbounded-growth footgun.
     *
     * Default `false`, preserving the historical **manual-lifecycle**
     * contract: a room lives until an explicit `destroy()` call (or
     * `Rivalis.shutdown`), no matter how many actors it holds. Long-lived
     * lobbies, persistent hubs, and rooms you pre-create and reuse should
     * keep this off.
     *
     * Enable per-room with `protected override destroyOnEmpty = true`.
     * Teardown is deferred to a microtask that re-checks `actorCount`
     * first, so a new actor that joins in the window between the last leave
     * and the scheduled teardown cancels the destruction — the room is torn
     * down only if it is still empty (and not already manually destroyed).
     */
    protected destroyOnEmpty: boolean = false

    protected logger: Logger | null = null

    private manager: RoomManager<TActorData> | null = null

    private transportLayer: TLayer<TActorData> | null = null

    private topics: Map<string, TopicListener<TActorData>> = new Map()

    private wildcardListener: TopicListener<TActorData> | null = null

    private actors: Map<string, Actor<TActorData>> = new Map()

    private emptyDestroyScheduled: boolean = false

    constructor(roomId: string, manager: RoomManager<TActorData>, transportLayer: TLayer<TActorData>, type: string = '') {
        this.id = roomId
        this.type = type
        this.logger = manager.logging.getLogger(`room=${roomId}`)
        this.manager = manager
        this.transportLayer = transportLayer
        this.onCreate()
        this.logger.info('created')
    }

    get actorCount(): number {
        return this.actors.size
    }

    /**
     * Capability descriptor of the transport(s) attached to this room (p2p.md §7, §12 Phase 4).
     *
     * Returns `null` when no transport has registered capabilities yet (rare — only possible
     * if a `StubTransport` that skips `registerCapabilities` is the sole transport). Otherwise
     * returns the merged descriptor across all configured transports:
     *
     * - `ordered` — `true` when every transport delivers frames in send order.
     * - `reliable` — `true` when every transport guarantees delivery.
     * - `maxFrameBytes` — the smallest per-frame ceiling across transports; `null` = no limit.
     *
     * Typical values: WS → `{ ordered:true, reliable:true, maxFrameBytes:65536 }`; RTC primary
     * channel → `{ ordered:true, reliable:true, maxFrameBytes:16384 }`.
     */
    protected get transportCapabilities(): TransportCapability | null {
        return this.transportLayer?.capabilities ?? null
    }

    /**
     * Look up a joined actor by id. Returns `null` when no actor with that
     * id is currently in the room. Visibility is `protected` — the intended
     * caller is a `Room` subclass (e.g. a signaling relay that must route a
     * message to one specific peer). App code that needs cross-actor lookups
     * should go through `each` or a subclass-maintained index; `getActor`
     * is a targeted primitive, not a general query API.
     */
    protected getActor(actorId: string): Actor<TActorData> | null {
        return this.actors.get(actorId) ?? null
    }

    protected onCreate(): void {}

    protected onJoin(_actor: Actor<TActorData>): void {}

    protected onLeave(_actor: Actor<TActorData>): void {}

    protected onDestroy(): void {}

    /**
     * Opt-in state serialization for host handoff (p2p.md §12 Phase 3).
     *
     * Override to return a `Uint8Array` snapshot of the room's authoritative
     * state.  The framework calls this when the host is transferring control to
     * a newly-elected host; the bytes are forwarded via the signal layer and
     * delivered to the new host, which receives them through `hydrate`.
     *
     * The default returns `null`, which opts the room out of state transfer —
     * rooms that do not override this are completely unaffected by the handoff
     * mechanism.
     *
     * Keep the snapshot compact: it is sent as a binary payload over the signal
     * WebSocket.  Prefer encoding with `@rivalis/handshake` or a similar
     * framing discipline so the new host can version-check before applying.
     */
    protected serialize(): Uint8Array | null {
        return null
    }

    /**
     * Opt-in state restoration for host handoff (p2p.md §12 Phase 3).
     *
     * Called on the newly-elected host's room with the bytes that the outgoing
     * host produced via `serialize`.  Override to restore room state so the new
     * host resumes where the old host left off.
     *
     * Only called when the outgoing host had previously pushed a non-null
     * snapshot via `signal:host_state`.  Rooms that do not override `serialize`
     * will never have `hydrate` called on them.
     */
    protected hydrate(_bytes: Uint8Array): void {}

    /**
     * @internal
     * Called by the framework to safely invoke `serialize`. Catches and logs
     * any exception thrown by user-supplied code so a bad serialize
     * implementation cannot crash the handoff flow.
     */
    trySerialize(): Uint8Array | null {
        try {
            return this.serialize()
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger?.error(`serialize threw: ${reason}`)
            return null
        }
    }

    /**
     * @internal
     * Called by the framework to safely invoke `hydrate`. Catches and logs
     * any exception thrown by user-supplied code so a bad hydrate
     * implementation cannot crash the room startup path.
     */
    tryHydrate(bytes: Uint8Array): void {
        try {
            this.hydrate(bytes)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger?.error(`hydrate threw: ${reason}`)
        }
    }

    /**
     * Hook for the presence broadcast payload. Default returns
     * `{ id: actor.id, data: actor.data }`. Override to scrub
     * server-only fields out of `data` before it is broadcast to
     * other actors in the room.
     */
    protected presencePayload(actor: Actor<TActorData>): unknown {
        return { id: actor.id, data: actor.data }
    }

    /**
     * Register a listener for an inbound topic. Throws on:
     *   - non-string topic,
     *   - topic that begins with the reserved `__` prefix,
     *   - the literal `'*'` topic (use `bindAny` instead),
     *   - a topic that is already bound (silent overwrite was a footgun).
     */
    protected bind(topic: string, topicListener: TopicListener<TActorData>, context: unknown = null): void {
        this.assertBindableTopic(topic)
        if (typeof topicListener !== 'function') {
            throw new Error(`topicListener must be a function, ${topicListener} provided`)
        }
        if (this.topics.has(topic)) {
            throw new Error(`topic "${topic}" is already bound`)
        }
        this.topics.set(topic, topicListener.bind(context === null ? this : context) as TopicListener<TActorData>)
    }

    /**
     * Remove a previously-bound topic listener. Returns whether
     * anything was actually removed. Throws on the same reserved /
     * wildcard topic names as `bind`.
     */
    protected unbind(topic: string): boolean {
        this.assertBindableTopic(topic)
        return this.topics.delete(topic)
    }

    /**
     * Register a single fallback listener that receives any inbound
     * frame whose topic was not matched by an explicit `bind`. The
     * listener's third argument is the actual topic string. Useful
     * for protocols where the topic space is dynamic (e.g. a chat
     * room with arbitrary channel names). Only one wildcard listener
     * may be registered at a time.
     */
    protected bindAny(topicListener: TopicListener<TActorData>, context: unknown = null): void {
        if (typeof topicListener !== 'function') {
            throw new Error(`topicListener must be a function, ${topicListener} provided`)
        }
        if (this.wildcardListener !== null) {
            throw new Error('a wildcard listener is already bound; call unbindAny() first')
        }
        this.wildcardListener = topicListener.bind(context === null ? this : context) as TopicListener<TActorData>
    }

    /** Remove the wildcard listener. Returns whether one was registered. */
    protected unbindAny(): boolean {
        if (this.wildcardListener === null) {
            return false
        }
        this.wildcardListener = null
        return true
    }

    private assertBindableTopic(topic: string): void {
        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }
        if (topic.startsWith(RESERVED_TOPIC_PREFIX)) {
            throw new Error(`topic prefix "${RESERVED_TOPIC_PREFIX}" is reserved for framework events, got: ${topic}`)
        }
        if (topic === WILDCARD_TOPIC) {
            throw new Error('topic "*" is reserved; use bindAny() / unbindAny() instead')
        }
    }

    send(actor: Actor<TActorData>, topic: string, payload: Uint8Array | string): void {
        if (typeof topic !== 'string') {
            throw new Error(`send error: topic must be a sting, ${topic} provided`)
        }
        if (!(actor instanceof Actor)) {
            throw new Error(`send error: actor=${actor} must be an instance of Actor`)
        }
        if (this.transportLayer === null) {
            return
        }
        if (payload instanceof Uint8Array) {
            return this.transportLayer.send(actor.id, topic, payload)
        }
        if (typeof payload === 'string') {
            return this.transportLayer.send(actor.id, topic, textEncoder.encode(payload))
        }
        throw new Error(`send error: invalid payload=${payload}, must be a string or Uint8Array`)
    }

    broadcast(topic: string, payload: Uint8Array | string): void {
        this.each(actor => this.send(actor, topic, payload))
    }

    each(foreachFn: ForEachFn<TActorData>): void {
        this.actors.forEach(foreachFn)
    }

    kick(actor: Actor<TActorData>, payload: Uint8Array | string = ''): void {
        if (this.transportLayer === null) {
            return
        }
        if (payload instanceof Uint8Array) {
            return this.transportLayer.kick(actor.id, payload)
        }
        if (typeof payload === 'string') {
            return this.transportLayer.kick(actor.id, textEncoder.encode(payload))
        }
        throw new Error(`kick error: invalid payload=${payload}, must be a string or Uint8Array`)
    }

    destroy(): void {
        this.manager?.destroy(this.id)
    }

    /** @internal */
    handleDestroy(): void {
        this.each(actor => actor.kick(KickReason.ROOM_DESTROYED))
        // B-6: a throwing user onDestroy would otherwise short-circuit
        // the cleanup below, leaving live actor / topic / listener
        // tables on a "destroyed" room. Run cleanup unconditionally.
        try {
            this.onDestroy()
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger?.error(`onDestroy threw: ${reason}`)
        }
        this.actors.clear()
        this.topics.clear()
        this.wildcardListener = null
        this.transportLayer = null
        this.manager = null
        this.logger?.info('destroyed')
        this.logger = null
    }

    /** @internal */
    handleJoin(actorId: string, data: TActorData | null = null): void {
        const actor = new Actor<TActorData>(actorId, data, this)
        this.actors.set(actorId, actor)
        try {
            this.onJoin(actor)
        } catch (error) {
            // Don't let a user-thrown onJoin leave a half-initialised actor
            // in the room's map. Drop it before propagating so TLayer can
            // unwind its own bookkeeping.
            this.actors.delete(actorId)
            throw error
        }
        if (this.presence) {
            // B-5: a throwing `presencePayload` (custom override) or a
            // non-serialisable `data` field (circular ref / BigInt) would
            // otherwise leave the actor in `this.actors` while TLayer's
            // outer catch wipes its own bookkeeping — the room and TLayer
            // would disagree. The join itself succeeded; treat the
            // broadcast failure as a soft error and log loudly.
            try {
                this.broadcast(PRESENCE_JOIN_TOPIC, JSON.stringify(this.presencePayload(actor)))
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger?.error(`presence:join broadcast failed for actor id=${actorId}: ${reason}`)
            }
        }
    }

    /** @internal */
    handleMessage(actorId: string, topic: string, payload: Uint8Array): void {
        const actor = this.actors.get(actorId) ?? null
        if (actor === null) {
            this.logger?.debug(`message dropped for unknown actor id=${actorId} on topic=${topic}`)
            return
        }
        const topicListener = this.topics.get(topic) ?? this.wildcardListener
        if (topicListener === null) {
            if (this.unknownTopicPolicy === 'drop') {
                this.logger?.debug(`actor id=${actorId} sent unbound topic=${topic}, dropped (policy=drop)`)
                return
            }
            this.logger?.debug(`actor id=${actorId} kicked: unbound topic=${topic}`)
            return actor.kick(KickReason.INVALID_MESSAGE)
        }
        // B-1: a synchronous throw out of user code would otherwise
        // bubble up through `TLayer.handleMessage` (async) as an
        // unhandled rejection — and unhandled rejections crash modern
        // Node by default. Log loudly so the server author still sees
        // the bug; the actor stays connected because the framework
        // can't tell whether the throw came from malformed client input
        // or from a server-side bug.
        try {
            topicListener(actor, payload, topic)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger?.error(`topic listener for "${topic}" threw for actor id=${actorId}: ${reason}`)
        }
    }

    /** @internal */
    handleLeave(actorId: string): void {
        // Remove the actor BEFORE onLeave runs, so any `each` / `broadcast`
        // from inside the user-supplied onLeave naturally excludes the
        // leaver. The `actor` reference passed to onLeave remains valid
        // (we hold it on the stack); only the room's actor map no longer
        // contains it. Same ordering applies whether `presence` is on or
        // off — previously the two paths disagreed about when the leaver
        // disappeared from broadcasts.
        const actor = this.actors.get(actorId)
        this.actors.delete(actorId)
        if (actor === undefined) {
            return
        }
        try {
            this.onLeave(actor)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger?.error(`onLeave threw for actor id=${actorId}: ${reason}`)
        }
        if (this.presence) {
            try {
                this.broadcast(PRESENCE_LEAVE_TOPIC, JSON.stringify(this.presencePayload(actor)))
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger?.error(`presence:leave broadcast failed for actor id=${actorId}: ${reason}`)
            }
        }
        if (this.destroyOnEmpty && this.actors.size === 0) {
            this.scheduleDestroyOnEmpty()
        }
    }

    /**
     * Defer destruction of a now-empty `destroyOnEmpty` room to a microtask,
     * guarding the join-before-teardown race. Between the last leave and the
     * scheduled callback, a new actor may join (restoring `actorCount`) or a
     * manual `destroy()` may have already torn the room down. The callback
     * re-checks both and only destroys a room that is still registered with
     * the manager and still empty. The `emptyDestroyScheduled` latch coalesces
     * repeated empties within the same turn into a single scheduled teardown.
     */
    private scheduleDestroyOnEmpty(): void {
        if (this.emptyDestroyScheduled) {
            return
        }
        this.emptyDestroyScheduled = true
        queueMicrotask(() => {
            this.emptyDestroyScheduled = false
            // manager === null  → a manual destroy() / shutdown already ran.
            // actors.size !== 0  → a new actor won the race; room is live again.
            if (this.manager === null || this.actors.size !== 0) {
                return
            }
            try {
                this.manager.destroy(this.id)
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger?.error(`destroyOnEmpty teardown failed: ${reason}`)
            }
        })
    }
}

export default Room
