/**
 * Verifies task 034: the room-membership guard runs before the rate limiter
 * (so non-joined actors never allocate a token bucket), `release()` reclaims
 * bucket state on every disconnect, and `TokenBucketRateLimiter` self-bounds
 * its bucket map via idle eviction and a hard LRU cap.
 *
 * AC1 — A frame for an actor that has left does NOT create/resurrect a bucket.
 * AC2 — `handleClose` releases the actor's bucket on disconnect.
 * AC3 — Idle buckets are swept once they age past `idleEvictMs`.
 * AC4 — The bucket map never exceeds `maxBuckets` (LRU eviction).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Rivalis, Room, Transport, AuthMiddleware, TokenBucketRateLimiter } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'
import { encode } from '@rivalis/handshake'

// ── helpers ──────────────────────────────────────────────────────────────────

class StubTransport extends Transport {
    layer: any = null
    override onInitialize(tl: any): void { this.layer = tl }
    override get sockets(): number { return 0 }
}

class AcceptAll extends AuthMiddleware<null> {
    async authenticate(_ticket: string): Promise<AuthResult<null> | null> {
        return { data: null, roomId: 'test-room' }
    }
}

function makeRivalis(rateLimiter: TokenBucketRateLimiter) {
    const stub = new StubTransport()
    const rivalis = new Rivalis<null>({
        transports: [stub],
        authMiddleware: new AcceptAll(),
        rateLimiter,
    })
    rivalis.rooms.define('r', class extends Room<null> {})
    rivalis.rooms.create('r', 'test-room')
    return { stub, rivalis }
}

/** Internal bucket map — exposed only for assertions. */
function buckets(limiter: TokenBucketRateLimiter): Map<string, { tokens: number; lastRefill: number }> {
    return (limiter as any).state
}

// ── AC1 + AC2: membership guard precedes the limiter; release frees buckets ───

test('no bucket persists for an actor that has left', async () => {
    const limiter = new TokenBucketRateLimiter()
    const { stub } = makeRivalis(limiter)

    const actorId = await stub.layer.grantAccess('ticket')

    // While joined, a frame allocates a bucket.
    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.ok(buckets(limiter).has(actorId), 'joined actor must have a bucket')

    // Disconnect runs handleClose → release → bucket reclaimed (AC2).
    stub.layer.handleClose(actorId)
    assert.ok(!buckets(limiter).has(actorId), 'release must drop the bucket on disconnect')

    // A late frame for the departed actor must be dropped by the membership
    // guard BEFORE the rate limiter, so no bucket is resurrected (AC1).
    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.ok(!buckets(limiter).has(actorId), 'frame for a non-joined actor must not create a bucket')
    assert.equal(buckets(limiter).size, 0, 'bucket map must be empty after the actor leaves')
})

// ── AC3: idle buckets are swept once they age past idleEvictMs ────────────────

test('idle buckets are evicted by the opportunistic sweep', () => {
    const limiter = new TokenBucketRateLimiter({ idleEvictMs: 50 })

    // Two active buckets.
    assert.equal(limiter.check('idle-actor'), true)
    assert.equal(limiter.check('active-actor'), true)
    assert.equal(buckets(limiter).size, 2)

    // Backdate one bucket past the idle window and reset the sweep gate so
    // the next check performs a sweep (deterministic, no wall-clock wait).
    buckets(limiter).get('idle-actor')!.lastRefill -= 10_000
    ;(limiter as any).lastSweep = 0

    // A check for the active actor triggers the sweep, dropping the idle one.
    assert.equal(limiter.check('active-actor'), true)
    assert.ok(!buckets(limiter).has('idle-actor'), 'idle bucket must be swept')
    assert.ok(buckets(limiter).has('active-actor'), 'recently-touched bucket must survive')
})

// ── AC4: the bucket map never exceeds maxBuckets (LRU eviction) ───────────────

test('bucket map is bounded by maxBuckets via LRU eviction', () => {
    const limiter = new TokenBucketRateLimiter({ maxBuckets: 3, idleEvictMs: 1_000_000 })

    for (let i = 0; i < 10; i++) {
        limiter.check(`actor-${i}`)
        assert.ok(buckets(limiter).size <= 3, `map must stay within cap (after actor-${i})`)
    }

    // Only the three most-recently-used actors remain.
    assert.equal(buckets(limiter).size, 3)
    for (const id of ['actor-7', 'actor-8', 'actor-9']) {
        assert.ok(buckets(limiter).has(id), `${id} (recent) must be retained`)
    }
    for (const id of ['actor-0', 'actor-6']) {
        assert.ok(!buckets(limiter).has(id), `${id} (stale) must be evicted`)
    }
})

// ── invalid options are rejected ──────────────────────────────────────────────

test('invalid maxBuckets / idleEvictMs are rejected', () => {
    assert.throws(() => new TokenBucketRateLimiter({ maxBuckets: 0 }), /maxBuckets/)
    assert.throws(() => new TokenBucketRateLimiter({ maxBuckets: 1.5 }), /maxBuckets/)
    assert.throws(() => new TokenBucketRateLimiter({ idleEvictMs: 0 }), /idleEvictMs/)
})
