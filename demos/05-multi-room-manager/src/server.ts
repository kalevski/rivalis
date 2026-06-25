// Guided level 05 — RoomManager: create, route, list, dispose. Ticket format: "<name>|<room>"

import http from 'http'

import { Rivalis, Room, AuthMiddleware, RoomManager } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

const PORT = 3104
const SERVER_URL = `ws://localhost:${PORT}`

const ROOM_TYPE = 'echo'

const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/

type ActorData = { name: string }

// EchoRoom cannot receive the RoomManager via its (framework-fixed) constructor,
// so we wire the reference once at boot and share it through these accessors.
let _rooms: RoomManager<ActorData> | null = null

const setRooms = (rm: RoomManager<ActorData>): void => { _rooms = rm }

const getRooms = (): RoomManager<ActorData> => {
    if (_rooms === null) throw new Error('rooms not initialised — call setRooms() at boot')
    return _rooms
}

class EchoRoom extends Room<ActorData> {

    protected override presence = true

    protected override onCreate(): void {
        this.bind('echo', this.onEcho)
        console.log(`[room:${this.id}] created  type="${this.type}"`)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[room:${this.id}] JOIN  name="${name}"  occupants=${this.actorCount}`)
        actor.send('welcome', `joined room "${this.id}" — ${this.actorCount} here`)
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[room:${this.id}] LEAVE  name="${name}"  remaining=${this.actorCount}`)

        // actorCount already excludes the leaving actor, so 0 means the room is empty.
        if (this.actorCount === 0) {
            getRooms().destroy(this.id)
        }
    }

    protected override onDestroy(): void {
        console.log(`[room:${this.id}] destroyed`)
    }

    private onEcho(actor: Actor<ActorData>, payload: Uint8Array): void {
        const text = new TextDecoder().decode(payload).trim().slice(0, 500)
        if (!text) return
        const name = actor.data?.name ?? actor.id
        actor.send('echo', `[${this.id}] ${name}: ${text}`)
    }

}

// Room creation happens here because auth runs before the actor is routed in.
class RoomAuth extends AuthMiddleware<ActorData> {

    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const sep = ticket.indexOf('|')
        if (sep === -1) return null
        const name = ticket.slice(0, sep).trim()
        const roomId = ticket.slice(sep + 1).trim()
        if (!NAME_RE.test(name) || !ROOM_RE.test(roomId)) return null

        const rm = getRooms()
        if (rm.get(roomId) === null) {
            rm.create(ROOM_TYPE, roomId)
        }

        return {
            data: { name },
            roomId,
        }
    }

}

async function main(): Promise<void> {
    const server = http.createServer()

    const rivalis = new Rivalis<ActorData>({
        transports: [new WSTransport({ server })],
        authMiddleware: new RoomAuth(),
        rateLimiter: null,
    })

    rivalis.logging.level = 'warn'

    rivalis.rooms.define(ROOM_TYPE, EchoRoom)

    rivalis.rooms.on('create', (roomId: string, roomType: string) => {
        const active = [...rivalis.rooms.keys()]
        console.log(
            `[manager] CREATED  id="${roomId}"  type="${roomType}"` +
            `  total=${rivalis.rooms.count}  active=[${active.join(', ')}]`
        )
    })

    rivalis.rooms.on('destroy', (roomId: string) => {
        const active = [...rivalis.rooms.keys()]
        console.log(
            `[manager] DESTROYED  id="${roomId}"` +
            `  total=${rivalis.rooms.count}  active=[${active.join(', ')}]`
        )
    })

    setRooms(rivalis.rooms)

    await new Promise<void>(resolve => server.listen(PORT, resolve))

    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)`)
    console.log('[server] no rooms exist yet — they are created on first join')
    console.log('[server] ---')
    console.log('[server] connect clients in separate terminals:')
    console.log('[server]   npm run client -w @rivalis/guided-05-multi-room-manager -- Alice lobby')
    console.log('[server]   npm run client -w @rivalis/guided-05-multi-room-manager -- Bob   arena')
    console.log('[server]   npm run client -w @rivalis/guided-05-multi-room-manager -- Carol lobby')
    console.log('[server] When the last actor in a room leaves the room is auto-disposed.')

    process.on('SIGINT', async () => {
        console.log('\n[server] shutting down...')
        await rivalis.shutdown()
        server.close(() => process.exit(0))
    })
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
