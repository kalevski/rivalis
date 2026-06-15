import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FleetControl } from '../lib/FleetControl.js'
import { CommandEngine } from '../lib/CommandEngine.js'
import { FleetState } from '../lib/FleetState.js'
import { Topics } from '../lib/wire.js'

// ---------------------------------------------------------------------------
// Direct unit tests for the control surface (task 008 decomposition). It composes
// FleetState placement + the CommandEngine over an injected link resolver — driven
// here with a real FleetState + CommandEngine and a recording link (§15).
// ---------------------------------------------------------------------------

function makeClock() {
    let now = 0
    let id = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    return {
        scheduler: {
            setTimeout: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn }); return t },
            clearTimeout: (h: unknown) => { timers.delete(h as number) }
        },
        advance: (ms: number) => {
            const target = now + ms
            for (;;) {
                let next: { id: number; at: number; fn: () => void } | null = null
                for (const [tid, t] of timers) {
                    if (t.at <= target && (next === null || t.at < next.at)) { next = { id: tid, at: t.at, fn: t.fn } }
                }
                if (next === null) { break }
                now = next.at
                timers.delete(next.id)
                next.fn()
            }
            now = target
        }
    }
}

function syncPayload(over: any = {}): any {
    return {
        seq: over.seq ?? 1,
        hash: over.hash ?? 'h1',
        name: over.name ?? 'eu1',
        processUid: over.processUid ?? 'p1',
        agentVersion: over.agentVersion ?? '1.0.0',
        protocolVersion: over.protocolVersion ?? 1,
        endpointUrl: over.endpointUrl ?? 'wss://eu1.example.com',
        labels: over.labels ?? {},
        capacity: over.capacity ?? { maxConnections: null, maxRooms: null },
        autoCreate: over.autoCreate ?? true,
        roomTypes: over.roomTypes ?? ['match'],
        rooms: over.rooms ?? [],
        status: over.status ?? 'active'
    }
}

function harness() {
    const clock = makeClock()
    const state = new FleetState()
    const commands = new CommandEngine(clock.scheduler as any, state as any, 10000)
    const sent: Array<{ topic: string; payload: any }> = []
    const link = { instanceId: 'i1', send: (topic: string, payload: unknown) => sent.push({ topic, payload }), close: () => {} }
    const control = new FleetControl(state as any, commands as any, (id: string) => (id === 'i1' ? (link as any) : undefined))
    return { state, commands, control, sent, lastCmd: () => sent.filter((m) => m.topic === Topics.cmd).pop()!.payload }
}

test('createRoom places, pushes fleet/cmd {create} and resolves with RoomInfo on the ack', async () => {
    const h = harness()
    h.state.applySnapshot('i1', syncPayload(), 1) // a placement candidate

    const pending = h.control.createRoom({ type: 'match', roomId: 'match-1' })
    const cmd = h.lastCmd()
    assert.equal(cmd.op, 'create')
    assert.equal(cmd.roomId, 'match-1')
    assert.equal(cmd.roomType, 'match')

    h.commands.ack('i1', { cmdId: cmd.cmdId, ok: true } as any)
    const room = await pending
    assert.equal(room.id, 'match-1')
    assert.equal(room.instanceId, 'i1')
    assert.equal(room.endpointUrl, 'wss://eu1.example.com')
    assert.equal(room.local, false)
})

