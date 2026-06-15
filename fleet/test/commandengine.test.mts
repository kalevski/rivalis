import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CommandEngine } from '../lib/CommandEngine.js'
import { MAX_INFLIGHT_COMMANDS, Topics } from '../lib/wire.js'

// ---------------------------------------------------------------------------
// Direct unit tests for the command engine (task 008 decomposition). The engine
// runs against an AgentLink seam, a virtual-time scheduler and a fake reservation
// releaser — no Orchestrator, no WebSocket (§15).
// ---------------------------------------------------------------------------

/** Virtual-time scheduler: timers fire deterministically as `advance` crosses them. */
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
        },
        pending: () => timers.size
    }
}

/** Fake reservation releaser recording every release/hold for leak + lifecycle assertions. */
function makeReleaser() {
    const released: unknown[] = []
    const releasedIds: unknown[] = []
    const held: Array<{ roomId: unknown; reservation: unknown }> = []
    return {
        released,
        releasedIds,
        held,
        release: (r: unknown) => { released.push(r) },
        releaseRoomId: (r: unknown) => { releasedIds.push(r) },
        // task 003: ack-OK / timeout hold the create's reservations until the room is
        // visible, rather than releasing them on settle.
        holdUntilVisible: (roomId: unknown, reservation: unknown) => { held.push({ roomId, reservation }) }
    }
}

/** A fake agent link recording every outbound frame. */
function makeLink(instanceId = 'i1') {
    const sent: Array<{ topic: string; payload: any }> = []
    return {
        link: { instanceId, send: (topic: string, payload: unknown) => sent.push({ topic, payload }), close: () => {} },
        sent,
        cmds: () => sent.filter((m) => m.topic === Topics.cmd)
    }
}

const cmd = (cmdId: string, over: any = {}) => ({ cmdId, op: over.op ?? 'create', roomId: over.roomId, roomType: over.roomType })

test('nextCmdId is monotonic', () => {
    const engine = new CommandEngine(makeClock().scheduler as any, makeReleaser() as any, 10000)
    assert.equal(engine.nextCmdId(), 'cmd_1')
    assert.equal(engine.nextCmdId(), 'cmd_2')
    assert.equal(engine.nextCmdId(), 'cmd_3')
})

test('send pushes fleet/cmd and resolves on a matching ok ack', async () => {
    const clock = makeClock()
    const engine = new CommandEngine(clock.scheduler as any, makeReleaser() as any, 10000)
    const agent = makeLink()

    const pending = engine.send(agent.link, cmd('cmd_1'))
    assert.equal(agent.cmds().length, 1, 'cmd hit the wire')
    assert.equal(engine.inFlight('i1'), 1)

    const settled = engine.ack('i1', { cmdId: 'cmd_1', ok: true, room: { id: 'r', type: 'match' } } as any)
    assert.equal(settled, true, 'ack settled a pending command')
    const ack = await pending
    assert.equal(ack.ok, true)
    assert.equal(engine.inFlight('i1'), 0, 'pending cleared after settle')
})

test('an ok:false ack rejects with COMMAND_FAILED carrying the agent error', async () => {
    const engine = new CommandEngine(makeClock().scheduler as any, makeReleaser() as any, 10000)
    const agent = makeLink()
    const pending = engine.send(agent.link, cmd('cmd_1'))
    engine.ack('i1', { cmdId: 'cmd_1', ok: false, error: 'boom' } as any)
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_FAILED' && /boom/.test(e.message))
})

test('a command times out with COMMAND_TIMEOUT after commandTimeoutMs', async () => {
    const clock = makeClock()
    const engine = new CommandEngine(clock.scheduler as any, makeReleaser() as any, 10000)
    const agent = makeLink()
    const pending = engine.send(agent.link, cmd('cmd_1'))
    clock.advance(10000)
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_TIMEOUT')
    assert.equal(engine.inFlight('i1'), 0, 'timed-out command no longer in flight')
    assert.equal(clock.pending(), 0, 'the timeout timer was cleared on settle')
})

