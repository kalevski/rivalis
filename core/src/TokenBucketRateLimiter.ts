import RateLimiter from './RateLimiter'

export type TokenBucketOptions = {
    /** Max tokens per actor (burst capacity). Default 30. */
    capacity?: number
    /** Tokens added per second per actor. Default 30. */
    refillPerSecond?: number
    /**
     * Hard cap on the number of per-actor buckets retained. When a new
     * bucket would exceed this, the least-recently-used buckets are
     * evicted until the map is back within bounds. Default 100_000.
     */
    maxBuckets?: number
    /**
     * Buckets untouched for at least this many milliseconds are evicted by
     * an opportunistic sweep that runs at most once per window on `check`.
     * A token bucket that has sat idle this long has fully refilled, so
     * dropping it is behaviorally identical to keeping it — the actor's
     * next frame simply re-creates a full bucket. Default 60_000 (60s).
     */
    idleEvictMs?: number
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
 *
 * As a backstop against any path that skips `release()` (or sheer
 * connection churn), the bucket map is self-bounding: an opportunistic
 * idle sweep evicts buckets untouched for `idleEvictMs`, and a hard
 * `maxBuckets` LRU cap evicts the least-recently-used buckets when the
 * map would otherwise grow without bound. Eviction is behaviorally
 * transparent — an evicted actor's next frame re-creates a full bucket.
 */
class TokenBucketRateLimiter extends RateLimiter {

    private state: Map<string, { tokens: number; lastRefill: number }> = new Map()

    private capacity: number

    private refillPerMs: number

    private maxBuckets: number

    private idleEvictMs: number

    private lastSweep: number = 0

    constructor(options: TokenBucketOptions = {}) {
        super()
        this.capacity = options.capacity ?? 30
        this.refillPerMs = (options.refillPerSecond ?? 30) / 1000
        this.maxBuckets = options.maxBuckets ?? 100_000
        this.idleEvictMs = options.idleEvictMs ?? 60_000
        if (!(this.capacity > 0)) {
            throw new Error(`TokenBucketRateLimiter: capacity must be positive, got ${this.capacity}`)
        }
        if (!(this.refillPerMs > 0)) {
            throw new Error('TokenBucketRateLimiter: refillPerSecond must be positive')
        }
        if (!Number.isInteger(this.maxBuckets) || this.maxBuckets <= 0) {
            throw new Error(`TokenBucketRateLimiter: maxBuckets must be a positive integer, got ${this.maxBuckets}`)
        }
        if (!(this.idleEvictMs > 0)) {
            throw new Error(`TokenBucketRateLimiter: idleEvictMs must be positive, got ${this.idleEvictMs}`)
        }
    }

    override check(actorId: string): boolean {
        const now = Date.now()
        this.sweepIdle(now)
        let entry = this.state.get(actorId)
        if (entry === undefined) {
            entry = { tokens: this.capacity, lastRefill: now }
            this.state.set(actorId, entry)
            this.evictOverCap(actorId)
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
            // Re-insert so the Map's iteration order tracks recency: the
            // most-recently-touched bucket moves to the tail, leaving the
            // least-recently-used at the head for `evictOverCap` to drop.
            this.state.delete(actorId)
            this.state.set(actorId, entry)
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

    /**
     * Drop buckets untouched for `idleEvictMs`. Gated to run at most once
     * per `idleEvictMs` window so a hot path stays O(1) amortized rather
     * than scanning the whole map on every frame.
     */
    private sweepIdle(now: number): void {
        if (now - this.lastSweep < this.idleEvictMs) {
            return
        }
        this.lastSweep = now
        for (const [id, entry] of this.state) {
            // A backward clock step (elapsed < 0) is not "idle"; only evict
            // entries whose last touch is genuinely older than the window.
            if (now - entry.lastRefill >= this.idleEvictMs) {
                this.state.delete(id)
            }
        }
    }

    /**
     * Enforce the hard `maxBuckets` cap by evicting least-recently-used
     * buckets (the head of the Map's insertion order). `keepActorId` — the
     * bucket just created/touched by the current `check` — is never evicted.
     */
    private evictOverCap(keepActorId: string): void {
        if (this.state.size <= this.maxBuckets) {
            return
        }
        for (const id of this.state.keys()) {
            if (this.state.size <= this.maxBuckets) {
                break
            }
            if (id === keepActorId) {
                continue
            }
            this.state.delete(id)
        }
    }

}

export default TokenBucketRateLimiter
