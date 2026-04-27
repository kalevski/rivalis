/**
 * Optional inbound rate limiter. Implementations are invoked from
 * `TLayer.handleMessage` before the frame is dispatched to the room.
 * Returning `false` causes the message to be dropped and the actor to
 * be kicked with `rate_limited`.
 *
 * Implementations are responsible for their own state (per-actor token
 * bucket, sliding window, etc.) and must release any resources for an
 * actor when `release(actorId)` is called.
 */
class RateLimiter {

    check(_actorId: string): boolean | Promise<boolean> {
        return true
    }

    release(_actorId: string): void {}

}

export default RateLimiter
