import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    isWall,
    pelletIndex,
    pelletPoints,
    allPelletIndices,
    DIR_VECTORS,
    COLS,
    ROWS,
    TICK_HZ,
    DEATH_PENALTY,
    type Dir,
    type InputCommand,
    type GameState,
    type PlayerState,
    type GhostState,
    type WelcomeEvent,
    type PelletEvent,
    type DeathEvent
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

const TICK_MS = Math.round(1000 / TICK_HZ)

const PAC_SPEED = 6.0 // tiles / second
const GHOST_SPEED = 4.8 // tiles / second — slower so players can escape

const CATCH_DISTANCE = 0.5 // tiles; proximity that counts as a catch
const NODE_EPS = 1e-6

const PLAYER_SPAWNS: ReadonlyArray<{ x: number; y: number }> = [
    { x: 9, y: 17 }, { x: 5, y: 17 }, { x: 13, y: 17 },
    { x: 7, y: 17 }, { x: 11, y: 17 }, { x: 3, y: 17 },
    { x: 15, y: 17 }, { x: 1, y: 17 }, { x: 17, y: 17 }
]

const GHOST_DEFS: ReadonlyArray<{ color: string; x: number; y: number }> = [
    { color: '#ff0000', x: 9, y: 9 },
    { color: '#ffb8ff', x: 7, y: 9 },
    { color: '#00ffff', x: 11, y: 9 },
    { color: '#ffb852', x: 13, y: 9 }
]

const ALL_DIRS: Dir[] = ['up', 'down', 'left', 'right']

const REVERSE: Record<Dir, Dir> = {
    up: 'down', down: 'up', left: 'right', right: 'left', none: 'none'
}

type Entity = {
    x: number
    y: number
    dir: Dir
    speed: number
}

type Pac = Entity & {
    want: Dir
    score: number
    spawnIndex: number
}

type Ghost = Entity & {
    id: number
    color: string
}

// The authoritative simulation: the server owns the board, players, and ghosts, and broadcasts a snapshot each tick.
class PacmanRoom extends Room<ActorData> {

    private pacs: Map<string, Pac> = new Map()

    // ghosts / pellets / tickHandle / lastTickAt have no initialisers: onCreate
    // runs inside the base Room constructor, before field initialisers would, so
    // an initialiser here would clobber what onCreate set.
    private ghosts!: Ghost[]

    private pellets!: Set<number>

    private spawnCursor = 0

    private tickHandle!: NodeJS.Timeout | null

    private lastTickAt!: number

    protected override onCreate(): void {
        this.bind('input', this.onInput)
        this.ghosts = []
        this.resetPellets()
        for (const def of GHOST_DEFS) {
            this.ghosts.push({
                id: this.ghosts.length,
                color: def.color,
                x: def.x,
                y: def.y,
                dir: 'none',
                speed: GHOST_SPEED
            })
        }
        this.lastTickAt = Date.now()
        this.tickHandle = setInterval(() => this.tick(), TICK_MS)
        this.tickHandle.unref?.()
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const spawn = PLAYER_SPAWNS[this.spawnCursor % PLAYER_SPAWNS.length]!
        this.spawnCursor += 1
        this.pacs.set(actor.id, {
            x: spawn.x,
            y: spawn.y,
            dir: 'none',
            want: 'none',
            speed: PAC_SPEED,
            score: 0,
            spawnIndex: (this.spawnCursor - 1) % PLAYER_SPAWNS.length
        })

        // Tell the joiner its id and which pellets are already gone, so it can reconcile its board.
        const eaten = this.eatenIndices()
        const welcome: WelcomeEvent = { youId: actor.id, eaten }
        actor.send('welcome', encode(welcome))

        this.broadcastState()
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        this.pacs.delete(actor.id)
    }

    protected override onDestroy(): void {
        if (this.tickHandle !== null) {
            clearInterval(this.tickHandle)
            this.tickHandle = null
        }
        this.pacs.clear()
        this.ghosts = []
        this.pellets.clear()
    }

