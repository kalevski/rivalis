import http from 'http'

import { Rivalis, Room, AuthMiddleware } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

const PORT      = 3101
const ROOM_ID   = 'lobby'
const SERVER_URL = `ws://localhost:${PORT}`

type ActorData = { name: string }

type ChatFrame = { from: string; text: string }
type DmRequest = { to: string; text: string }
type DmFrame = { from: string; text: string }
type NoticeFrame = { type: 'join' | 'leave'; id: string; name: string }
type RosterFrame = { you: string; peers: Array<{ id: string; name: string }> }

class BroadcastAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name) {
            return null
        }
        return {
            data: { name },
            roomId: ROOM_ID,
            actorId: name,  // requested id is only honored when not already taken
        }
    }
}

class BroadcastRoom extends Room<ActorData> {

    protected override onCreate(): void {
        this.bind('chat', this.onChat)
        this.bind('dm',   this.onDm)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const { id } = actor
        const name   = actor.data?.name ?? id

        console.log(`[server] JOIN   ${name}  (id=${id})  total=${this.actorCount}`)

        // Direct send: the roster goes only to the joining actor.
        const peers: RosterFrame['peers'] = []
        this.each(a => {
            if (a.id !== id) {
                peers.push({ id: a.id, name: a.data?.name ?? a.id })
            }
        })
        actor.send('roster', JSON.stringify({ you: id, peers } as RosterFrame))
        console.log(`[server] ROSTER → ${name}  peers=[${peers.map(p => p.name).join(', ') || '(none)'}]`)

        // Broadcast reaches every actor, including the one that just joined.
        this.broadcast('notice', JSON.stringify({ type: 'join', id, name } as NoticeFrame))
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const { id } = actor
        const name   = actor.data?.name ?? id

        console.log(`[server] LEAVE  ${name}  (id=${id})  remaining=${this.actorCount}`)

        this.broadcast('notice', JSON.stringify({ type: 'leave', id, name } as NoticeFrame))
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array): void {
        const { text } = JSON.parse(new TextDecoder().decode(payload)) as { text: string }
        const from      = actor.data?.name ?? actor.id

        console.log(`[server] CHAT   <${from}>: ${text}`)

        this.broadcast('chat', JSON.stringify({ from, text } as ChatFrame))
    }

    private onDm(sender: Actor<ActorData>, payload: Uint8Array): void {
        const { to, text } = JSON.parse(new TextDecoder().decode(payload)) as DmRequest
        const from          = sender.data?.name ?? sender.id

        // getActor returns null when no such actor is currently in the room.
        const target = this.getActor(to)
        if (target === null) {
            console.log(`[server] DM     from=${from} to=${to} — target not found, dropping`)
            return
        }

        const targetName = target.data?.name ?? target.id
        console.log(`[server] DM     <${from}> → <${targetName}>: ${text}`)

        target.send('dm', JSON.stringify({ from, text } as DmFrame))
    }

}

async function main(): Promise<void> {
    const server  = http.createServer()
    const rivalis = new Rivalis({
        transports:     [new WSTransport({ server })],
        authMiddleware: new BroadcastAuth(),
    })

    rivalis.logging.level = 'warning'

    rivalis.rooms.define(ROOM_ID, BroadcastRoom)
    rivalis.rooms.create(ROOM_ID, ROOM_ID)
    console.log(`[server] room "${ROOM_ID}" ready`)

    await new Promise<void>(resolve => server.listen(PORT, resolve))
    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)\n`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
