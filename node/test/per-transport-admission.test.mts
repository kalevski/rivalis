/**
 * Acceptance tests for per-transport auth/rate-limit override (p2p.md §3.6, §12 Phase 4, task 086).
 *
 * AC1 — Per-transport authMiddleware is used when present.
 * AC2 — Global authMiddleware is used when the transport has none.
 * AC3 — Per-transport rateLimiter (instance) is used instead of global.
 * AC4 — Per-transport rateLimiter=null disables rate limiting for that transport.
 * AC5 — Global rateLimiter is used when the transport has no override.
 * AC6 — Per-transport rateLimiter.release() is called on actor close; global is not.
 * AC7 — ConfigOptions is unchanged (no new required fields).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Rivalis, Room, Transport, AuthMiddleware, RateLimiter } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { encode } from '@rivalis/handshake'

// ── helpers ──────────────────────────────────────────────────────────────────

class StubTransport extends Transport {
    layer: any = null
    override onInitialize(tl: any): void { this.layer = tl }
    override get sockets(): number { return 0 }
}

/** Accepts any ticket, routes to 'test-room'. */
class AcceptAll extends AuthMiddleware<null> {
    calls = 0
    async authenticate(_ticket: string): Promise<AuthResult<null> | null> {
        this.calls++
        return { data: null, roomId: 'test-room' }
    }
}

/** Rejects every ticket. */
class RejectAll extends AuthMiddleware<null> {
    calls = 0
    async authenticate(_ticket: string): Promise<AuthResult<null> | null> {
        this.calls++
        return null
    }
}

/** Rate limiter that tracks calls and allows every frame. */
class TrackingRateLimiter extends RateLimiter {
    checkCalls = 0
    releaseCalls = 0
    check(_actorId: string): boolean { this.checkCalls++; return true }
    override release(_actorId: string): void { this.releaseCalls++ }
}

function makeRivalis(transports: Array<Transport>, globalAuth: AuthMiddleware<null>, globalRateLimiter?: RateLimiter | null) {
    const rivalis = new Rivalis<null>({ transports, authMiddleware: globalAuth, rateLimiter: globalRateLimiter })
    rivalis.rooms.define('r', class extends Room<null> {})
    rivalis.rooms.create('r', 'test-room')
    return rivalis
}

// ── AC1: per-transport authMiddleware is used when present ────────────────────

test('per-transport authMiddleware is used instead of global when set on transport', async () => {
    const transportAuth = new AcceptAll()
    const globalAuth = new RejectAll()

    const stub = new StubTransport()
    stub.authMiddleware = transportAuth

    makeRivalis([stub], globalAuth)

    const actorId = await stub.layer.grantAccess('any-ticket', undefined, stub)
    assert.ok(typeof actorId === 'string' && actorId.length > 0, 'actor must be admitted')
    assert.equal(transportAuth.calls, 1, 'transport-level auth must have been called')
    assert.equal(globalAuth.calls, 0, 'global auth must NOT have been called')
})

// ── AC2: global authMiddleware used when transport has none ───────────────────

test('global authMiddleware is used when transport has no override', async () => {
    const globalAuth = new AcceptAll()
    const stub = new StubTransport()
    // stub.authMiddleware not set — should fall back to global

    makeRivalis([stub], globalAuth)

    const actorId = await stub.layer.grantAccess('any-ticket', undefined, stub)
    assert.ok(typeof actorId === 'string' && actorId.length > 0)
    assert.equal(globalAuth.calls, 1, 'global auth must have been called')
})

test('per-transport authMiddleware rejection blocks admission', async () => {
    const transportAuth = new RejectAll()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    stub.authMiddleware = transportAuth

    makeRivalis([stub], globalAuth)

    await assert.rejects(
        () => stub.layer.grantAccess('any-ticket', undefined, stub),
        /invalid ticket/i,
        'transport-level rejection must produce an invalid ticket error'
    )
    assert.equal(transportAuth.calls, 1)
    assert.equal(globalAuth.calls, 0, 'global auth must NOT be consulted after transport reject')
})

