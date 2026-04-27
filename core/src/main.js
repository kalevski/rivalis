import Rivalis from './Rivalis'
import AuthMiddleware from './AuthMiddleware'
import CloseCode from './CloseCode'
import RateLimiter from './RateLimiter'
import Room from './Room'
import Actor from './Actor'
import CustomLoggerFactory from './CustomLoggerFactory'

import WSTransport from './transports/WSTransport'

import WSClient from './clients/WSClient'

const logging = CustomLoggerFactory.Instance

/** @namespace */
const Transports = {
    WSTransport
}

const Clients = {
    WSClient
}

/**
 * @callback TopicListener
 * @param {Actor} actor
 * @param {Uint8Array} payload
 * @param {string} topic
 * @returns {void}
 */

export {
    Rivalis,
    Transports,
    Clients,
    logging,
    AuthMiddleware,
    CloseCode,
    RateLimiter,
    Room,
    Actor
}