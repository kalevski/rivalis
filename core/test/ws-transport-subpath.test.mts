import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WSTransport } from '../lib/ws.js'

test('WSTransport is exported from the @rivalis/core/transports/ws subpath', () => {
    assert.ok(typeof WSTransport === 'function', 'WSTransport should be a class/function')
})

test('WSTransport can be instantiated (noServer mode)', () => {
    // noServer: true avoids binding a real port in the test
    const transport = new WSTransport({ noServer: true })
    assert.ok(transport instanceof WSTransport)
})
