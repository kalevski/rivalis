// Shared wire types and the static maze. Frame payloads are opaque bytes, so we encode our own JSON shapes.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

export const ROOM_ID = 'pacman'

// Legend: '#' wall, '.' pellet, 'o' power pellet, ' ' open corridor (side-tunnel mouths).
export const MAZE: readonly string[] = [
    '###################',
    '#.................#',
    '#o###.###.###.###o#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.................#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    ' ................. ',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.................#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.................#',
    '#o###.###.###.###o#',
    '#.................#',
    '###################'
]

export const COLS = MAZE[0]!.length
export const ROWS = MAZE.length

export const TILE = 24
export const TUNNEL_ROW = 9
export const TICK_HZ = 30

export const PELLET_POINTS = 10
export const POWER_POINTS = 50
export const DEATH_PENALTY = 20

// Reads the maze tile at (x, y), wrapping horizontally on the tunnel row.
export const tileAt = (x: number, y: number): string => {
    if (y < 0 || y >= ROWS) return '#'
    let cx = x
    if (cx < 0) cx += COLS
    else if (cx >= COLS) cx -= COLS
    const row = MAZE[y]!
    return row[cx] ?? '#'
}

export const isWall = (x: number, y: number): boolean => tileAt(x, y) === '#'

// Flat index of a tile, used as the stable id of a pellet.
export const pelletIndex = (x: number, y: number): number => y * COLS + x

export const pelletPoints = (index: number): number => {
    const x = index % COLS
    const y = Math.floor(index / COLS)
    const c = tileAt(x, y)
    if (c === '.') return PELLET_POINTS
    if (c === 'o') return POWER_POINTS
    return 0
}

export const allPelletIndices = (): number[] => {
    const out: number[] = []
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const c = tileAt(x, y)
            if (c === '.' || c === 'o') out.push(pelletIndex(x, y))
        }
    }
    return out
}

export type Dir = 'up' | 'down' | 'left' | 'right' | 'none'

export const DIR_VECTORS: Record<Dir, { x: number; y: number }> = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    none: { x: 0, y: 0 }
}

export type InputCommand = { dir: Dir }

export type PlayerState = {
    id: string
    name: string
    color: string
    x: number
    y: number
    dir: Dir
    score: number
}

export type GhostState = {
    id: number
    color: string
    x: number
    y: number
    dir: Dir
}

export type GameState = {
    players: PlayerState[]
    ghosts: GhostState[]
    pelletsLeft: number
}

// `eaten` lets a late joiner reconcile its board to the pellets already consumed.
export type WelcomeEvent = {
    youId: string
    eaten: number[]
}

export type PelletEvent = {
    index: number
    by: string
}

export type DeathEvent = {
    id: string
}
