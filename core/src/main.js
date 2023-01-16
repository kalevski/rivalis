import Rivalis from './Rivalis'
import AuthMiddleware from './AuthMiddleware'
import Room from './Room'
import Actor from './Actor'

import WSTransport from './transports/WSTransport'

import WSClient from './clients/WSClient'

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
 * @returns {void}
 */

export {
    Rivalis,
    Transports,
    Clients,
    logging,
    AuthMiddleware,
    Room,
    Actor
}