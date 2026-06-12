import { EventEmitter, generateId } from '@toolcase/base'
import type { LoggerFactory } from '@toolcase/logging'
import AuthMiddleware from './AuthMiddleware'
import CustomLoggerFactory from './CustomLoggerFactory'
import RateLimiter from './RateLimiter'
import Transport from './Transport'
import { decode, encode, MAX_CLOSE_REASON_BYTES } from '@rivalis/handshake'
import KickReason from './KickReason'
import type { ConnectionContext, EventFn, EventType, GetRoomFn, TransportCapability } from './types'

const textEncoder = new TextEncoder()

const truncateCloseReason = (payload: Uint8Array): Uint8Array => {
    if (payload.byteLength <= MAX_CLOSE_REASON_BYTES) {
        return payload
    }
    let end = MAX_CLOSE_REASON_BYTES
    while (end > 0) {
        const b = payload[end - 1]!
        if ((b & 0x80) === 0) break
        if ((b & 0xC0) === 0xC0) { end--; break }
        end--
    }
    // If the boundary search collapses to 0, the input wasn't valid
    // UTF-8 (e.g. all continuation bytes). Returning the raw byte clip
    // here would violate RFC 6455 — the close-frame reason MUST be
    // UTF-8 — and trip `WS_ERR_INVALID_UTF8` validation on the
    // receiving side. An empty reason is correct: the user passed
    // malformed bytes; there is no safe truncation to fall back on.
    return payload.subarray(0, end)
}

class TLayer<TActorData = Record<string, unknown>> {

    readonly logging: LoggerFactory

    logger: ReturnType<LoggerFactory['getLogger']>

    private authMiddleware: AuthMiddleware<TActorData>

    private getRoom: GetRoomFn<TActorData>

    private roomIds: Map<string, string> = new Map()

    private actorTransports: Map<string, Transport> = new Map()

    private emitter: EventEmitter

    private rateLimiter: RateLimiter | null = null

    private maxTopicLength: number

    private maxPayloadBytes: number

    /**
     * Outbound frames emitted before a transport has subscribed for a
     * given actor (e.g. the `actor.send` inside `Room.onJoin`, which
     * runs synchronously inside `grantAccess` before the transport
     * registers its per-actor listener) are buffered here keyed by
     * `${event}:${actorId}` and flushed on the first matching `on` /
     * `once`. Cleared on `handleClose`. Without this, the demo and
     * every other room had to defer initial-state sends with
     * `setImmediate(...)`.
     */
    private pendingEmits: Map<string, Array<Uint8Array>> = new Map()

    private static readonly MAX_PENDING_EMITS_PER_KEY = 256

    /**
     * Bounds for a client-requested actorId honored from an auth result. Server
     * allocated ids are 16 hex chars; a requested id must stay comparably shaped
     * so it cannot amplify memory across the per-actor maps or smuggle a `:` into
     * the `${event}:${actorId}` emitter keyspace. Anything outside these bounds
     * falls back to CSPRNG allocation.
     */
    private static readonly MAX_REQUESTED_ACTOR_ID_LENGTH = 64

    private static readonly REQUESTED_ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/

    /**
     * Merged transport capabilities registered by all transports during
     * `onInitialize`. Multiple transports are merged conservatively:
     * `ordered`/`reliable` are AND-ed; `maxFrameBytes` takes the minimum
     * non-null value so rooms see the most restrictive limit across all
     * admitted connection paths.
     */
    private _capabilities: TransportCapability | null = null

    constructor(
        authMiddleware: AuthMiddleware<TActorData>,
        getRoomFn: GetRoomFn<TActorData>,
        rateLimiter: RateLimiter | null = null,
        logging: LoggerFactory = CustomLoggerFactory.Instance,
        maxTopicLength: number = 256,
        maxPayloadBytes: number = 65536
    ) {
        this.authMiddleware = authMiddleware
        this.getRoom = getRoomFn
        this.rateLimiter = rateLimiter
        this.emitter = new EventEmitter()
        this.logging = logging
        this.logger = logging.getLogger('transport layer')
        this.maxTopicLength = maxTopicLength
        this.maxPayloadBytes = maxPayloadBytes
    }

