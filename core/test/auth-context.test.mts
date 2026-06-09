import { test } from 'node:test'
import assert from 'node:assert/strict'
import AuthMiddleware from '../lib/main.js'
import type { ConnectionContext, AuthResult } from '../lib/main.js'

// Single-arg override — no `context` parameter declared.
// TS allows overrides that ignore trailing optional params on the abstract method.
class TicketOnlyAuth extends AuthMiddleware<{ role: string }> {
    async authenticate(ticket: string): Promise<AuthResult<{ role: string }> | null> {
        if (ticket === 'valid') {
            return { data: { role: 'player' }, roomId: 'room-1' }
        }
        return null
    }
}

// Context-aware override — reads `context.kind` and `context.remoteId`.
class ContextAwareAuth extends AuthMiddleware<{ transport: string; peer: string | null }> {
    async authenticate(
        ticket: string,
        context?: ConnectionContext
    ): Promise<AuthResult<{ transport: string; peer: string | null }> | null> {
        if (ticket !== 'valid') return null
        return {
            data: { transport: context?.kind ?? 'unknown', peer: context?.remoteId ?? null },
            roomId: 'room-1'
        }
    }
}

test('single-arg override accepts a ticket and returns AuthResult', async () => {
    const auth = new TicketOnlyAuth()
    const result = await auth.authenticate('valid')
    assert.deepEqual(result, { data: { role: 'player' }, roomId: 'room-1' })
})

test('single-arg override rejects an invalid ticket', async () => {
    const auth = new TicketOnlyAuth()
    const result = await auth.authenticate('bad')
    assert.equal(result, null)
})

test('context-aware override receives context.kind when supplied', async () => {
    const auth = new ContextAwareAuth()
    const ctx: ConnectionContext = { kind: 'webrtc', remoteId: 'peer-42' }
    const result = await auth.authenticate('valid', ctx)
    assert.deepEqual(result, { data: { transport: 'webrtc', peer: 'peer-42' }, roomId: 'room-1' })
})

test('context-aware override handles absent context gracefully', async () => {
    const auth = new ContextAwareAuth()
    const result = await auth.authenticate('valid')
    assert.deepEqual(result, { data: { transport: 'unknown', peer: null }, roomId: 'room-1' })
})

test('context-aware override can read context.kind ws', async () => {
    const auth = new ContextAwareAuth()
    const ctx: ConnectionContext = { kind: 'ws', remoteId: '127.0.0.1', meta: { origin: 'localhost' } }
    const result = await auth.authenticate('valid', ctx)
    assert.deepEqual(result, { data: { transport: 'ws', peer: '127.0.0.1' }, roomId: 'room-1' })
})
