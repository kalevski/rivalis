import Rivalis from './Rivalis'
import AuthMiddleware from './AuthMiddleware'
import { CloseCode } from '@rivalis/handshake'
import RateLimiter from './RateLimiter'
import Room from './Room'
import Actor from './Actor'
import CustomLoggerFactory from './CustomLoggerFactory'

import WSTransport from './transports/WSTransport'

import WSClient from './clients/WSClient'

const logging = CustomLoggerFactory.Instance

const Transports = {
    WSTransport
}

const Clients = {
    WSClient
}

export type { TopicListener, ForEachFn, GetRoomFn, EventFn, EventType } from './types'
export type { ConfigOptions } from './Config'
export type { WSTransportOptions } from './transports/WSTransport'
export type { Message } from '@rivalis/handshake'

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