    get connections(): number {
        return this.roomIds.size
    }

    /**
     * Register (or merge) a transport's capability descriptor.
     * Called by each transport from its `onInitialize` so that the
     * resulting `capabilities` snapshot reflects every admitted path.
     *
     * Merge rules for multiple transports:
     * - `ordered`/`reliable` — AND (both must be true for the merged result to be true)
     * - `maxFrameBytes` — minimum of non-null values; `null` (no limit) defers to
     *   the other transport's limit; both null → null.
     */
    registerCapabilities(caps: TransportCapability): void {
        if (this._capabilities === null) {
            this._capabilities = { ...caps }
            return
        }
        const prev = this._capabilities
        const mergedMax =
            prev.maxFrameBytes === null && caps.maxFrameBytes === null ? null
            : prev.maxFrameBytes === null ? caps.maxFrameBytes
            : caps.maxFrameBytes === null ? prev.maxFrameBytes
            : Math.min(prev.maxFrameBytes, caps.maxFrameBytes)
        this._capabilities = {
            ordered: prev.ordered && caps.ordered,
            reliable: prev.reliable && caps.reliable,
            maxFrameBytes: mergedMax,
        }
    }

    /** Merged capability descriptor for all registered transports, or `null` if none registered yet. */
    get capabilities(): TransportCapability | null {
        return this._capabilities
    }

    on = (event: EventType, actorId: string, eventListener: EventFn, context?: unknown): void => {
        const eventKey = `${event}:${actorId}`
        this.emitter.on(eventKey, eventListener, context)
        this.flushPending(eventKey, actorId)
    }

    once = (event: EventType, actorId: string, eventListener: EventFn, context?: unknown): void => {
        const eventKey = `${event}:${actorId}`
        this.emitter.once(eventKey, eventListener, context)
        this.flushPending(eventKey, actorId)
    }

    protected emit = (event: EventType, actorId: string, message: Uint8Array): void => {
        const eventKey = `${event}:${actorId}`
        if (this.emitter.listenerCount(eventKey) > 0) {
            this.emitter.emit(eventKey, actorId, message)
            return
        }
        // B-4: only buffer when the actor is currently registered. The
        // pre-listener buffer is meaningful in the brief window between
        // `roomIds.set` (inside `grantAccess`) and the transport's
        // listener registration. Outside that window — e.g. a stale
        // `Actor` reference held past disconnect — buffering would
        // accumulate forever because `handleClose` already ran.
        if (!this.roomIds.has(actorId)) {
            return
        }
        let queue = this.pendingEmits.get(eventKey)
        if (queue === undefined) {
            queue = []
            this.pendingEmits.set(eventKey, queue)
        }
        if (queue.length >= TLayer.MAX_PENDING_EMITS_PER_KEY) {
            this.logger.warning(`pre-listener buffer overflow for ${eventKey}, dropping frame`)
            return
        }
        queue.push(message)
    }

    private flushPending(eventKey: string, actorId: string): void {
        const queue = this.pendingEmits.get(eventKey)
        if (queue === undefined) {
            return
        }
        this.pendingEmits.delete(eventKey)
        for (const message of queue) {
            this.emitter.emit(eventKey, actorId, message)
        }
    }

