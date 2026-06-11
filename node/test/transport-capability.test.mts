/**
 * Acceptance tests for the Transport capability descriptor (p2p.md §7, §12 Phase 4).
 *
 * Covered:
 *   AC1 — Transport base class exposes a capability descriptor.
 *   AC2 — WSTransport reports accurate capabilities (ordered, reliable, maxFrameBytes).
 *   AC3 — Room.transportCapabilities surfaces the registered capabilities.
 *   AC4 — Multi-transport merges conservatively (AND ordered/reliable, min maxFrameBytes).
 *   AC5 — TransportCapability is a named export of @rivalis/core.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { Rivalis, Room, Transport, AuthMiddleware } from '@rivalis/core'
import type { AuthResult, TransportCapability } from '@rivalis/core'
import { WSTransport } from '../lib/main.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, () => {
            const address = srv.address()
            const port = typeof address === 'object' && address !== null ? address.port : 0
            srv.close(() => resolve(port))
        })
    })
}

class SimpleAuth extends AuthMiddleware<null> {
    async authenticate(_ticket: string): Promise<AuthResult<null> | null> {
        return { data: null, roomId: 'test-room' }
    }
}

/** Stub transport that does NOT register capabilities — simulates legacy / external transport. */
class NoCapStub extends Transport {
    layer: any = null
    override onInitialize(tl: any): void { this.layer = tl }
    override get sockets(): number { return 0 }
}

/** Stub that registers explicit capabilities. */
class CapStub extends Transport {
    layer: any = null
    private readonly _caps: TransportCapability

    constructor(caps: TransportCapability) {
        super()
        this._caps = caps
    }

    override onInitialize(tl: any): void {
        this.layer = tl
        tl.registerCapabilities(this._caps)
    }

    override get sockets(): number { return 0 }
    override get maxFrameBytes(): number | null { return this._caps.maxFrameBytes }
    override get capabilities(): TransportCapability { return { ...this._caps } }
}

// ── AC5: TransportCapability is a named export ────────────────────────────────

test('TransportCapability type is re-exported from @rivalis/core (structural check)', () => {
    // We can't check a TS type at runtime, but we can confirm the Transport
    // class exposes a capabilities getter with the right shape.
    const stub = new NoCapStub()
    const caps = stub.capabilities
    assert.ok(typeof caps === 'object' && caps !== null, 'capabilities must be an object')
    assert.ok('ordered' in caps, 'must have ordered')
    assert.ok('reliable' in caps, 'must have reliable')
    assert.ok('maxFrameBytes' in caps, 'must have maxFrameBytes')
})

// ── AC1: Transport base class exposes a capability descriptor ─────────────────

test('Transport base class capabilities default: ordered=true, reliable=true, maxFrameBytes=null', () => {
    const stub = new NoCapStub()
    const caps = stub.capabilities
    assert.strictEqual(caps.ordered, true)
    assert.strictEqual(caps.reliable, true)
    assert.strictEqual(caps.maxFrameBytes, null)
})

test('Transport subclass overriding maxFrameBytes is reflected in capabilities', () => {
    const stub = new CapStub({ ordered: true, reliable: true, maxFrameBytes: 16384 })
    const caps = stub.capabilities
    assert.strictEqual(caps.ordered, true)
    assert.strictEqual(caps.reliable, true)
    assert.strictEqual(caps.maxFrameBytes, 16384)
})

// ── AC2: WSTransport reports accurate capabilities ────────────────────────────

test('WSTransport capabilities: ordered=true, reliable=true, maxFrameBytes=configured maxPayload', async () => {
    const port = await getFreePort()
    const ws = new WSTransport({ port }, null, { maxPayload: 32768, heartbeat: false })
    const caps = ws.capabilities
    assert.strictEqual(caps.ordered, true, 'WS is ordered (TCP)')
    assert.strictEqual(caps.reliable, true, 'WS is reliable (TCP)')
    assert.strictEqual(caps.maxFrameBytes, 32768, 'maxFrameBytes must match configured maxPayload')
    await ws.dispose()
})

test('WSTransport capabilities default maxFrameBytes is 64 KiB', async () => {
    const port = await getFreePort()
    const ws = new WSTransport({ port }, null, { heartbeat: false })
    assert.strictEqual(ws.capabilities.maxFrameBytes, 64 * 1024)
    await ws.dispose()
})

