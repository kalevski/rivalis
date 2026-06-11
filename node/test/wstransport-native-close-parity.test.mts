/**
 * Verifies that WSTransport closes WS connections via native WebSocket close
 * frames (close code + reason), not the transport-agnostic __rivalis:close
 * control frame (p2p.md §3.4, task 039).
 *
 * §3.4 design decision:
 *   - WSTransport keeps using native close frames — no observable change to WS
 *     clients.
 *   - Non-close-code transports (RTC) send __rivalis:close before closing the
 *     channel. That convention is for future transports only.
 *
 * This test uses a raw ws.WebSocket to observe what the server actually sends
 * and what close code arrives, so the assertions are against the wire, not an
 * abstraction layer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { WebSocket } from 'ws'

import { Rivalis, Room, Actor, AuthMiddleware, KickReason } from '@rivalis/core'
import type { AuthResult } from '@rivalis/core'
import { WSTransport } from '../lib/main.js'
import { CloseCode, CLOSE_CONTROL_TOPIC } from '@rivalis/handshake'

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

class AlwaysAcceptAuth extends AuthMiddleware<null> {
    async authenticate(ticket: string): Promise<AuthResult<null> | null> {
        if (ticket === 'good') return { data: null, roomId: 'room-1' }
        return null
    }
}

// ── AC1: in-room kick delivers native close code 4003, not a control frame ──

test('in-room kick closes the WS connection with native close code 4003 (KICKED)', async (t) => {
    const port = await getFreePort()

    // A room that kicks the actor immediately after they join.
    class KickOnJoinRoom extends Room<null> {
        protected override onJoin(actor: Actor<null>): void {
            this.kick(actor, KickReason.ROOM_DESTROYED)
        }
    }

    const rivalis = new Rivalis<null>({
        transports: [new WSTransport({ port }, null, { ticketSource: 'protocol' })],
        authMiddleware: new AlwaysAcceptAuth()
    })
    rivalis.rooms.define('kick-test', KickOnJoinRoom)
    rivalis.rooms.create('kick-test', 'room-1')

    t.after(() => rivalis.shutdown())

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for close frame')), 3000)
        timer.unref?.()

        const receivedMessages: string[] = []
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['good'])

        ws.on('message', (data) => {
            // Decode any binary message to check for the control topic.
            // WSTransport must NOT send __rivalis:close before the native close.
            if (data instanceof Buffer || data instanceof Uint8Array) {
                try {
                    const text = Buffer.from(data).toString()
                    receivedMessages.push(text)
                } catch {
                    receivedMessages.push('<binary>')
                }
            }
        })

        ws.on('close', (code, reason) => {
            clearTimeout(timer)

            try {
                // WSTransport uses native WS close frames — no control message.
                const controlFrameSent = receivedMessages.some(m => m.includes(CLOSE_CONTROL_TOPIC))
                assert.equal(
                    controlFrameSent,
                    false,
                    `WSTransport must NOT send a ${CLOSE_CONTROL_TOPIC} control frame; use native close only`
                )

                // The close code must be the native WS KICKED code (4003).
                assert.equal(code, CloseCode.KICKED, `expected native close code ${CloseCode.KICKED}, got ${code}`)

                // The reason must be the kick reason string carried in the close frame.
                const reasonStr = reason.toString('utf-8')
                assert.equal(
                    reasonStr,
                    KickReason.ROOM_DESTROYED,
                    `expected reason "${KickReason.ROOM_DESTROYED}", got "${reasonStr}"`
                )

                resolve()
            } catch (err) {
                reject(err)
            }
        })

        ws.on('error', reject)
    })
})

// ── AC2: pre-join rejection delivers native close code, not a control frame ──

test('invalid-ticket rejection closes with native close code 4001 (INVALID_TICKET)', async (t) => {
    const port = await getFreePort()

    class BasicRoom extends Room<null> {}

    const rivalis = new Rivalis<null>({
        transports: [new WSTransport({ port }, null, { ticketSource: 'protocol' })],
        authMiddleware: new AlwaysAcceptAuth()
    })
    rivalis.rooms.define('basic', BasicRoom)
    rivalis.rooms.create('basic', 'room-1')

    t.after(() => rivalis.shutdown())

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for close frame')), 3000)
        timer.unref?.()

        const receivedMessages: string[] = []
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['bad-ticket'])

        ws.on('message', (data) => {
            if (data instanceof Buffer || data instanceof Uint8Array) {
                try {
                    receivedMessages.push(Buffer.from(data).toString())
                } catch {
                    receivedMessages.push('<binary>')
                }
            }
        })

        ws.on('close', (code, reason) => {
            clearTimeout(timer)

            try {
                const controlFrameSent = receivedMessages.some(m => m.includes(CLOSE_CONTROL_TOPIC))
                assert.equal(
                    controlFrameSent,
                    false,
                    `WSTransport must NOT send a ${CLOSE_CONTROL_TOPIC} control frame; use native close only`
                )

                assert.equal(code, CloseCode.INVALID_TICKET, `expected native close code ${CloseCode.INVALID_TICKET}, got ${code}`)

                // Pre-join rejections carry no reason payload.
                const reasonStr = reason.toString('utf-8')
                assert.equal(reasonStr, '', `expected empty reason for INVALID_TICKET, got "${reasonStr}"`)

                resolve()
            } catch (err) {
                reject(err)
            }
        })

        ws.on('error', reject)
    })
})

// ── AC3: close-code values match the CloseCode constants from @rivalis/handshake ──

test('CloseCode.KICKED is 4003 and CloseCode.INVALID_TICKET is 4001 (native WS range)', () => {
    assert.equal(CloseCode.KICKED, 4003, 'KICKED must be 4003 — the native WS close code WS clients observe')
    assert.equal(CloseCode.INVALID_TICKET, 4001, 'INVALID_TICKET must be 4001')
    assert.equal(CloseCode.ROOM_REJECTED, 4004, 'ROOM_REJECTED must be 4004')
    assert.equal(CloseCode.RATE_LIMITED, 4005, 'RATE_LIMITED must be 4005')
    // All Rivalis close codes are in the application-reserved WS range 4000–4999.
    for (const code of Object.values(CloseCode)) {
        assert.ok(code >= 4000 && code <= 4999, `close code ${code} must be in WS application range 4000–4999`)
    }
})