    async grantAccess(ticket: string, context?: ConnectionContext, transport?: Transport): Promise<string> {
        const effectiveAuth = transport?.authMiddleware ?? this.authMiddleware
        const result = await effectiveAuth.authenticate(ticket, context)
        if (result === null) {
            throw new Error('invalid ticket')
        }
        const { data, roomId, actorId: requestedActorId } = result
        if (data !== null && typeof data !== 'object') {
            throw new Error(`actor data can be an object or null, provided=${data}`)
        }
        if (typeof roomId !== 'string' || roomId.length === 0) {
            throw new Error(`roomId from authenticate must be a non-empty string, provided=${roomId}`)
        }
        const room = this.getRoom(roomId)
        if (room === null) {
            throw new Error(`room id=${roomId} does not exist`)
        }
        if (!room.joinable) {
            throw new Error(KickReason.ROOM_NOT_JOINABLE)
        }
        if (room.maxActors !== null && room.actorCount >= room.maxActors) {
            throw new Error(KickReason.ROOM_FULL)
        }

        // Honor a stable actorId requested by the transport (e.g. a reconnecting peer)
        // when it is free and well-formed. A client-echoing auth implementation could
        // otherwise supply arbitrarily long ids (memory amplification across roomIds,
        // actorTransports, pendingEmits and the `${event}:${actorId}` emitter keys) or
        // ids containing `:`, which would collide with / confuse the `event:actorId`
        // keyspace. Hold requested ids to the same shape as server-allocated ones:
        // capped length and a `:`-free charset. Fall back to CSPRNG allocation —
        // generateId is CSPRNG-backed (64 bits of entropy in 16 hex chars), retried up
        // to 8 times defensively so a collision never silently overwrites an existing
        // actor's roomIds entry.
        let actorId: string | null = null
        if (
            typeof requestedActorId === 'string' &&
            requestedActorId.length > 0 &&
            requestedActorId.length <= TLayer.MAX_REQUESTED_ACTOR_ID_LENGTH &&
            TLayer.REQUESTED_ACTOR_ID_PATTERN.test(requestedActorId) &&
            !this.roomIds.has(requestedActorId)
        ) {
            actorId = requestedActorId
        } else {
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidate = generateId(16)
                if (!this.roomIds.has(candidate)) {
                    actorId = candidate
                    break
                }
            }
        }
        if (actorId === null) {
            throw new Error('actorId allocation failed: 8 consecutive collisions')
        }

