import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rivalis, Room, Actor, AuthMiddleware } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'

// Expose getActor as public so the test can call it directly.
class ObservableRoom extends Room<null> {
    public lookup(id: string): Actor<null> | null {
        return this.getActor(id)
    }
}

class StaticAuth extends AuthMiddleware<null> {
    constructor(private readonly result: AuthResult<null>) { super() }
    async authenticate(): Promise<AuthResult<null> | null> {
        return this.result
    }
}

function setup() {
    const rivalis = new Rivalis<null>({
        transports: [],
        authMiddleware: new StaticAuth({ data: null, roomId: 'room-1' })
    })
    rivalis.rooms.define('test', ObservableRoom)
    const room = rivalis.rooms.create('test', 'room-1') as ObservableRoom
    const tl: any = (rivalis as any)['transportLayer']
    return { room, tl }
}

test('getActor returns null when no actor with that id is in the room', () => {
    const { room } = setup()
    assert.strictEqual(room.lookup('nonexistent'), null)
})

test('getActor returns the actor after it joins the room', async () => {
    const { room, tl } = setup()
    const actorId: string = await tl.grantAccess('ticket')
    const actor = room.lookup(actorId)
    assert.ok(actor !== null, 'actor should be found after join')
    assert.equal(actor.id, actorId)
})

test('getActor returns null for an actor that has left', async () => {
    const { room, tl } = setup()
    const actorId: string = await tl.grantAccess('ticket')
    assert.ok(room.lookup(actorId) !== null, 'actor present before leave')
    tl.handleClose(actorId)
    assert.strictEqual(room.lookup(actorId), null)
})

test('getActor does not affect actorCount or each iteration', async () => {
    const { room, tl } = setup()
    const id1: string = await tl.grantAccess('ticket')
    const id2: string = await tl.grantAccess('ticket')

    // getActor side-effect free — count and each are unaffected
    room.lookup(id1)
    room.lookup('bogus')

    assert.equal(room.actorCount, 2)
    const seen: string[] = []
    room.each(a => seen.push(a.id))
    assert.deepEqual([...seen].sort(), [id1, id2].sort())
})