// ── AC3: Room.transportCapabilities surfaces the registered capabilities ──────

test('Room.transportCapabilities is null when no transport registers capabilities', () => {
    const stub = new NoCapStub()
    let seen: TransportCapability | null = undefined as unknown as TransportCapability | null

    class InspectRoom extends Room<null> {
        protected override onCreate(): void {
            seen = this.transportCapabilities
        }
    }

    const rivalis = new Rivalis<null>({
        transports: [stub],
        authMiddleware: new SimpleAuth(),
    })
    rivalis.rooms.define('r', InspectRoom)
    rivalis.rooms.create('r', 'test-room')

    assert.strictEqual(seen, null, 'no capabilities registered → null')
})

test('Room.transportCapabilities returns the transport capabilities after registration', async () => {
    const port = await getFreePort()
    const ws = new WSTransport({ port }, null, { maxPayload: 16384, heartbeat: false })
    let captured: TransportCapability | null = null

    class InspectRoom extends Room<null> {
        protected override onCreate(): void {
            captured = this.transportCapabilities
        }
    }

    const rivalis = new Rivalis<null>({
        transports: [ws],
        authMiddleware: new SimpleAuth(),
    })
    rivalis.rooms.define('r', InspectRoom)
    rivalis.rooms.create('r', 'test-room')

    assert.ok(captured !== null, 'capabilities must be set')
    assert.strictEqual(captured!.ordered, true)
    assert.strictEqual(captured!.reliable, true)
    assert.strictEqual(captured!.maxFrameBytes, 16384)

    await rivalis.shutdown()
})

// ── AC4: multi-transport merges conservatively ────────────────────────────────

test('two transports merge capabilities: min maxFrameBytes, AND ordered+reliable', () => {
    const a = new CapStub({ ordered: true,  reliable: true,  maxFrameBytes: 65536 })
    const b = new CapStub({ ordered: true,  reliable: true,  maxFrameBytes: 16384 })
    let merged: TransportCapability | null = null

    class InspectRoom extends Room<null> {
        protected override onCreate(): void { merged = this.transportCapabilities }
    }

    const rivalis = new Rivalis<null>({
        transports: [a, b],
        authMiddleware: new SimpleAuth(),
    })
    rivalis.rooms.define('r', InspectRoom)
    rivalis.rooms.create('r', 'test-room')

    assert.ok(merged !== null)
    assert.strictEqual(merged!.maxFrameBytes, 16384, 'min of 65536 and 16384 is 16384')
    assert.strictEqual(merged!.ordered, true)
    assert.strictEqual(merged!.reliable, true)
})

test('merge: ordered=false when any transport is unordered', () => {
    const a = new CapStub({ ordered: true,  reliable: true,  maxFrameBytes: null })
    const b = new CapStub({ ordered: false, reliable: true,  maxFrameBytes: null })

    // Capabilities are registered during onInitialize (before rooms exist),
    // so we inspect TLayer directly via the stub's stored layer reference.
    new Rivalis<null>({ transports: [a, b], authMiddleware: new SimpleAuth() })

    assert.strictEqual((a.layer as any).capabilities.ordered, false)
    assert.strictEqual((a.layer as any).capabilities.reliable, true)
    assert.strictEqual((a.layer as any).capabilities.maxFrameBytes, null)
})

test('merge: maxFrameBytes=null when both transports have no limit', () => {
    const a = new CapStub({ ordered: true, reliable: true, maxFrameBytes: null })
    const b = new CapStub({ ordered: true, reliable: true, maxFrameBytes: null })

    new Rivalis<null>({ transports: [a, b], authMiddleware: new SimpleAuth() })

    assert.strictEqual((a.layer as any).capabilities.maxFrameBytes, null)
})

test('merge: null maxFrameBytes defers to the other transport limit', () => {
    const a = new CapStub({ ordered: true, reliable: true, maxFrameBytes: null })
    const b = new CapStub({ ordered: true, reliable: true, maxFrameBytes: 16384 })

    new Rivalis<null>({ transports: [a, b], authMiddleware: new SimpleAuth() })

    assert.strictEqual((a.layer as any).capabilities.maxFrameBytes, 16384)
})
