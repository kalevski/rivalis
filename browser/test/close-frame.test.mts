/**
 * Tests for __rivalis:close control frame decoding in the browser WSClient
 * (p2p.md §3.4, task 040-core-medium-client-decode-close-frame).
 *
 * Acceptance criteria:
 *   1. A __rivalis:close frame arriving in onMessage emits client:kicked
 *      with the decoded { code, reason }.
 *   2. The __rivalis:close topic is NOT forwarded to user-topic listeners.
 *   3. client:kicked is NOT emitted twice when the channel subsequently
 *      closes with a plain code-1000 close (no double-fire).
 *   4. Native 4xxx WS close codes still emit client:kicked on their own
 *      (existing behaviour is not broken).
 *   5. NO_RECONNECT_CODES gate blocks reconnect when the kick code is
 *      terminal (KICKED, INVALID_TICKET) arriving via the control frame.
 *   6. A non-terminal code (e.g. RATE_LIMITED) via the control frame
 *      still schedules a reconnect.
 *   7. pendingCloseCode is cleared by disconnect() so it never leaks
 *      across connections.
 *
 * Test strategy: mock window.WebSocket (and the other browser globals the
 * module needs at evaluation time) BEFORE dynamically importing the built
 * browser lib, so the top-level `const encoder = new window.TextEncoder()`
 * runs against a valid window object.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── 1. Mock browser globals BEFORE the browser module is loaded ──────────────

let lastSocket: MockWebSocket | null = null

class MockWebSocket {
    static OPEN = 1
    static CONNECTING = 0

    readyState = MockWebSocket.CONNECTING
    onopen: ((event: any) => void) | null = null
    onclose: ((event: any) => void) | null = null
    onerror: ((event: any) => void) | null = null
    onmessage: ((event: any) => void) | null = null
    binaryType: string = 'blob'

    constructor(_url: string, _protocols?: any) {
        // Track the most-recently constructed socket for test control.
        lastSocket = this
    }

    send(_data: any): void {}

    close(_code?: number, _reason?: string): void {}

    // ── Test-control helpers ─────────────────────────────────────────────────

    _open(): void {
        this.readyState = MockWebSocket.OPEN
        this.onopen?.({})
    }

    _message(data: ArrayBuffer): void {
        this.onmessage?.({ data })
    }

    _close(code: number, reason: string): void {
        this.readyState = 3 // CLOSED
        this.onclose?.({ code, reason })
    }
}

;(global as any).window = {
    TextEncoder,
    TextDecoder,
    URL,
    WebSocket: MockWebSocket,
}

// ── 2. Dynamic import AFTER window is set up ─────────────────────────────────
// Static imports are hoisted and evaluated before any module body code runs,
// so the browser module must be loaded via dynamic import to guarantee that
// global.window is set before the top-level `new window.TextEncoder()` call.

const { WSClient } = await import('../lib/main.js')
const { encode, encodeCloseFrame, CloseCode, CLOSE_CONTROL_TOPIC } =
    await import('../../handshake/lib/main.js')

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitForEvent(emitter: any, event: string, timeoutMs = 500): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`timed out waiting for '${event}'`)),
            timeoutMs
        )
        timer.unref?.()
        emitter.once(event, (...args: unknown[]) => {
            clearTimeout(timer)
            resolve(args)
        })
    })
}

/**
 * Build a binary ArrayBuffer that looks like a __rivalis:close handshake
 * frame arriving over the wire:  encode(CLOSE_CONTROL_TOPIC, encodeCloseFrame(code, reason)).
 */
function makeCloseFrameBuffer(code: number, reason: string): ArrayBuffer {
    const payload = encodeCloseFrame(code, reason)
    const frame = encode(CLOSE_CONTROL_TOPIC, payload)
    return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('__rivalis:close frame emits client:kicked with decoded code and reason', async () => {
    const client = new WSClient('ws://localhost:9999', { reconnect: false })
    client.on('client:error', () => {})
    client.on('client:disconnect', () => {})

    const kicked = waitForEvent(client, 'client:kicked')
    client.connect('ticket')
    lastSocket!._open()
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.KICKED, 'room_destroyed'))

    const [info] = await kicked as [{ code: number; reason: string }]
    assert.equal(info.code, CloseCode.KICKED, 'code must match the encoded close code')
    assert.equal(info.reason, 'room_destroyed', 'reason must match the encoded reason')

    client.disconnect()
})

test('all CloseCode values round-trip through the control frame', async () => {
    for (const [name, code] of Object.entries(CloseCode) as [string, number][]) {
        const client = new WSClient('ws://localhost:9999', { reconnect: false })
        client.on('client:error', () => {})
        client.on('client:disconnect', () => {})

        const kicked = waitForEvent(client, 'client:kicked')
        client.connect('ticket')
        lastSocket!._open()
        lastSocket!._message(makeCloseFrameBuffer(code, name))

        const [info] = await kicked as [{ code: number; reason: string }]
        assert.equal(info.code, code, `${name} (${code}) must round-trip`)

        client.disconnect()
    }
})

test('__rivalis:close topic is NOT forwarded to user-topic listeners', async () => {
    const client = new WSClient('ws://localhost:9999', { reconnect: false })
    client.on('client:error', () => {})
    client.on('client:disconnect', () => {})

    let userTopicFired = false
    ;(client as any).on(CLOSE_CONTROL_TOPIC, () => { userTopicFired = true })

    const kicked = waitForEvent(client, 'client:kicked')
    client.connect('ticket')
    lastSocket!._open()
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.KICKED, 'test'))
    await kicked

    assert.equal(userTopicFired, false, '__rivalis:close must not reach user-topic listeners')
    client.disconnect()
})

