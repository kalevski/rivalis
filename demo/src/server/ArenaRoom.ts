import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    ARENA_WIDTH,
    ARENA_HEIGHT,
    ARENA_PLAYER_RADIUS,
    ARENA_TICK_HZ,
    type ArenaInput,
    type ArenaPlayerState,
    type ArenaState
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

const SPEED = 220 // px/sec

const TICK_MS = Math.round(1000 / ARENA_TICK_HZ)

const MIN_X = ARENA_PLAYER_RADIUS
const MAX_X = ARENA_WIDTH - ARENA_PLAYER_RADIUS
const MIN_Y = ARENA_PLAYER_RADIUS
const MAX_Y = ARENA_HEIGHT - ARENA_PLAYER_RADIUS

const NEUTRAL_INPUT: Readonly<ArenaInput> = Object.freeze({
    up: false, down: false, left: false, right: false
})

/**
 * Top-down 2D playfield. Each connected actor is a circle the server
 * moves at a fixed velocity in response to per-actor input flags.
 *
 * Demonstrates the "high-frequency authoritative state" pattern that
 * `LobbyRoom` and `CounterRoom` deliberately don't exercise:
 *   - Server owns the simulation; clients send *intent* (input flags),
 *     not positions.
 *   - Server broadcasts state at `ARENA_TICK_HZ`; clients render from
 *     the broadcast.
 *   - Clients send input frames only on key state CHANGES, so the
 *     inbound rate stays well under the default 30 fps token bucket
 *     even with multiple players holding multiple keys.
 */
class ArenaRoom extends Room<ActorData> {

    private positions: Map<string, { x: number; y: number }> = new Map()

    private inputs: Map<string, ArenaInput> = new Map()

    private tickHandle: NodeJS.Timeout | null = null

    private lastTickAt: number = 0

    protected override onCreate(): void {
        this.bind('input', this.onInput)
        this.lastTickAt = Date.now()
        this.tickHandle = setInterval(() => this.tick(), TICK_MS)
        this.tickHandle.unref?.()
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        // Spawn at a random point inside the play area, well away from
        // the walls so the player is immediately visible.
        const x = MIN_X + Math.random() * (MAX_X - MIN_X)
        const y = MIN_Y + Math.random() * (MAX_Y - MIN_Y)
        this.positions.set(actor.id, { x, y })
        this.inputs.set(actor.id, { ...NEUTRAL_INPUT })
        // Send the joiner the full snapshot immediately so they don't
        // have to wait for the next tick to see other players.
        this.broadcastSnapshot()
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        this.positions.delete(actor.id)
        this.inputs.delete(actor.id)
    }

    protected override onDestroy(): void {
        if (this.tickHandle !== null) {
            clearInterval(this.tickHandle)
            this.tickHandle = null
        }
        this.positions.clear()
        this.inputs.clear()
    }

    private onInput(actor: Actor<ActorData>, payload: Uint8Array): void {
        try {
            const raw = decode<Partial<ArenaInput>>(payload)
            this.inputs.set(actor.id, {
                up: raw.up === true,
                down: raw.down === true,
                left: raw.left === true,
                right: raw.right === true
            })
        } catch {
            // Bad JSON — ignore the frame; the client will resend on the
            // next key change. No reason to disconnect for one stutter.
        }
    }

    private tick(): void {
        const now = Date.now()
        const dt = Math.max(0, (now - this.lastTickAt) / 1000)
        this.lastTickAt = now
        if (dt <= 0) return

        for (const [id, pos] of this.positions) {
            const input = this.inputs.get(id) ?? NEUTRAL_INPUT
            const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0)
            const dy = (input.down ? 1 : 0) - (input.up ? 1 : 0)
            if (dx === 0 && dy === 0) continue
            const len = Math.hypot(dx, dy) || 1
            pos.x = clamp(pos.x + (dx / len) * SPEED * dt, MIN_X, MAX_X)
            pos.y = clamp(pos.y + (dy / len) * SPEED * dt, MIN_Y, MAX_Y)
        }

        this.broadcastSnapshot()
    }

    /**
     * Build a single players[] snapshot from the live actor map and
     * send each actor a state frame stamped with their own id.
     */
    private broadcastSnapshot(): void {
        const players: ArenaPlayerState[] = []
        this.each((actor) => {
            const pos = this.positions.get(actor.id)
            if (pos === undefined) return
            const data = actor.data as ActorData
            players.push({
                id: actor.id,
                x: pos.x,
                y: pos.y,
                name: data.name,
                color: data.color
            })
        })
        this.each((actor) => {
            const state: ArenaState = { youId: actor.id, players }
            actor.send('arena:state', encode(state))
        })
    }
}

const clamp = (v: number, lo: number, hi: number): number => {
    if (v < lo) return lo
    if (v > hi) return hi
    return v
}

export default ArenaRoom
