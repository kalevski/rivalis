import { Broadcast } from '@toolcase/base'
import { WebSocket } from 'ws'
import CustomLoggerFactory from '../CustomLoggerFactory'
import { decode, encode } from '../serializer'

/**
 * @typedef EventTypes
 * @type {string}
 */

/**
 * @callback EventListener
 * @param {Uint8Array} payload
 * @param {string} topic
 */

/**
 * @extends {Broadcast<EventTypes,EventListener,any>}
 */
class WSClient extends Broadcast {

    /**
     * @private
     * @type {string}
     */
    baseURL = null

    /** @private */
    logger = CustomLoggerFactory.Instance.getLogger('ws client')

    /** 
     * @private
     * @type {WebSocket}
     */
    ws = null

    /**
     * 
     * @param {string} baseURL 
     */
    constructor(baseURL) {
        super()
        this.baseURL = baseURL
    }

    get connected() {
        return this.ws !== null
    }

    connect(ticket = '') {
        if (this.connected) {
            return this.logger.warning('the client is already connected')
        }
        if (typeof ticket !== 'string') {
            throw new Error(`ticket must be a sting, ${ticket} provided`)
        }
        let url = new URL(this.baseURL)
        url.searchParams.append('ticket', ticket)
        this.ws = new WebSocket(url.toString())
        this.ws.once('open', () => this.onOpen())
        this.ws.once('close', (code, reason) => this.onClose(code, reason))
    }

    disconnect() {
        if (!this.connected) {
            return
        }
        this.ws.close()
        this.ws.removeAllListeners()
        this.ws = null
        this.emit('client:disconnect', Buffer.from('terminated'))
    }

    /**
     * 
     * @param {string} topic 
     * @param {Uint8Array|string} payload 
     */
    send(topic, payload) {
        if (!this.connected) {
            return this.logger.warning('send fail: connection is not established yet')
        }

        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }

        if (payload instanceof Uint8Array) {
            return this.ws.send(encode(topic, payload))
        }

        if (typeof payload === 'string') {
            return this.ws.send(encode(topic, Buffer.from(payload, 'utf-8')))
        }

        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    /** @private */
    onOpen() {
        this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary))
        this.emit('client:connect')
    }

    /**
     * @private
     * @param {Uint8Array} data 
     * @param {boolean} isBinary 
     */
    onMessage(data, isBinary) {
        let { topic, payload } = decode(data)
        this.emit(topic, payload)
    }

    /**
     * @private
     * @param {number} code 
     * @param {Uint8Array} reason 
     */
    onClose(code, reason) {
        this.emit('client:disconnect', reason)
        this.ws.removeAllListeners()
        this.ws = null
    }

    /**
     * @protected
     * @param {EventTypes} eventName 
     * @param  {...any} messages 
     */
    emit(eventName, ...messages) {
        if (this.events.listenerCount(eventName) === 0) {
            return this.logger.warning(`event=${eventName} emitted, register listener to handle the event`)
        }
        super.emit(eventName, ...messages)
    }

}

export default WSClient