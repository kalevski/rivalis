import { Logger } from '@toolcase/logging'
import Actor from './Actor'
import CustomLoggerFactory from './CustomLoggerFactory'
import RoomManager from './RoomManager'
import TLayer from './TLayer'

const ERROR = {
    INVALID_MESSAGE: 'invalid_message',
    ROOM_DESTROYED: 'room_destroyed'
}

/**
 * @callback ForEachFn
 * @param {Actor} actor
 */

class Room {

    /**
     * @readonly
     * @type {string}
     */
    id = null

    /**
     * @protected
     * @type {Logger}
     */
    logger = null

    /**
     * @private
     * @type {RoomManager}
     */
    manager = null

    /**
     * @private
     * @type {TLayer}
     */
    transportLayer = null

    /**
     * @private
     * @type {Map<string,import('./main').TopicListener>}
     */
    topics = new Map()

    /**
     * @private
     * @type {Map<string,Actor>}
     */
    actors = new Map()

    /**
     * 
     * @param {string} roomId 
     * @param {RoomManager} manager 
     * @param {TLayer} transportLayer 
     */
    constructor(roomId, manager, transportLayer) {
        this.id = roomId
        this.logger = CustomLoggerFactory.Instance.getLogger(`room=${roomId}`)
        this.manager = manager
        this.transportLayer = transportLayer
        this.onCreate()
        this.logger.info('created')
    }

    /** @protected */
    onCreate() {}

    /**
     * @protected
     * @param {Actor} actor 
     */
    onJoin(actor) {}

    /**
     * @protected
     * @param {Actor} actor 
     */
    onLeave(actor) {}

    /** @protected */
    onDestroy() {}

    /**
     * @protected
     * @param {string} topic 
     * @param {import('./main').TopicListener} topicListener 
     * @param {any|null} context
     */
    bind(topic, topicListener, context = null) {
        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }
        if (typeof topicListener !== 'function') {
            throw new Error(`topicListener must be a function, ${topicListener} provided`)
        }
        if (this.topics.has(topic)) {
            return false
        }
        this.topics.set(topic, topicListener.bind(context === null ? this : context))
        return true
    }

    /**
     * 
     * @param {string} topic 
     */
    unbind(topic) {
        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }
        return this.topics.delete(topic)
    }

    /**
     * 
     * @param {Actor} actor 
     * @param {string} topic 
     * @param {Uint8Array|string} payload 
     */
    send(actor, topic, payload) {
        if (typeof topic !== 'string') {
            throw new Error(`send error: topic must be a sting, ${topic} provided`)
        }
        if (!(actor instanceof Actor)) {
            throw new Error(`send error: actor=${actor} must be an instance of Actor`)
        }
        if (payload instanceof Uint8Array) {
            return this.transportLayer.send(actor.id, topic, payload)
        }
        if (typeof payload === 'string') {
            return this.transportLayer.send(actor.id, topic, Buffer.from(payload, 'utf-8'))
        }
        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    /**
     * 
     * @param {string} topic 
     * @param {Uint8Array|string} payload 
     */
    broadcast(topic, payload) {
        this.each(actor => this.send(actor, topic, payload))
    }



    /**
     * 
     * @param {ForEachFn} foreachFn 
     */
    each(foreachFn) {
        this.actors.forEach(foreachFn)
    }

    /**
     * 
     * @param {Actor} actor 
     * @param {Uint8Array|string} [payload] 
     */
    kick(actor, payload = '') {
        if (payload instanceof Uint8Array) {
            return this.transportLayer.kick(actor.id, payload)
        }
        if (typeof payload === 'string') {
            return this.transportLayer.kick(actor.id, Buffer.from(payload, 'utf-8'))
        }
        throw new Error(`kick error: invalid payload=${payload}, must be a string or Buffer`)
    }

    destroy() {
        this.manager.destroy(this.id)
    }

    /** @private */
    handleDestroy() {
        this.each(actor => actor.kick(ERROR.ROOM_DESTROYED))
        this.onDestroy()
        this.actors.clear()
        this.topics.clear()
        this.transportLayer = null
        this.manager = null
        this.logger.info('destroyed')
        this.logger = null
    }

    /**
     * @private
     * @param {string} actorId 
     * @param {Object<string,any>} data
     */
    handleJoin(actorId, data = null) {
        let actor = new Actor(actorId, data || {}, this)
        this.actors.set(actorId, actor)
        this.onJoin(actor)
    }

    /**
     * @private
     * @param {string} actorId 
     * @param {string} topic 
     * @param {Uint8Array} payload 
     */
    handleMessage(actorId, topic, payload) {
        let topicListener = this.topics.get(topic) || null
        if (topicListener === null) {
            topicListener = this.topics.get(Room.Any) || null
        }
        let actor = this.actors.get(actorId) || null
        if (topicListener === null) {
            this.logger.debug(`actor id=${actorId} is kicked, reason: sending message on non existing topic=${topic}`)
            return actor.kick(ERROR.INVALID_MESSAGE)
        }
        topicListener(actor, payload, topic)
    }

    /**
     * @private
     * @param {string} actorId 
     */
    handleLeave(actorId) {
        let actor = this.actors.get(actorId)
        this.onLeave(actor)
        this.actors.delete(actorId)
    }



}

Room.Any = '*'

export default Room