/**
 * Reason strings carried in WebSocket close-frame payloads when the
 * server disconnects an actor. Centralised so transports, rooms and
 * the framework all agree on the wire spelling — clients pattern-match
 * on these values, so they are part of the public protocol.
 *
 * The matching `CloseCode` is chosen by the transport (`KICKED`,
 * `ROOM_REJECTED`, `RATE_LIMITED`, etc.). Reason strings are limited
 * to ASCII so they fit comfortably in the 123-byte close-reason cap
 * without UTF-8 truncation surprises.
 */
const KickReason = Object.freeze({
    /** Inbound frame was malformed, exceeded `maxTopicLength` or `maxPayloadBytes`, or hit an unbound topic with `unknownTopicPolicy='kick'`. */
    INVALID_MESSAGE: 'invalid_message',
    /** The room the actor was in was destroyed (e.g. `Rivalis.shutdown`, `RoomManager.destroy`). */
    ROOM_DESTROYED: 'room_destroyed',
    /** `room.maxActors` reached at the moment the actor tried to join. */
    ROOM_FULL: 'room_full',
    /** `room.joinable === false` at the moment the actor tried to join. */
    ROOM_NOT_JOINABLE: 'room_not_joinable',
    /** `RateLimiter.check` returned `false`, or `ConnectionLimiter.check` returned `false` pre-handshake. */
    RATE_LIMITED: 'rate_limited',
    /** Sent during `Transport.dispose` / `Rivalis.shutdown` to actors still connected. */
    SERVER_SHUTDOWN: 'server_shutdown'
} as const)

export type KickReason = (typeof KickReason)[keyof typeof KickReason]

export default KickReason