    private onInput(actor: Actor<ActorData>, payload: Uint8Array): void {
        const pac = this.pacs.get(actor.id)
        if (pac === undefined) return
        try {
            const cmd = decode<InputCommand>(payload)
            if (cmd.dir in DIR_VECTORS) {
                pac.want = cmd.dir
            }
        } catch {
            // Malformed frame — ignore; the client resends on the next change.
        }
    }

    private tick(): void {
        const now = Date.now()
        const dt = Math.max(0, (now - this.lastTickAt) / 1000)
        this.lastTickAt = now
        if (dt <= 0) return
        // Clamp dt so a long pause can't hurl entities across the board in one step.
        const step = Math.min(dt, 0.1)

        for (const [id, pac] of this.pacs) {
            this.movePac(id, pac, step)
        }
        for (const ghost of this.ghosts) {
            this.moveGhost(ghost, step)
        }
        this.resolveCollisions()

        if (this.pellets.size === 0) {
            // Board cleared — refill so play continues; scores persist.
            this.resetPellets()
            this.broadcast('reset', encode({}))
        }

        this.broadcastState()
    }

    private movePac(actorId: string, pac: Pac, dt: number): void {
        let remaining = pac.speed * dt
        if (atNode(pac)) {
            snap(pac)
            this.eatAt(actorId, pac)
            this.decidePac(pac)
        }
        while (remaining > NODE_EPS && pac.dir !== 'none') {
            const dist = distToNextNode(pac)
            const move = Math.min(remaining, dist)
            advance(pac, move)
            remaining -= move
            wrap(pac)
            if (atNode(pac)) {
                snap(pac)
                this.eatAt(actorId, pac)
                this.decidePac(pac)
            }
        }
    }

    private moveGhost(ghost: Ghost, dt: number): void {
        let remaining = ghost.speed * dt
        if (atNode(ghost)) {
            snap(ghost)
            this.decideGhost(ghost)
        }
        while (remaining > NODE_EPS && ghost.dir !== 'none') {
            const dist = distToNextNode(ghost)
            const move = Math.min(remaining, dist)
            advance(ghost, move)
            remaining -= move
            wrap(ghost)
            if (atNode(ghost)) {
                snap(ghost)
                this.decideGhost(ghost)
            }
        }
    }

    // At a node: take the wanted direction if open, else go straight if possible, else stop.
    private decidePac(pac: Pac): void {
        const tx = Math.round(pac.x)
        const ty = Math.round(pac.y)
        let chosen = pac.dir
        if (pac.want !== 'none' && this.canEnter(tx, ty, pac.want)) {
            chosen = pac.want
        }
        if (chosen === 'none' || !this.canEnter(tx, ty, chosen)) {
            chosen = 'none'
        }
        pac.dir = chosen
    }

    // At a node: ghosts avoid reversing unless trapped, and chase the nearest player most of the time.
    private decideGhost(ghost: Ghost): void {
        const tx = Math.round(ghost.x)
        const ty = Math.round(ghost.y)
        const options = ALL_DIRS.filter(
            (dir) => dir !== REVERSE[ghost.dir] && this.canEnter(tx, ty, dir)
        )
        if (options.length === 0) {
            // Dead end — the only way out is back.
            ghost.dir = this.canEnter(tx, ty, REVERSE[ghost.dir]) ? REVERSE[ghost.dir] : 'none'
            return
        }

        const target = this.nearestPac(tx, ty)
        if (target !== null && Math.random() < 0.65) {
            let best = options[0]!
            let bestDist = Infinity
            for (const dir of options) {
                const v = DIR_VECTORS[dir]
                const d = manhattan(tx + v.x, ty + v.y, target.x, target.y)
                if (d < bestDist) {
                    bestDist = d
                    best = dir
                }
            }
            ghost.dir = best
            return
        }
        ghost.dir = options[Math.floor(Math.random() * options.length)]!
    }

    private canEnter(tx: number, ty: number, dir: Dir): boolean {
        const v = DIR_VECTORS[dir]
        if (v.x === 0 && v.y === 0) return false
        return !isWall(tx + v.x, ty + v.y)
    }

