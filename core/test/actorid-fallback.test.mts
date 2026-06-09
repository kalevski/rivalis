import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rivalis, Room, AuthMiddleware } from '../lib/main.js'
import type { AuthResult } from '../lib/main.js'

class TestRoom extends Room<null> {
    readonly joinedIds: string[] = []
    protected override onJoin(actor: any): void {
        this.joinedIds.push(actor.id)
    }
}

class StaticAuth extends AuthMiddleware<null> {
    constructor(private result: AuthResult<null>) { super() }
    async authenticate(): Promise<AuthResult<null> | null> {
        return this.result
    }
}

function setup(authResult: AuthResult<null>) {
    const rivalis = new Rivalis<null>({
        transports: [],
        authMiddleware: new StaticAuth(authResult)
    })
    rivalis.rooms.define('test', TestRoom)
    const room = rivalis.rooms.create('test', 'room-1') as TestRoom
    // Access TLayer via the private field — acceptable in a unit test
    const tl: any = (rivalis as any)['transportLayer']
    return { room, tl }
}

test('a requested unique actorId is honored', async () => {
    const { room, tl } = setup({ data: null, roomId: 'room-1', actorId: 'stable-id-1' })
    const id: string = await tl.grantAccess('ticket')
    assert.equal(id, 'stable-id-1')
    assert.deepEqual(room.joinedIds, ['stable-id-1'])
})

test('a taken actorId falls back to CSPRNG allocation', async () => {
    const { room, tl } = setup({ data: null, roomId: 'room-1', actorId: 'stable-id-1' })
    const first: string = await tl.grantAccess('ticket')
    assert.equal(first, 'stable-id-1')
    // Second call: same actorId is now taken — must not collide
    const second: string = await tl.grantAccess('ticket')
    assert.notEqual(second, 'stable-id-1')
    assert.equal(typeof second, 'string')
    assert.ok(second.length > 0)
    assert.deepEqual(room.joinedIds, ['stable-id-1', second])
})

test('absent actorId falls back to CSPRNG allocation', async () => {
    const { room, tl } = setup({ data: null, roomId: 'room-1' })
    const id: string = await tl.grantAccess('ticket')
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
    assert.deepEqual(room.joinedIds, [id])
})

test('empty-string actorId falls back to CSPRNG allocation', async () => {
    const { room, tl } = setup({ data: null, roomId: 'room-1', actorId: '' })
    const id: string = await tl.grantAccess('ticket')
    assert.notEqual(id, '')
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
    assert.deepEqual(room.joinedIds, [id])
})