test('client:kicked is NOT emitted twice when channel closes with code 1000 after __rivalis:close', async () => {
    const client = new WSClient('ws://localhost:9999', { reconnect: false })
    client.on('client:error', () => {})

    let kickCount = 0
    client.on('client:kicked', () => { kickCount++ })

    const disconnected = waitForEvent(client, 'client:disconnect')
    client.connect('ticket')
    lastSocket!._open()
    // Control frame arrives first (RTC close path)
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.KICKED, 'room_destroyed'))
    // Channel closes with a plain 1000 (no native kick semantics)
    lastSocket!._close(1000, '')

    await disconnected
    assert.equal(kickCount, 1, 'exactly one client:kicked must fire for a control-frame kick')
})

test('native 4xxx WS close code still emits client:kicked when no control frame was received', async () => {
    const client = new WSClient('ws://localhost:9999', { reconnect: false })
    client.on('client:error', () => {})

    const kicked = waitForEvent(client, 'client:kicked')
    const disconnected = waitForEvent(client, 'client:disconnect')

    client.connect('ticket')
    lastSocket!._open()
    // Only a native WS close, no __rivalis:close frame
    lastSocket!._close(CloseCode.INVALID_TICKET, 'invalid_ticket')

    const [info] = await kicked as [{ code: number; reason: string }]
    await disconnected

    assert.equal(info.code, CloseCode.INVALID_TICKET)
    assert.equal(info.reason, 'invalid_ticket')
})

test('NO_RECONNECT_CODES: KICKED via __rivalis:close blocks reconnect', async () => {
    const client = new WSClient('ws://localhost:9999', {
        reconnect: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 50 }
    })
    client.on('client:error', () => {})

    let reconnectAttempted = false
    client.on('client:reconnecting', () => { reconnectAttempted = true })

    const disconnected = waitForEvent(client, 'client:disconnect')
    client.connect('ticket')
    lastSocket!._open()
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.KICKED, 'room_destroyed'))
    lastSocket!._close(1000, '')

    await disconnected
    // Give macrotask queue a moment to confirm no reconnect timer was scheduled
    await new Promise(resolve => setTimeout(resolve, 60))

    assert.equal(reconnectAttempted, false, 'KICKED via control frame must block reconnect')
    client.disconnect()
})

test('NO_RECONNECT_CODES: INVALID_TICKET via __rivalis:close blocks reconnect', async () => {
    const client = new WSClient('ws://localhost:9999', {
        reconnect: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 50 }
    })
    client.on('client:error', () => {})

    let reconnectAttempted = false
    client.on('client:reconnecting', () => { reconnectAttempted = true })

    const disconnected = waitForEvent(client, 'client:disconnect')
    client.connect('ticket')
    lastSocket!._open()
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.INVALID_TICKET, ''))
    lastSocket!._close(1000, '')

    await disconnected
    await new Promise(resolve => setTimeout(resolve, 60))

    assert.equal(reconnectAttempted, false, 'INVALID_TICKET via control frame must block reconnect')
    client.disconnect()
})

test('NO_RECONNECT_CODES: ROOM_REJECTED via __rivalis:close blocks reconnect', async () => {
    const client = new WSClient('ws://localhost:9999', {
        reconnect: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 50 }
    })
    client.on('client:error', () => {})

    let reconnectAttempted = false
    client.on('client:reconnecting', () => { reconnectAttempted = true })

    const disconnected = waitForEvent(client, 'client:disconnect')
    client.connect('ticket')
    lastSocket!._open()
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.ROOM_REJECTED, ''))
    lastSocket!._close(1000, '')

    await disconnected
    await new Promise(resolve => setTimeout(resolve, 60))

    assert.equal(reconnectAttempted, false, 'ROOM_REJECTED via control frame must block reconnect')
    client.disconnect()
})

test('non-terminal code RATE_LIMITED via __rivalis:close allows reconnect', async () => {
    // CloseCode.RATE_LIMITED (4005) is NOT in NO_RECONNECT_CODES
    const client = new WSClient('ws://localhost:9999', {
        reconnect: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20 }
    })
    client.on('client:error', () => {})

    const reconnecting = waitForEvent(client, 'client:reconnecting', 500)
    const disconnected = waitForEvent(client, 'client:disconnect')

    client.connect('ticket')
    lastSocket!._open()
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.RATE_LIMITED, 'rate_limited'))
    lastSocket!._close(1000, '')

    await disconnected
    // client:reconnecting is emitted synchronously by scheduleReconnect()
    await reconnecting

    client.disconnect()
})

test('pendingCloseCode is cleared by disconnect() and does not leak across connections', () => {
    const client = new WSClient('ws://localhost:9999', { reconnect: false })
    client.on('client:error', () => {})
    client.on('client:disconnect', () => {})

    let kickCount = 0
    client.on('client:kicked', () => { kickCount++ })

    client.connect('ticket')
    lastSocket!._open()
    // Receive a control frame — synchronously emits client:kicked
    lastSocket!._message(makeCloseFrameBuffer(CloseCode.KICKED, 'test'))
    assert.equal(kickCount, 1, 'control frame must fire exactly one client:kicked')

    // Calling disconnect() must clear pendingCloseCode — not cause a second emission
    client.disconnect()
    assert.equal(kickCount, 1, 'disconnect() must not cause a second client:kicked')
})
