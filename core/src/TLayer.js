import { Broadcast, EventEmitter, generateId } from '@toolcase/base'
import AuthMiddleware from './AuthMiddleware'
import CustomLoggerFactory from './CustomLoggerFactory'
import RateLimiter from './RateLimiter'
import { decode, encode } from './serializer'

/**
 * @typedef Message
 * @type {string}
 */

/**
 * @typedef EventType
 * @type {('message'|'kick')}
 */

/**
 * @callback EventFn
 * @param {string} actorId
 * @param {Message} message
 */

/**
 * @callback GetRoomFn
 * @param {string} roomId
 * @returns {import('./Room').Room}
 */

class TLayer {

    logger = CustomLoggerFactory.Instance.getLogger('transport layer')

    /**
     * @private
     * @type {AuthMiddleware}
     */
    authMiddleware = null

    /**
     * @private
     * @type {GetRoomFn}
     */
    getRoom = null

    /**
     * @private
     * @type {Map<string,string>}
     */
    roomIds = new Map()

    /**
     * @private
     * @type {EventEmitter<string,any,any>}
     */
    emitter = null

    /**
     * @private
     * @type {RateLimiter|null}
     */
    rateLimiter = null

    /**
     *
     * @param {AuthMiddleware} authMiddleware
     * @param {GetRoomFn} getRoomFn
     * @param {RateLimiter|null} [rateLimiter]
     */
    constructor(authMiddleware, getRoomFn = null, rateLimiter = null) {
        this.authMiddleware = authMiddleware
        this.getRoom = getRoomFn
        this.rateLimiter = rateLimiter
        this.emitter = new EventEmitter()
    }

    get connections() {
        return this.roomIds.size
    }

    /**
     * @param {EventType} event 
     * @param {string} actorId 
     * @param {EventFn} eventListener 
     * @param {any} context 
     * @returns {void}
     */
    on = (event, actorId, eventListener, context) => this.emitter.on(`${event}:${actorId}`, eventListener, context)

    /**
     * @param {EventType} event 
     * @param {string} actorId 
     * @param {EventFn} eventListener 
     * @param {any} context 
     * @returns {void}
     */
    once = (event, actorId, eventListener, context) => this.emitter.once(`${event}:${actorId}`, eventListener, context)

    /**
     * @protected
     * @param {EventType} event 
     * @param {string} actorId 
     * @param {Message} message 
     * @returns {void}
     */
    emit = (event, actorId, message) => this.emitter.emit(`${event}:${actorId}`, actorId, message)

    /**
     * 
     * @param {string} ticket 
     */
    async grantAccess(ticket) {
        let isValid = await this.authMiddleware.validateTicket(ticket)
        if (isValid !== true) {
            throw new Error('invalid ticket')
        }
        let data = await this.authMiddleware.extractPayload(ticket)
        
        if (data !== null && typeof data !== 'object') {
            throw new Error(`actor data can be an object or null, provided=${data}`)
        }
        
        let roomId = await this.authMiddleware.getRoomId(ticket)
        let room = this.getRoom(roomId)
        if (room === null) {
            throw new Error(`room id=${roomId} does not exist`)
        }
        let actorId = generateId(16)
        this.roomIds.set(actorId, roomId)
        room.handleJoin(actorId, data)
        this.logger.info(`actor id=${actorId} join room id=${roomId}`)
        return actorId
    }

    /**
     * @private
     * @param {string} actorId
     * @param {Uint8Array} message
     */
    async handleMessage(actorId, message) {
        let data = null
        try {
            data = decode(message)
        } catch (error) {
            this.logger.error(`actor id=${actorId} sent malformed frame, kicking. reason=${error.message}`)
            this.roomIds.delete(actorId)
            return this.kick(actorId, Buffer.from('invalid_message', 'utf-8'))
        }
        if (this.rateLimiter !== null) {
            let allowed = await this.rateLimiter.check(actorId)
            if (allowed === false) {
                this.logger.debug(`actor id=${actorId} rate limited, dropping frame`)
                this.kick(actorId, Buffer.from('rate_limited', 'utf-8'))
                return
            }
        }
        this.logger.verbose('decoded data:', data)
        let roomId = this.roomIds.get(actorId)
        let room = this.getRoom(roomId)
        if (room === null) {
            this.logger.warning(`message for actor id=${actorId} dropped: room id=${roomId} no longer exists`)
            this.roomIds.delete(actorId)
            return
        }
        room.handleMessage(actorId, data.topic, data.payload)
    }

    /**
     * @private
     * @param {string} actorId
     */
    handleClose(actorId) {
        let roomId = this.roomIds.get(actorId)
        let room = this.getRoom(roomId)
        this.roomIds.delete(actorId)
        try {
            if (room !== null) {
                room.handleLeave(actorId)
            } else {
                this.logger.info(`actor id=${actorId} leave: room id=${roomId} already destroyed`)
            }
        } catch (error) {
            this.logger.error(`actor id=${actorId} leave threw in room id=${roomId}: ${error.message}`)
        } finally {
            this.emitter.removeAllListeners(`message:${actorId}`)
            this.emitter.removeAllListeners(`kick:${actorId}`)
            if (this.rateLimiter !== null) {
                try {
                    this.rateLimiter.release(actorId)
                } catch (error) {
                    this.logger.warning(`rateLimiter.release threw for actor id=${actorId}: ${error.message}`)
                }
            }
        }
        this.logger.info(`actor id=${actorId} leave room id=${roomId}`)
    }

    /**
     * 
     * @param {string} actorId 
     * @param {string} topic 
     * @param {Uint8Array} payload 
     */
    send(actorId, topic, payload) {
        let message = encode(topic, payload)
        this.emit('message', actorId, message)
    }

    /**
     * 
     * @param {string} actorId 
     * @param {Uint8Array} payload 
     */
    kick(actorId, payload) {
        this.emit('kick', actorId, payload)
    }


}

export default TLayer