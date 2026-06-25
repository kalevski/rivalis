import http from 'http'

import { Rivalis, Room, AuthMiddleware } from '@rivalis/core'
import type { Actor, AuthResult } from '@rivalis/core'
import { WSTransport } from '@rivalis/node'

const PORT = 3103
const ROOM_ID = 'state-room'
const SERVER_URL = `ws://localhost:${PORT}`
const TICK_RATE_MS = 1_000

type ActorData = { name: string }

type SnapshotFrame = {
    tick: number
    counter: number
    lastMutatedBy: string | null
}

type IncrementInput = { amount: number }

// Any non-empty ticket is accepted and used as both display name and actor ID.
class NameAuth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name) {
            return null
        }
        return {
            data: { name },
            roomId: ROOM_ID,
            actorId: name,
        }
    }
}

type SharedState = {
    tick: number
    counter: number
    lastMutatedBy: string | null
}

class StateRoom extends Room<ActorData> {

    // Server-authoritative state — only this Room reads or writes it.
    private state: SharedState = { tick: 0, counter: 0, lastMutatedBy: null }

    private tickTimer: NodeJS.Timeout | null = null

    protected override onCreate(): void {
        this.bind('increment', this.onIncrement)
        this.bind('reset', this.onReset)

        // The tick loop runs regardless of actor presence; actors observe it.
        this.tickTimer = setInterval(() => this.onTick(), TICK_RATE_MS)
        console.log(`[room] created  tick=${TICK_RATE_MS}ms`)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(
            `[room] JOIN  name="${name}"` +
            `  tick=${this.state.tick}  counter=${this.state.counter}` +
            `  total=${this.actorCount}`
        )
        // Late-join snapshot: new actor is in sync without waiting for the next tick.
        actor.send('snapshot', JSON.stringify(this.buildSnapshot()))
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        const name = actor.data?.name ?? actor.id
        console.log(`[room] LEAVE  name="${name}"  remaining=${this.actorCount}`)
    }

    protected override onDestroy(): void {
        if (this.tickTimer !== null) {
            clearInterval(this.tickTimer)
            this.tickTimer = null
        }
        console.log('[room] destroyed — tick loop stopped')
    }

    private onTick(): void {
        this.state.tick += 1
        const snap = this.buildSnapshot()

        console.log(
            `[tick] #${String(this.state.tick).padStart(4, '0')}` +
            `  counter=${this.state.counter}` +
            `  lastMutatedBy=${this.state.lastMutatedBy ?? '(none)'}` +
            `  actors=${this.actorCount}`
        )

        if (this.actorCount > 0) {
            this.broadcast('snapshot', JSON.stringify(snap))
        }
    }

    private onIncrement(actor: Actor<ActorData>, payload: Uint8Array): void {
        const { amount } = JSON.parse(new TextDecoder().decode(payload)) as IncrementInput
        // Clamp the client-supplied amount so a single frame can't make a huge jump.
        const clamped = Math.max(-100, Math.min(100, Math.round(amount)))
        const name = actor.data?.name ?? actor.id

        this.state.counter += clamped
        this.state.lastMutatedBy = name

        console.log(
            `[room] INCREMENT  from="${name}"` +
            `  amount=${clamped >= 0 ? '+' : ''}${clamped}` +
            `  counter=${this.state.counter}`
        )
    }

    private onReset(actor: Actor<ActorData>, _payload: Uint8Array): void {
        const name = actor.data?.name ?? actor.id
        const before = this.state.counter

        this.state.counter = 0
        this.state.lastMutatedBy = name

        console.log(`[room] RESET  from="${name}"  before=${before}  after=0`)
    }

    private buildSnapshot(): SnapshotFrame {
        return {
            tick: this.state.tick,
            counter: this.state.counter,
            lastMutatedBy: this.state.lastMutatedBy,
        }
    }

}

async function main(): Promise<void> {
    const server = http.createServer()

    // rateLimiter: null opts out of the default limiter so rapid testing isn't throttled.
    const rivalis = new Rivalis<ActorData>({
        transports: [new WSTransport({ server })],
        authMiddleware: new NameAuth(),
        rateLimiter: null,
    })

    rivalis.logging.level = 'warning'

    rivalis.rooms.define(ROOM_ID, StateRoom)
    rivalis.rooms.create(ROOM_ID, ROOM_ID)

    await new Promise<void>(resolve => server.listen(PORT, resolve))

    console.log(`[server] listening on ${SERVER_URL}  (Ctrl-C to stop)`)
    console.log(`[server] room "${ROOM_ID}" ready  tickRate=${TICK_RATE_MS}ms`)
    console.log('[server] ---')
    console.log('[server] run clients in separate terminals:')
    console.log('[server]   npm run client:watch  -w @rivalis/guided-04-shared-state-tlayer')
    console.log('[server]   npm run client:mutate -w @rivalis/guided-04-shared-state-tlayer')
    console.log('[server]   or supply a custom name / mode:')
    console.log('[server]   ts-node src/client.ts Alice watch')
    console.log('[server]   ts-node src/client.ts Bob   mutate')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
