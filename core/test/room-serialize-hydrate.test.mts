/**
 * Room.serialize() / Room.hydrate() hook tests (p2p.md §12 Phase 3).
 *
 * Verifies the opt-in contract:
 *  - default serialize() returns null (no-op)
 *  - default hydrate() is a no-op
 *  - trySerialize() and tryHydrate() swallow user throws rather than crashing
 *  - subclasses that implement serialize/hydrate participate in state transfer
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rivalis, Room, AuthMiddleware } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'

// ── test helpers ──────────────────────────────────────────────────────────────

class AlwaysAuth extends AuthMiddleware<null> {
    constructor(private readonly roomId: string) { super() }
    async authenticate(): Promise<AuthResult<null> | null> {
        return { data: null, roomId: this.roomId }
    }
}

// Expose trySerialize / tryHydrate (both @internal) for direct testing.
class InspectableRoom extends Room<null> {
    public callTrySerialize(): Uint8Array | null { return this.trySerialize() }
    public callTryHydrate(bytes: Uint8Array): void { return this.tryHydrate(bytes) }
}

class StateRoom extends InspectableRoom {
    public state: string = ''

    protected override serialize(): Uint8Array {
        return new TextEncoder().encode(this.state)
    }

    protected override hydrate(bytes: Uint8Array): void {
        this.state = new TextDecoder().decode(bytes)
    }
}

class ThrowingSerializeRoom extends InspectableRoom {
    protected override serialize(): Uint8Array {
        throw new Error('serialize exploded')
    }
}

class ThrowingHydrateRoom extends InspectableRoom {
    protected override hydrate(_bytes: Uint8Array): void {
        throw new Error('hydrate exploded')
    }
}

function setup<R extends InspectableRoom>(RoomClass: new (...args: any[]) => R, roomId = 'r1'): { room: R; tl: any } {
    const rivalis = new Rivalis<null>({
        transports: [],
        authMiddleware: new AlwaysAuth(roomId),
    })
    rivalis.rooms.define('test', RoomClass)
    const room = rivalis.rooms.create('test', roomId) as R
    const tl: any = (rivalis as any)['transportLayer']
    return { room, tl }
}

// ── default behavior (opt-out) ────────────────────────────────────────────────

test('default serialize returns null — room opts out of state transfer', () => {
    const { room } = setup(InspectableRoom)
    assert.strictEqual(room.callTrySerialize(), null)
})

test('default hydrate is a no-op — calling it does not throw', () => {
    const { room } = setup(InspectableRoom)
    assert.doesNotThrow(() => room.callTryHydrate(new Uint8Array([1, 2, 3])))
})

// ── implementing serialize / hydrate ─────────────────────────────────────────

test('implementing room can serialize and hydrate state round-trip', () => {
    const { room } = setup(StateRoom)
    room.state = 'hello-world'

    const bytes = room.callTrySerialize()
    assert.ok(bytes !== null, 'serialize must return non-null bytes')

    // Hydrate into a fresh room instance to verify independence.
    const { room: room2 } = setup(StateRoom, 'r2')
    assert.equal(room2.state, '', 'fresh room starts with empty state')
    room2.callTryHydrate(bytes)
    assert.equal(room2.state, 'hello-world', 'hydrate must restore serialized state')
})

// ── error resilience ──────────────────────────────────────────────────────────

test('trySerialize catches a throwing serialize and returns null', () => {
    const { room } = setup(ThrowingSerializeRoom)
    // Must not throw; must return null.
    let result: Uint8Array | null = undefined!
    assert.doesNotThrow(() => { result = room.callTrySerialize() })
    assert.strictEqual(result, null)
})

test('tryHydrate catches a throwing hydrate and does not propagate', () => {
    const { room } = setup(ThrowingHydrateRoom)
    assert.doesNotThrow(() => room.callTryHydrate(new Uint8Array([7, 8, 9])))
})
