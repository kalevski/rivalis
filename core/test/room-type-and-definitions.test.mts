import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Rivalis, Room, AuthMiddleware } from '../lib/main.js'

// Minimal auth middleware — never invoked, since these tests drive the
// RoomManager directly with no transport attached.
class TestAuth extends AuthMiddleware {
    async authenticate(): Promise<null> {
        return null
    }
}

// Concrete room — `Room` has no abstract members, every hook has a default.
class TestRoom extends Room {}

function makeRivalis(): Rivalis {
    return new Rivalis({
        transports: [],
        authMiddleware: new TestAuth()
    })
}

test('room.type returns the definition key for a room created via RoomManager.create', () => {
    const rivalis = makeRivalis()
    rivalis.rooms.define('match', TestRoom)

    const generated = rivalis.rooms.create('match')
    assert.equal(generated.type, 'match')

    const explicit = rivalis.rooms.create('match', 'match-42')
    assert.equal(explicit.type, 'match')
    assert.equal(explicit.id, 'match-42')
})

test('room.type is available for rooms created before an observer attaches', () => {
    const rivalis = makeRivalis()
    rivalis.rooms.define('lobby', TestRoom)

    // create first, then look at the instance later — type is stamped on the
    // instance at construction, not derived from any later event.
    rivalis.rooms.create('lobby', 'lobby-1')
    const room = rivalis.rooms.get('lobby-1')
    assert.notEqual(room, null)
    assert.equal(room?.type, 'lobby')
})

test('rooms.definitions() returns every defined key, including pre-existing ones', () => {
    const rivalis = makeRivalis()

    assert.deepEqual(rivalis.rooms.definitions(), [])

    rivalis.rooms.define('match', TestRoom)
    rivalis.rooms.define('lobby', TestRoom)

    const defs = rivalis.rooms.definitions()
    assert.deepEqual([...defs].sort(), ['lobby', 'match'])

    // returns a fresh array — mutating it must not corrupt internal state
    defs.push('bogus')
    assert.deepEqual([...rivalis.rooms.definitions()].sort(), ['lobby', 'match'])
})

test('create broadcast listener receives (roomId, roomType)', () => {
    const rivalis = makeRivalis()
    rivalis.rooms.define('match', TestRoom)

    const received: Array<[string, string]> = []
    rivalis.rooms.on('create', (roomId: string, roomType: string) => {
        received.push([roomId, roomType])
    })

    rivalis.rooms.create('match', 'match-7')
    assert.deepEqual(received, [['match-7', 'match']])
})
