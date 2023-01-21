import { Broadcast } from '@toolcase/base'
import logging from '@toolcase/logging'
import { decode, encode } from './serializer'

const encoder = new window.TextEncoder()
const EMPTY_PAYLOAD = new Uint8Array()

/**
 * @typedef EventTypes
 * @type {string}
 */

/**
 * @callback EventListener
 * @param {Uint8Array} payload
 * @param {string} [topic]
 */

/**
 * @class
 * @augments Broadcast<EventTypes,EventListener,any?>
 */
class WSClient extends Broadcast {

    /** @private */
    logger = logging.getLogger('ws client')

    /**
     * @private
     * @type {string}
     */
    baseURL = null

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
        let url = new window.URL(this.baseURL)
        url.searchParams.append('ticket', ticket)
        this.ws = new window.WebSocket(url.toString())
        this.ws.onopen = this.onOpen
        this.ws.onclose = this.onClose
        this.ws.binaryType = 'arraybuffer'
    }

    disocnnect() {
        if (!this.connected) {
            return
        }
        this.ws.close()
        this.ws = null
        this.emit('client:disconnect', encoder.encode('terminated'))
    }

    /**
     * 
     * @param {string} topic 
     * @param {Uint8Array|string} [payload] 
     */
    send(topic, payload = EMPTY_PAYLOAD) {
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
            return this.ws.send(encode(topic, encoder.encode(payload)))
        }

        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    /** @private */
    onOpen = () => {
        this.ws.onmessage = this.onMessage
        this.emit('client:connect')
    }

    /**
     * @private
     * @param {MessageEvent} message 
     */
    onMessage = (message) => {
        let { topic, payload } = decode(new Uint8Array(message.data))
        this.emit(topic, payload)
    }

    /**
     * @private
     * @param {CloseEvent} event
     */
    onClose = (event) => {
        this.emit('client:disconnect', encoder.encode(event.reason))
        this.ws = null
    }

    /**
     * @protected
     * @param {EventTypes} eventName 
     * @param  {...any} messages 
     * @returns {boolean}
     */
    emit(eventName, ...messages) {
        if (this.events.listenerCount(eventName) === 0) {
            return this.logger.warning(`event=${eventName} emitted, register listener to handle the event`)
        }
        return super.emit(eventName, ...messages)
    }

}

export default WSClient