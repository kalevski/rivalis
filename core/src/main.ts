import Rivalis from './Rivalis'
import AuthMiddleware, { LegacyAuthMiddleware } from './AuthMiddleware'
import { CloseCode } from '@rivalis/handshake'
import RateLimiter from './RateLimiter'
import TokenBucketRateLimiter from './TokenBucketRateLimiter'
import ConnectionLimiter from './ConnectionLimiter'
import KickReason from './KickReason'
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
export type { AuthResult } from './AuthMiddleware'
export type { UnknownTopicPolicy } from './Room'
export type { TokenBucketOptions } from './TokenBucketRateLimiter'
export type { ConfigOptions } from './Config'
export type {
    WSTransportOptions,
    AllowedOrigins,
    TicketSource,
    BackpressureDropFn
} from './transports/WSTransport'
export type { WSClientOptions, WSClientTicketSource, ClientEventListener } from './clients/WSClient'
export type { Message } from '@rivalis/handshake'

export {
    Rivalis,
    Transports,
    Clients,
    logging,
    AuthMiddleware,
    LegacyAuthMiddleware,
    CloseCode,
    KickReason,
    RateLimiter,
    TokenBucketRateLimiter,
    ConnectionLimiter,
    Room,
    Actor
}