test('createRoom with no candidate rejects NO_CANDIDATE (and the reserved id is freed)', async () => {
    const h = harness() // empty read model
    await assert.rejects(h.control.createRoom({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')
    // The id reservation was released on the placement failure, so a later create reuses it.
    h.state.applySnapshot('i1', syncPayload(), 1)
    const pending = h.control.createRoom({ type: 'match', roomId: 'free-again' })
    pending.catch(() => {})
    assert.equal(h.lastCmd().roomId, 'free-again', 'the id freed by NO_CANDIDATE is reusable')
})

test('a re-create of the same id between ack and the next snapshot yields ROOM_EXISTS, never a 502 or a duplicate (task 003)', async () => {
    const h = harness()
    h.state.applySnapshot('i1', syncPayload(), 1)

    const first = h.control.createRoom({ type: 'match', roomId: 'dup' })
    const cmd1 = h.lastCmd()
    h.commands.ack('i1', { cmdId: cmd1.cmdId, ok: true } as any)
    await first

    // No snapshot carrying 'dup' has arrived (the read model is still the empty seq=1
    // one). The held reservation makes the re-create fail fast with ROOM_EXISTS BEFORE
    // any second fleet/cmd is pushed — never a 502 and never a second create.
    const cmdsBefore = h.sent.filter((m) => m.topic === Topics.cmd).length
    await assert.rejects(h.control.createRoom({ type: 'match', roomId: 'dup' }), (e: any) => e.code === 'ROOM_EXISTS')
    const cmdsAfter = h.sent.filter((m) => m.topic === Topics.cmd).length
    assert.equal(cmdsAfter, cmdsBefore, 'the duplicate re-create never reaches the agent (no second create)')
})

test('destroyRoom on an unknown id rejects ROOM_NOT_FOUND', async () => {
    const h = harness()
    await assert.rejects(h.control.destroyRoom('nope'), (e: any) => e.code === 'ROOM_NOT_FOUND')
})

test('drain/undrain on an unknown instance reject INSTANCE_NOT_FOUND', async () => {
    const h = harness()
    await assert.rejects(h.control.drainInstance('ghost'), (e: any) => e.code === 'INSTANCE_NOT_FOUND')
    await assert.rejects(h.control.undrainInstance('ghost'), (e: any) => e.code === 'INSTANCE_NOT_FOUND')
})

test('drainInstance pushes fleet/cmd {drain} and resolves on the ack', async () => {
    const h = harness()
    h.state.applySnapshot('i1', syncPayload(), 1)
    const pending = h.control.drainInstance('i1')
    const cmd = h.lastCmd()
    assert.equal(cmd.op, 'drain')
    h.commands.ack('i1', { cmdId: cmd.cmdId, ok: true } as any)
    await pending
})

// ---------------------------------------------------------------------------
// task 004 — after drainInstance() resolves, no room may land on the drained
// instance even before its next poll reply updates the read-model status. The
// race is driven deterministically: ack, await the resolve, then place — all
// synchronous, no poll reply in between.
// ---------------------------------------------------------------------------

test('after drainInstance() resolves, default placement never selects that instance (task 004)', async () => {
    const h = harness()
    h.state.applySnapshot('i1', syncPayload(), 1) // the sole active candidate

    // Sanity: it is a candidate before the drain.
    assert.equal(h.state.place({ type: 'match' }).instance.id, 'i1')

    const drain = h.control.drainInstance('i1')
    h.commands.ack('i1', { cmdId: h.lastCmd().cmdId, ok: true } as any)
    await drain

    // No new snapshot has arrived, so the read-model status is STILL 'active'
    // (agent owns it — §7), yet the just-drained instance must already be excluded.
    assert.equal(h.state.getInstance('i1')!.status, 'active', 'read-model status unchanged — agent-owned (§7)')
    await assert.rejects(h.control.createRoom({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')
})

test('undrainInstance() restores candidacy at ack time even while the read model still reports draining (task 004)', async () => {
    const h = harness()
    // The instance's snapshot reports it draining: read-model status = 'draining'.
    h.state.applySnapshot('i1', syncPayload({ status: 'draining' }), 1)
    await assert.rejects(h.control.createRoom({ type: 'match' }), (e: any) => e.code === 'NO_CANDIDATE')

    const undrain = h.control.undrainInstance('i1')
    h.commands.ack('i1', { cmdId: h.lastCmd().cmdId, ok: true } as any)
    await undrain

    // Read model still says 'draining' (no new snapshot — status still agent-owned, §7),
    // but candidacy is restored within the same accelerated window.
    assert.equal(h.state.getInstance('i1')!.status, 'draining', 'read-model status unchanged — agent-owned (§7)')
    const room = h.control.createRoom({ type: 'match' })
    room.catch(() => {})
    assert.equal(h.lastCmd().op, 'create', 'the undrained instance is a placement candidate again')
})

test('a failed drain ack records no override — candidacy is unchanged (task 004)', async () => {
    const h = harness()
    h.state.applySnapshot('i1', syncPayload(), 1)
    const drain = h.control.drainInstance('i1')
    h.commands.ack('i1', { cmdId: h.lastCmd().cmdId, ok: false, error: 'boom' } as any)
    await assert.rejects(drain, (e: any) => e.code === 'COMMAND_FAILED')
    // The drain never took effect, so the instance stays a candidate.
    assert.equal(h.state.place({ type: 'match' }).instance.id, 'i1')
})
