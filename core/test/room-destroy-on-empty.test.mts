/**
 * Room.destroyOnEmpty lifecycle tests (task 037).
 *
 * Verifies the opt-in contract:
 *  - default off: a room is never auto-destroyed when it empties (manual lifecycle)
 *  - opt-in: after the last actor leaves, the room schedules its own destruction
 *    through RoomManager.destroy — deferred to a microtask, not synchronous
 *  - the join-before-teardown race: a new actor that joins before the scheduled
 *    teardown runs cancels the destruction; a later empty re-arms it
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

// Default behavior — destroyOnEmpty stays false.
class ManualRoom extends Room<null> {}

// Opt-in: destroy as soon as the last actor leaves.
class EphemeralRoom extends Room<null> {
    protected override destroyOnEmpty = true
}

// Drain the microtask queue so any scheduled teardown runs. The teardown
// microtask is queued before this continuation, so it executes first.
function flushMicrotasks(): Promise<void> {
    return Promise.resolve().then(() => undefined)
}

function setup(RoomClass: new (...args: any[]) => Room<null>, roomId = 'r1') {
    const rivalis = new Rivalis<null>({
        transports: [],
        authMiddleware: new AlwaysAuth(roomId),
    })
    rivalis.rooms.define('test', RoomClass)
    const room = rivalis.rooms.create('test', roomId)
    const tl: any = (rivalis as any)['transportLayer']
    return { rivalis, room, tl, roomId }
}

// ── default behavior (opt-out) ────────────────────────────────────────────────

test('default destroyOnEmpty=false: room survives after its last actor leaves', async () => {
    const { rivalis, room, roomId } = setup(ManualRoom)

    room.handleJoin('a')
    assert.equal(room.actorCount, 1)
    room.handleLeave('a')
    assert.equal(room.actorCount, 0)

    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), room, 'room must still be registered')
    assert.equal(rivalis.rooms.count, 1)
})

// ── opt-in auto-destroy ───────────────────────────────────────────────────────

test('destroyOnEmpty=true: room is destroyed once the last actor leaves', async () => {
    const { rivalis, room, roomId } = setup(EphemeralRoom)
    let destroyedId: string | null = null
    rivalis.rooms.on('destroy', (id: string) => { destroyedId = id })

    room.handleJoin('a')
    room.handleJoin('b')
    room.handleLeave('a')

    // Still has one actor — teardown must not be scheduled yet.
    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), room, 'room with a live actor must not be destroyed')

    room.handleLeave('b')
    // Teardown is deferred, not synchronous: the room is still present here.
    assert.strictEqual(rivalis.rooms.get(roomId), room, 'teardown must be deferred to a microtask')

    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), null, 'room must be destroyed after the last actor leaves')
    assert.equal(rivalis.rooms.count, 0)
    assert.equal(destroyedId, roomId, 'manager must emit destroy for the auto-destroyed room')
})

test('destroyOnEmpty auto-destroy fires on the real grantAccess/handleClose leave path', async () => {
    const { rivalis, tl, roomId } = setup(EphemeralRoom)

    const actorId: string = await tl.grantAccess('ticket')
    assert.strictEqual(rivalis.rooms.get(roomId)?.actorCount, 1)

    tl.handleClose(actorId)
    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), null, 'room destroyed after the connection closes')
})

// ── join-before-teardown race ─────────────────────────────────────────────────

test('join before teardown cancels the scheduled destruction', async () => {
    const { rivalis, room, roomId } = setup(EphemeralRoom)
    let destroyed = false
    rivalis.rooms.on('destroy', () => { destroyed = true })

    room.handleJoin('a')
    room.handleLeave('a')        // count → 0, teardown scheduled
    room.handleJoin('b')         // new actor wins the race before the microtask runs

    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), room, 'room must survive — a new actor joined before teardown')
    assert.equal(room.actorCount, 1)
    assert.equal(destroyed, false, 'no destroy must have been emitted')
})

test('teardown re-arms after a survived race, so a later empty still destroys', async () => {
    const { rivalis, room, roomId } = setup(EphemeralRoom)

    room.handleJoin('a')
    room.handleLeave('a')        // schedule
    room.handleJoin('b')         // cancel the race
    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), room, 'room survived the first race')

    room.handleLeave('b')        // empty again — must re-arm a fresh teardown
    await flushMicrotasks()
    assert.strictEqual(rivalis.rooms.get(roomId), null, 'room destroyed on the second empty')
})

test('a manual destroy() before the scheduled teardown does not double-destroy', async () => {
    const { rivalis, room, roomId } = setup(EphemeralRoom)
    let destroyCount = 0
    rivalis.rooms.on('destroy', () => { destroyCount++ })

    room.handleJoin('a')
    room.handleLeave('a')        // schedule teardown
    room.destroy()               // manual teardown happens first
    assert.strictEqual(rivalis.rooms.get(roomId), null)

    // The pending microtask must be a no-op (manager already null), not throw
    // or emit a second destroy.
    await flushMicrotasks()
    assert.equal(destroyCount, 1, 'destroy must fire exactly once')
})
