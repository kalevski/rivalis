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

    /**
     * Decide whether the actor is allowed to send another message right
     * now. Called once per inbound frame.
     *
     * @param {string} actorId
     * @returns {boolean | Promise<boolean>}
     */
    check(actorId) {
        return true
    }

    /**
     * Called when an actor disconnects so the implementation can free
     * any per-actor state.
     *
     * @param {string} actorId
     * @returns {void}
     */
    release(actorId) {}

}

export default RateLimiter