test('the in-flight cap is enforced and the rejected command releases its reservations', async () => {
    const releaser = makeReleaser()
    const engine = new CommandEngine(makeClock().scheduler as any, releaser as any, 10000)
    const agent = makeLink()

    const inflight: Array<Promise<unknown>> = []
    for (let i = 0; i < MAX_INFLIGHT_COMMANDS; i++) {
        inflight.push(engine.send(agent.link, cmd(`cmd_${i}`)).catch(() => {}))
    }
    assert.equal(agent.cmds().length, MAX_INFLIGHT_COMMANDS, 'all 32 commands were pushed')

    const reservation = { kind: 'cap' }
    const roomIdReservation = { kind: 'id' }
    await assert.rejects(
        engine.send(agent.link, cmd('cmd_over'), reservation as any, roomIdReservation as any),
        (e: any) => e.code === 'INSTANCE_BUSY'
    )
    assert.equal(agent.cmds().length, MAX_INFLIGHT_COMMANDS, 'the busy-rejected command never hit the wire')
    assert.deepEqual(releaser.released, [reservation], 'capacity reservation released on INSTANCE_BUSY (no leak)')
    assert.deepEqual(releaser.releasedIds, [roomIdReservation], 'room-id reservation released on INSTANCE_BUSY (no leak)')
    void inflight
})

test('an ok ack HOLDS the create reservations until the room is visible, never releasing them (task 003)', async () => {
    const releaser = makeReleaser()
    const engine = new CommandEngine(makeClock().scheduler as any, releaser as any, 10000)
    const agent = makeLink()
    const reservation = { kind: 'cap' }
    const roomIdReservation = { kind: 'id' }

    const pending = engine.send(agent.link, cmd('cmd_1'), reservation as any, roomIdReservation as any)
    engine.ack('i1', { cmdId: 'cmd_1', ok: true } as any)
    await pending
    // The id stays reserved past the ack (held until the next snapshot reconciles it),
    // so neither reservation is released here — releasing would reopen the §11 window.
    assert.deepEqual(releaser.held, [{ roomId: roomIdReservation, reservation }], 'both reservations held until visible')
    assert.deepEqual(releaser.released, [], 'capacity reservation NOT released on ack')
    assert.deepEqual(releaser.releasedIds, [], 'room-id reservation NOT released on ack')
    assert.equal(engine.inFlight('i1'), 0, 'pending cleared after settle')
})

test('a timeout HOLDS the create reservations (a late ack may mean the room was created — §10/task 003)', async () => {
    const releaser = makeReleaser()
    const clock = makeClock()
    const engine = new CommandEngine(clock.scheduler as any, releaser as any, 10000)
    const agent = makeLink()
    const reservation = { kind: 'cap' }
    const roomIdReservation = { kind: 'id' }

    const pending = engine.send(agent.link, cmd('cmd_1'), reservation as any, roomIdReservation as any)
    clock.advance(10000)
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_TIMEOUT')
    assert.deepEqual(releaser.held, [{ roomId: roomIdReservation, reservation }], 'timeout holds, does not release')
    assert.deepEqual(releaser.released, [])
    assert.deepEqual(releaser.releasedIds, [])
})

test('an ok:false ack RELEASES the create reservations immediately (no room created)', async () => {
    const releaser = makeReleaser()
    const engine = new CommandEngine(makeClock().scheduler as any, releaser as any, 10000)
    const agent = makeLink()
    const reservation = { kind: 'cap' }
    const roomIdReservation = { kind: 'id' }

    const pending = engine.send(agent.link, cmd('cmd_1'), reservation as any, roomIdReservation as any)
    engine.ack('i1', { cmdId: 'cmd_1', ok: false, error: 'boom' } as any)
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_FAILED')
    assert.deepEqual(releaser.held, [], 'a failed create is not held — the id never existed')
    assert.deepEqual(releaser.released, [reservation])
    assert.deepEqual(releaser.releasedIds, [roomIdReservation])
})

