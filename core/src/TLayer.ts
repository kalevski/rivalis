import { EventEmitter, generateId } from '@toolcase/base'
import type { LoggerFactory } from '@toolcase/logging'
import AuthMiddleware from './AuthMiddleware'
import CustomLoggerFactory from './CustomLoggerFactory'
import RateLimiter from './RateLimiter'
import { decode, encode } from '@rivalis/handshake'
import KickReason from './KickReason'
import type { ConnectionContext, EventFn, EventType, GetRoomFn } from './types'

/**
 * RFC 6455 caps the close-frame reason at 123 bytes. Truncate the payload
 * at a UTF-8 codepoint boundary so the reason remains decodable.
 */
const MAX_CLOSE_REASON_BYTES = 123

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

    private emitter: EventEmitter

    private rateLimiter: RateLimiter | null = null

    private maxTopicLength: number

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

    constructor(
        authMiddleware: AuthMiddleware<TActorData>,
        getRoomFn: GetRoomFn<TActorData>,
        rateLimiter: RateLimiter | null = null,
        logging: LoggerFactory = CustomLoggerFactory.Instance,
        maxTopicLength: number = 256
    ) {
        this.authMiddleware = authMiddleware
        this.getRoom = getRoomFn
        this.rateLimiter = rateLimiter
        this.emitter = new EventEmitter()
        this.logging = logging
        this.logger = logging.getLogger('transport layer')
        this.maxTopicLength = maxTopicLength
    }

    get connections(): number {
        return this.roomIds.size
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

    async grantAccess(ticket: string, context?: ConnectionContext): Promise<string> {
        const result = await this.authMiddleware.authenticate(ticket, context)
        if (result === null) {
            throw new Error('invalid ticket')
        }
        const { data, roomId } = result
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

        // generateId is CSPRNG-backed (64 bits of entropy in 16 hex chars), so
        // a collision against an existing actor is astronomically unlikely.
        // The retry loop is purely defensive — without it the failure mode
        // would be a silent overwrite of an existing actor's roomIds entry.
        let actorId: string | null = null
        for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = generateId(16)
            if (!this.roomIds.has(candidate)) {
                actorId = candidate
                break
            }
        }
        if (actorId === null) {
            throw new Error('actorId allocation failed: 8 consecutive collisions')
        }

        this.roomIds.set(actorId, roomId)
        try {
            room.handleJoin(actorId, data)
        } catch (error) {
            // User-supplied onJoin (or the presence broadcast) threw. Unwind
            // every entry that handleJoin / TLayer registered so the actor
            // does not linger as a half-joined ghost.
            this.roomIds.delete(actorId)
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
            this.roomIds.delete(actorId)
            return this.kick(actorId, Buffer.from(KickReason.INVALID_MESSAGE, 'utf-8'))
        }
        if (data.topic.length > this.maxTopicLength) {
            this.logger.warning(`actor id=${actorId} sent topic exceeding maxTopicLength=${this.maxTopicLength}, kicking`)
            this.roomIds.delete(actorId)
            return this.kick(actorId, Buffer.from(KickReason.INVALID_MESSAGE, 'utf-8'))
        }
        if (this.rateLimiter !== null) {
            const allowed = await this.rateLimiter.check(actorId)
            if (allowed === false) {
                this.logger.debug(`actor id=${actorId} rate limited, dropping frame`)
                this.kick(actorId, Buffer.from(KickReason.RATE_LIMITED, 'utf-8'))
                return
            }
        }
        this.logger.verbose('decoded data:', data)
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
            if (this.rateLimiter !== null) {
                try {
                    this.rateLimiter.release(actorId)
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
