/**
 * Verifies that game-traffic rate-limiting auto-applies to RTC peers (p2p.md §8, task 092).
 *
 * §8 wiring: `TLayer.handleMessage` runs the limiter before dispatching to the room
 * (TLayer.ts:211-218). Because every transport — WS, RTC, or any future transport —
 * enters the room exclusively through `handleMessage`, rate-limiting is
 * transport-agnostic. No RTC-specific transport code is required.
 *
 * The `StubTransport` below is a stand-in for a real `RTCTransport`. It carries zero
 * rate-limit logic of its own, yet AC1–AC3 show RTC peers are kicked identically to
 * WS peers.
 *
 * AC1 — RTC peer exceeding the per-message limit is kicked with RATE_LIMITED.
 * AC2 — Frames below the limit are accepted; only the frame crossing the threshold kicks.
 * AC3 — Per-transport RateLimiter on a stub RTC transport is also enforced via handleMessage.
 * AC4 — No RTC-specific transport code is required (structural assertion).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Rivalis, Room, Transport, AuthMiddleware, RateLimiter, KickReason } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'
import { encode } from '@rivalis/handshake'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Simulates any non-WS transport — used here as a stand-in for an RTC peer. */
class StubTransport extends Transport {
    layer: any = null
    override onInitialize(tl: any): void { this.layer = tl }
    override get sockets(): number { return 0 }
}

/** Accepts every ticket, routes to 'test-room'. */
class AcceptAll extends AuthMiddleware<null> {
    async authenticate(_ticket: string): Promise<AuthResult<null> | null> {
        return { data: null, roomId: 'test-room' }
    }
}

/**
 * Allows exactly `budget` frames per actor then refuses. Simulates a strict
 * per-message ceiling without wall-clock dependency.
 */
class FixedBudgetRateLimiter extends RateLimiter {
    readonly checkCalls: Array<{ actorId: string; result: boolean }> = []
    private remaining: Map<string, number> = new Map()
    private readonly budget: number

    constructor(budget: number) {
        super()
        this.budget = budget
    }

    check(actorId: string): boolean {
        const left = this.remaining.get(actorId) ?? this.budget
        const allowed = left > 0
        this.remaining.set(actorId, allowed ? left - 1 : 0)
        this.checkCalls.push({ actorId, result: allowed })
        return allowed
    }

    override release(actorId: string): void {
        this.remaining.delete(actorId)
    }
}

function makeRivalis(rateLimiter: RateLimiter | null) {
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

// ── AC1: RTC peer is kicked with RATE_LIMITED when over the message limit ─────

test('RTC peer exceeding per-message limit is kicked with RATE_LIMITED', async () => {
    const limiter = new FixedBudgetRateLimiter(2)  // allow 2 frames, kick on the 3rd
    const { stub } = makeRivalis(limiter)

    const actorId = await stub.layer.grantAccess('ticket')

    let kickPayload: Uint8Array | null = null
    stub.layer.on('kick', actorId, (_: string, payload: Uint8Array) => {
        kickPayload = payload
    })

    // First two frames — within limit
    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.strictEqual(kickPayload, null, 'first frame: no kick expected')

    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.strictEqual(kickPayload, null, 'second frame: no kick expected')

    // Third frame — over limit
    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.ok(kickPayload !== null, 'third frame: kick must be emitted')
    assert.equal(
        new TextDecoder().decode(kickPayload!),
        KickReason.RATE_LIMITED,
        'kick reason must be RATE_LIMITED'
    )
})

// ── AC2: frames below limit are accepted; limiter is checked on every frame ───

test('rate limiter is checked on each handleMessage call; only over-limit frame kicks', async () => {
    const limiter = new FixedBudgetRateLimiter(1)  // allow exactly one frame
    const { stub } = makeRivalis(limiter)

    const actorId = await stub.layer.grantAccess('ticket')

    let kickPayload: Uint8Array | null = null
    stub.layer.on('kick', actorId, (_: string, payload: Uint8Array) => {
        kickPayload = payload
    })

    // Frame within budget — accepted
    await stub.layer.handleMessage(actorId, encode('x', new Uint8Array(0)))
    assert.strictEqual(kickPayload, null, 'frame within budget must not kick')
    assert.equal(limiter.checkCalls.length, 1, 'limiter must be checked once')
    assert.equal(limiter.checkCalls[0]!.result, true, 'first check must allow the frame')

    // Frame over budget — kicked
    await stub.layer.handleMessage(actorId, encode('x', new Uint8Array(0)))
    assert.ok(kickPayload !== null, 'over-limit frame must kick')
    assert.equal(limiter.checkCalls.length, 2, 'limiter must be checked again')
    assert.equal(limiter.checkCalls[1]!.result, false, 'second check must deny the frame')
    assert.equal(
        new TextDecoder().decode(kickPayload!),
        KickReason.RATE_LIMITED
    )
})

// ── AC3: per-transport RateLimiter on an RTC stub is enforced via handleMessage

test('per-transport RateLimiter on RTC stub kicks with RATE_LIMITED when exceeded', async () => {
    const transportLimiter = new FixedBudgetRateLimiter(1)
    const stub = new StubTransport()
    stub.rateLimiter = transportLimiter  // per-transport override, simulating per-peer RTC limit

    const rivalis = new Rivalis<null>({
        transports: [stub],
        authMiddleware: new AcceptAll(),
        rateLimiter: null,  // no global limiter
    })
    rivalis.rooms.define('r', class extends Room<null> {})
    rivalis.rooms.create('r', 'test-room')

    const actorId = await stub.layer.grantAccess('ticket', undefined, stub)

    let kickPayload: Uint8Array | null = null
    stub.layer.on('kick', actorId, (_: string, payload: Uint8Array) => {
        kickPayload = payload
    })

    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.strictEqual(kickPayload, null, 'frame within per-transport budget must not kick')

    await stub.layer.handleMessage(actorId, encode('ping', new Uint8Array(0)))
    assert.ok(kickPayload !== null, 'over per-transport-limit frame must kick')
    assert.equal(new TextDecoder().decode(kickPayload!), KickReason.RATE_LIMITED)
})

// ── AC4: no RTC-specific transport code required (structural assertion) ────────

test('StubTransport (RTC stand-in) requires no transport-specific rate-limit code', () => {
    // StubTransport carries zero rate-limit logic — `rateLimiter` is undefined by
    // default (inherited from Transport). TLayer.handleMessage automatically resolves
    // to the global limiter. The fact that AC1 and AC2 above pass without any
    // per-transport code confirms no RTC transport modifications are needed.
    const stub = new StubTransport()
    assert.strictEqual(stub.rateLimiter, undefined, 'default Transport has no per-transport limiter')
})
