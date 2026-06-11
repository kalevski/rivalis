import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Transport } from '../lib/main.js'

// Concrete subclass authored entirely outside core — mirrors
// what an RTCTransport or any external transport would do.
class StubTransport extends Transport {
    override onInitialize(_tl: any): void {}
    override get sockets(): number { return 0 }
}

test('Transport is a named export of @rivalis/core', () => {
    assert.ok(typeof Transport === 'function', 'Transport should be a class/function')
})

test('Transport can be subclassed from outside core', () => {
    const t = new StubTransport()
    assert.ok(t instanceof Transport, 'subclass instance should satisfy instanceof Transport')
})

test('Transport subclass dispose() is a no-op by default', async () => {
    const t = new StubTransport()
    // dispose() has a default implementation — should not throw
    await assert.doesNotReject(async () => t.dispose())
})
