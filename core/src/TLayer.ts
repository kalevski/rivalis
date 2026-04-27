import { EventEmitter, generateId } from '@toolcase/base'
import type { LoggerFactory } from '@toolcase/logging'
import AuthMiddleware from './AuthMiddleware'
import CustomLoggerFactory from './CustomLoggerFactory'
import RateLimiter from './RateLimiter'
import { decode, encode } from '@rivalis/handshake'
import type { EventFn, EventType, GetRoomFn } from './types'

class TLayer<TActorData = Record<string, unknown>> {

    readonly logging: LoggerFactory

    logger: ReturnType<LoggerFactory['getLogger']>

    private authMiddleware: AuthMiddleware<TActorData>

    private getRoom: GetRoomFn<TActorData>

    private roomIds: Map<string, string> = new Map()

    private emitter: EventEmitter

    private rateLimiter: RateLimiter | null = null

    constructor(
        authMiddleware: AuthMiddleware<TActorData>,
        getRoomFn: GetRoomFn<TActorData>,
        rateLimiter: RateLimiter | null = null,
        logging: LoggerFactory = CustomLoggerFactory.Instance
    ) {
        this.authMiddleware = authMiddleware
        this.getRoom = getRoomFn
        this.rateLimiter = rateLimiter
        this.emitter = new EventEmitter()
        this.logging = logging
        this.logger = logging.getLogger('transport layer')
    }

    get connections(): number {
        return this.roomIds.size
    }

    on = (event: EventType, actorId: string, eventListener: EventFn, context?: unknown): void => {
        this.emitter.on(`${event}:${actorId}`, eventListener, context)
    }

    once = (event: EventType, actorId: string, eventListener: EventFn, context?: unknown): void => {
        this.emitter.once(`${event}:${actorId}`, eventListener, context)
    }

    protected emit = (event: EventType, actorId: string, message: Uint8Array): void => {
        this.emitter.emit(`${event}:${actorId}`, actorId, message)
    }

    async grantAccess(ticket: string): Promise<string> {
        const isValid = await this.authMiddleware.validateTicket(ticket)
        if (isValid !== true) {
            throw new Error('invalid ticket')
        }
        const data = await this.authMiddleware.extractPayload(ticket)

        if (data !== null && typeof data !== 'object') {
            throw new Error(`actor data can be an object or null, provided=${data}`)
        }

        const roomId = await this.authMiddleware.getRoomId(ticket)
        const room = this.getRoom(roomId)
        if (room === null) {
            throw new Error(`room id=${roomId} does not exist`)
        }
        if (!room.joinable) {
            throw new Error('room_not_joinable')
        }
        if (room.maxActors !== null && room.actorCount >= room.maxActors) {
            throw new Error('room_full')
        }
        const actorId = generateId(16)
        this.roomIds.set(actorId, roomId)
        room.handleJoin(actorId, data)
        this.logger.info(`actor id=${actorId} join room id=${roomId}`)
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
            return this.kick(actorId, Buffer.from('invalid_message', 'utf-8'))
        }
        if (this.rateLimiter !== null) {
            const allowed = await this.rateLimiter.check(actorId)
            if (allowed === false) {
                this.logger.debug(`actor id=${actorId} rate limited, dropping frame`)
                this.kick(actorId, Buffer.from('rate_limited', 'utf-8'))
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
                this.logger.info(`actor id=${actorId} leave: room id=${roomId} already destroyed`)
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.error(`actor id=${actorId} leave threw in room id=${roomId}: ${reason}`)
        } finally {
            this.emitter.removeAllListeners(`message:${actorId}`)
            this.emitter.removeAllListeners(`kick:${actorId}`)
            if (this.rateLimiter !== null) {
                try {
                    this.rateLimiter.release(actorId)
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    this.logger.warning(`rateLimiter.release threw for actor id=${actorId}: ${reason}`)
                }
            }
        }
        this.logger.info(`actor id=${actorId} leave room id=${roomId}`)
    }

    send(actorId: string, topic: string, payload: Uint8Array): void {
        const message = encode(topic, payload)
        this.emit('message', actorId, message)
    }

    kick(actorId: string, payload: Uint8Array): void {
        this.emit('kick', actorId, payload)
    }

}

export default TLayer
