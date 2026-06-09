import Rivalis from './Rivalis'
import AuthMiddleware, { LegacyAuthMiddleware } from './AuthMiddleware'
import { CloseCode } from '@rivalis/handshake'
import RateLimiter from './RateLimiter'
import TokenBucketRateLimiter from './TokenBucketRateLimiter'
import ConnectionLimiter from './ConnectionLimiter'
import KickReason from './KickReason'
import Room from './Room'
import Actor from './Actor'
import RoomManager from './RoomManager'
import TLayer from './TLayer'
import Config from './Config'
import Transport from './Transport'
import Client from './Client'
import CustomLoggerFactory from './CustomLoggerFactory'

const logging = CustomLoggerFactory.Instance

export type { BackpressureDropFn } from './transports/backpressure'
export { checkBackpressure, DEFAULT_MAX_BUFFERED_BYTES } from './transports/backpressure'

export type { TopicListener, ForEachFn, GetRoomFn, EventFn, EventType, ConnectionContext } from './types'
export type { AuthResult } from './AuthMiddleware'
export type { UnknownTopicPolicy } from './Room'
export type { TokenBucketOptions } from './TokenBucketRateLimiter'
export type { ConfigOptions } from './Config'
export type { Message } from '@rivalis/handshake'
export type { ClientEvent, ClientKickedEvent } from './Client'

export {
    Rivalis,
    logging,
    AuthMiddleware,
    LegacyAuthMiddleware,
    CloseCode,
    KickReason,
    RateLimiter,
    TokenBucketRateLimiter,
    ConnectionLimiter,
    Room,
    Actor,
    RoomManager,
    TLayer,
    Config,
    Transport,
    Client
}
