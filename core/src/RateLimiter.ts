/**
 * Optional inbound rate limiter. Implementations are invoked from
 * `TLayer.handleMessage` before the frame is dispatched to the room.
 * Returning `false` causes the message to be dropped and the actor to
 * be kicked with `rate_limited`.
 *
 * `check` is required. `release(actorId)` is optional — override only
 * if the limiter holds per-actor state (token bucket, sliding window)
 * that needs cleanup on disconnect; the default is a no-op.
 */
abstract class RateLimiter {

    abstract check(actorId: string): boolean | Promise<boolean>

    release(_actorId: string): void {}

}

export default RateLimiter