    private nearestPac(tx: number, ty: number): { x: number; y: number } | null {
        let best: { x: number; y: number } | null = null
        let bestDist = Infinity
        for (const pac of this.pacs.values()) {
            const d = manhattan(tx, ty, pac.x, pac.y)
            if (d < bestDist) {
                bestDist = d
                best = { x: pac.x, y: pac.y }
            }
        }
        return best
    }

    private eatAt(actorId: string, pac: Pac): void {
        const index = pelletIndex(Math.round(pac.x), Math.round(pac.y))
        if (!this.pellets.has(index)) return
        this.pellets.delete(index)
        pac.score += pelletPoints(index)
        const event: PelletEvent = { index, by: actorId }
        this.broadcast('pellet', encode(event))
    }

    private resolveCollisions(): void {
        for (const [id, pac] of this.pacs) {
            for (const ghost of this.ghosts) {
                if (distance(pac.x, pac.y, ghost.x, ghost.y) < CATCH_DISTANCE) {
                    this.killPac(id, pac)
                    break
                }
            }
        }
    }

    private killPac(actorId: string, pac: Pac): void {
        const spawn = PLAYER_SPAWNS[pac.spawnIndex]!
        pac.x = spawn.x
        pac.y = spawn.y
        pac.dir = 'none'
        pac.want = 'none'
        pac.score = Math.max(0, pac.score - DEATH_PENALTY)
        const event: DeathEvent = { id: actorId }
        this.broadcast('death', encode(event))
    }

    private resetPellets(): void {
        this.pellets = new Set(allPelletIndices())
    }

    private eatenIndices(): number[] {
        const out: number[] = []
        for (const index of allPelletIndices()) {
            if (!this.pellets.has(index)) out.push(index)
        }
        return out
    }

    private broadcastState(): void {
        const players: PlayerState[] = []
        this.each((actor) => {
            const pac = this.pacs.get(actor.id)
            if (pac === undefined) return
            const data = actor.data as ActorData
            players.push({
                id: actor.id,
                name: data.name,
                color: data.color,
                x: round2(pac.x),
                y: round2(pac.y),
                dir: pac.dir,
                score: pac.score
            })
        })
        const ghosts: GhostState[] = this.ghosts.map((g) => ({
            id: g.id,
            color: g.color,
            x: round2(g.x),
            y: round2(g.y),
            dir: g.dir
        }))
        const state: GameState = { players, ghosts, pelletsLeft: this.pellets.size }
        this.broadcast('state', encode(state))
    }
}

const atNode = (e: Entity): boolean =>
    Math.abs(e.x - Math.round(e.x)) < 1e-4 && Math.abs(e.y - Math.round(e.y)) < 1e-4

const snap = (e: Entity): void => {
    e.x = Math.round(e.x)
    e.y = Math.round(e.y)
}

// Distance (in tiles) from the entity to the next tile centre along its direction.
const distToNextNode = (e: Entity): number => {
    const v = DIR_VECTORS[e.dir]
    if (v.x > 0) return Math.floor(e.x + NODE_EPS) + 1 - e.x
    if (v.x < 0) return e.x - (Math.ceil(e.x - NODE_EPS) - 1)
    if (v.y > 0) return Math.floor(e.y + NODE_EPS) + 1 - e.y
    if (v.y < 0) return e.y - (Math.ceil(e.y - NODE_EPS) - 1)
    return 0
}

const advance = (e: Entity, step: number): void => {
    const v = DIR_VECTORS[e.dir]
    e.x += v.x * step
    e.y += v.y * step
}

// Wrap horizontally through the side tunnels.
const wrap = (e: Entity): void => {
    if (e.x < 0) e.x += COLS
    else if (e.x > COLS - 1) e.x -= COLS
    if (e.y < 0) e.y += ROWS
    else if (e.y > ROWS - 1) e.y -= ROWS
}

const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
    Math.abs(ax - bx) + Math.abs(ay - by)

const distance = (ax: number, ay: number, bx: number, by: number): number =>
    Math.hypot(ax - bx, ay - by)

const round2 = (v: number): number => Math.round(v * 100) / 100

export default PacmanRoom