        this.roomIds.set(actorId, roomId)
        if (transport !== undefined) {
            this.actorTransports.set(actorId, transport)
        }
        try {
            room.handleJoin(actorId, data)
        } catch (error) {
            // User-supplied onJoin (or the presence broadcast) threw. Unwind
            // every entry that handleJoin / TLayer registered so the actor
            // does not linger as a half-joined ghost.
            this.roomIds.delete(actorId)
            this.actorTransports.delete(actorId)
            this.pendingEmits.delete(`message:${actorId}`)
            this.pendingEmits.delete(`kick:${actorId}`)
            this.emitter.removeAllListeners(`message:${actorId}`)
            this.emitter.removeAllListeners(`kick:${actorId}`)
            throw error
        }
        this.logger.debug(`actor id=${actorId} join room id=${roomId}`)
        return actorId
    }

    /** @internal */
    async handleMessage(actorId: string, message: Uint8Array): Promise<void> {
        let data: ReturnType<typeof decode>
        try {
            data = decode(message)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.error(`actor id=${actorId} sent malformed frame, kicking. reason=${reason}`)
            // Do NOT delete the roomIds entry here. The kick closes the socket,
            // which drives `handleClose` — the single authoritative cleanup path
            // that runs `room.handleLeave` (firing onLeave/presence-leave and
            // restoring actorCount) plus map/rate-limiter teardown. Deleting the
            // entry first would make `handleClose` take its "room already
            // destroyed" branch and leak a ghost actor in `Room.actors`. Mirror
            // the rate-limited branch below, which also leaves cleanup to handleClose.
            return this.kick(actorId, textEncoder.encode(KickReason.INVALID_MESSAGE))
        }
        if (data.topic.length > this.maxTopicLength) {
            this.logger.warning(`actor id=${actorId} sent topic exceeding maxTopicLength=${this.maxTopicLength}, kicking`)
            // See the decode-failure branch above: leave roomIds intact so the
            // kick-driven `handleClose` performs handleLeave + cleanup.
            return this.kick(actorId, textEncoder.encode(KickReason.INVALID_MESSAGE))
        }
        if (data.payload.byteLength > this.maxPayloadBytes) {
            this.logger.warning(`actor id=${actorId} sent payload exceeding maxPayloadBytes=${this.maxPayloadBytes}, kicking`)
            // See the decode-failure branch above: leave roomIds intact so the
            // kick-driven `handleClose` performs handleLeave + cleanup.
            return this.kick(actorId, textEncoder.encode(KickReason.INVALID_MESSAGE))
        }
        // Membership guard runs BEFORE the rate limiter so a frame for an
        // actor that is no longer joined never allocates/touches a token
        // bucket. Buckets are per-actor state reclaimed only by `release()`
        // from `handleClose`; checking a departed actor here would resurrect
        // an entry in the limiter's map that nothing will ever release.
        if (!this.roomIds.has(actorId)) {
            this.logger.warning(`message for actor id=${actorId} dropped: not joined to a room`)
            return
        }
        const actorTransport = this.actorTransports.get(actorId)
        const effectiveRateLimiter = actorTransport !== undefined && actorTransport.rateLimiter !== undefined
            ? actorTransport.rateLimiter
            : this.rateLimiter
        if (effectiveRateLimiter !== null) {
            const allowed = await effectiveRateLimiter.check(actorId)
            if (allowed === false) {
                this.logger.debug(`actor id=${actorId} rate limited, dropping frame`)
                this.kick(actorId, textEncoder.encode(KickReason.RATE_LIMITED))
                return
            }
        }
        this.logger.verbose('decoded data:', data)
        // Re-resolve membership after the (possibly async) limiter check: the
        // actor may have disconnected during the await, in which case
        // `handleClose` already ran and we must not dispatch to the room.
        const roomId = this.roomIds.get(actorId)
        if (roomId === undefined) {
            this.logger.warning(`message for actor id=${actorId} dropped: not joined to a room`)
            return
        }
        const room = this.getRoom(roomId)
        if (room === null) {
            this.logger.warning(`message for actor id=${actorId} dropped: room id=${roomId} no longer exists`)
            this.roomIds.delete(actorId)
            return
        }
        room.handleMessage(actorId, data.topic, data.payload)
    }

    /** @internal */
    handleClose(actorId: string): void {
        const roomId = this.roomIds.get(actorId)
        const room = roomId !== undefined ? this.getRoom(roomId) : null
        this.roomIds.delete(actorId)
        const closingTransport = this.actorTransports.get(actorId)
        this.actorTransports.delete(actorId)
        try {
            if (room !== null) {
                room.handleLeave(actorId)
            } else {
                this.logger.debug(`actor id=${actorId} leave: room id=${roomId} already destroyed`)
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.error(`actor id=${actorId} leave threw in room id=${roomId}: ${reason}`)
        } finally {
            this.emitter.removeAllListeners(`message:${actorId}`)
            this.emitter.removeAllListeners(`kick:${actorId}`)
            this.pendingEmits.delete(`message:${actorId}`)
            this.pendingEmits.delete(`kick:${actorId}`)
            const effectiveRateLimiter = closingTransport !== undefined && closingTransport.rateLimiter !== undefined
                ? closingTransport.rateLimiter
                : this.rateLimiter
            if (effectiveRateLimiter !== null) {
                try {
                    effectiveRateLimiter.release(actorId)
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    this.logger.warning(`rateLimiter.release threw for actor id=${actorId}: ${reason}`)
                }
            }
        }
        this.logger.debug(`actor id=${actorId} leave room id=${roomId}`)
    }

    send(actorId: string, topic: string, payload: Uint8Array): void {
        const message = encode(topic, payload)
        this.emit('message', actorId, message)
    }

    kick(actorId: string, payload: Uint8Array): void {
        this.emit('kick', actorId, truncateCloseReason(payload))
    }

}

export default TLayer
