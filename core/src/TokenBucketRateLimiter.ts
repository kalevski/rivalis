import RateLimiter from './RateLimiter'

export type TokenBucketOptions = {
    /** Max tokens per actor (burst capacity). Default 30. */
    capacity?: number
    /** Tokens added per second per actor. Default 30. */
    refillPerSecond?: number
}

/**
 * Default per-actor inbound rate limiter shipped from `Config` when
 * the consumer does not supply one. Each actor gets an independent
 * token bucket: every inbound frame deducts one token; tokens refill
 * continuously at `refillPerSecond` up to `capacity`.
 *
 * The defaults (30 tokens, 30/sec refill) are chosen well above
 * realistic human-pace traffic (chat, presence, turn-based commands)
 * but well below DoS-grade flooding. Real-time games with high-
 * frequency client→server input (e.g. 60 Hz) should bump the
 * parameters explicitly or pass `null` to opt out entirely.
 *
 * `release(actorId)` is wired to the disconnect lifecycle so per-
 * actor state is reclaimed when the actor leaves; an unlimited
 * stream of brand-new connections from the same IP is the
 * `ConnectionLimiter`'s problem, not this one.
 */
class TokenBucketRateLimiter extends RateLimiter {

    private state: Map<string, { tokens: number; lastRefill: number }> = new Map()

    private capacity: number

    private refillPerMs: number

    constructor(options: TokenBucketOptions = {}) {
        super()
        this.capacity = options.capacity ?? 30
        this.refillPerMs = (options.refillPerSecond ?? 30) / 1000
        if (!(this.capacity > 0)) {
            throw new Error(`TokenBucketRateLimiter: capacity must be positive, got ${this.capacity}`)
        }
        if (!(this.refillPerMs > 0)) {
            throw new Error('TokenBucketRateLimiter: refillPerSecond must be positive')
        }
    }

    override check(actorId: string): boolean {
        const now = Date.now()
        let entry = this.state.get(actorId)
        if (entry === undefined) {
            entry = { tokens: this.capacity, lastRefill: now }
            this.state.set(actorId, entry)
        } else {
            const elapsed = now - entry.lastRefill
            if (elapsed < 0) {
                // B-7: system clock moved backward (NTP step, VM resume).
                // Without rebasing, every subsequent call would compute
                // a negative elapsed against the future timestamp and
                // never refill. Reset the baseline; tokens stay where
                // they were until real wall time accumulates again.
                entry.lastRefill = now
            } else if (elapsed > 0) {
                entry.tokens = Math.min(this.capacity, entry.tokens + elapsed * this.refillPerMs)
                entry.lastRefill = now
            }
        }
        if (entry.tokens >= 1) {
            entry.tokens -= 1
            return true
        }
        return false
    }

    override release(actorId: string): void {
        this.state.delete(actorId)
    }

}

export default TokenBucketRateLimiter