test('an ok:false ack with exists:true maps to ROOM_EXISTS, not COMMAND_FAILED (task 003 defense in depth)', async () => {
    const releaser = makeReleaser()
    const engine = new CommandEngine(makeClock().scheduler as any, releaser as any, 10000)
    const agent = makeLink()
    const pending = engine.send(agent.link, cmd('cmd_1'), { kind: 'cap' } as any, { kind: 'id' } as any)
    engine.ack('i1', { cmdId: 'cmd_1', ok: false, exists: true, error: 'room id already exists' } as any)
    await assert.rejects(pending, (e: any) => e.code === 'ROOM_EXISTS')
    // Still released (the existing room — not this command — holds the id).
    assert.equal(releaser.released.length, 1)
    assert.equal(releaser.releasedIds.length, 1)
    assert.deepEqual(releaser.held, [])
})

test('rejectAll rejects every in-flight command with INSTANCE_DISCONNECTED and releases reservations', async () => {
    const releaser = makeReleaser()
    const engine = new CommandEngine(makeClock().scheduler as any, releaser as any, 10000)
    const agent = makeLink()
    const r1 = { id: 1 }
    const r2 = { id: 2 }
    const p1 = engine.send(agent.link, cmd('cmd_1'), r1 as any)
    const p2 = engine.send(agent.link, cmd('cmd_2'), r2 as any)

    engine.rejectAll('i1', 'socket close')

    await assert.rejects(p1, (e: any) => e.code === 'INSTANCE_DISCONNECTED' && /socket close/.test(e.message))
    await assert.rejects(p2, (e: any) => e.code === 'INSTANCE_DISCONNECTED')
    assert.equal(engine.inFlight('i1'), 0, 'no pending left after rejectAll')
    assert.equal(releaser.released.length, 2, 'both reservations released')
})

test('a synchronous link.send failure settles the command immediately: reservations released, in-flight back to 0 (task 005)', async () => {
    const releaser = makeReleaser()
    const clock = makeClock()
    const engine = new CommandEngine(clock.scheduler as any, releaser as any, 10000)
    const reservation = { kind: 'cap' }
    const roomIdReservation = { kind: 'id' }
    // A link whose send throws synchronously — e.g. core Room.send against a
    // half-closed actor, or an encode error (task 005). The pending entry is already
    // inserted when this fires, so a naive engine would leak its slot + reservations
    // until commandTimeoutMs.
    const throwingLink = {
        instanceId: 'i1',
        send: () => { throw new Error('core Room.send: invalid payload') },
        close: () => {}
    }

    const pending = engine.send(throwingLink as any, cmd('cmd_1'), reservation as any, roomIdReservation as any)
    await assert.rejects(pending, (e: any) => e.code === 'INSTANCE_DISCONNECTED' && /failed to send command cmd_1/.test(e.message))
    assert.equal(engine.inFlight('i1'), 0, 'the send-failed command holds no in-flight slot')
    assert.equal(clock.pending(), 0, 'the timeout timer was cleared on the immediate settle (no leak until commandTimeoutMs)')
    assert.deepEqual(releaser.released, [reservation], 'capacity reservation released (no leak)')
    assert.deepEqual(releaser.releasedIds, [roomIdReservation], 'room-id reservation released (no leak)')
    assert.deepEqual(releaser.held, [], 'a never-sent create is not held — the room was never created')
})

test('a late ack after settle returns false — no double-resolve', async () => {
    const clock = makeClock()
    const engine = new CommandEngine(clock.scheduler as any, makeReleaser() as any, 10000)
    const agent = makeLink()
    const pending = engine.send(agent.link, cmd('cmd_1'))
    clock.advance(10000)
    await assert.rejects(pending, (e: any) => e.code === 'COMMAND_TIMEOUT')

    // The originating promise already settled; a late ack must be inert.
    assert.equal(engine.ack('i1', { cmdId: 'cmd_1', ok: true } as any), false)
    assert.equal(engine.ack('i1', { cmdId: 'unknown', ok: true } as any), false)
})
