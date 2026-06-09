import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '../lib/main.js'

// Concrete subclass authored entirely outside core — mirrors
// what an RTCClient or any external client would do.
class StubClient extends Client<'game:state' | 'chat'> {
    override get connected(): boolean { return false }
    override connect(_ticket?: string): void {}
    override disconnect(): void {}
    override send(_topic: string, _payload?: Uint8Array | string): void {}
}

test('Client is a named export of @rivalis/core', () => {
    assert.ok(typeof Client === 'function', 'Client should be a class/function')
})

test('Client can be subclassed from outside core', () => {
    const c = new StubClient()
    assert.ok(c instanceof Client, 'subclass instance should satisfy instanceof Client')
})

test('Client subclass exposes connected/connect/disconnect/send', () => {
    const c = new StubClient()
    assert.strictEqual(c.connected, false)
    assert.doesNotThrow(() => c.connect('ticket'))
    assert.doesNotThrow(() => c.disconnect())
    assert.doesNotThrow(() => c.send('game:state'))
})