// ── AC3: per-transport RateLimiter instance is used instead of global ─────────

test('per-transport rateLimiter is checked instead of global on handleMessage', async () => {
    const transportLimiter = new TrackingRateLimiter()
    const globalLimiter = new TrackingRateLimiter()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    stub.rateLimiter = transportLimiter

    makeRivalis([stub], globalAuth, globalLimiter)

    const actorId = await stub.layer.grantAccess('t', undefined, stub)
    await stub.layer.handleMessage(actorId, encode('x', new Uint8Array(0)))

    assert.equal(transportLimiter.checkCalls, 1, 'transport limiter must be checked')
    assert.equal(globalLimiter.checkCalls, 0, 'global limiter must NOT be checked when transport overrides')
})

// ── AC4: rateLimiter=null on transport disables rate limiting for that transport

test('per-transport rateLimiter=null means global limiter is not checked', async () => {
    const globalLimiter = new TrackingRateLimiter()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    stub.rateLimiter = null  // explicit opt-out for this transport

    makeRivalis([stub], globalAuth, globalLimiter)

    const actorId = await stub.layer.grantAccess('t', undefined, stub)
    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))

    assert.equal(globalLimiter.checkCalls, 0, 'global limiter must NOT be checked when transport rateLimiter=null')
})

// ── AC5: global rateLimiter is used when transport has no override ────────────

test('global rateLimiter is checked when transport has no rateLimiter override', async () => {
    const globalLimiter = new TrackingRateLimiter()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    // stub.rateLimiter not set — should fall back to global

    makeRivalis([stub], globalAuth, globalLimiter)

    const actorId = await stub.layer.grantAccess('t', undefined, stub)
    await stub.layer.handleMessage(actorId, encode('x', new Uint8Array(0)))

    assert.equal(globalLimiter.checkCalls, 1, 'global limiter must be checked when transport has no override')
})

// ── AC6: per-transport rateLimiter.release() on close; global is not ──────────

test('per-transport rateLimiter.release() is called on actor close; global is not', async () => {
    const transportLimiter = new TrackingRateLimiter()
    const globalLimiter = new TrackingRateLimiter()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    stub.rateLimiter = transportLimiter

    makeRivalis([stub], globalAuth, globalLimiter)

    const actorId = await stub.layer.grantAccess('t', undefined, stub)
    stub.layer.handleClose(actorId)

    assert.equal(transportLimiter.releaseCalls, 1, 'transport limiter release must be called on close')
    assert.equal(globalLimiter.releaseCalls, 0, 'global limiter release must NOT be called')
})

test('global rateLimiter.release() is called on close when transport has no override', async () => {
    const globalLimiter = new TrackingRateLimiter()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    // stub.rateLimiter not set

    makeRivalis([stub], globalAuth, globalLimiter)

    const actorId = await stub.layer.grantAccess('t', undefined, stub)
    stub.layer.handleClose(actorId)

    assert.equal(globalLimiter.releaseCalls, 1, 'global limiter release must be called on close')
})

test('transport rateLimiter=null: global release is NOT called on close', async () => {
    const globalLimiter = new TrackingRateLimiter()
    const globalAuth = new AcceptAll()

    const stub = new StubTransport()
    stub.rateLimiter = null  // explicit opt-out

    makeRivalis([stub], globalAuth, globalLimiter)

    const actorId = await stub.layer.grantAccess('t', undefined, stub)
    stub.layer.handleClose(actorId)

    assert.equal(globalLimiter.releaseCalls, 0, 'global limiter release must NOT be called when transport rateLimiter=null')
})

// ── AC7: ConfigOptions unchanged — no new required fields ────────────────────

test('Rivalis can be created without any per-transport overrides (backward compat)', () => {
    const globalAuth = new AcceptAll()
    // Must compile and run with the original ConfigOptions shape (no new required fields).
    const rivalis = new Rivalis<null>({
        transports: [new StubTransport()],
        authMiddleware: globalAuth,
    })
    assert.ok(rivalis !== null)
})
